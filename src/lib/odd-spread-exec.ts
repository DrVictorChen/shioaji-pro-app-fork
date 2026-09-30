// src/lib/odd-spread-exec.ts — 整零價差兩腳送單的狀態機（純函式，可測）。
//
// reduce(state, event, ctx) → { state, commands }：呼叫端依 commands 實際送單／
// 刪單，再把結果（placed／placeUnknown／placeFailed／report）當成 event 餵回來。
// ctx.quoteHedge 以「當下」委託簿替第二腳（補單）重新定價並判斷是否仍在滑價
// 上限與成本內；狀態機本身不讀行情，測試可注入固定結果。
//
// 送單方式：
// - sequential（預設「零股成交後再送整股」）：先送第一腳（預設零股），第一腳
//   每筆都到終態、成交量確定後才決定第二腳數量：
//     · 第一腳零股 → 第二腳整股 = floor(零股成交股數 / 1,000) 張（全數成交＝計畫張數）
//     · 第一腳整股 → 第二腳零股 = 整股成交張數 × 1,000 股
//   第二腳以當下委託簿重新定價；在滑價上限與成本內自動送出，否則停在
//   hedgeDecision（未配對），由使用者選「以最新價補單」或「取消」。
// - simultaneous（兩腳同時送）：一次送出；全部結束後若兩腳成交不對等，
//   同樣停在 hedgeDecision 由使用者決定是否補單。
//
// 結果不明：送單錯誤可能已到券商（非 mutationNotStarted）時該筆為 unknown —
// 不算終態、不決定第二腳、也不允許重新執行；委託列出現對應委託（依委託編號
// 或標記比對）就接回追蹤。使用者核對後可標記為未送出。
//
// 終態後的晚到成交（例如 unknown 事後成交、刪單前已成交）照樣更新成交量並
// 重新計算：需要補第二腳時再次自動補單或回到 hedgeDecision，絕不少算。
//
// 冪等：每筆委託有唯一 key，只有 unsent → sending 會產生 place 指令；重複的
// start、重複或倒退的回報都不會多送；第二腳補單只補「目標 − 已承諾」的差額。
// 券商拒絕或刪除的第二腳不會自動重送（改由使用者決定），避免無限重送。

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
    | 'unknown'
    | 'hedgeDecision'
    | 'done'
    | 'failed'
    | 'cancelled';

export type SlotStatus = 'unsent' | 'sending' | 'unknown' | 'working' | 'filled' | 'cancelled' | 'failed';

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
    /** 刪單狀態：pending＝已發出等待結果、sent＝券商已受理、failed＝刪單失敗（可再按取消重試） */
    cancelState?: 'pending' | 'sent' | 'failed';
    cancelError?: string;
    /** 送出途中／結果不明時按了取消：拿到委託編號就刪單 */
    cancelWanted?: boolean;
    /** 第二腳補單 */
    hedge?: boolean;
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
    /** 計畫時的加權淨價差 元/股（補單重新定價的成本上限） */
    netPerShare?: number;
}

export interface PendingHedge {
    leg: LegKind;
    action: 'Buy' | 'Sell';
    /** 需補數量（整股張、零股股） */
    quantity: number;
    reason: string;
    /** 以最新委託簿建議的補單 */
    orders: LegOrder[];
}

export interface ExecState {
    plan: ExecPlan;
    phase: ExecPhase;
    slots: OrderSlot[];
    started: boolean;
    cancelRequested: boolean;
    seq: number;
    /** 使用者選擇不補的數量（各腳單位） */
    waived: Record<LegKind, number>;
    pendingHedge: PendingHedge | null;
}

export type HedgeQuote = { ok: true; orders: LegOrder[] } | { ok: false; reason: string; orders: LegOrder[] };

export interface ExecContext {
    /** 以當下委託簿為第二腳定價；ok=false 時不自動送 */
    quoteHedge: (leg: LegKind, action: 'Buy' | 'Sell', quantity: number) => HedgeQuote;
}

export type ExecEvent =
    | { type: 'start' }
    | { type: 'placed'; key: string; orderId: string }
    /** 送出失敗但可能已到券商 */
    | { type: 'placeUnknown'; key: string; error: string }
    /** 確定沒有送出 */
    | { type: 'placeFailed'; key: string; error: string }
    | { type: 'report'; key: string; filled: number; status: 'working' | 'filled' | 'cancelled' | 'failed' }
    | { type: 'cancel' }
    /** 刪單請求的結果 */
    | { type: 'cancelResult'; key: string; ok: boolean; error?: string }
    /** 使用者核對後確認 unknown 那筆沒有送出 */
    | { type: 'resolveUnknown'; key: string }
    | { type: 'hedgeAccept'; orders?: LegOrder[] }
    | { type: 'hedgeDecline' };

export type ExecCommand =
    | { kind: 'place'; key: string; leg: LegKind; action: 'Buy' | 'Sell'; price: number; quantity: number }
    | { kind: 'cancel'; key: string; orderId: string };

export interface ExecResult {
    state: ExecState;
    commands: ExecCommand[];
}

const TERMINAL: ReadonlySet<SlotStatus> = new Set(['filled', 'cancelled', 'failed']);
const LIVE: ReadonlySet<SlotStatus> = new Set(['sending', 'unknown', 'working']);

export function isTerminalPhase(p: ExecPhase): boolean {
    return p === 'done' || p === 'failed' || p === 'cancelled';
}

export function legAction(direction: SpreadDirection, leg: LegKind): 'Buy' | 'Sell' {
    const buyOdd = direction === 'buyOddSellRound';
    return (leg === 'odd') === buyOdd ? 'Buy' : 'Sell';
}

function firstLegOf(plan: ExecPlan): LegKind {
    return plan.firstLeg ?? 'odd';
}

function makeSlots(state: ExecState, leg: LegKind, orders: LegOrder[], hedge = false): { slots: OrderSlot[]; seq: number } {
    let seq = state.seq;
    const slots = orders
        .filter(o => o.quantity > 0 && o.price > 0)
        .map(o => ({
            key: `${leg}:${seq++}`,
            leg,
            action: legAction(state.plan.direction, leg),
            price: o.price,
            quantity: o.quantity,
            status: 'unsent' as const,
            filled: 0,
            ...(hedge ? { hedge: true } : {}),
        }));
    return { slots, seq };
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
    return { plan, phase: 'idle', slots: [], started: false, cancelRequested: false, seq: 0, waived: { odd: 0, round: 0 }, pendingHedge: null };
}

export interface ExecSummary {
    oddFilledShares: number;
    roundFilledLots: number;
    /** 零股計畫股數 */
    oddPlannedShares: number;
    /** 未配對股數：零股成交股數 − 整股成交股數（>0 表示零股那邊多） */
    unhedgedShares: number;
    /** 仍有結果不明的委託 */
    unknownCount: number;
}

function filledOf(s: ExecState, leg: LegKind): number {
    return s.slots.filter(x => x.leg === leg).reduce((a, x) => a + x.filled, 0);
}

/** 仍可能成交的量：委託中／送出中／不明取全量，其餘取已成交 */
function committedOf(s: ExecState, leg: LegKind): number {
    return s.slots.filter(x => x.leg === leg).reduce((a, x) => a + (LIVE.has(x.status) ? x.quantity : x.filled), 0);
}

function oddPlanned(plan: ExecPlan): number {
    return plan.oddOrders.reduce((a, o) => a + o.quantity, 0);
}

export function execSummary(s: ExecState): ExecSummary {
    const odd = filledOf(s, 'odd');
    const round = filledOf(s, 'round');
    return {
        oddFilledShares: odd,
        roundFilledLots: round,
        oddPlannedShares: oddPlanned(s.plan),
        unhedgedShares: odd - round * SHARES_PER_LOT,
        unknownCount: s.slots.filter(x => x.status === 'unknown').length,
    };
}

function sendUnsent(slots: OrderSlot[], commands: ExecCommand[]): OrderSlot[] {
    return slots.map(s => {
        if (s.status !== 'unsent') return s;
        commands.push({ kind: 'place', key: s.key, leg: s.leg, action: s.action, price: s.price, quantity: s.quantity });
        return { ...s, status: 'sending' };
    });
}

function cancelWorking(slots: OrderSlot[], commands: ExecCommand[]): OrderSlot[] {
    return slots.map(s => {
        if (s.status === 'unsent') return { ...s, status: 'cancelled' };
        if (s.status === 'sending' || s.status === 'unknown' || (s.status === 'working' && !s.orderId)) return { ...s, cancelWanted: true };
        // 已發出、尚未有結果的不重送；失敗或已受理但仍在委託中的可再刪
        if (s.status === 'working' && s.orderId && s.cancelState !== 'pending') {
            commands.push({ kind: 'cancel', key: s.key, orderId: s.orderId });
            return { ...s, cancelState: 'pending', cancelError: undefined };
        }
        return s;
    });
}

/** 第二腳（或同時送的落後腳）的目標總量；第一腳尚未確定時回 null */
function hedgeTarget(s: ExecState): { leg: LegKind; qty: number } | null {
    const { plan } = s;
    if (!s.started) return null;
    if (plan.mode === 'sequential') {
        const first = firstLegOf(plan);
        const firstSlots = s.slots.filter(x => x.leg === first);
        if (firstSlots.length === 0 || firstSlots.some(x => !TERMINAL.has(x.status))) return null;
        const f = filledOf(s, first);
        const allFilled = firstSlots.every(x => x.status === 'filled' && x.filled >= x.quantity);
        return first === 'odd'
            ? { leg: 'round', qty: allFilled ? plan.lots : Math.min(plan.lots, Math.floor(f / SHARES_PER_LOT)) }
            : { leg: 'odd', qty: allFilled ? oddPlanned(plan) : Math.min(oddPlanned(plan), f * SHARES_PER_LOT) };
    }
    if (s.slots.some(x => !TERMINAL.has(x.status))) return null;
    const odd = filledOf(s, 'odd');
    const roundSh = filledOf(s, 'round') * SHARES_PER_LOT;
    if (odd > roundSh) return { leg: 'round', qty: Math.min(plan.lots, Math.floor(odd / SHARES_PER_LOT)) };
    if (roundSh > odd) return { leg: 'odd', qty: Math.min(oddPlanned(plan), roundSh) };
    return null;
}

/** 建議委託的總量對齊需補數量（不足的部分加到最後一筆） */
function fitOrders(orders: LegOrder[], quantity: number): LegOrder[] {
    const out = takeOddOrders(orders, quantity);
    const got = out.reduce((a, o) => a + o.quantity, 0);
    const last = out[out.length - 1];
    if (got < quantity && last) out[out.length - 1] = { ...last, quantity: last.quantity + quantity - got };
    return out;
}

// 依目前 slots 推進：決定／補第二腳、計算 phase
function advance(state: ExecState, commands: ExecCommand[], ctx: ExecContext): ExecState {
    let s = state;
    const target = hedgeTarget(s);
    const gap = target ? target.qty - committedOf(s, target.leg) - s.waived[target.leg] : 0;
    if (target && gap > 0) {
        const leg = target.leg;
        const action = legAction(s.plan.direction, leg);
        const q = ctx.quoteHedge(leg, action, gap);
        // 券商拒絕／刪除過的補單不自動重送
        const rejectedBefore = s.slots.some(x => x.hedge && x.leg === leg && (x.status === 'failed' || x.status === 'cancelled') && x.filled < x.quantity);
        const auto = s.plan.mode === 'sequential' && !rejectedBefore && !s.pendingHedge;
        if (auto && q.ok) {
            const made = makeSlots(s, leg, fitOrders(q.orders, gap), true);
            s = { ...s, seq: made.seq, pendingHedge: null, slots: sendUnsent([...s.slots, ...made.slots], commands) };
        } else {
            const reason = !q.ok ? q.reason
                : s.plan.mode === 'simultaneous' ? '兩腳成交數量不對等'
                    : rejectedBefore ? '補單未成交（被拒或已刪除）' : s.pendingHedge?.reason ?? '第二腳待確認';
            s = { ...s, pendingHedge: { leg, action, quantity: gap, reason, orders: fitOrders(q.orders, gap) } };
        }
    } else if (s.pendingHedge) {
        s = { ...s, pendingHedge: null };
    }
    return { ...s, phase: phaseOf(s) };
}

function phaseOf(s: ExecState): ExecPhase {
    if (!s.started) return s.cancelRequested ? 'cancelled' : 'idle';
    if (s.slots.some(x => x.status === 'unknown')) return 'unknown';
    if (s.pendingHedge) return 'hedgeDecision';
    const live = s.slots.filter(x => LIVE.has(x.status));
    if (live.length > 0) {
        if (s.plan.mode === 'simultaneous') return 'bothPending';
        const leg = live[0]!.leg;
        const filled = s.slots.filter(x => x.leg === leg).some(x => x.filled > 0);
        if (leg === 'odd') return filled ? 'oddPartial' : 'oddPending';
        return filled ? 'roundPartial' : 'roundPending';
    }
    const sum = execSummary(s);
    if (sum.roundFilledLots === s.plan.lots && sum.oddFilledShares === sum.oddPlannedShares) return 'done';
    if (sum.unhedgedShares !== 0) return 'failed';
    return s.cancelRequested ? 'cancelled' : 'failed';
}

function mapSlot(state: ExecState, key: string, fn: (s: OrderSlot) => OrderSlot | null): ExecState | null {
    let changed = false;
    const slots = state.slots.map(s => {
        if (s.key !== key) return s;
        const next = fn(s);
        if (!next || next === s) return s;
        changed = true;
        return next;
    });
    return changed ? { ...state, slots } : null;
}

export function execReduce(state: ExecState, event: ExecEvent, ctx: ExecContext): ExecResult {
    const commands: ExecCommand[] = [];
    const done = (next: ExecState | null): ExecResult => (next ? { state: advance(next, commands, ctx), commands } : { state, commands });
    switch (event.type) {
        case 'start': {
            if (state.started || state.cancelRequested) return { state, commands };
            const { plan } = state;
            if (plan.lots <= 0 || plan.oddOrders.every(o => o.quantity <= 0)) {
                return { state: { ...state, started: true, phase: 'failed' }, commands };
            }
            let s: ExecState = { ...state, started: true };
            const add = (leg: LegKind, orders: LegOrder[]) => {
                const made = makeSlots(s, leg, orders);
                s = { ...s, seq: made.seq, slots: [...s.slots, ...made.slots] };
            };
            const round = [{ price: plan.roundPrice, quantity: plan.lots }];
            if (plan.mode === 'simultaneous') {
                add('odd', plan.oddOrders);
                add('round', round);
            } else if (firstLegOf(plan) === 'odd') add('odd', plan.oddOrders);
            else add('round', round);
            s = { ...s, slots: sendUnsent(s.slots, commands) };
            return { state: { ...s, phase: phaseOf(s) }, commands };
        }
        case 'placed':
            return done(mapSlot(state, event.key, s => {
                // 回報可能比下單回應先到，或 unknown 事後才對上：仍要記下委託編號
                if (s.orderId || s.status === 'unsent') return null;
                const status: SlotStatus = s.status === 'sending' || s.status === 'unknown' ? 'working' : s.status;
                const next: OrderSlot = { ...s, status, orderId: event.orderId };
                if (s.cancelWanted && status === 'working') {
                    commands.push({ kind: 'cancel', key: s.key, orderId: event.orderId });
                    next.cancelState = 'pending';
                }
                return next;
            }));
        case 'placeUnknown':
            return done(mapSlot(state, event.key, s => (s.status === 'sending' ? { ...s, status: 'unknown', error: event.error } : null)));
        case 'placeFailed':
            return done(mapSlot(state, event.key, s => (s.status === 'sending' ? { ...s, status: 'failed', error: event.error } : null)));
        case 'cancelResult':
            return done(mapSlot(state, event.key, s => (s.cancelState === 'pending'
                ? { ...s, cancelState: event.ok ? 'sent' : 'failed', cancelError: event.ok ? undefined : event.error }
                : null)));
        case 'resolveUnknown':
            return done(mapSlot(state, event.key, s => (s.status === 'unknown' ? { ...s, status: 'failed' } : null)));
        case 'report':
            return done(mapSlot(state, event.key, s => {
                const filled = Math.min(s.quantity, Math.max(s.filled, Math.trunc(event.filled) || 0));
                let status: SlotStatus = s.status;
                if (filled >= s.quantity) status = 'filled';
                else if (!TERMINAL.has(s.status)) {
                    if (event.status === 'cancelled' || event.status === 'failed') status = event.status;
                    else if (s.status === 'sending' || s.status === 'unknown') status = 'working';
                }
                if (filled === s.filled && status === s.status) return null;
                return { ...s, filled, status };
            }));
        case 'cancel': {
            if (!state.started) return { state: { ...state, phase: 'cancelled', cancelRequested: true }, commands };
            const slots = cancelWorking(state.slots, commands);
            return { state: advance({ ...state, cancelRequested: true, slots }, commands, ctx), commands };
        }
        case 'hedgeAccept': {
            const p = state.pendingHedge;
            if (!p) return { state, commands };
            const orders = fitOrders(event.orders ?? p.orders, p.quantity);
            if (orders.length === 0) return { state, commands };
            const made = makeSlots(state, p.leg, orders, true);
            const s: ExecState = { ...state, pendingHedge: null, seq: made.seq, slots: sendUnsent([...state.slots, ...made.slots], commands) };
            return { state: { ...s, phase: phaseOf(s) }, commands };
        }
        case 'hedgeDecline': {
            const p = state.pendingHedge;
            if (!p) return { state, commands };
            const s: ExecState = { ...state, pendingHedge: null, waived: { ...state.waived, [p.leg]: state.waived[p.leg] + p.quantity } };
            return { state: { ...s, phase: phaseOf(s) }, commands };
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
    unknown: '委託結果未確認',
    hedgeDecision: '未配對，待處理',
    done: '完成',
    failed: '未完成',
    cancelled: '已取消',
};
