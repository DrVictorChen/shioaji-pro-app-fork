// src/lib/chart-drawing-history.ts — 畫圖的復原／重做（每張圖各自一份）
//
// 每一步記「改動前、改動後」兩份清單（物件本身不可變，存的是參考，
// 不複製）。復原時不直接把整份清單換回 before — 同一個商品可能在別的
// 視窗、或這一步之後被別的操作改過；只把「這一步動到的物件」退回
// before 的版本，其他物件維持現況（rebase）。

import type { Drawing } from './chart-drawings';

export interface HistoryEntry {
    key: string;
    before: Drawing[];
    after: Drawing[];
    // 連續的同類操作（拉填色滑桿、連按線寬）合併成一步
    tag?: string;
    at: number;
}

export const HISTORY_LIMIT = 100;
const COALESCE_MS = 800;

// 把 from → to 這一步的改動套到 current 上：只動 from 與 to 之間有差異
// 的物件；圖層順序若在這一步變了，依 to 的順序重排共同物件
export function rebase(current: Drawing[], from: Drawing[], to: Drawing[]): Drawing[] {
    const fromMap = new Map(from.map((d) => [d.id, d]));
    const toMap = new Map(to.map((d) => [d.id, d]));
    const changed = new Set<string>();
    for (const [id, d] of fromMap) if (toMap.get(id) !== d) changed.add(id);
    for (const id of toMap.keys()) if (!fromMap.has(id)) changed.add(id);

    let next = current
        .filter((d) => !changed.has(d.id) || toMap.has(d.id))
        .map((d) => (changed.has(d.id) ? toMap.get(d.id)! : d));
    const present = new Set(next.map((d) => d.id));
    for (const d of to) if (changed.has(d.id) && !present.has(d.id)) next.push(d);

    const order = (list: Drawing[], keep: Map<string, Drawing>) =>
        list.filter((d) => keep.has(d.id)).map((d) => d.id);
    const fromOrder = order(from, toMap);
    const toOrder = order(to, fromMap);
    if (fromOrder.some((id, i) => id !== toOrder[i])) {
        const rank = new Map(to.map((d, i) => [d.id, i]));
        const ranked = next.filter((d) => rank.has(d.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        const rest = next.filter((d) => !rank.has(d.id));
        next = [...ranked, ...rest];
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

    push(key: string, before: Drawing[], after: Drawing[], tag?: string, now = Date.now()) {
        if (before === after) return;
        const last = this._undo[this._undo.length - 1];
        if (tag && last && last.tag === tag && last.key === key && now - last.at < COALESCE_MS) {
            last.after = after;
            last.at = now;
        } else {
            this._undo.push({ key, before, after, tag, at: now });
            if (this._undo.length > this._limit) this._undo.shift();
        }
        this._redo = [];
    }

    // 回傳要套用的 { key, from, to }；呼叫端用 rebase 套到目前清單
    undo(): { key: string; from: Drawing[]; to: Drawing[] } | null {
        const e = this._undo.pop();
        if (!e) return null;
        this._redo.push(e);
        return { key: e.key, from: e.after, to: e.before };
    }

    redo(): { key: string; from: Drawing[]; to: Drawing[] } | null {
        const e = this._redo.pop();
        if (!e) return null;
        this._undo.push(e);
        return { key: e.key, from: e.before, to: e.after };
    }

    clear() {
        this._undo = [];
        this._redo = [];
    }
}
