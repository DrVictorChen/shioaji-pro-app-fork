import { describe, expect, it } from 'vitest';
import {
    execReduce,
    execSummary,
    initExec,
    takeOddOrders,
    type ExecCommand,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type HedgeQuote,
} from './odd-spread-exec';

const SELL_ODD: ExecPlan = {
    direction: 'buyRoundSellOdd',
    mode: 'sequential',
    lots: 1,
    roundPrice: 1085,
    oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }],
    netPerShare: 1.76,
};

// 補單定價：預設以計畫價可送；個別測試可改成不可送
function ctxOf(fn?: (leg: 'odd' | 'round', action: 'Buy' | 'Sell', qty: number) => HedgeQuote): ExecContext & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        calls,
        quoteHedge: (leg, action, qty) => {
            calls.push([leg, action, qty]);
            return fn ? fn(leg, action, qty) : { ok: true, orders: [{ price: leg === 'round' ? 1085 : 1095, quantity: qty }] };
        },
    };
}

function run(plan: ExecPlan, events: ExecEvent[], ctx: ExecContext = ctxOf(), from?: ExecState): { state: ExecState; commands: ExecCommand[] } {
    let state = from ?? initExec(plan);
    const commands: ExecCommand[] = [];
    for (const e of events) {
        const r = execReduce(state, e, ctx);
        state = r.state;
        commands.push(...r.commands);
    }
    return { state, commands };
}

const places = (cmds: ExecCommand[]) => cmds.filter(c => c.kind === 'place');
const oddFilled: ExecEvent[] = [
    { type: 'start' },
    { type: 'placed', key: 'odd:0', orderId: 'A' },
    { type: 'placed', key: 'odd:1', orderId: 'B' },
    { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
    { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
];
const LOTS2: ExecPlan = { ...SELL_ODD, lots: 2, oddOrders: [{ price: 1095, quantity: 999 }, { price: 1095, quantity: 999 }, { price: 1095, quantity: 2 }] };

describe('sequential：零股成交後再送整股', () => {
    it('start 只送零股那一腳（每檔一筆），整股等零股成交確定', () => {
        const { state, commands } = run(SELL_ODD, [{ type: 'start' }]);
        expect(state.phase).toBe('oddPending');
        expect(commands).toEqual([
            { kind: 'place', key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620 },
        ]);
    });

    it('零股全部成交 → 以當下價重新定價送整股 → 整股成交 → done', () => {
        const ctx = ctxOf();
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(r.state.phase).toBe('roundPending');
        expect(ctx.calls).toEqual([['round', 'Buy', 1]]);
        expect(places(r.commands).at(-1)).toEqual({ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 });
        const done = run(SELL_ODD, [
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
        ], ctx, r.state);
        expect(done.state.phase).toBe('done');
        expect(execSummary(done.state).unhedgedShares).toBe(0);
    });

    it('補單以最新價：價格已變，送出的是重新定價後的限價', () => {
        const ctx = ctxOf(() => ({ ok: true, orders: [{ price: 1090, quantity: 1 }] }));
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(places(r.commands).at(-1)).toMatchObject({ leg: 'round', price: 1090, quantity: 1 });
    });

    it('補單超出滑價上限或不足成本：不送，停在未配對待處理，由使用者決定', () => {
        const ctx = ctxOf(() => ({ ok: false, reason: '價格已偏離計畫價超過 2 檔', orders: [{ price: 1100, quantity: 1 }] }));
        const r = run(SELL_ODD, oddFilled, ctx);
        expect(places(r.commands)).toHaveLength(2);
        expect(r.state.phase).toBe('hedgeDecision');
        expect(r.state.pendingHedge).toEqual({ leg: 'round', action: 'Buy', quantity: 1, reason: '價格已偏離計畫價超過 2 檔', orders: [{ price: 1100, quantity: 1 }] });
        // 以最新價補單
        const accept = execReduce(r.state, { type: 'hedgeAccept', orders: [{ price: 1105, quantity: 1 }] }, ctx);
        expect(accept.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1105, quantity: 1 }]);
        expect(accept.state.phase).toBe('roundPending');
        // 或取消：保留未配對、結束
        const decline = execReduce(r.state, { type: 'hedgeDecline' }, ctx);
        expect(decline.commands).toEqual([]);
        expect(decline.state.phase).toBe('failed');
        expect(execSummary(decline.state).unhedgedShares).toBe(1000);
    });

    it('第一腳成交量未確定前絕不送第二腳（部分成交、仍在委託中）', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 600, status: 'working' },
        ]);
        expect(state.phase).toBe('oddPartial');
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
    });

    it('部分成交後取消：刪剩餘零股，已成交的整張配對整股，零頭列未配對', () => {
        const { state, commands } = run(LOTS2, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'odd:2', orderId: 'C' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 500, status: 'working' },
            { type: 'cancel' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([
            { kind: 'cancel', key: 'odd:1', orderId: 'B' },
            { kind: 'cancel', key: 'odd:2', orderId: 'C' },
        ]);
        const r = run(LOTS2, [
            { type: 'report', key: 'odd:1', filled: 500, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled' },
        ], ctxOf(), state);
        // 1,499 股 → floor = 1 張
        expect(r.commands).toEqual([{ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        const fin = run(LOTS2, [
            { type: 'placed', key: 'round:3', orderId: 'R' },
            { type: 'report', key: 'round:3', filled: 1, status: 'filled' },
        ], ctxOf(), r.state);
        expect(fin.state.phase).toBe('failed');
        expect(execSummary(fin.state)).toMatchObject({ oddFilledShares: 1499, roundFilledLots: 1, unhedgedShares: 499 });
    });

    it('零股不足 1 張就取消：不送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 200, status: 'working' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:0', filled: 200, status: 'cancelled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
        expect(state.phase).toBe('failed');
        expect(execSummary(state).unhedgedShares).toBe(200);
    });

    it('零股確定未送出（placeFailed）→ failed、不送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placeFailed', key: 'odd:0', error: '庫存不足' },
            { type: 'placeFailed', key: 'odd:1', error: '庫存不足' },
        ]);
        expect(state.phase).toBe('failed');
        expect(places(commands)).toHaveLength(2);
    });

    it('冪等：重複 start、重複與倒退的回報都不會重送', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:0', orderId: 'A2' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 100, status: 'working' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toHaveLength(1);
        expect(places(commands)).toHaveLength(3);
        expect(state.slots.find(s => s.key === 'odd:0')?.orderId).toBe('A');
        expect(state.slots.find(s => s.key === 'odd:1')?.filled).toBe(620);
    });

    it('成交先於下單回應：先記成交，回應到了再記委託編號，第二腳只送一次', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toHaveLength(1);
        expect(state.slots.map(s => s.orderId)).toEqual(['A', 'B', undefined]);
        expect(state.phase).toBe('roundPending');
    });

    it('送出途中取消：拿到委託編號立刻刪單；取消前已成交則照計畫送整股', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        const r = execReduce(state, { type: 'report', key: 'odd:1', filled: 620, status: 'filled' }, ctxOf());
        expect(r.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
    });

    it('買零→賣整：買零股、依成交送賣整股', () => {
        const plan: ExecPlan = { direction: 'buyOddSellRound', mode: 'sequential', lots: 1, roundPrice: 1080, oddOrders: [{ price: 1060, quantity: 600 }, { price: 1065, quantity: 400 }] };
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 600, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 400, status: 'filled' },
        ]);
        expect(places(commands).map(c => c.kind === 'place' && `${c.leg}:${c.action}`)).toEqual(['odd:Buy', 'odd:Buy', 'round:Sell']);
        expect(state.phase).toBe('roundPending');
    });

    it('整股補單被刪或被拒：不自動重送，回到未配對待處理', () => {
        const r = run(SELL_ODD, [
            ...oddFilled,
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'cancel' },
            { type: 'report', key: 'round:2', filled: 0, status: 'cancelled' },
        ]);
        expect(places(r.commands)).toHaveLength(3);
        expect(r.state.phase).toBe('hedgeDecision');
        expect(r.state.pendingHedge?.reason).toBe('補單未成交（被拒或已刪除）');
        const failed = run(SELL_ODD, [...oddFilled, { type: 'placeFailed', key: 'round:2', error: 'x' }]);
        expect(places(failed.commands)).toHaveLength(3);
        expect(failed.state.phase).toBe('hedgeDecision');
    });
});

describe('結果不明（unknown）', () => {
    it('可能已送出的錯誤不是終態：不決定第二腳、phase=unknown', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
        ]);
        expect(state.phase).toBe('unknown');
        expect(commands.some(c => c.kind === 'place' && c.leg === 'round')).toBe(false);
        expect(execSummary(state).unknownCount).toBe(1);
    });

    it('事後對上委託並成交 → 照實際成交送第二腳，不少算', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
        ]);
        expect(places(commands).filter(c => c.leg === 'round')).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        expect(state.phase).toBe('roundPending');
    });

    it('使用者核對標記未送出 → 依已成交決定；事後又成交（晚到）→ 重新計算並補第二腳', () => {
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:2', orderId: 'C' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'filled' },
            { type: 'placeUnknown', key: 'odd:1', error: 'timeout' },
            { type: 'resolveUnknown', key: 'odd:1' },
        ]);
        // 1,001 股 → 1 張
        expect(places(r.commands).filter(c => c.leg === 'round')).toEqual([{ kind: 'place', key: 'round:3', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        const fin = run(LOTS2, [
            { type: 'placed', key: 'round:3', orderId: 'R' },
            { type: 'report', key: 'round:3', filled: 1, status: 'filled' },
        ], ctxOf(), r.state);
        expect(fin.state.phase).toBe('failed');
        // 被標記未送出的那筆其實有送、事後全數成交 → 補 1 張
        const late = run(LOTS2, [
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:1', filled: 999, status: 'filled' },
        ], ctxOf(), fin.state);
        expect(places(late.commands)).toEqual([{ kind: 'place', key: 'round:4', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        expect(late.state.phase).toBe('roundPartial');
    });

    it('unknown 時取消：對上委託編號後立即刪單', () => {
        const { commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placeUnknown', key: 'odd:0', error: 'timeout' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:0', orderId: 'A' }]);
    });
});

describe('終態後的晚到成交', () => {
    it('零股刪單後才回報成交：已結束的執行重新計算並補送第二腳', () => {
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'cancelled' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(r.state.phase).toBe('failed');
        const late = execReduce(r.state, { type: 'report', key: 'odd:1', filled: 620, status: 'cancelled' }, ctxOf());
        expect(late.commands).toEqual([{ kind: 'place', key: 'round:2', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
    });

    it('已選擇不補後又有晚到成交：新的缺口重新列為未配對待處理', () => {
        const ctx = ctxOf(() => ({ ok: false, reason: '不足成本', orders: [] }));
        const r = run(LOTS2, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 999, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 1, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled' },
            { type: 'hedgeDecline' },
        ], ctx);
        expect(r.state.phase).toBe('failed');
        expect(r.state.waived.round).toBe(1);
        const late = run(LOTS2, [
            { type: 'report', key: 'odd:1', filled: 999, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 2, status: 'cancelled' },
        ], ctx, r.state);
        expect(late.state.phase).toBe('hedgeDecision');
        expect(late.state.pendingHedge?.quantity).toBe(1);
    });
});

describe('sequential：整股先送（firstLeg=round）', () => {
    it('零股賣出股數 = 整股成交股數', () => {
        const plan: ExecPlan = { ...LOTS2, firstLeg: 'round' };
        const ctx = ctxOf((_leg, _a, qty) => ({ ok: true, orders: [{ price: 1095, quantity: 999 }, { price: 1090, quantity: qty - 999 }] }));
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'round:0', orderId: 'R' },
            { type: 'report', key: 'round:0', filled: 1, status: 'working' },
            { type: 'cancel' },
            { type: 'report', key: 'round:0', filled: 1, status: 'cancelled' },
        ], ctx);
        expect(places(commands)).toEqual([
            { kind: 'place', key: 'round:0', leg: 'round', action: 'Buy', price: 1085, quantity: 2 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1095, quantity: 999 },
            { kind: 'place', key: 'odd:2', leg: 'odd', action: 'Sell', price: 1090, quantity: 1 },
        ]);
        expect(state.phase).toBe('oddPending');
    });
});

describe('simultaneous：兩腳同時送', () => {
    const plan: ExecPlan = { ...SELL_ODD, mode: 'simultaneous' };
    it('一次送出全部委託，全部成交 → done', () => {
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
        ]);
        expect(places(commands)).toHaveLength(3);
        expect(state.phase).toBe('done');
    });
    it('取消後一腳沒成交 → 不自動補，列為未配對待處理（附最新價補單建議）', () => {
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'round:2', orderId: 'R' },
            { type: 'report', key: 'round:2', filled: 1, status: 'filled' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        expect(places(commands)).toHaveLength(3);
        expect(state.phase).toBe('hedgeDecision');
        expect(state.pendingHedge).toMatchObject({ leg: 'odd', action: 'Sell', quantity: 620 });
        expect(execSummary(state).unhedgedShares).toBe(380 - 1000);
    });
    it('進行中為 bothPending', () => {
        expect(run(plan, [{ type: 'start' }]).state.phase).toBe('bothPending');
    });
});

describe('其他', () => {
    it('未開始就取消 → cancelled，之後 start 不送單', () => {
        const { state, commands } = run(SELL_ODD, [{ type: 'cancel' }, { type: 'start' }]);
        expect(state.phase).toBe('cancelled');
        expect(commands).toEqual([]);
    });
    it('計畫為空 → failed', () => {
        expect(run({ ...SELL_ODD, lots: 0 }, [{ type: 'start' }]).state.phase).toBe('failed');
    });
    it('takeOddOrders 依計畫價位取前 N 股', () => {
        expect(takeOddOrders([{ price: 10, quantity: 999 }, { price: 9, quantity: 999 }], 1200)).toEqual([
            { price: 10, quantity: 999 },
            { price: 9, quantity: 201 },
        ]);
    });
});
