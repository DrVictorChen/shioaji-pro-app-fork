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
export function backgroundEligible(t: NewTrigger, contract: ContractBase | undefined): boolean {
    if (t.kind !== 'stop' && t.kind !== 'take') return false;
    // #226 options the background engine does not have yet
    if (t.time || t.bracketPlan || t.ocoMode) return false;
    if (t.group || t.bracketId || (t.orderLot && t.orderLot !== 'Common')) return false;
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
        background: { programId: p.id, levelId: lv.id },
    };
}

/** Armed (or 待確認) background triggers as trigger rows: the pending list
 * and the chart lines. Fired, finished or stopped ones are not triggers any
 * more (their orders show in the orders list), like a fired window trigger. */
export function triggerRowsFromPrograms(programs: readonly OrderProgram[]): BackgroundTriggerOrder[] {
    const out: BackgroundTriggerOrder[] = [];
    for (const p of programs) {
        if (p.kind !== 'trigger' || p.status === 'stopped' || p.status === 'stopping') continue;
        for (const lv of p.levels) {
            const r = row(p, lv);
            if (r) out.push(r);
        }
    }
    return out;
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
