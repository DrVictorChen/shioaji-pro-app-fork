import { describe, expect, it } from 'vitest';
import {
    buildSpreadLadder,
    maxProfitableLots,
    planLeg,
    quoteBoth,
    quoteDirection,
    sanitizePrefs,
    sliceOddOrders,
    type SideBook,
    type SpreadInput,
} from './odd-spread';
import { applyRateYuan, priceCents, stockSellTax, stockTradeFee } from './utils/contract-cost';

// 設計稿（2330，6 折、證交稅 0.3%）的五檔
const ROUND: SideBook = {
    asks: [
        { price: 1085, vol: 2317 },
        { price: 1090, vol: 1038 },
        { price: 1095, vol: 655 },
        { price: 1100, vol: 412 },
    ],
    bids: [
        { price: 1080, vol: 1904 },
        { price: 1075, vol: 822 },
        { price: 1070, vol: 530 },
    ],
};
const ODD: SideBook = {
    asks: [{ price: 1100, vol: 86 }],
    bids: [
        { price: 1095, vol: 380 },
        { price: 1090, vol: 1020 },
        { price: 1085, vol: 640 },
        { price: 1080, vol: 3410 },
        { price: 1075, vol: 2200 },
        { price: 1070, vol: 150 },
    ],
};
const FEES = { discount: 0.6, taxRate: 0.003 };

function input(over: Partial<SpreadInput> = {}): SpreadInput {
    return { round: ROUND, odd: ODD, lots: 1, fees: FEES, inventoryShares: 3420, ...over };
}

describe('台股手續費／證交稅（contract-cost）', () => {
    it('整股最低 20 元、零股最低 1 元', () => {
        expect(stockTradeFee(priceCents(10) * 1000, { odd: false })).toBe(20); // 14.25 → 20
        expect(stockTradeFee(priceCents(10) * 10, { odd: true })).toBe(1); // 0.14 → 1
        expect(stockTradeFee(0, { odd: true })).toBe(0);
    });
    it('折數後四捨五入，以整數運算避免 .5 邊界誤差', () => {
        // 1,085 × 1,000 × 0.1425% × 0.6 = 927.675 → 928
        expect(stockTradeFee(priceCents(1085) * 1000, { odd: false, discount: 0.6 })).toBe(928);
        // 無折扣：1,085,000 × 0.1425% = 1,546.125 → 1,546
        expect(stockTradeFee(priceCents(1085) * 1000, { odd: false })).toBe(1546);
        // 0.5 邊界：10.5 元 → 11（浮點 0.1425% 相乘會落在 10.499999…）
        expect(applyRateYuan(1_050_000, 0.00001)).toBe(0); // 0.105 元
        expect(applyRateYuan(10_500_000, 0.0001)).toBe(11); // 105,000 元 × 0.01% = 10.5 → 11
    });
    it('證交稅四捨五入到元', () => {
        expect(stockSellTax(priceCents(1095) * 380, 0.003)).toBe(1248); // 1,248.3
        expect(stockSellTax(priceCents(1090) * 620, 0.003)).toBe(2027); // 2,027.4
        expect(stockSellTax(priceCents(10.05) * 1000, 0.001)).toBe(10); // 10.05
    });
});

describe('sliceOddOrders', () => {
    it('零股每筆 ≤ 999 股，同價位超過就拆筆', () => {
        expect(sliceOddOrders([{ price: 100, shares: 2500 }, { price: 99, shares: 10 }])).toEqual([
            { price: 100, quantity: 999 },
            { price: 100, quantity: 999 },
            { price: 100, quantity: 502 },
            { price: 99, quantity: 10 },
        ]);
    });
});

describe('planLeg', () => {
    it('零股賣出往下吃檔：1,095×380、1,090×620，每筆各計費與稅', () => {
        const leg = planLeg(ODD, true, 'Sell', 1000, FEES);
        expect(leg.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 620 }]);
        expect(leg.orders).toEqual([{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }]);
        expect(leg.fee).toBe(356 + 578);
        expect(leg.tax).toBe(1248 + 2027);
        expect(leg.short).toBe(false);
    });
    it('整股一筆、以吃到的最差檔為限價', () => {
        const leg = planLeg(ROUND, false, 'Buy', 3000_000, FEES);
        expect(leg.fills.map(f => f.price)).toEqual([1085, 1090]);
        expect(leg.orders).toEqual([{ price: 1090, quantity: 3000 }]);
        expect(leg.short).toBe(false);
    });
    it('量不足標記 short', () => {
        const leg = planLeg(ODD, true, 'Buy', 1000, FEES);
        expect(leg.short).toBe(true);
        expect(leg.fills).toEqual([{ price: 1100, shares: 86 }]);
    });
});

describe('quoteDirection — 設計稿數字', () => {
    it('買整→賣零：+10.00 元/股、92 bps、淨 +4.85、加權 +1.76、損益 +1,763、可執行', () => {
        const q = quoteDirection('buyRoundSellOdd', input());
        expect(q.buyPrice).toBe(1085);
        expect(q.sellPrice).toBe(1095);
        expect(q.grossPerShare).toBe(10);
        expect(q.grossBps).toBe(92);
        expect(q.netPerShare).toBe(4.85);
        expect(q.sellLeg?.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 620 }]);
        // 6,900 − 928 − (356+578) − (1,248+2,027)。設計稿的 1,762 是零股合併一筆
        // 計費的近似；實際每檔各一筆委託、各自四捨五入，得 1,763。
        expect(q.pnl).toBe(1763);
        expect(q.weightedNetPerShare).toBe(1.76);
        expect(q.maxLots).toBe(1);
        expect(q.block).toBeNull();
        expect(q.canExecute).toBe(true);
    });
    it('買零→賣整：−20.00 元/股、−182 bps、淨 −25.10、價差未達成本', () => {
        const q = quoteDirection('buyOddSellRound', input());
        expect(q.buyPrice).toBe(1100);
        expect(q.sellPrice).toBe(1080);
        expect(q.grossPerShare).toBe(-20);
        expect(q.grossBps).toBe(-182);
        expect(q.netPerShare).toBe(-25.1);
        expect(q.block).toBe('belowCost');
        expect(q.canExecute).toBe(false);
        expect(q.maxLots).toBe(0);
    });
    it('quoteBoth 兩個方向各算一次', () => {
        const both = quoteBoth(input());
        expect(both.buyRoundSellOdd.canExecute).toBe(true);
        expect(both.buyOddSellRound.canExecute).toBe(false);
    });
});

describe('quoteDirection — 擋下原因', () => {
    it('零股量不足', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 8 }));
        expect(q.block).toBe('oddDepth');
        expect(q.canExecute).toBe(false);
    });
    it('加權後不賺 → 價差未達成本（最佳一檔仍賺）', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 2 }));
        expect(q.netPerShare).toBeGreaterThan(0);
        expect(q.pnl).toBeLessThanOrEqual(0);
        expect(q.block).toBe('belowCost');
    });
    it('庫存不足或未知 → 不可執行', () => {
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: 999 })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: null })).block).toBe('inventory');
        expect(quoteDirection('buyRoundSellOdd', input({ inventoryShares: 1000 })).canExecute).toBe(true);
    });
    it('整股量不足', () => {
        const round: SideBook = { asks: [{ price: 1085, vol: 1 }], bids: ROUND.bids };
        const odd: SideBook = { asks: ODD.asks, bids: [{ price: 1200, vol: 5000 }] };
        const q = quoteDirection('buyRoundSellOdd', input({ round, odd, lots: 2 }));
        expect(q.block).toBe('roundDepth');
    });
    it('沒有報價', () => {
        const q = quoteDirection('buyOddSellRound', input({ odd: { bids: [], asks: [] } }));
        expect(q.block).toBe('noQuote');
        expect(q.grossPerShare).toBeNull();
    });
    it('買零→賣整有利時可執行，整股賣出檢查庫存', () => {
        const odd: SideBook = { asks: [{ price: 1060, vol: 600 }, { price: 1065, vol: 900 }], bids: [] };
        const q = quoteDirection('buyOddSellRound', input({ odd, inventoryShares: 1000 }));
        expect(q.buyLeg?.orders).toEqual([{ price: 1060, quantity: 600 }, { price: 1065, quantity: 400 }]);
        expect(q.sellLeg?.orders).toEqual([{ price: 1080, quantity: 1 }]);
        // 賣 1,080,000 − 買 (636,000 + 426,000) = 18,000；費 923 + (544 + 364)；稅 3,240
        expect(q.pnl).toBe(18000 - 923 - 544 - 364 - 3240);
        expect(q.canExecute).toBe(true);
        expect(quoteDirection('buyOddSellRound', input({ odd, inventoryShares: 420 })).block).toBe('inventory');
    });
    it('未配對：零股股數另設，損益以配對股數計', () => {
        const q = quoteDirection('buyRoundSellOdd', input({ lots: 1, oddShares: 500 }));
        expect(q.sellLeg?.shares).toBe(500);
        expect(q.buyLeg?.shares).toBe(1000);
        expect(q.sellLeg?.fills).toEqual([{ price: 1095, shares: 380 }, { price: 1090, shares: 120 }]);
    });
});

describe('maxProfitableLots', () => {
    it('多一張不再多賺就停止', () => {
        const odd: SideBook = { asks: [], bids: [{ price: 1100, vol: 2500 }, { price: 1086, vol: 5000 }] };
        expect(maxProfitableLots('buyRoundSellOdd', ROUND, odd, FEES)).toBe(3);
    });
});

describe('buildSpreadLadder', () => {
    const step = (p: number, dir: 1 | -1) => p + dir * 5;
    it('共用價格欄、補齊跳動點、標出可套利價位與最後成交價', () => {
        const rows = buildSpreadLadder(ROUND, ODD, { roundLast: 1085, oddLast: 1095, step });
        expect(rows.map(r => r.price)).toEqual([1100, 1095, 1090, 1085, 1080, 1075, 1070]);
        const at = (p: number) => rows.find(r => r.price === p)!;
        expect(at(1095)).toMatchObject({ roundAsk: 655, oddBid: 380, cross: true, oddLast: true, roundLast: false });
        expect(at(1090).cross).toBe(true);
        expect(at(1085)).toMatchObject({ roundAsk: 2317, oddBid: 640, cross: false, roundLast: true });
        expect(at(1100)).toMatchObject({ roundAsk: 412, oddAsk: 86, cross: false });
        expect(at(1080).cross).toBe(false);
    });
    it('零股賣價低於整股買一也算可套利', () => {
        const odd: SideBook = { asks: [{ price: 1075, vol: 10 }], bids: [] };
        const rows = buildSpreadLadder(ROUND, odd);
        expect(rows.find(r => r.price === 1075)!.cross).toBe(true);
    });
    it('補齊中間價位、依 maxRows 截取', () => {
        const rows = buildSpreadLadder(
            { bids: [{ price: 100, vol: 1 }], asks: [{ price: 101, vol: 1 }] },
            { bids: [{ price: 90, vol: 1 }], asks: [{ price: 110, vol: 1 }] },
            { step: (p, d) => p + d, maxRows: 5 },
        );
        expect(rows).toHaveLength(5);
        expect(rows.map(r => r.price)).toEqual([102, 101, 100, 99, 98]);
    });
    it('沒有報價時為空', () => {
        expect(buildSpreadLadder({ bids: [], asks: [] }, { bids: [], asks: [] })).toEqual([]);
    });
});

describe('sanitizePrefs', () => {
    it('折數 0～1、稅率 0～1%，其餘回預設', () => {
        expect(sanitizePrefs({ discount: 0.6, taxRate: 0.0015 })).toEqual({ discount: 0.6, taxRate: 0.0015 });
        expect(sanitizePrefs({ discount: 6, taxRate: 3 })).toEqual({ discount: 1, taxRate: null });
        expect(sanitizePrefs(null)).toEqual({ discount: 1, taxRate: null });
    });
});
