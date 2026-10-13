// src/lib/execution/background-view.ts — pure mapping between the background
// execution engine (#201 ①-3, desktop, 「背景持續執行（實驗）」) and the
// existing trigger UI. No I/O: background.ts talks to the Tauri host.
//
// One owner per trigger, decided once at creation: a trigger is created
// either in the window's trigger engine (trigger-engine.ts) or as a
// background program — never both, and switching the setting never moves
// one. Rows built here carry `background` and ids prefixed `bg:`, which the
// window's trigger engine never stores, so it can never evaluate or send
// them, and a background command never touches a window trigger.

import type { ContractBase, TickBand as ContractTickBand } from '../types/contract';
import type { NewTrigger, RestoreReason as TriggerRestoreReason, TriggerOrder, TriggerSend } from '../trigger-engine';
import { accountRef, envKeyOf, programsFromTriggers } from './adapter';
import { bracketEntryWaiting } from './bracket-contract';
import type { Level, OrderProgram, OrderSpec, TickBand } from './model';

export const BACKGROUND_ID_PREFIX = 'bg:';

export interface BackgroundRef {
    programId: string;
    levelId: string;
}

export type BackgroundTriggerOrder = TriggerOrder & { background: BackgroundRef };

export function isBackgroundId(id: string): boolean {
    return id.startsWith(BACKGROUND_ID_PREFIX);
}

export function backgroundRowId(programId: string, levelId: string): string {
    return `${BACKGROUND_ID_PREFIX}${programId}:${levelId}`;
}

/** Futures / options stop, take and entry triggers (#226: 進場單 with the
 * App's risk checks, 上穿／下穿, 對手價, 市價／範圍市價／觸價後限價, 有效期),
 * with the contract known. Not yet: OCO groups, time orders, a trigger
 * that places a bracket, odd lots, alerts, bracket legs. */
export function backgroundEligible(t: NewTrigger, contract: ContractBase | undefined, inGroup = false): boolean {
    if (t.kind !== 'stop' && t.kind !== 'take') return false;
    // #226 options the background engine does not have yet
    if (t.time || t.bracketPlan) return false;
    // 二擇一 legs go together (backgroundGroupEligible)
    if (!inGroup && (t.group || t.ocoMode)) return false;
    if (t.bracketId || (t.orderLot && t.orderLot !== 'Common')) return false;
    if (t.account?.account_type !== 'F' || !t.env || !t.orderCode) return false;
    return contract?.security_type === 'FUT' || contract?.security_type === 'OPT';
}

/** The contract's tick-size table for the engine: the server's bands of
 * its tick rule (`bands`), else its one fixed tick; null when neither is
 * known (nothing can be priced in ticks then). */
export function tickTableOf(contract: ContractBase & { tick_rule?: string; tick?: number },
    bands: readonly ContractTickBand[] | undefined): TickBand[] | null {
    if (contract.tick_rule) return bands && bands.length ? bands.map(b => ({ min: b.min, max: b.max, tick: b.tick })) : null;
    const tick = Number(contract.tick);
    return Number.isFinite(tick) && tick > 0 ? [{ min: 0, max: null, tick }] : null;
}

/** The order a firing trigger sends, by its send style (#226). */
function sendOrder(base: OrderSpec, send: TriggerSend | undefined): OrderSpec {
    const octype = base.octype ? { octype: base.octype } : {};
    if (!send || send.type === 'MKT') return { priceType: 'MKT', timeInForce: 'IOC', ...octype };
    if (send.type === 'MKP') return { priceType: 'MKP', timeInForce: 'IOC', ...octype };
    return { priceType: 'LMT', timeInForce: 'ROD', ...octype };
}

/** #226 二擇一: both legs (same group, environment, account and contract,
 * a known mode) run in the background, or neither. */
export function backgroundGroupEligible(legs: readonly NewTrigger[], contract: ContractBase | undefined): boolean {
    const [first] = legs;
    if (!first?.group || legs.length < 2) return false;
    const mode = first.ocoMode ?? 'trigger';
    if (mode !== 'trigger' && mode !== 'fill') return false;
    return legs.every(l => l.group === first.group && (l.ocoMode ?? 'trigger') === mode && l.env === first.env
        && l.orderCode === first.orderCode && l.account?.account_id === first.account?.account_id
        && l.account?.broker_id === first.account?.broker_id && backgroundEligible(l, contract, true));
}

/** The one program a 二擇一 becomes: one level per leg; the first leg that
 * fires decides (`trigger`: ends the others; `fill`: they wait for its final
 * fills and lose exactly that — a limit goes out IOC so the order ends by
 * itself). Null: a leg is not mappable. */
export function programForNewGroup(legs: readonly TriggerOrder[], contract: ContractBase, tickTable: TickBand[] | null = null): OrderProgram | null {
    const first = legs[0];
    const made = legs.map(l => programForNewTrigger(l, contract, tickTable));
    if (!first?.group || made.some(p => !p)) return null;
    const programs = made as OrderProgram[];
    const fill = (first.ocoMode ?? 'trigger') === 'fill';
    const levels = programs.map(p => {
        const lv = p.levels[0]!;
        if (!fill || lv.entry.type !== 'touch' || lv.entry.order.priceType !== 'LMT') return lv;
        return { ...lv, entry: { ...lv.entry, order: { ...lv.entry.order, timeInForce: 'IOC' as const } } };
    });
    return { ...programs[0]!, id: `grp:${first.group}:${first.id}`, levels, ocoLevels: true,
        ...(fill ? { ocoMode: 'fill' as const } : {}),
        ...(programs.some(p => p.opens) ? { opens: true } : {}) };
}

/** The program a new stop / take / entry trigger becomes (null: not
 * mappable — e.g. a limit in ticks without a tick table). */
export function programForNewTrigger(t: TriggerOrder, contract: ContractBase, tickTable: TickBand[] | null = null): OrderProgram | null {
    const p = programsFromTriggers([t])[0];
    if (!p || (contract.security_type !== 'FUT' && contract.security_type !== 'OPT')) return null;
    const lv = p.levels[0];
    if (!lv || lv.entry.type !== 'touch' || p.levels.length !== 1) return null;
    const ticks = t.send?.type === 'LMT' ? t.send.ticks : null;
    if (ticks !== null && ticks !== 0 && !tickTable) return null;
    const entry = {
        ...lv.entry,
        order: sendOrder(lv.entry.order, t.send),
        ...(t.cross ? { cross: true } : {}),
        // 對手價: a sell watches the best bid, a buy the best ask
        ...(t.source === 'opposite' ? { feed: t.action === 'Sell' ? 'bid' as const : 'ask' as const } : {}),
        ...(ticks !== null ? { limitTicks: ticks } : {}),
        ...(t.validity ? { validity: { type: t.validity.type, until: t.validity.until } } : {}),
    };
    const at = t.createdAt ?? Date.now();
    return { ...p, binding: { ...p.binding, contract: { ...p.binding.contract, securityType: contract.security_type } },
        levels: [{ ...lv, entry, recross: [] }],
        ...(t.role === 'entry' ? { opens: true } : {}),
        ...(tickTable ? { tickTable } : {}),
        createdAt: at, updatedAt: at };
}

const restoreReason = (p: OrderProgram, r: string | undefined): TriggerRestoreReason =>
    r === 'disconnect' || r === 'env' ? r
        // a trigger turned back on in a new session (contract v2) starts with a resume check
        : r === 'resume' ? (p.id.startsWith('rearm:') ? 'rearm' : 'resume') : 'restart';

/** A stop sells below / buys above; a take the other way round. */
const kindOf = (condition: 'below' | 'above', action: 'Buy' | 'Sell'): 'stop' | 'take' =>
    (condition === 'below') === (action === 'Sell') ? 'stop' : 'take';

function row(p: OrderProgram, lv: Level): BackgroundTriggerOrder | null {
    if (lv.entry.type !== 'touch') return null;
    const e = lv.entry;
    const b = p.binding;
    // an order whose outcome is unknown is decided on the 委託待確認 card
    const pending = lv.phase === 'needsConfirm' && lv.pending && lv.pending.reason !== 'unknownNotSent'
        ? { price: lv.pending.price ?? e.price, at: lv.pending.ts, reason: restoreReason(p, lv.pending.reason) }
        : undefined;
    if (lv.phase !== 'idle' && !pending) return null;
    // #226 options, shown as the window shows them
    const send: TriggerSend | undefined = e.order.priceType === 'MKP' ? { type: 'MKP' }
        : e.order.priceType === 'LMT' ? { type: 'LMT', ticks: e.limitTicks ?? 0 } : undefined;
    return {
        id: backgroundRowId(p.id, lv.id),
        code: b.contract.quoteCode,
        condition: e.condition,
        price: e.price,
        action: lv.side,
        quantity: lv.qty,
        kind: kindOf(e.condition, lv.side),
        env: envKeyOf(b),
        account: accountRef(b.account),
        orderCode: b.contract.orderCode,
        createdAt: p.createdAt,
        ...(pending ? { pending } : {}),
        ...(lv.recross.includes('entry') ? { awaitingRecross: true } : {}),
        ...(p.status === 'paused' ? { paused: true } : {}),
        ...(p.opens ? { role: 'entry' as const } : {}),
        ...(e.cross ? { cross: true } : {}),
        ...(e.feed ? { source: 'opposite' as const } : {}),
        ...(send ? { send } : {}),
        ...(e.validity ? { validity: { type: e.validity.type, until: e.validity.until } } : {}),
        // 二擇一: one group per program; a waiting side names the row it waits for
        ...(p.ocoLevels ? { group: p.id, ocoMode: p.ocoMode === 'fill' ? 'fill' as const : 'trigger' as const } : {}),
        ...(lv.ocoLock ? { ocoLock: backgroundRowId(p.id, lv.ocoLock) } : {}),
        background: { programId: p.id, levelId: lv.id },
    };
}

/** Armed (or 待確認) background triggers as trigger rows: the pending list
 * and the chart lines. Fired, finished or stopped ones are not triggers any
 * more (their orders show in the orders list), like a fired window trigger. */
export function triggerRowsFromPrograms(programs: readonly OrderProgram[]): BackgroundTriggerOrder[] {
    const out: BackgroundTriggerOrder[] = [];
    for (const p of programs) {
        if (p.status === 'stopped' || p.status === 'stopping') continue;
        if (p.kind === 'bracket') {
            // #226 a bracket whose 觸價 entry did not fire yet is a trigger
            // carrying its plan, as in this window
            const e = bracketEntryWaiting(p);
            const r = e ? row(p, e) : null;
            if (r) out.push({ ...r, bracketPlan: planOf(p) });
            continue;
        }
        if (p.kind !== 'trigger') continue;
        for (const lv of p.levels) {
            const r = row(p, lv);
            if (r) out.push(r);
        }
    }
    return out;
}

/** The plan of a panel bracket's tiers (as the panel created it). */
export function planOf(p: OrderProgram): NonNullable<TriggerOrder['bracketPlan']> {
    const tiers = p.levels.filter(lv => lv.entry.type === 'tier')
        .sort((a, b) => (a.entry.type === 'tier' ? a.entry.index : 0) - (b.entry.type === 'tier' ? b.entry.index : 0));
    const rules = tiers.map(t => t.rules).find(Boolean);
    const trail = tiers.map(t => t.rules?.trail).find(Boolean);
    const be = rules?.breakeven;
    return {
        tiers: tiers.map(t => ({ quantity: t.qty, takeTicks: t.rules?.takeTicks ?? null })),
        stopTicks: rules?.stopTicks ?? 0,
        trail: trail ? { activateTicks: trail.activateTicks, distanceTicks: trail.distanceTicks, stepTicks: trail.stepTicks } : null,
        breakeven: be ? { afterTier: be.afterTier, offsetTicks: be.offsetTicks } : null,
    };
}

/** Safe to drop: nothing working, no unknown outcome, no position, and
 * stopped or every level done / disabled. */
export function programFinished(p: OrderProgram): boolean {
    // an order of unknown outcome stays until the 委託待確認 card decides it
    const busy = p.levels.some(lv => lv.position > 0 || lv.unprotected > 0 || lv.pending?.reason === 'unknownNotSent' || lv.orders.some(o =>
        o.status === 'pendingSubmit' || o.status === 'working' || (o.status === 'unknown' && !o.acknowledged)));
    if (busy) return false;
    return p.status === 'stopped' || p.levels.every(lv => lv.phase === 'done' || lv.phase === 'disabled');
}
