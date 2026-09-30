import { describe, expect, it } from 'vitest';
import { DrawingHistory, HISTORY_LIMIT, rebase } from './chart-drawing-history';
import { DEFAULT_DRAWING_STYLE, type Drawing } from './chart-drawings';

const mk = (id: string, price = 100, extra: Partial<Drawing> = {}): Drawing => ({
    id,
    tool: 'horizontal',
    anchors: [{ time: 1, price }],
    style: DEFAULT_DRAWING_STYLE,
    locked: false,
    hidden: false,
    createdAt: 0,
    ...extra,
});

describe('rebase：只把這一步動到的物件退回', () => {
    it('復原新增＝移除那個物件，其他視窗同時加的物件保留', () => {
        const a = mk('a');
        const b = mk('b');
        const theirs = mk('z');
        // 這一步：[a] → [a, b]；之後別的視窗加了 z
        expect(rebase([a, b, theirs], [a, b], [a]).map((d) => d.id)).toEqual(['a', 'z']);
    });

    it('復原修改＝換回修改前的版本，其他物件的後續修改不動', () => {
        const a1 = mk('a', 100);
        const a2 = mk('a', 110);
        const c1 = mk('c', 1);
        const c2 = mk('c', 2); // 之後另一步改的
        expect(rebase([a2, c2], [a2, c1], [a1, c1])).toEqual([a1, c2]);
    });

    it('復原刪除＝把物件放回來', () => {
        const a = mk('a');
        const b = mk('b');
        expect(rebase([a], [a], [a, b]).map((d) => d.id)).toEqual(['a', 'b']);
    });

    it('圖層順序改過時依目標順序重排', () => {
        const a = mk('a');
        const b = mk('b');
        const c = mk('c');
        expect(rebase([b, a, c], [b, a, c], [a, b, c]).map((d) => d.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('DrawingHistory', () => {
    it('復原後可重做；新的一步清掉重做', () => {
        const h = new DrawingHistory();
        const s0: Drawing[] = [];
        const s1 = [mk('a')];
        h.push('TXF', s0, s1);
        expect(h.canUndo).toBe(true);
        expect(h.undo()).toEqual({ key: 'TXF', from: s1, to: s0 });
        expect(h.canRedo).toBe(true);
        expect(h.redo()).toEqual({ key: 'TXF', from: s0, to: s1 });
        h.undo();
        h.push('TXF', s0, [mk('b')]);
        expect(h.canRedo).toBe(false);
    });

    it('同標籤的連續操作（拉滑桿）在短時間內合併成一步', () => {
        const h = new DrawingHistory();
        const s0 = [mk('a', 1)];
        const s1 = [mk('a', 2)];
        const s2 = [mk('a', 3)];
        h.push('TXF', s0, s1, 'style:fillOpacity', 1000);
        h.push('TXF', s1, s2, 'style:fillOpacity', 1200);
        expect(h.undo()).toEqual({ key: 'TXF', from: s2, to: s0 });
        expect(h.canUndo).toBe(false);
        // 隔太久就不合併
        h.push('TXF', s0, s1, 'x', 1000);
        h.push('TXF', s1, s2, 'x', 5000);
        h.undo();
        expect(h.canUndo).toBe(true);
    });

    it('紀錄有上限，最舊的丟掉', () => {
        const h = new DrawingHistory();
        for (let i = 0; i < HISTORY_LIMIT + 20; i++) h.push('TXF', [mk(`a${i}`)], [mk(`b${i}`)]);
        let n = 0;
        while (h.undo()) n++;
        expect(n).toBe(HISTORY_LIMIT);
    });

    it('沒有變化（同一個清單）不記', () => {
        const h = new DrawingHistory();
        const s = [mk('a')];
        h.push('TXF', s, s);
        expect(h.canUndo).toBe(false);
    });
});
