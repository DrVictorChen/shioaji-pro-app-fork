// src/lib/chart-drawing-history.ts — 畫圖的復原／重做（每張圖各自一份）
//
// 每一步只記「這一步動到的物件」：它們改動前後的版本與圖層位置。復原
// 時只把這些物件退回改動前 — 同一個商品可能在別的視窗、或在這一步進行
// 中（拖曳、編輯文字）被別處改過，那些改動不能跟著被復原掉。刪除後復原
// 放回原本的圖層位置（接在原本排在它前面的那個物件後面）。

import type { Drawing } from './chart-drawings';

export interface HistoryChange {
    id: string;
    before: Drawing | null; // null＝這一步新增的
    after: Drawing | null; // null＝這一步刪掉的
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

function predecessor(order: string[], id: string): string | null {
    const i = order.indexOf(id);
    return i > 0 ? order[i - 1]! : null;
}

// before → after 之間，這一步動到的物件。ids 給了就只看這些（拖曳、文字
// 編輯這種跨時間的操作，期間別處的改動不算進來）
export function diffDrawings(
    before: Drawing[],
    after: Drawing[],
    ids?: Iterable<string>,
): HistoryChange[] {
    const b = new Map(before.map((d) => [d.id, d]));
    const a = new Map(after.map((d) => [d.id, d]));
    const bo = before.map((d) => d.id);
    const ao = after.map((d) => d.id);
    const scope = ids ? new Set(ids) : new Set([...b.keys(), ...a.keys()]);
    const out: HistoryChange[] = [];
    for (const id of scope) {
        const x = b.get(id) ?? null;
        const y = a.get(id) ?? null;
        if (!x && !y) continue;
        const moved = !!x && !!y && predecessor(bo, id) !== predecessor(ao, id) && !ids;
        if (x !== y || moved) out.push({ id, before: x, after: y });
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

    constructor(private readonly _limit = HISTORY_LIMIT) {}

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
        const beforeOrder = before.map((d) => d.id);
        const afterOrder = after.map((d) => d.id);
        const last = this._undo[this._undo.length - 1];
        if (
            tag &&
            last &&
            last.tag === tag &&
            last.key === key &&
            now - last.at < COALESCE_MS &&
            changes.every((c) => last.changes.some((l) => l.id === c.id))
        ) {
            for (const c of changes) last.changes.find((l) => l.id === c.id)!.after = c.after;
            last.afterOrder = afterOrder;
            last.at = now;
        } else {
            this._undo.push({ key, changes, beforeOrder, afterOrder, tag, at: now });
            if (this._undo.length > this._limit) this._undo.shift();
        }
        this._redo = [];
    }

    // 回傳要套用的步驟；呼叫端用 applyChanges 套到目前清單
    undo(): { key: string; changes: HistoryChange[]; side: 'before'; order: string[] } | null {
        const e = this._undo.pop();
        if (!e) return null;
        this._redo.push(e);
        return { key: e.key, changes: e.changes, side: 'before', order: e.beforeOrder };
    }

    redo(): { key: string; changes: HistoryChange[]; side: 'after'; order: string[] } | null {
        const e = this._redo.pop();
        if (!e) return null;
        this._undo.push(e);
        return { key: e.key, changes: e.changes, side: 'after', order: e.afterOrder };
    }

    clear() {
        this._undo = [];
        this._redo = [];
    }
}
