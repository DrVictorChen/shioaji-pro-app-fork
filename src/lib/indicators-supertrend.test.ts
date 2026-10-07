import { describe, expect, it } from 'vitest';
import { supertrend } from './indicators';
import type { Candle } from './types/market';

function trendString(bars: Candle[]): string {
    const r = supertrend(bars, 10, 3);
    return r.up
        .map((p, i) => (p.value !== undefined ? 'U' : r.down[i]!.value !== undefined ? 'D' : '.'))
        .join('');
}

describe('supertrend band ratchet (#239)', () => {
    // 跌 15 根 → 漲 15 根 → 跌 4 根 → 盤整 11 根（issue #239 的重現資料）
    const bars: Candle[] = [];
    let c = 100;
    for (let i = 0; i < 45; i++) {
        if (i < 15) c -= 2;
        else if (i < 30) c += 2;
        else if (i < 34) c -= 4;
        else c += i % 2 ? 0.5 : -0.5;
        bars.push({ time: 1_700_000_000 + i * 86400, open: c, high: c + 1, low: c - 1, close: c, volume: 1 });
    }

    it('翻空後盤整不會每根多空交替', () => {
        expect(trendString(bars)).toBe('.........UUUUUDDDDDUUUUUUUUUUUUUDDDDDDDDDDDDD');
    });

    it('前一根收盤越過前帶時重設為新帶（標準 SuperTrend）', () => {
        const r = supertrend(bars, 10, 3);
        // 盤整段為空頭，上軌應是當根計算的帶或更緊的前帶，且始終高於收盤
        for (let i = 34; i < bars.length; i++) {
            const v = r.down[i]!.value;
            expect(v).toBeDefined();
            expect(v!).toBeGreaterThan(bars[i]!.close);
        }
    });

    it('鏡射資料：翻多後盤整不會每根多空交替（下軌重設）', () => {
        const mirrored = bars.map(b => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
        expect(trendString(mirrored)).toBe('.........UUUUUUUUUUDDDDDDDDDDDDDUUUUUUUUUUUUU');
    });
});
