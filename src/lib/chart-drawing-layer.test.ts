import { describe, expect, it } from 'vitest';
import { DrawingLayer, drawingPassPlan, SELECTED_EXTRA_WIDTH } from './chart-drawing-layer';
import type { Drawing } from './chart-drawings';

type D = Pick<Drawing, 'id' | 'tool' | 'hidden' | 'behind'>;
const d = (id: string, tool: Drawing['tool'], extra: Partial<D> = {}): D => ({ id, tool, hidden: false, ...extra });
const plan = (list: D[], pass: 'front' | 'back') =>
    drawingPassPlan(list, pass).map((p) => `${p.drawing.id}:${p.part}`);

describe('DrawingLayer 圖層', () => {
    it('兩個 pane view：K 棒後方一層（bottom）、K 棒前方一層（top），前方最後畫', () => {
        const layer = new DrawingLayer(() => []);
        expect(layer.paneViews().map((v) => v.zOrder?.())).toEqual(['bottom', 'top']);
    });

    it('選取時至少加粗 1px，0.5px 細線選取後也看得出來（至少變成 4 倍粗）', () => {
        expect(SELECTED_EXTRA_WIDTH).toBeGreaterThanOrEqual(1);
        expect((0.5 + SELECTED_EXTRA_WIDTH) / 0.5).toBeGreaterThanOrEqual(4);
    });
});

describe('前方／後方分流', () => {
    it('舊資料（沒有 behind 欄位）與新物件一律畫在前方', () => {
        const list = [d('old', 'trend'), d('h', 'horizontal', { behind: false })];
        expect(plan(list, 'front')).toEqual(['old:all', 'h:all']);
        expect(plan(list, 'back')).toEqual([]);
    });

    it('後方物件的線條在後方層，依清單順序；前方層不重畫線條', () => {
        const list = [d('a', 'trend', { behind: true }), d('b', 'box'), d('c', 'ray', { behind: true })];
        expect(plan(list, 'back')).toEqual(['a:body', 'c:body']);
        expect(plan(list, 'front')).toEqual(['a:labels', 'b:all', 'c:labels']);
    });

    it('文字註記一律在前方，即使資料寫了 behind；隱藏的物件兩層都不畫', () => {
        const list = [d('t', 'text', { behind: true }), d('x', 'trend', { behind: true, hidden: true })];
        expect(plan(list, 'back')).toEqual([]);
        expect(plan(list, 'front')).toEqual(['t:all']);
    });
});
