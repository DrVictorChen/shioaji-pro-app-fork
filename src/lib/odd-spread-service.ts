// src/lib/odd-spread-service.ts — 整零價差兩腳送單的主視窗服務。
//
// 執行狀態不放在面板元件裡：面板移除、切換商品都不會中斷追蹤（同觸價單
// 引擎，只在主視窗執行）。每筆執行保存在本機（重新整理後接回），並：
// - 依 odd-spread-exec 狀態機的指令送單／刪單（source:'auto'，整筆價差已在
//   開始前確認；零股帶 IntradayOdd；委託帶 custom_field 標記）。
// - 訂閱委託列（trading-state），以委託編號或標記＋商品／方向／價格／數量
//   對回每一筆：成交先於下單回應、下單結果不明（unknown）事後出現，都能接回。
// - 第二腳以當下整股／零股委託簿重新定價（repriceHedge）。
//
// 彈出視窗沒有這個服務：關掉視窗就無法追蹤第二腳，所以彈出視窗停用兩腳送單
// （面板顯示原因）；點價單筆下單不受影響。

import { useSyncExternalStore } from 'react';
import { displayBook } from './display-book';
import { accountMatches } from './flash-account';
import { claimExecutor, isExecutor, isMainWindow } from './main-window-commands';
import { SHARES_PER_LOT, isOddLot } from './odd-lot';
import { repriceHedge, type FeeSettings, type SideBook } from './odd-spread';
import {
    execReduce,
    execSummary,
    initExec,
    isTerminalPhase,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type LegKind,
} from './odd-spread-exec';
import { retainContractQuotes } from './quote-ownership';
import { cancelOrders } from './shioaji';
import { getQuote } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState, subscribeTradingState } from './trading-state';
import type { ContractInfo } from './types/contract';
import type { AccountedTrade, Trade } from './types/order';
import type { Account } from './types/portfolio';
import { stepPrice } from './utils/ticksize';

export const ODD_SPREAD_TAG = 'sjodsp';
const STORE_KEY = 'sj-pro-odd-spread-exec-v1';
const MAX_KEPT = 20;

export interface SpreadExecRecord {
    id: string;
    contract: ContractInfo;
    account: Account;
    fees: FeeSettings;
    maxSlipTicks: number;
    startedAt: number;
    state: ExecState;
}

let records: SpreadExecRecord[] = [];
const listeners = new Set<() => void>();
const releases = new Map<string, () => void>();
let started = false;
let seq = 0;

function emit() {
    for (const l of listeners) l();
}

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(records.slice(-MAX_KEPT)));
    } catch {
        // 本機儲存不可用：只在本次有效
    }
}

export function tradeReport(t: Trade): { filled: number; status: 'working' | 'filled' | 'cancelled' | 'failed' } {
    const deals = (t.status.deals ?? []).reduce((a, d) => a + (d.quantity || 0), 0);
    const filled = Math.max(t.status.deal_quantity || 0, deals);
    const st = t.status.status;
    const status = st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working';
    return { filled, status };
}

/** 兩腳送單在此視窗不可用的原因；可用時回 null */
export function oddSpreadExecUnavailable(): string | null {
    if (!isMainWindow()) return '兩腳價差單只能在主視窗執行（彈出視窗關閉後無法繼續追蹤第二腳）';
    if (!isExecutor()) return '另一個主視窗正在執行交易服務，請在該視窗送出價差單';
    return null;
}

function bookOf(rec: SpreadExecRecord, odd: boolean): SideBook {
    const q = getQuote(rec.contract.code, odd);
    const b = displayBook(rec.contract.code, undefined, q?.bidask, rec.contract.target_code);
    return { bids: b?.bids ?? [], asks: b?.asks ?? [] };
}

function contextFor(rec: SpreadExecRecord): ExecContext {
    return {
        quoteHedge: (leg: LegKind, action, quantity) => {
            const plan = rec.state.plan;
            const odd = leg === 'odd';
            // 計畫中最差的那一檔（買取最高、賣取最低）
            const oddPrices = plan.oddOrders.map(o => o.price);
            const plannedPrice = !odd ? plan.roundPrice
                : oddPrices.length === 0 ? 0
                    : action === 'Buy' ? Math.max(...oddPrices) : Math.min(...oddPrices);
            return repriceHedge({
                book: bookOf(rec, odd),
                odd,
                action,
                quantity,
                plannedPrice,
                netPerShare: plan.netPerShare ?? 0,
                maxSlipTicks: rec.maxSlipTicks,
                step: (p, dir) => stepPrice(rec.contract, p, dir),
                fees: rec.fees,
            });
        },
    };
}

function update(id: string, event: ExecEvent) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    const before = rec.state;
    const { state, commands } = execReduce(before, event, contextFor(rec));
    if (state === before && commands.length === 0) return;
    const next = { ...rec, state };
    records = records.map(r => (r.id === id ? next : r));
    persist();
    emit();
    announce(next, before);
    for (const c of commands) run(next, c);
    if (isTerminalPhase(state.phase)) releaseQuotes(id);
    else retainQuotes(next);
}

function announce(rec: SpreadExecRecord, before: ExecState) {
    const { phase } = rec.state;
    if (phase === before.phase) return;
    const code = rec.contract.code;
    const sum = execSummary(rec.state);
    if (phase === 'unknown') {
        notify({ kind: 'err', title: '整零價差：委託結果未確認', body: `${code}：有委託可能已送出但未收到回應，已暫停第二腳，請核對委託；勿直接重送` });
    } else if (phase === 'hedgeDecision') {
        notify({ kind: 'err', title: '整零價差：未配對待處理', body: `${code}：${rec.state.pendingHedge?.reason ?? ''}；請在面板選擇補單或取消` });
    } else if (isTerminalPhase(phase)) {
        notify({
            kind: phase === 'done' ? 'ok' : 'err',
            title: phase === 'done' ? '整零價差完成' : phase === 'cancelled' ? '整零價差已取消' : '整零價差未完成',
            body: `${code}：零股 ${sum.oddFilledShares} 股、整股 ${sum.roundFilledLots} 張${sum.unhedgedShares ? `，未配對 ${Math.abs(sum.unhedgedShares)} 股` : ''}`,
        });
    }
}

function run(rec: SpreadExecRecord, c: ReturnType<typeof execReduce>['commands'][number]) {
    if (c.kind === 'cancel') {
        void cancelOrders([c.orderId]).catch(() => undefined);
        return;
    }
    void placeQuickOrder(rec.contract, c.action, c.price, c.quantity, {
        account: rec.account,
        source: 'auto',
        customField: ODD_SPREAD_TAG,
        ...(c.leg === 'odd' ? { orderLot: 'IntradayOdd' as const } : {}),
    }).then(
        (trade) => {
            update(rec.id, { type: 'placed', key: c.key, orderId: trade.order.id });
            update(rec.id, { type: 'report', key: c.key, ...tradeReport(trade) });
            reconcile();
        },
        (error: unknown) => {
            const notStarted = !!(error && typeof error === 'object' && 'mutationNotStarted' in error);
            const msg = error instanceof Error ? error.message : String(error);
            if (notStarted) {
                notify({ kind: 'err', title: `整零價差：${c.leg === 'odd' ? '零股' : '整股'}委託未送出`, body: msg });
                update(rec.id, { type: 'placeFailed', key: c.key, error: msg });
            } else {
                update(rec.id, { type: 'placeUnknown', key: c.key, error: msg });
                reconcile();
            }
        },
    );
}

function tradeAccount(t: AccountedTrade) {
    return t.account ?? t.order.account;
}

/** 委託列 → 各筆執行的成交回報（含尚無委託編號的 sending／unknown） */
export function reconcile(trades: AccountedTrade[] = getTradingState().trades) {
    const claimed = new Set<string>();
    for (const r of records) for (const s of r.state.slots) if (s.orderId) claimed.add(s.orderId);
    for (const rec of records) {
        if (!rec.state.started) continue;
        for (const slot of rec.state.slots) {
            if (slot.status === 'unsent') continue;
            let t = slot.orderId ? trades.find(x => x.order.id === slot.orderId) : undefined;
            if (!t && !slot.orderId && (slot.status === 'sending' || slot.status === 'unknown' || slot.status === 'failed')) {
                t = trades.find(x =>
                    !claimed.has(x.order.id)
                    && (x.order.custom_field === ODD_SPREAD_TAG || !x.order.custom_field)
                    && accountMatches(tradeAccount(x), rec.account)
                    && x.contract.code === rec.contract.code
                    && x.order.action === slot.action
                    && Math.round(x.order.price * 100) === Math.round(slot.price * 100)
                    && x.order.quantity === slot.quantity
                    && isOddLot(x.order.order_lot) === (slot.leg === 'odd')
                    && (x.status.order_ts === undefined || x.status.order_ts * 1000 >= rec.startedAt - 60_000));
                if (t) {
                    claimed.add(t.order.id);
                    update(rec.id, { type: 'placed', key: slot.key, orderId: t.order.id });
                }
            }
            if (t) update(rec.id, { type: 'report', key: slot.key, ...tradeReport(t) });
        }
    }
}

function retainQuotes(rec: SpreadExecRecord) {
    if (releases.has(rec.id)) return;
    try {
        const a = retainContractQuotes(rec.contract);
        const b = retainContractQuotes(rec.contract, { oddLot: true });
        releases.set(rec.id, () => { a(); b(); });
    } catch {
        // 行情訂閱失敗：補單定價會回報沒有報價，交由使用者決定
    }
}

function releaseQuotes(id: string) {
    releases.get(id)?.();
    releases.delete(id);
}

// 與觸價單引擎同一把主視窗執行鎖（claimExecutor 在同一視窗只建立一次）
const EXECUTOR_LOCK = 'sj-protection-executor';

/** 主視窗啟動：取得執行權後接回本機保存的執行並開始對帳（只執行一次） */
export function startOddSpreadService() {
    if (started || !isMainWindow()) return;
    if (!isExecutor()) {
        void claimExecutor(EXECUTOR_LOCK).acquired.then(() => startOddSpreadService());
        return;
    }
    started = true;
    try {
        const raw = localStorage.getItem(STORE_KEY);
        const parsed = raw ? (JSON.parse(raw) as SpreadExecRecord[]) : [];
        // 重新整理前還在送出中的委託：結果不明，等委託列對上或使用者核對
        records = Array.isArray(parsed)
            ? parsed.map(r => ({ ...r, state: { ...r.state, slots: r.state.slots.map(s => (s.status === 'sending' ? { ...s, status: 'unknown' as const } : s)) } }))
            : [];
    } catch {
        records = [];
    }
    for (const r of records) if (!isTerminalPhase(r.state.phase)) retainQuotes(r);
    subscribeTradingState(() => reconcile());
    reconcile();
    emit();
}

export interface StartSpreadRequest {
    contract: ContractInfo;
    account: Account;
    plan: ExecPlan;
    fees: FeeSettings;
    maxSlipTicks: number;
}

export function liveExecutionFor(code: string, account: Account | undefined): SpreadExecRecord | undefined {
    return records.find(r => r.contract.code === code && accountMatches(r.account, account) && !isTerminalPhase(r.state.phase));
}

export function hasLiveSpreadExecution(): boolean {
    return records.some(r => r.state.started && !isTerminalPhase(r.state.phase));
}

/** 開始一筆兩腳價差單；同商品同帳戶已有執行中（含結果不明）時拒絕 */
export function startSpreadExecution(req: StartSpreadRequest): string {
    const unavailable = oddSpreadExecUnavailable();
    if (unavailable) throw new Error(unavailable);
    startOddSpreadService();
    if (liveExecutionFor(req.contract.code, req.account)) throw new Error('此商品已有執行中的價差單（含結果未確認的委託），請先處理');
    const id = `os-${Date.now().toString(36)}-${++seq}`;
    records = [...records.filter(r => !(r.contract.code === req.contract.code && accountMatches(r.account, req.account))), {
        id,
        contract: req.contract,
        account: req.account,
        fees: req.fees,
        maxSlipTicks: req.maxSlipTicks,
        startedAt: Date.now(),
        state: initExec(req.plan),
    }];
    update(id, { type: 'start' });
    return id;
}

export function spreadExecAction(id: string, event: Extract<ExecEvent, { type: 'cancel' | 'hedgeAccept' | 'hedgeDecline' | 'resolveUnknown' }>) {
    update(id, event);
}

/** 以最新委託簿重算補單建議（面板「以最新價補單」前呼叫） */
export function refreshHedgeOrders(id: string) {
    const rec = records.find(r => r.id === id);
    const p = rec?.state.pendingHedge;
    if (!rec || !p) return undefined;
    return contextFor(rec).quoteHedge(p.leg, p.action, p.quantity).orders;
}

export function dismissSpreadExecution(id: string) {
    const rec = records.find(r => r.id === id);
    if (!rec || (rec.state.started && !isTerminalPhase(rec.state.phase))) return;
    records = records.filter(r => r.id !== id);
    releaseQuotes(id);
    persist();
    emit();
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

const getRecords = () => records;

/** 面板顯示：此商品／帳戶最近一筆執行（含已結束、尚未關閉的） */
export function useSpreadExecution(code: string, account: Account | undefined): SpreadExecRecord | undefined {
    const all = useSyncExternalStore(subscribe, getRecords);
    for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i]!;
        if (r.contract.code === code && accountMatches(r.account, account)) return r;
    }
    return undefined;
}

/** 已成交股數換算（面板顯示用） */
export function hedgeUnitLabel(leg: LegKind, quantity: number): string {
    return leg === 'odd' ? `零股 ${quantity.toLocaleString('en-US')} 股` : `整股 ${quantity} 張（${(quantity * SHARES_PER_LOT).toLocaleString('en-US')} 股）`;
}

// 測試用
export function resetOddSpreadServiceForTest() {
    for (const id of [...releases.keys()]) releaseQuotes(id);
    records = [];
    started = false;
    listeners.clear();
}
