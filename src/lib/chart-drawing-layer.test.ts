import { describe, expect, it } from 'vitest';
import { DrawingLayer, SELECTED_EXTRA_WIDTH } from './chart-drawing-layer';

describe('DrawingLayer 圖層', () => {
    it('畫圖層在 K 棒之上，文字與量測標籤不會被 K 棒蓋住', () => {
        const layer = new DrawingLayer(() => []);
        const views = layer.paneViews();
        expect(views.length).toBeGreaterThan(0);
        for (const v of views) expect(v.zOrder?.()).toBe('top');
    });

    it('選取時至少加粗 1px，細線選取後也看得出來', () => {
        expect(SELECTED_EXTRA_WIDTH).toBeGreaterThanOrEqual(1);
    });
});
