// src/lib/odd-spread-service.ts — 整零價差兩腳送單的主視窗服務。
//
// 執行狀態不放在面板元件裡：面板移除、切換商品都不會中斷追蹤（同觸價單
// 引擎，只在主視窗執行）。每筆執行保存在本機（重新整理後接回），並：
// - 依 odd-spread-exec 狀態機的指令送單／刪單（source:'auto'，整筆價差已在
//   開始前確認；零股帶 IntradayOdd；委託帶 custom_field 標記）。
// - 每筆委託帶唯一標記（custom_field，最多 6 字元：o＋執行代碼 3 碼＋序號 2 碼）；
//   訂閱委託列（trading-state），只以委託編號或「完全相同的標記」對回：成交先於
//   下單回應、結果不明（unknown）事後出現都能接回。沒有標記的委託（投影遺失）
//   絕不自動認領，只列為候選，由使用者在面板指定。
// - 執行綁定開始時的伺服器（API base）與模擬／正式模式；目前連線不同時暫停：
//   不送單、不對帳、回報先保留，同一環境回來後才繼續。
// - 結束的執行保留到當日結束（晚到成交仍會對帳、必要時補第二腳）；本機保存
//   永不丟棄執行中或結果不明的紀錄，只限制已結束紀錄的數量。
// - 第二腳以當下整股／零股委託簿重新定價（repriceHedge）。
//
// 彈出視窗沒有這個服務：關掉視窗就無法追蹤第二腳，所以彈出視窗停用兩腳送單
// （面板顯示原因）；點價單筆下單不受影響。

import { useMemo, useSyncExternalStore } from 'react';
import { displayBook } from './display-book';
import { accountMatches, flashAccountKey } from './flash-account';
import { claimExecutor, isExecutor, isMainWindow } from './main-window-commands';
import { getApiBase } from './runtime';
import { knownServerInfo, subscribeServerInfo } from './server-info-store';
import { SHARES_PER_LOT } from './odd-lot';
import type { LegOrder } from './odd-spread';
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
    type OrderSlot,
    type ReportStatus,
    allBrokerFinal,
    restoreAfterReload,
} from './odd-spread-exec';
import { retainContractQuotes } from './quote-ownership';
import { cancelOrders } from './shioaji';
import { getQuote } from './stream';
import { notify, placeQuickOrder } from './trade';
import { getTradingState, ordersBaselineLostMark, subscribeTradingState } from './trading-state';
import { candidateTrades, reconcileEvents, slotTag, tradeReport } from './odd-spread-reconcile';
import type { ContractInfo } from './types/contract';
import type { AccountedTrade } from './types/order';
import type { Account } from './types/portfolio';
import { stepPrice } from './utils/ticksize';

const STORE_KEY = 'sj-pro-odd-spread-exec-v1';
const TAG_KEY = 'sj-pro-odd-spread-tags-v1';
/** 已了結紀錄最多保存幾筆（當日內）；未了結的永不丟棄 */
const MAX_TERMINAL = 50;

/** 送單環境：API base＋模擬／正式 */
export interface ExecEnv {
    base: string;
    simulation: boolean;
}

export interface SpreadExecRecord {
    id: string;
    /** 委託標記前綴（3 碼 base36），同日唯一 */
    tagBase: string;
    env: ExecEnv;
    contract: ContractInfo;
    account: Account;
    fees: FeeSettings;
    maxSlipTicks: number;
    startedAt: number;
    state: ExecState;
    /** 使用者已關閉顯示（仍追蹤晚到成交；重新開啟時再顯示） */
    dismissed?: boolean;
    /** 環境不符期間保留的回報，同一環境回來後依序處理 */
    held?: ExecEvent[];
}

let records: SpreadExecRecord[] = [];
const listeners = new Set<() => void>();
const releases = new Map<string, () => void>();
let started = false;
let seq = 0;

function emit() {
    for (const l of listeners) l();
}

/** 台北時間當日 00:00（ms） */
function taipeiDayStart(now: number): number {
    const tw = now + 8 * 3600_000;
    return tw - (tw % 86_400_000) - 8 * 3600_000;
}

/**
 * 已完全了結：已結束、沒有保留中的回報、每筆委託都是券商確認的終態（刪單要有
 * 刪單量對得上；使用者標記「未送出」只是暫定、不算），且兩腳已配對或使用者已
 * 關閉。只有了結的紀錄可以被丟棄。
 */
export function isSettled(r: SpreadExecRecord): boolean {
    if (!isTerminalPhase(r.state.phase) || (r.held?.length ?? 0) > 0) return false;
    if (!allBrokerFinal(r.state)) return false;
    return execSummary(r.state).unhedgedShares === 0 || !!r.dismissed;
}

/** 保存規則：未了結（執行中、結果不明、未配對未處理…）全留；了結的只留當日、最多 MAX_TERMINAL 筆 */
export function pruneRecords(list: SpreadExecRecord[], now = Date.now()): SpreadExecRecord[] {
    const day = taipeiDayStart(now);
    const settled = list.filter(r => isSettled(r) && r.startedAt >= day);
    const keepSettled = new Set(settled.slice(-MAX_TERMINAL).map(r => r.id));
    return list.filter(r => !isSettled(r) || keepSettled.has(r.id));
}

function persist() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(pruneRecords(records)));
    } catch {
        // 本機儲存不可用：只在本次有效
    }
}

// ---- 委託標記 ----

export { slotTag, tradeReport };

function usedTagBases(now: number): { day: number; bases: string[] } {
    try {
        const v = JSON.parse(localStorage.getItem(TAG_KEY) ?? 'null') as { day: number; bases: string[] } | null;
        if (v && v.day === taipeiDayStart(now) && Array.isArray(v.bases)) return v;
    } catch {
        // 讀不到就當作今天還沒用過
    }
    return { day: taipeiDayStart(now), bases: [] };
}

function newTagBase(now: number): string {
    const used = usedTagBases(now);
    const taken = new Set([...used.bases, ...records.map(r => r.tagBase)]);
    let base = '';
    for (let i = 0; i < 1000; i++) {
        base = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, '0');
        if (!taken.has(base)) break;
    }
    try {
        localStorage.setItem(TAG_KEY, JSON.stringify({ day: used.day, bases: [...used.bases, base] }));
    } catch {
        // 本機儲存不可用：只避開記憶體中的紀錄
    }
    return base;
}

// ---- 環境 ----

export function currentEnv(): { base: string; simulation: boolean | undefined } {
    return { base: getApiBase(), simulation: knownServerInfo()?.simulation };
}

/** 執行的環境與目前連線相同？（模擬／正式未知時視為不同） */
export function envMatches(env: ExecEnv, now: { base: string; simulation: boolean | undefined } = currentEnv()): boolean {
    return env.base === now.base && now.simulation !== undefined && now.simulation === env.simulation;
}

export const ENV_PAUSED_TEXT = '環境已切換，執行暫停';

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

function replace(next: SpreadExecRecord) {
    records = records.map(r => (r.id === next.id ? next : r));
}

function update(id: string, event: ExecEvent) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    // 環境不符：回報先保留，不推進狀態機（避免在別的環境送第二腳）
    if (!envMatches(rec.env)) {
        replace({ ...rec, held: [...(rec.held ?? []), event] });
        persist();
        emit();
        return;
    }
    const before = rec.state;
    const { state, commands } = execReduce(before, event, contextFor(rec));
    if (state === before && commands.length === 0) return;
    // 晚到成交讓已關閉的執行重新需要處理時，恢復顯示
    const next: SpreadExecRecord = { ...rec, state, dismissed: rec.dismissed && isTerminalPhase(state.phase) };
    replace(next);
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
        if (!envMatches(rec.env)) {
            update(rec.id, { type: 'cancelResult', key: c.key, ok: false, error: ENV_PAUSED_TEXT });
            return;
        }
        void cancelOrders([c.orderId]).then(
            (results) => {
                const r = results[0];
                const ok = r?.status === 'fulfilled';
                const error = !r ? '沒有回應' : r.status === 'rejected' ? (r.reason instanceof Error ? r.reason.message : String(r.reason)) : undefined;
                if (!ok) notify({ kind: 'err', title: '整零價差：刪單失敗', body: `${rec.contract.code}：${error}；原單可能仍會成交，請在面板再按「取消」重試` });
                update(rec.id, { type: 'cancelResult', key: c.key, ok, ...(error ? { error } : {}) });
            },
            (e: unknown) => update(rec.id, { type: 'cancelResult', key: c.key, ok: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return;
    }
    void placeQuickOrder(rec.contract, c.action, c.price, c.quantity, {
        account: rec.account,
        source: 'auto',
        customField: slotTag(rec.tagBase, c.key),
        ...(c.leg === 'odd' ? { orderLot: 'IntradayOdd' as const } : {}),
        // 送出前最後一刻再確認環境：不同就不送（mutationNotStarted）
        beforeSend: () => { if (!envMatches(rec.env)) throw new Error(`${ENV_PAUSED_TEXT}，未送出`); },
    }).then(
        (trade) => {
            update(rec.id, { type: 'placed', key: c.key, orderId: trade.order.id, gen: currentGen() });
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

/** 目前的 sidecar 世代（trade_id 只在同一 sidecar 程序有效） */
function currentGen(): number {
    try {
        return ordersBaselineLostMark();
    } catch {
        return 0;
    }
}

/** 同一世代取得、可信的委託編號（標記對帳時不可被別的委託占用） */
function trustedIds(gen: number): Set<string> {
    const ids = new Set<string>();
    for (const r of records) for (const s of r.state.slots) if (s.orderId && s.idGen === gen) ids.add(s.orderId);
    return ids;
}

const target = (rec: SpreadExecRecord) => ({ tagBase: rec.tagBase, code: rec.contract.code, account: rec.account, state: rec.state });

/** 委託列 → 各筆執行的成交回報（以唯一標記對帳；sidecar 重啟換 id 時重新接回） */
export function reconcile(trades: AccountedTrade[] = getTradingState().trades) {
    const gen = currentGen();
    const claimed = trustedIds(gen);
    for (const rec of records) {
        if (!rec.state.started || !envMatches(rec.env)) continue;
        for (const e of reconcileEvents(target(rec), trades, claimed, gen)) update(rec.id, e);
    }
}

/** 結果不明、或 sidecar 重啟後 id 不可信的那筆的候選委託，供使用者指定 */
export function candidateOrders(id: string, key: string, trades: AccountedTrade[] = getTradingState().trades): AccountedTrade[] {
    const rec = records.find(r => r.id === id);
    const slot = rec?.state.slots.find(s => s.key === key);
    if (!rec || !slot) return [];
    const gen = currentGen();
    return candidateTrades(target(rec), slot, trades, trustedIds(gen), gen) as AccountedTrade[];
}

/** 使用者指定結果不明那筆就是某筆委託 */
export function claimOrder(id: string, key: string, orderId: string) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    if (!envMatches(rec.env)) {
        notify({ kind: 'err', title: '整零價差', body: ENV_PAUSED_TEXT });
        return;
    }
    if (!candidateOrders(id, key).some(t => t.order.id === orderId)) return;
    const slot = rec.state.slots.find(s => s.key === key);
    update(id, { type: 'placed', key, orderId, gen: currentGen(), rebind: !!slot?.orderId });
    reconcile();
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

/** 同一環境回來：依序處理保留的回報，再對帳 */
function resumeHeld() {
    for (const rec of records) {
        if (!rec.held?.length || !envMatches(rec.env)) continue;
        const events = rec.held;
        replace({ ...rec, held: [] });
        for (const e of events) update(rec.id, e);
    }
    reconcile();
    emit();
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
            ? pruneRecords(parsed.filter(r => r && r.tagBase && r.env).map(r => ({
                ...r,
                // 送出中 → 結果不明；刪單等待中 → 刪單結果不明（仍在委託中可再取消）
                state: restoreAfterReload(r.state),
            })))
            : [];
    } catch {
        records = [];
    }
    persist();
    for (const r of records) if (!isTerminalPhase(r.state.phase)) retainQuotes(r);
    subscribeTradingState(() => reconcile());
    subscribeServerInfo(() => resumeHeld());
    resumeHeld();
    // 接回後以總量重算一次（例如重新發出因重新整理遺失回應的多餘補單刪單）
    for (const r of records) if (!isSettled(r)) update(r.id, { type: 'refresh' });
}

export interface StartSpreadRequest {
    contract: ContractInfo;
    account: Account;
    plan: ExecPlan;
    fees: FeeSettings;
    maxSlipTicks: number;
    /** 使用者按下時綁定的環境；開始當下不同就拒絕 */
    env: ExecEnv;
}

export function liveExecutionFor(code: string, account: Account | undefined): SpreadExecRecord | undefined {
    return records.find(r => r.contract.code === code && accountMatches(r.account, account) && r.state.started && !isTerminalPhase(r.state.phase));
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
    if (!envMatches(req.env)) throw new Error('確認期間伺服器或模擬／正式環境已切換，未送出，請重新確認');
    const env = req.env;
    const now = Date.now();
    const id = `os-${now.toString(36)}-${++seq}`;
    // 之前的執行（含已結束）保留追蹤晚到成交，不因新執行刪除
    records = pruneRecords([...records, {
        id,
        tagBase: newTagBase(now),
        env: { base: env.base, simulation: env.simulation },
        contract: req.contract,
        account: req.account,
        fees: req.fees,
        maxSlipTicks: req.maxSlipTicks,
        startedAt: now,
        state: initExec(req.plan),
    }], now);
    update(id, { type: 'start' });
    return id;
}

/** 使用者確認補單（數量與價格凍結在確認當下）；缺口已變、環境不符就不送，回 false */
export function acceptHedge(id: string, quantity: number, orders: LegOrder[]): boolean {
    const rec = records.find(r => r.id === id);
    if (!rec || !envMatches(rec.env)) return false;
    const before = rec.state;
    update(id, { type: 'hedgeAccept', quantity, orders });
    const after = records.find(r => r.id === id)?.state;
    return !!after && after !== before && !after.pendingHedge;
}

export function spreadExecAction(id: string, event: Extract<ExecEvent, { type: 'cancel' | 'hedgeDecline' | 'resolveUnknown' }>) {
    const rec = records.find(r => r.id === id);
    if (!rec) return;
    if (!envMatches(rec.env)) {
        notify({ kind: 'err', title: '整零價差', body: `${ENV_PAUSED_TEXT}：請切回開始時的伺服器與${rec.env.simulation ? '模擬' : '正式'}環境再操作` });
        return;
    }
    update(id, event);
}

/** 以最新委託簿重算補單建議（面板「以最新價補單」前呼叫） */
export function refreshHedgeOrders(id: string): LegOrder[] | undefined {
    const rec = records.find(r => r.id === id);
    const p = rec?.state.pendingHedge;
    if (!rec || !p) return undefined;
    return contextFor(rec).quoteHedge(p.leg, p.action, p.quantity).orders;
}

/** 關閉顯示：已結束的執行仍保留到當日結束，晚到成交照樣對帳 */
export function dismissSpreadExecution(id: string) {
    const rec = records.find(r => r.id === id);
    if (!rec || (rec.state.started && !isTerminalPhase(rec.state.phase))) return;
    replace({ ...rec, dismissed: true });
    persist();
    emit();
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

const getRecords = () => records;

/** 此商品／帳戶所有未關閉（或重新需要處理）的執行，新的在前 */
export function executionsFor(all: SpreadExecRecord[], code: string, account: Account | undefined): SpreadExecRecord[] {
    return all.filter(r => r.contract.code === code && accountMatches(r.account, account) && r.state.started && !r.dismissed).reverse();
}

/** 面板顯示：此商品／帳戶每一筆需要看／處理的執行（含較早的） */
export function useSpreadExecutions(code: string, account: Account | undefined): SpreadExecRecord[] {
    const all = useSyncExternalStore(subscribe, getRecords);
    return useMemo(() => executionsFor(all, code, account), [all, code, account]);
}

// ---- 點價鎖（持久化；彈出視窗與主視窗共用本機儲存） ----

export interface ClickLock {
    id: string;
    code: string;
    /** flashAccountKey */
    account: string;
    text: string;
    at: number;
}

const LOCK_KEY = 'sj-pro-odd-spread-click-locks-v1';
let locks: ClickLock[] | null = null;
const lockListeners = new Set<() => void>();

function readLocks(): ClickLock[] {
    try {
        const v = JSON.parse(localStorage.getItem(LOCK_KEY) ?? '[]') as ClickLock[];
        return Array.isArray(v) ? v.filter(l => l && typeof l.id === 'string') : [];
    } catch {
        return [];
    }
}

function getLocks(): ClickLock[] {
    if (locks === null) {
        locks = readLocks();
        // 其他視窗改了鎖 → 重新讀
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('storage', e => {
                if (e.key !== LOCK_KEY) return;
                locks = readLocks();
                for (const l of lockListeners) l();
            });
        }
    }
    return locks;
}

function setLocks(next: ClickLock[]) {
    locks = next;
    try {
        localStorage.setItem(LOCK_KEY, JSON.stringify(next));
    } catch {
        // 本機儲存不可用：只在本次有效
    }
    for (const l of lockListeners) l();
}

/** 加上點價鎖（送出前就加，送出途中重新整理也不會遺失） */
export function addClickLock(code: string, account: Account, text: string): string {
    const id = `lk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setLocks([...getLocks(), { id, code, account: flashAccountKey(account), text, at: Date.now() }]);
    return id;
}

export function updateClickLock(id: string, text: string) {
    setLocks(getLocks().map(l => (l.id === id ? { ...l, text } : l)));
}

export function clearClickLock(id: string) {
    setLocks(getLocks().filter(l => l.id !== id));
}

function subscribeLocks(l: () => void) {
    lockListeners.add(l);
    return () => { lockListeners.delete(l); };
}

export function clickLocksFor(code: string, account: Account | undefined): ClickLock[] {
    const key = account ? flashAccountKey(account) : '';
    return getLocks().filter(l => l.code === code && l.account === key);
}

export function useClickLocks(code: string, account: Account | undefined): ClickLock[] {
    const all = useSyncExternalStore(subscribeLocks, getLocks);
    const key = account ? flashAccountKey(account) : '';
    return useMemo(() => all.filter(l => l.code === code && l.account === key), [all, code, key]);
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
    locks = null;
    lockListeners.clear();
}
