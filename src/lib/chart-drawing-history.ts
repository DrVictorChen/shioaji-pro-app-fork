// src/lib/chart-drawing-history.ts — 畫圖的復原／重做（每張圖各自一份）
//
// 每一步只記「這一步動到的物件」：它們改動前後的版本與圖層位置。復原
// 時只把這些物件退回改動前 — 同一個商品可能在別的視窗、或在這一步進行
// 中（拖曳、編輯文字）被別處改過，那些改動不能跟著被復原掉。刪除後復原
// 放回原本的圖層位置（接在原本排在它前面的那個物件後面）。

import type { Drawing } from './chart-drawings';
import { drawingRevision, type Revision } from './chart-drawing-revision';

export interface HistoryChange {
    id: string;
    before: Drawing | null; // null＝這一步新增的
    after: Drawing | null; // null＝這一步刪掉的
    beforeVersion: Revision | null; // 缺席時也保留墓碑版本
    afterVersion: Revision | null;
    moved?: boolean;
}

export interface HistoryStep {
    key: string;
    changes: HistoryChange[];
    side: 'before' | 'after';
    order: string[];
}

export interface HistoryEntry {
    key: string;
    changes: HistoryChange[];
    beforeOrder: string[]; // 動到的物件在改動前後各自的圖層順序（整份 id）
    afterOrder: string[];
    // 連續的同類操作（拉填色滑桿、連按線寬）合併成一步
    tag?: string;
    at: number;
}

export const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

// before → after 之間，這一步動到的物件。ids 給了就只看這些（拖曳、文字
// 編輯這種跨時間的操作，期間別處的改動不算進來）
export function diffDrawings(
    before: Drawing[],
    after: Drawing[],
    ids?: Iterable<string>,
): HistoryChange[] {
    const b = new Map(before.map((d) => [d.id, d]));
    const a = new Map(after.map((d) => [d.id, d]));
    const scope = ids ? new Set(ids) : new Set([...b.keys(), ...a.keys()]);
    const out: HistoryChange[] = [];
    for (const id of scope) {
        const x = b.get(id) ?? null;
        const y = a.get(id) ?? null;
        if (!x && !y) continue;
        // 前驅因新增／刪除／移動而改變，不代表這個鄰居也被修改。
        // 調整圖層的呼叫端會替實際移動的物件建立新版本。
        if (x !== y) {
            out.push({
                id,
                before: x,
                after: y,
                beforeVersion: x ? drawingRevision(x) : null,
                afterVersion: y ? drawingRevision(y) : null,
                // 指定 ids 的跨時間操作只改座標／文字，期間鄰居的排序
                // 改變不算這個物件的圖層移動。
                moved: !ids && !!x && !!y &&
                    before.filter((d) => a.has(d.id)).findIndex((d) => d.id === id) !==
                    after.filter((d) => b.has(d.id)).findIndex((d) => d.id === id),
            });
        }
    }
    return out;
}

// 把 changes 套到 current：每個物件換成 pick 那一側的版本（null＝移除），
// 並依 order（那一側的圖層順序）放回位置
export function applyChanges(
    current: Drawing[],
    changes: HistoryChange[],
    side: 'before' | 'after',
    order: string[],
): Drawing[] {
    let next = [...current];
    for (const c of changes) {
        const target = c[side];
        const i = next.findIndex((d) => d.id === c.id);
        if (i >= 0 && target && c.before && c.after && !c.moved) {
            next[i] = target;
            continue;
        }
        if (i >= 0) next.splice(i, 1);
        if (!target) continue;
        // 接在目標順序裡排在它前面、而且現在還在的物件後面
        const pos = order.indexOf(c.id);
        let at = 0;
        for (let k = pos - 1; k >= 0; k--) {
            const j = next.findIndex((d) => d.id === order[k]);
            if (j >= 0) {
                at = j + 1;
                break;
            }
        }
        if (pos < 0) at = i >= 0 ? Math.min(i, next.length) : next.length;
        next = [...next.slice(0, at), target, ...next.slice(at)];
    }
    return next;
}

export class DrawingHistory {
    private _undo: HistoryEntry[] = [];
    private _redo: HistoryEntry[] = [];

    constructor(
        private readonly _limit = HISTORY_LIMIT,
        private readonly versionOf?: (key: string, id: string) => Revision | null,
    ) {}

    get canUndo(): boolean {
        return this._undo.length > 0;
    }

    get canRedo(): boolean {
        return this._redo.length > 0;
    }

    // ids：只記這些物件（省略＝前後清單所有差異；同步操作用）
    push(
        key: string,
        before: Drawing[],
        after: Drawing[],
        tag?: string,
        now = Date.now(),
        ids?: Iterable<string>,
    ) {
        if (before === after) return;
        const changes = diffDrawings(before, after, ids);
        if (!changes.length) return;
        for (const c of changes) {
            if (!c.after) c.afterVersion = this.versionOf?.(key, c.id) ?? null;
        }
        const beforeOrder = before.map((d) => d.id);
        const afterOrder = after.map((d) => d.id);
        const last = this._undo[this._undo.length - 1];
        if (
            tag &&
            last &&
            last.tag === tag &&
            last.key === key &&
            now - last.at < COALESCE_MS &&
            changes.every((c) =>
                last.changes.some((l) => l.id === c.id && l.afterVersion === c.beforeVersion),
            )
        ) {
            for (const c of changes) {
                const previous = last.changes.find((l) => l.id === c.id)!;
                previous.after = c.after;
                previous.afterVersion = c.afterVersion;
                previous.moved ||= c.moved;
            }
            last.afterOrder = afterOrder;
            last.at = now;
        } else {
            this._undo.push({ key, changes, beforeOrder, afterOrder, tag, at: now });
            if (this._undo.length > this._limit) this._undo.shift();
        }
        this._redo = [];
    }

    // 回傳待套用的步驟；呼叫端檢查版本後，透過 applied 接回成功寫入的版本
    undo(): HistoryStep | null {
        const e = this._undo.pop();
        if (!e) return null;
        this._redo.push(e);
        return { key: e.key, changes: e.changes, side: 'before', order: e.beforeOrder };
    }

    redo(): HistoryStep | null {
        const e = this._redo.pop();
        if (!e) return null;
        this._undo.push(e);
        return { key: e.key, changes: e.changes, side: 'after', order: e.afterOrder };
    }

    // 只有成功套用的物件才可再反向操作。復原／重做的新 revision 要接回
    // 相同舊版本的歷史邊界，連續復原與重做才不會把自己的寫入當成衝突。
    applied(step: HistoryStep, versions: Map<string, Revision | null>) {
        for (const c of step.changes) {
            if (!versions.has(c.id)) continue;
            const old = step.side === 'before' ? c.beforeVersion : c.afterVersion;
            const next = versions.get(c.id)!;
            for (const e of [...this._undo, ...this._redo]) {
                if (e.key !== step.key) continue;
                for (const change of e.changes) {
                    if (change.id !== c.id) continue;
                    if (change.beforeVersion === old) change.beforeVersion = next;
                    if (change.afterVersion === old) change.afterVersion = next;
                }
            }
        }
        step.changes.splice(0, step.changes.length, ...step.changes.filter((c) => versions.has(c.id)));
        this._undo = this._undo.filter((e) => e.changes.length);
        this._redo = this._redo.filter((e) => e.changes.length);
    }

    clear() {
        this._undo = [];
        this._redo = [];
    }

    // 遠端新版本永久切斷此物件的所有歷史；多物件步驟保留其餘物件。
    invalidate(key: string, ids: ReadonlySet<string>) {
        let changed = false;
        for (const e of [...this._undo, ...this._redo]) {
            if (e.key !== key) continue;
            const keep = e.changes.filter((c) => !ids.has(c.id));
            if (keep.length !== e.changes.length) changed = true;
            e.changes.splice(0, e.changes.length, ...keep);
        }
        this._undo = this._undo.filter((e) => e.changes.length);
        this._redo = this._redo.filter((e) => e.changes.length);
        return changed;
    }
}
