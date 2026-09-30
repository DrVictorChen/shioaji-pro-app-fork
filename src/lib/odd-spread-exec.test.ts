import { describe, expect, it } from 'vitest';
import {
    execReduce,
    execSummary,
    initExec,
    takeOddOrders,
    type ExecCommand,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
} from './odd-spread-exec';

const SELL_ODD: ExecPlan = {
    direction: 'buyRoundSellOdd',
    mode: 'sequential',
    lots: 1,
    roundPrice: 1085,
    oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }],
};

// 依序套用事件，收集所有指令
function run(plan: ExecPlan, events: ExecEvent[]): { state: ExecState; commands: ExecCommand[] } {
    let state = initExec(plan);
    const commands: ExecCommand[] = [];
    for (const e of events) {
        const r = execReduce(state, e);
        state = r.state;
        commands.push(...r.commands);
    }
    return { state, commands };
}

const places = (cmds: ExecCommand[]) => cmds.filter(c => c.kind === 'place');

describe('sequential：零股成交後再送整股', () => {
    it('start 只送零股那一腳（每檔一筆），整股等零股成交確定', () => {
        const { state, commands } = run(SELL_ODD, [{ type: 'start' }]);
        expect(state.phase).toBe('oddPending');
        expect(commands).toEqual([
            { kind: 'place', key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 380 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 620 },
        ]);
    });

    it('零股全部成交 → 送整股 1 張 → 整股成交 → done', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
        ]);
        expect(state.phase).toBe('oddPartial');
        expect(places(commands)).toHaveLength(2);
        const r = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
        ]);
        expect(r.state.phase).toBe('roundPending');
        expect(places(r.commands).at(-1)).toEqual({ kind: 'place', key: 'round', leg: 'round', action: 'Buy', price: 1085, quantity: 1 });
        const done = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'placed', key: 'round', orderId: 'R' },
            { type: 'report', key: 'round', filled: 1, status: 'filled' },
        ]);
        expect(done.state.phase).toBe('done');
        expect(execSummary(done.state).unhedgedShares).toBe(0);
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
        const plan: ExecPlan = { ...SELL_ODD, lots: 2, oddOrders: [{ price: 1095, quantity: 999 }, { price: 1095, quantity: 999 }, { price: 1095, quantity: 2 }] };
        const { state, commands } = run(plan, [
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
        expect(state.phase).toBe('oddPartial');
        const after = [
            { type: 'report', key: 'odd:1', filled: 500, status: 'cancelled' },
            { type: 'report', key: 'odd:2', filled: 0, status: 'cancelled' },
        ] as ExecEvent[];
        let s = state;
        const more: ExecCommand[] = [];
        for (const e of after) {
            const r = execReduce(s, e);
            s = r.state;
            more.push(...r.commands);
        }
        // 1,499 股 → floor = 1 張
        expect(more).toEqual([{ kind: 'place', key: 'round', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        expect(s.phase).toBe('roundPending');
        const fin = execReduce(execReduce(s, { type: 'placed', key: 'round', orderId: 'R' }).state, { type: 'report', key: 'round', filled: 1, status: 'filled' });
        expect(fin.state.phase).toBe('cancelled');
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
        expect(state.phase).toBe('cancelled');
        expect(execSummary(state).unhedgedShares).toBe(200);
    });

    it('零股全部被拒 → failed、不送整股', () => {
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

    it('回報先於下單回應：仍記下委託編號，取消可刪單', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 100, status: 'working' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:0', orderId: 'A' }]);
        expect(state.slots[0]?.orderId).toBe('A');
    });

    it('送出途中取消：拿到委託編號立刻刪單；之後送出的第二腳不受影響', () => {
        const { state, commands } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        const r = execReduce(state, { type: 'report', key: 'odd:1', filled: 620, status: 'filled' });
        // 取消送達前已全數成交 → 照計畫送整股
        expect(r.commands).toEqual([{ kind: 'place', key: 'round', leg: 'round', action: 'Buy', price: 1085, quantity: 1 }]);
        const placed = execReduce(r.state, { type: 'placed', key: 'round', orderId: 'R' });
        expect(placed.commands).toEqual([]);
    });

    it('買零→賣整：買零股、依成交送賣整股', () => {
        const plan: ExecPlan = { direction: 'buyOddSellRound', mode: 'sequential', lots: 1, roundPrice: 1080, oddOrders: [{ price: 1060, quantity: 600 }, { price: 1065, quantity: 400 }] };
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 600, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 400, status: 'filled' },
        ]);
        expect(places(commands).map(c => c.kind === 'place' && `${c.leg}:${c.action}`)).toEqual(['odd:Buy', 'odd:Buy', 'round:Sell']);
        expect(state.phase).toBe('roundPending');
    });

    it('整股部分成交後取消 → cancelled，列出未配對', () => {
        const { state } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'placed', key: 'round', orderId: 'R' },
            { type: 'cancel' },
            { type: 'report', key: 'round', filled: 0, status: 'cancelled' },
        ]);
        expect(state.phase).toBe('cancelled');
        expect(execSummary(state).unhedgedShares).toBe(1000);
    });

    it('整股被拒 → failed', () => {
        const { state } = run(SELL_ODD, [
            { type: 'start' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'report', key: 'odd:1', filled: 620, status: 'filled' },
            { type: 'placeFailed', key: 'round', error: 'x' },
        ]);
        expect(state.phase).toBe('failed');
    });
});

describe('sequential：整股先送（firstLeg=round）', () => {
    it('零股賣出股數 = 整股成交股數', () => {
        const plan: ExecPlan = { ...SELL_ODD, firstLeg: 'round', lots: 2, oddOrders: [{ price: 1095, quantity: 999 }, { price: 1090, quantity: 999 }, { price: 1090, quantity: 2 }] };
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'round', orderId: 'R' },
            { type: 'report', key: 'round', filled: 1, status: 'working' },
            { type: 'cancel' },
            { type: 'report', key: 'round', filled: 1, status: 'cancelled' },
        ]);
        expect(places(commands)).toEqual([
            { kind: 'place', key: 'round', leg: 'round', action: 'Buy', price: 1085, quantity: 2 },
            { kind: 'place', key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 999 },
            { kind: 'place', key: 'odd:1', leg: 'odd', action: 'Sell', price: 1090, quantity: 1 },
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
            { type: 'report', key: 'round', filled: 1, status: 'filled' },
        ]);
        expect(places(commands)).toHaveLength(3);
        expect(state.phase).toBe('done');
    });
    it('取消 → 刪所有未成交委託，列出未配對', () => {
        const { state, commands } = run(plan, [
            { type: 'start' },
            { type: 'placed', key: 'odd:0', orderId: 'A' },
            { type: 'placed', key: 'odd:1', orderId: 'B' },
            { type: 'placed', key: 'round', orderId: 'R' },
            { type: 'report', key: 'round', filled: 1, status: 'filled' },
            { type: 'report', key: 'odd:0', filled: 380, status: 'filled' },
            { type: 'cancel' },
            { type: 'report', key: 'odd:1', filled: 0, status: 'cancelled' },
        ]);
        expect(commands.filter(c => c.kind === 'cancel')).toEqual([{ kind: 'cancel', key: 'odd:1', orderId: 'B' }]);
        expect(state.phase).toBe('cancelled');
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
