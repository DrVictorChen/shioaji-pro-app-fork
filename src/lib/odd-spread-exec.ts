// src/lib/odd-spread-exec.ts — 整零價差兩腳送單的狀態機（純函式，可測）。
//
// reduce(state, event) → { state, commands }：呼叫端依 commands 實際送單／
// 刪單，再把結果（placed／placeFailed／report）當成 event 餵回來。
//
// 送單方式：
// - sequential（預設「零股成交後再送整股」）：先送第一腳（預設零股，
//   流動性差的那一腳），第一腳每筆委託都到終態（全部成交、刪單、失敗）、
//   成交量確定之後，才依成交量送第二腳：
//     · 第一腳零股 → 第二腳整股 = floor(零股成交股數 / 1,000) 張（不超過計畫張數）
//     · 第一腳整股 → 第二腳零股 = 整股成交張數 × 1,000 股（依計畫價位切筆）
//   第一腳部分成交時停在 *Partial，使用者可「取消」：刪掉剩餘委託，
//   已成交的整張部分照樣送第二腳配對，不足 1 張的零頭列為未配對。
// - simultaneous（兩腳同時送）：一次送出全部委託，結束時列出未配對股數。
//
// 冪等：每筆委託有固定 key，只有 unsent → sending 會產生 place 指令；
// 第二腳只在 secondSent=false 時送一次；重複的 start、重複或倒退的回報
// 都不會多送。成交量以「累計量」回報（取最大值），重複事件無副作用。

import { SHARES_PER_LOT } from './odd-lot';
import type { LegOrder, SpreadDirection } from './odd-spread';

export type ExecMode = 'sequential' | 'simultaneous';
export type LegKind = 'odd' | 'round';

export type ExecPhase =
    | 'idle'
    | 'oddPending'
    | 'oddPartial'
    | 'roundPending'
    | 'roundPartial'
    | 'bothPending'
    | 'done'
    | 'failed'
    | 'cancelled';

export type SlotStatus = 'unsent' | 'sending' | 'working' | 'filled' | 'cancelled' | 'failed';

export interface OrderSlot {
    key: string;
    leg: LegKind;
    action: 'Buy' | 'Sell';
    price: number;
    /** 整股為張、零股為股 */
    quantity: number;
    status: SlotStatus;
    orderId?: string;
    /** 累計成交（同 quantity 單位） */
    filled: number;
    cancelSent?: boolean;
    /** 送出途中按了取消：拿到委託編號就刪單 */
    cancelWanted?: boolean;
    error?: string;
}

export interface ExecPlan {
    direction: SpreadDirection;
    mode: ExecMode;
    /** sequential 的第一腳，預設零股 */
    firstLeg?: LegKind;
    /** 整股計畫張數 */
    lots: number;
    /** 整股限價 */
    roundPrice: number;
    /** 零股計畫委託（每筆 ≤ 999 股） */
    oddOrders: LegOrder[];
}

export interface ExecState {
    plan: ExecPlan;
    phase: ExecPhase;
    slots: OrderSlot[];
    started: boolean;
    secondSent: boolean;
    cancelRequested: boolean;
}

export type ExecEvent =
    | { type: 'start' }
    | { type: 'placed'; key: string; orderId: string }
    | { type: 'placeFailed'; key: string; error: string }
    | { type: 'report'; key: string; filled: number; status: 'working' | 'filled' | 'cancelled' | 'failed' }
    | { type: 'cancel' };

export type ExecCommand =
    | { kind: 'place'; key: string; leg: LegKind; action: 'Buy' | 'Sell'; price: number; quantity: number }
    | { kind: 'cancel'; key: string; orderId: string };

export interface ExecResult {
    state: ExecState;
    commands: ExecCommand[];
}

const TERMINAL: ReadonlySet<SlotStatus> = new Set(['filled', 'cancelled', 'failed']);

export function isTerminalPhase(p: ExecPhase): boolean {
    return p === 'done' || p === 'failed' || p === 'cancelled';
}

function legAction(direction: SpreadDirection, leg: LegKind): 'Buy' | 'Sell' {
    const buyOdd = direction === 'buyOddSellRound';
    return (leg === 'odd') === buyOdd ? 'Buy' : 'Sell';
}

function firstLegOf(plan: ExecPlan): LegKind {
    return plan.firstLeg ?? 'odd';
}

function oddSlots(plan: ExecPlan, orders: LegOrder[]): OrderSlot[] {
    return orders
        .filter(o => o.quantity > 0)
        .map((o, i) => ({
            key: `odd:${i}`,
            leg: 'odd' as const,
            action: legAction(plan.direction, 'odd'),
            price: o.price,
            quantity: o.quantity,
            status: 'unsent' as const,
            filled: 0,
        }));
}

function roundSlot(plan: ExecPlan, lots: number): OrderSlot[] {
    return lots > 0
        ? [{ key: 'round', leg: 'round', action: legAction(plan.direction, 'round'), price: plan.roundPrice, quantity: lots, status: 'unsent', filled: 0 }]
        : [];
}

/** 計畫的零股委託取前 shares 股（第一腳整股時，第二腳依成交張數切零股） */
export function takeOddOrders(orders: LegOrder[], shares: number): LegOrder[] {
    const out: LegOrder[] = [];
    let left = shares;
    for (const o of orders) {
        if (left <= 0) break;
        const q = Math.min(o.quantity, left);
        out.push({ price: o.price, quantity: q });
        left -= q;
    }
    return out;
}

export function initExec(plan: ExecPlan): ExecState {
    return { plan, phase: 'idle', slots: [], started: false, secondSent: false, cancelRequested: false };
}

export interface ExecSummary {
    oddFilledShares: number;
    roundFilledLots: number;
    /** 零股計畫股數 */
    oddPlannedShares: number;
    /** 未配對股數：零股成交股數 − 整股成交股數（>0 表示零股那邊多） */
    unhedgedShares: number;
}

export function execSummary(s: ExecState): ExecSummary {
    let odd = 0;
    let round = 0;
    for (const slot of s.slots) {
        if (slot.leg === 'odd') odd += slot.filled;
        else round += slot.filled;
    }
    const oddPlannedShares = s.plan.oddOrders.reduce((a, o) => a + o.quantity, 0);
    return { oddFilledShares: odd, roundFilledLots: round, oddPlannedShares, unhedgedShares: odd - round * SHARES_PER_LOT };
}

function sendUnsent(slots: OrderSlot[], commands: ExecCommand[]): OrderSlot[] {
    return slots.map(s => {
        if (s.status !== 'unsent') return s;
        commands.push({ kind: 'place', key: s.key, leg: s.leg, action: s.action, price: s.price, quantity: s.quantity });
        return { ...s, status: 'sending' };
    });
}

function cancelWorking(slots: OrderSlot[], commands: ExecCommand[], leg?: LegKind): OrderSlot[] {
    return slots.map(s => {
        if (leg && s.leg !== leg) return s;
        if (s.status === 'unsent') return { ...s, status: 'cancelled' };
        if (s.status === 'sending' || (s.status === 'working' && !s.orderId)) return { ...s, cancelWanted: true };
        if (s.status === 'working' && s.orderId && !s.cancelSent) {
            commands.push({ kind: 'cancel', key: s.key, orderId: s.orderId });
            return { ...s, cancelSent: true };
        }
        return s;
    });
}

// 依目前 slots 推進：第一腳全部終態 → 送第二腳；全部終態 → 結束
function advance(state: ExecState, commands: ExecCommand[]): ExecState {
    const { plan } = state;
    let s = state;
    if (plan.mode === 'sequential' && !s.secondSent) {
        const first = firstLegOf(plan);
        const firstSlots = s.slots.filter(x => x.leg === first);
        if (firstSlots.every(x => TERMINAL.has(x.status))) {
            const filled = firstSlots.reduce((a, x) => a + x.filled, 0);
            const full = firstSlots.every(x => x.status === 'filled');
            const oddPlanned = plan.oddOrders.reduce((a, o) => a + o.quantity, 0);
            // 第一腳全部成交 → 第二腳照計畫；部分成交 → 只配對已成交的整張
            const second: OrderSlot[] = first === 'odd'
                ? roundSlot(plan, full ? plan.lots : Math.min(plan.lots, Math.floor(filled / SHARES_PER_LOT)))
                : oddSlots(plan, full ? plan.oddOrders : takeOddOrders(plan.oddOrders, Math.min(oddPlanned, filled * SHARES_PER_LOT)));
            s = { ...s, secondSent: true, slots: sendUnsent([...s.slots, ...second], commands) };
        }
    }
    const allTerminal = s.slots.length > 0 && s.slots.every(x => TERMINAL.has(x.status));
    if (allTerminal && (plan.mode === 'simultaneous' || s.secondSent)) {
        const sum = execSummary(s);
        const complete = sum.roundFilledLots === plan.lots
            && sum.oddFilledShares === sum.oddPlannedShares
            && s.slots.every(x => x.status === 'filled');
        const anyFill = sum.oddFilledShares > 0 || sum.roundFilledLots > 0;
        const phase: ExecPhase = complete ? 'done' : s.cancelRequested ? 'cancelled' : anyFill || s.slots.some(x => x.status === 'failed') ? 'failed' : 'cancelled';
        return { ...s, phase };
    }
    return { ...s, phase: livePhase(s) };
}

function livePhase(s: ExecState): ExecPhase {
    if (s.plan.mode === 'simultaneous') return 'bothPending';
    const first = firstLegOf(s.plan);
    const leg: LegKind = s.secondSent ? (first === 'odd' ? 'round' : 'odd') : first;
    const filled = s.slots.filter(x => x.leg === leg).some(x => x.filled > 0);
    if (leg === 'odd') return filled ? 'oddPartial' : 'oddPending';
    return filled ? 'roundPartial' : 'roundPending';
}

export function execReduce(state: ExecState, event: ExecEvent): ExecResult {
    const commands: ExecCommand[] = [];
    if (isTerminalPhase(state.phase) && event.type !== 'report') return { state, commands };
    switch (event.type) {
        case 'start': {
            if (state.started) return { state, commands };
            const { plan } = state;
            if (plan.lots <= 0 || plan.oddOrders.every(o => o.quantity <= 0)) {
                return { state: { ...state, started: true, phase: 'failed' }, commands };
            }
            let slots: OrderSlot[];
            if (plan.mode === 'simultaneous') {
                slots = [...oddSlots(plan, plan.oddOrders), ...roundSlot(plan, plan.lots)];
            } else {
                slots = firstLegOf(plan) === 'odd' ? oddSlots(plan, plan.oddOrders) : roundSlot(plan, plan.lots);
            }
            const next: ExecState = { ...state, started: true, slots: sendUnsent(slots, commands) };
            return { state: { ...next, phase: livePhase(next) }, commands };
        }
        case 'placed': {
            let changed = false;
            const slots = state.slots.map(s => {
                // 回報可能比下單回應先到（slot 已是 working／終態），仍要記下委託編號
                if (s.key !== event.key || s.orderId || s.status === 'unsent') return s;
                changed = true;
                const next: OrderSlot = { ...s, status: s.status === 'sending' ? 'working' : s.status, orderId: event.orderId };
                // 送出途中按了取消：拿到委託編號就立刻刪單
                if (s.cancelWanted && next.status === 'working') {
                    commands.push({ kind: 'cancel', key: s.key, orderId: event.orderId });
                    next.cancelSent = true;
                }
                return next;
            });
            if (!changed) return { state, commands };
            return { state: advance({ ...state, slots }, commands), commands };
        }
        case 'placeFailed': {
            let changed = false;
            const slots = state.slots.map(s => {
                if (s.key !== event.key || s.status !== 'sending') return s;
                changed = true;
                return { ...s, status: 'failed' as const, error: event.error };
            });
            if (!changed) return { state, commands };
            return { state: advance({ ...state, slots }, commands), commands };
        }
        case 'report': {
            let changed = false;
            const slots = state.slots.map(s => {
                if (s.key !== event.key) return s;
                const filled = Math.min(s.quantity, Math.max(s.filled, Math.trunc(event.filled) || 0));
                let status: SlotStatus = s.status;
                if (!TERMINAL.has(s.status)) {
                    if (filled >= s.quantity) status = 'filled';
                    else if (event.status === 'cancelled' || event.status === 'failed') status = event.status;
                    else if (s.status === 'sending' || s.status === 'working') status = 'working';
                }
                if (filled === s.filled && status === s.status) return s;
                changed = true;
                return { ...s, filled, status };
            });
            if (!changed) return { state, commands };
            // 終態後的遲到成交只更新數字（第二腳不重送）
            if (isTerminalPhase(state.phase)) return { state: { ...state, slots }, commands };
            return { state: advance({ ...state, slots }, commands), commands };
        }
        case 'cancel': {
            if (!state.started) return { state: { ...state, phase: 'cancelled', cancelRequested: true }, commands };
            const slots = cancelWorking(state.slots, commands);
            return { state: advance({ ...state, cancelRequested: true, slots }, commands), commands };
        }
    }
}

export const PHASE_LABEL: Record<ExecPhase, string> = {
    idle: '待送出',
    oddPending: '零股委託中',
    oddPartial: '零股部分成交',
    roundPending: '整股委託中',
    roundPartial: '整股部分成交',
    bothPending: '兩腳委託中',
    done: '完成',
    failed: '未完成',
    cancelled: '已取消',
};
