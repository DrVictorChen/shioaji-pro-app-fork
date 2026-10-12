// src/lib/flash-trigger.ts — 閃電下單的觸價單與自動停損停利（#216）。
// Pure rules shared by the flash panel and its tests: which way a ladder
// click triggers, whether it opens or closes, the bracket plan a flash entry
// gets, and the marks drawn on the ladder (pending triggers and protection).
// No I/O: orders and triggers go through trigger-engine / panel-bracket.

import { bracketPlanProblem } from './conditional/bracket-rules';
import { isOddLot } from './odd-lot';
import type { BracketEntryPlan, TriggerOrder, TriggerSend } from './trigger-engine';
import type { Action, FuturesOCType } from './types/order';

// ---- settings (saved with the panel, FlashOrderOpts) ----

/** 自動停損停利: every flash entry fill gets a bracket priced from its own
 * fill price. One tier (the whole entry quantity). */
export interface FlashProtect {
    on: boolean;
    stopTicks: number;
    /** null: no fixed take — the 移動停損 takes the profit */
    takeTicks: number | null;
    trail: { activateTicks: number; distanceTicks: number; stepTicks: number } | null;
}

export const DEFAULT_PROTECT: FlashProtect = { on: false, stopTicks: 10, takeTicks: 20, trail: null };

/** 觸價後送出: 市價 (futures follow the panel's 市價鈕) or a limit N ticks
 * past the trigger price toward a fill (buy +N, sell −N). */
export type FlashTriggerSend = { type: 'MKT' } | { type: 'LMT'; ticks: number };
export const DEFAULT_TRIGGER_SEND: FlashTriggerSend = { type: 'MKT' };
export const TRIGGER_LIMIT_MAX_TICKS = 50;

const posInt = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= max ? v : null;
const nonNegInt = (v: unknown, max: number): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null;

export const PROTECT_MAX_TICKS = 500;

/** A saved protect setting, or undefined when it is not one (→ default, off). */
export function normalizeFlashProtect(v: unknown): FlashProtect | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    const stop = posInt(o.stopTicks, PROTECT_MAX_TICKS);
    if (stop === null) return undefined;
    const take = o.takeTicks === null ? null : posInt(o.takeTicks, PROTECT_MAX_TICKS);
    const t = o.trail && typeof o.trail === 'object' ? o.trail as Record<string, unknown> : null;
    const trail = t && nonNegInt(t.activateTicks, PROTECT_MAX_TICKS) !== null && posInt(t.distanceTicks, PROTECT_MAX_TICKS) !== null
        && posInt(t.stepTicks, PROTECT_MAX_TICKS) !== null
        ? { activateTicks: t.activateTicks as number, distanceTicks: t.distanceTicks as number, stepTicks: t.stepTicks as number } : null;
    const out: FlashProtect = { on: o.on === true, stopTicks: stop, takeTicks: take, trail };
    // a saved setting that would be refused is kept but never on
    if (flashProtectProblem(out)) out.on = false;
    return out;
}

export function normalizeTriggerSend(v: unknown): FlashTriggerSend | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const o = v as Record<string, unknown>;
    if (o.type === 'MKT') return { type: 'MKT' };
    if (o.type === 'LMT') {
        const n = nonNegInt(o.ticks, TRIGGER_LIMIT_MAX_TICKS);
        return n === null ? undefined : { type: 'LMT', ticks: n };
    }
    return undefined;
}

/** The bracket a flash entry of `qty` gets. */
export function flashProtectPlan(p: FlashProtect, qty: number): BracketEntryPlan {
    return {
        tiers: [{ quantity: qty, takeTicks: p.takeTicks }],
        stopTicks: p.stopTicks,
        trail: p.trail,
        // one tier: after its take there is nothing left to move to cost
        breakeven: null,
    };
}

/** Why these rules cannot be used (null: fine) — the panel bracket's checks. */
export function flashProtectProblem(p: FlashProtect): string | null {
    return bracketPlanProblem(flashProtectPlan(p, 1));
}

/** One line: 「損 10・利 20 檔・移動停損」. */
export function flashProtectText(p: FlashProtect): string {
    const parts = [`損 ${p.stopTicks}`];
    if (p.takeTicks !== null) parts.push(`利 ${p.takeTicks}`);
    return `${parts.join('・')} 檔${p.trail ? '・移動停損' : ''}`;
}

// ---- what a click does ----

export type FlashMarketKind = 'S' | 'F';

/** Whether the panel's order conditions can carry 自動停損停利 (null: yes). */
export function protectConditionProblem(c: {
    market: FlashMarketKind;
    odd: boolean;
    creditCond: string;
    daytradeShort: boolean;
    octype?: FuturesOCType;
}): string | null {
    if (c.market === 'F') {
        const oc = c.octype ?? 'Auto';
        return oc === 'Auto' || oc === 'New' ? null : '自動停損停利只用於新倉：期貨倉別請選自動或新倉';
    }
    if (c.odd) return '盤中零股暫不支援自動停損停利，請改整股或關閉';
    if (c.creditCond !== 'Cash' || c.daytradeShort) return '自動停損停利只支援現股（不含融資券、借券與當沖先賣）';
    return null;
}

/** Whether triggers can be placed with these conditions (null: yes). A
 * trigger goes out in cash only (as on the chart, #263). */
export function triggerConditionProblem(c: { market: FlashMarketKind; creditCond: string; daytradeShort: boolean }): string | null {
    if (c.market === 'S' && (c.creditCond !== 'Cash' || c.daytradeShort)) return '觸價單觸發後只能以現股送出；信用條件不是現股時不能掛觸價單';
    return null;
}

/** What an order of `qty` does to a position of `held` (signed, same unit). */
export type PositionEffect = 'open' | 'reduce' | 'reverse';
export function positionEffect(held: number, action: Action, qty: number): PositionEffect {
    const against = held !== 0 && (held > 0) !== (action === 'Buy');
    if (!against) return 'open';
    return qty <= Math.abs(held) ? 'reduce' : 'reverse';
}

/** The trigger condition of a ladder click at `price`, from the price the
 * trigger watches; a string when it cannot be placed there. */
export function clickCondition(price: number, ref: number | null): 'above' | 'below' | string {
    if (ref === null || !Number.isFinite(ref) || ref <= 0) return '尚未收到成交價，無法判斷觸價方向';
    if (Math.abs(price - ref) < 1e-9) return '觸發價等於目前成交價，會立刻觸發；請改用限價或選其他價位';
    return price > ref ? 'above' : 'below';
}

/** A stop sells below / buys above; a take the other way round. */
export const triggerKind = (condition: 'below' | 'above', action: Action): 'stop' | 'take' =>
    (condition === 'below') === (action === 'Sell') ? 'stop' : 'take';

/** The send style of a flash trigger. 零股: the engine sends at the price
 * limit (no choice). */
export function triggerSendOf(s: FlashTriggerSend, c: { market: FlashMarketKind; odd: boolean; mktPriceType: 'MKT' | 'MKP'; action: Action }): TriggerSend | undefined {
    if (c.odd) return undefined;
    if (s.type === 'LMT') return { type: 'LMT', ticks: c.action === 'Buy' ? s.ticks : -s.ticks };
    return c.market === 'F' && c.mktPriceType === 'MKP' ? { type: 'MKP' } : undefined;
}

export function triggerSendText(s: FlashTriggerSend, c: { market: FlashMarketKind; odd: boolean; mktPriceType: 'MKT' | 'MKP' }): string {
    if (c.odd) return '零股以漲跌停價限價';
    if (s.type === 'LMT') return s.ticks === 0 ? '觸發價限價' : `觸發價 ± ${s.ticks} 檔限價`;
    return c.market === 'F' && c.mktPriceType === 'MKP' ? '範圍市價' : '市價';
}

/** Entry or protective exit, and the futures position effect it goes out with.
 * Opposite and within the position: a protective exit (never blocked by the
 * risk limits; futures close only). Otherwise an entry (risk checks apply). */
export function triggerIntent(c: {
    market: FlashMarketKind;
    octype?: FuturesOCType;
    effect: PositionEffect;
    /** the position rows are plain (one direction, cash for stocks) */
    exitSafe: boolean;
}): { role: 'entry' | 'exit'; octype?: FuturesOCType } {
    if (c.market === 'F') {
        const oc = c.octype ?? 'Auto';
        if (oc === 'Cover') return { role: 'exit', octype: 'Cover' };
        if (oc === 'Auto' && c.effect === 'reduce' && c.exitSafe) return { role: 'exit', octype: 'Cover' };
        return { role: 'entry', ...(oc !== 'Auto' ? { octype: oc } : {}) };
    }
    return { role: c.effect === 'reduce' && c.exitSafe ? 'exit' : 'entry' };
}

// ---- ladder marks ----

export interface LadderMark {
    id: string;
    side: 'buy' | 'sell';
    price: number;
    quantity: number;
    /** trigger: a pending 觸價單 (dashed); stop / take: protection (solid) */
    kind: 'trigger' | 'stop' | 'take';
    /** a trigger entry that places a bracket when it fills */
    protects: boolean;
    paused: boolean;
    pending: boolean;
    /** click deletes, drag moves (plain triggers only) */
    editable: boolean;
    background: boolean;
    condition?: 'above' | 'below';
    title: string;
}

export interface MarkScope {
    code: string;
    /** the quote code of a continuous alias (TXFR1 → TXFJ6) */
    aliasOf?: (code: string) => string | undefined;
    account: { account_type: string; broker_id: string; account_id: string } | undefined;
    odd: boolean;
    /** current protection environment; null: unknown (shown regardless) */
    env: string | null;
}

/** The part of a background bracket view the ladder needs. */
export interface ProtectionView {
    id: string;
    quoteCode: string;
    env: string;
    account: { accountType: string; brokerId: string; accountId: string };
    side: 'Buy' | 'Sell';
    stop: number | null;
    take: number | null;
    position: number;
    state: string;
}

const priceKey = (p: number) => p.toFixed(2);

function codeMatches(code: string, s: MarkScope): boolean {
    return code === s.code || s.aliasOf?.(code) === s.code;
}

function accountIs(a: { account_type: string; broker_id: string; account_id: string } | undefined, s: MarkScope): boolean {
    return !!a && !!s.account && a.account_type === s.account.account_type && a.broker_id === s.account.broker_id
        && a.account_id === s.account.account_id;
}

const qtyUnit = (odd: boolean, futures: boolean) => (futures ? '口' : odd ? '股' : '張');

function triggerTitle(t: TriggerOrder, editable: boolean, unit: string): string {
    const side = t.action === 'Buy' ? '買' : '賣';
    const cond = t.condition === 'above' ? '≥' : '≤';
    if (t.bracketId) return `${t.kind === 'stop' ? '停損' : '停利'} ${side} ${t.quantity} ${unit} @ ${t.price}（括號單保護；請到條件單面板修改）`;
    const what = t.role === 'entry' ? '觸價單' : t.kind === 'stop' ? '停損觸價' : '停利觸價';
    const state = t.pending ? '・待確認（請到條件單面板處理）' : t.paused ? '・已暫停' : '';
    const extra = t.bracketPlan ? '・成交後附停損停利' : '';
    const how = editable ? '\n點一下刪除・拖曳改觸發價' : '\n二擇一／時間條件請到條件單面板處理';
    return `${what} 成交價 ${cond} ${t.price} → ${side} ${t.quantity} ${unit}${extra}${state}${how}`;
}

function triggerInScope(t: TriggerOrder, s: MarkScope, futures: boolean): boolean {
    if (t.kind === 'alert' || t.time || !(t.price > 0)) return false;
    if (!codeMatches(t.code, s) || !accountIs(t.account, s)) return false;
    if (!futures && isOddLot(t.orderLot) !== s.odd) return false;
    return !(s.env && t.env && t.env !== s.env);
}

const HOLDING = ['protected', 'exiting', 'needsConfirm'];
function viewInScope(v: ProtectionView, s: MarkScope): boolean {
    // background brackets are whole lots / contracts only
    if (s.odd || !HOLDING.includes(v.state) || v.position <= 0 || !codeMatches(v.quoteCode, s)) return false;
    if (!accountIs({ account_type: v.account.accountType, broker_id: v.account.brokerId, account_id: v.account.accountId }, s)) return false;
    return !(s.env && v.env !== s.env);
}

/** Marks per price key: this panel's account, product, unit and environment. */
export function ladderMarks(triggers: readonly TriggerOrder[], views: readonly ProtectionView[], s: MarkScope, futures: boolean): Map<string, { buy: LadderMark[]; sell: LadderMark[] }> {
    const out = new Map<string, { buy: LadderMark[]; sell: LadderMark[] }>();
    const add = (m: LadderMark) => {
        const key = priceKey(m.price);
        const cur = out.get(key) ?? { buy: [], sell: [] };
        cur[m.side].push(m);
        out.set(key, cur);
    };
    const unit = qtyUnit(s.odd, futures);
    for (const t of triggers) {
        if (!triggerInScope(t, s, futures)) continue;
        const editable = !t.bracketId && !t.group && !t.ocoLock && !t.pending;
        add({
            id: t.id,
            side: t.action === 'Buy' ? 'buy' : 'sell',
            price: t.price,
            quantity: t.quantity,
            kind: t.bracketId ? (t.kind === 'take' ? 'take' : 'stop') : 'trigger',
            protects: !!t.bracketPlan,
            paused: !!t.paused,
            pending: !!t.pending,
            editable,
            background: t.id.startsWith('bg:'),
            condition: t.condition,
            title: triggerTitle(t, editable, unit),
        });
    }
    // background brackets: their stop / take while they hold a position
    for (const v of views) {
        if (!viewInScope(v, s)) continue;
        const side = v.side === 'Buy' ? 'sell' as const : 'buy' as const;
        const exitWord = side === 'sell' ? '賣' : '買';
        for (const [kind, price] of [['stop', v.stop], ['take', v.take]] as const) {
            if (price === null || !(price > 0)) continue;
            add({ id: `${v.id}:${kind}`, side, price, quantity: v.position, kind, protects: false, paused: false,
                pending: v.state === 'needsConfirm', editable: false, background: true,
                title: `${kind === 'stop' ? '停損' : '停利'} ${exitWord} ${v.position} ${unit} @ ${price}（括號單保護・背景執行；請到條件單面板修改）` });
        }
    }
    return out;
}

/** Quantity under protection for this panel (window bracket legs counted
 * once per bracket, background brackets by the position they hold). */
export function protectedQuantity(triggers: readonly TriggerOrder[], views: readonly ProtectionView[], s: MarkScope, futures: boolean): number {
    const perBracket = new Map<string, number>();
    for (const t of triggers) {
        if (!t.bracketId || !triggerInScope(t, s, futures)) continue;
        perBracket.set(t.bracketId, Math.max(perBracket.get(t.bracketId) ?? 0, t.quantity));
    }
    let n = 0;
    for (const q of perBracket.values()) n += q;
    for (const v of views) if (viewInScope(v, s)) n += v.position;
    return n;
}

/** Why a trigger cannot be dragged to `price` (null: it can). The new price
 * must stay on the same side of the price it watches (else it fires at once). */
export function dragProblem(m: Pick<LadderMark, 'editable' | 'condition' | 'price'>, price: number, ref: number | null): string | null {
    if (!m.editable) return '這張觸價單請到條件單面板修改';
    if (Math.abs(price - m.price) < 1e-9) return null;
    if (ref === null) return '尚未收到成交價，無法確認新觸發價';
    const cond = clickCondition(price, ref);
    if (cond !== 'above' && cond !== 'below') return cond;
    if (cond !== m.condition) return '不能拖過目前成交價（會立刻觸發）；請刪除後重新設定';
    return null;
}
