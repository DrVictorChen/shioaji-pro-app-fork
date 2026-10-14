// src/lib/order-trace.ts — debug-only trace of cancel/update order mutations (#244).
// Compiled in only when the build sets VITE_DEBUG_ORDER_TRACE=1: Vite replaces
// the env read with a literal, so every function below returns immediately and
// the minifier drops the bodies. Never records an identity number: account
// fields are booleans / shape only and server text is masked.
import type { Trade } from './types/order';

export const ORDER_TRACE_ENABLED: boolean = import.meta.env.VITE_DEBUG_ORDER_TRACE === '1';

export type OrderTraceEntry = 'flash cell' | 'flash 全刪' | 'orders tab' | 'other';
export type OrderTraceKind = 'cancel' | 'cancel_verified' | 'update_price' | 'update_qty';

export interface OrderTraceRecord {
    ts: string;
    kind: OrderTraceKind;
    entry: OrderTraceEntry;
    trade_id: string;
    seqno?: string; ordno?: string; code?: string; action?: string; price?: number; qty?: number; status?: string;
    custom_field_present?: boolean;
    report_only?: boolean;
    account?: { broker_id_present: boolean; account_id_tail: string; account_type: string; person_id_present: boolean; person_id_length: number };
    reconcile?: { ran: boolean; found_same_trade?: boolean; resolved_trade_id_changed?: boolean; person_id_present_after?: boolean };
    endpoint?: string;
    transport?: string;
    http_status?: number;
    error?: string;
    error_flags?: string[];
    summary?: string;
}

const MAX = 50;
const records: OrderTraceRecord[] = [];
const pendingEntry = new Map<string, OrderTraceEntry>();

/** National ID / ARC shapes and 10+ digit runs become ***. */
export function maskTraceText(text: string): string {
    return text.replace(/[A-Z]\d{9}/g, '***').replace(/\d{10,}/g, '***');
}

/** Callers that know their UI entry point tag the trade ids before cancelling. */
export function noteOrderTraceEntry(tradeIds: string[], entry: OrderTraceEntry) {
    if (!ORDER_TRACE_ENABLED) return;
    for (const id of tradeIds) pendingEntry.set(id, entry);
}

export function beginOrderTrace(kind: OrderTraceKind, tradeId: string): OrderTraceRecord | null {
    if (!ORDER_TRACE_ENABLED) return null;
    const entry = pendingEntry.get(tradeId) ?? 'other';
    pendingEntry.delete(tradeId);
    const record: OrderTraceRecord = { ts: new Date().toISOString(), kind, entry, trade_id: tradeId };
    records.push(record);
    if (records.length > MAX) records.splice(0, records.length - MAX);
    return record;
}

type AccountLike = { broker_id?: string; account_id?: string; account_type?: string; person_id?: string } | undefined | null;
export function accountShape(account: AccountLike): OrderTraceRecord['account'] {
    return {
        broker_id_present: !!account?.broker_id,
        account_id_tail: (account?.account_id ?? '').slice(-2),
        account_type: account?.account_type ?? '',
        person_id_present: !!account?.person_id,
        person_id_length: account?.person_id?.length ?? 0,
    };
}

export function traceTrade(record: OrderTraceRecord | null, trade: Trade, reportOnly: boolean, account: AccountLike) {
    if (!ORDER_TRACE_ENABLED || !record) return;
    const order = trade.order as Trade['order'] & { custom_field?: string };
    Object.assign(record, {
        seqno: order.seqno, ordno: order.ordno, code: trade.contract.target_code || trade.contract.code,
        action: order.action, price: order.price, qty: order.quantity, status: trade.status?.status,
        custom_field_present: !!order.custom_field, report_only: reportOnly, account: accountShape(account),
    });
}

export function traceSet(record: OrderTraceRecord | null, patch: Partial<OrderTraceRecord>) {
    if (!ORDER_TRACE_ENABLED || !record) return;
    Object.assign(record, patch);
}

/** Wraps an onResponse hook so the HTTP status is recorded. */
export function traceResponse(record: OrderTraceRecord | null, onResponse?: (res: Response) => void) {
    if (!ORDER_TRACE_ENABLED || !record) return onResponse;
    return (res: Response) => { record.http_status = res.status; onResponse?.(res); };
}

export async function finishOrderTrace<T>(record: OrderTraceRecord | null, pending: Promise<T>): Promise<T> {
    if (!ORDER_TRACE_ENABLED || !record) return pending;
    try {
        const value = await pending;
        const status = (value as { status?: { status?: string } } | null)?.status?.status;
        record.summary = `ok${status ? ` (${status})` : ''}`;
        emitTrace(record);
        return value;
    } catch (error) {
        const e = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>;
        if (typeof e.status === 'number') record.http_status ??= e.status;
        record.error = maskTraceText(error instanceof Error ? error.message : String(error));
        record.error_flags = ['mutationNotStarted', 'mutationOutcomeUnknown', 'tradingGateRejected', 'orderNotConnected']
            .filter(key => e[key] === true);
        if (typeof e.errorCode === 'string') record.error_flags.push(`errorCode=${maskTraceText(e.errorCode)}`);
        record.summary = e.mutationNotStarted === true ? 'not sent' : e.mutationOutcomeUnknown === true ? 'sent, outcome unknown' : 'failed';
        emitTrace(record);
        throw error;
    }
}

function emitTrace(record: OrderTraceRecord) {
    try { console.info('[order-trace]', JSON.stringify(record)); } catch { /* console unavailable */ }
}

export function getOrderTrace(): readonly OrderTraceRecord[] {
    return ORDER_TRACE_ENABLED ? records.slice() : [];
}

/** The 「Order trace」 section of the copied diagnostics; empty when disabled. */
export function orderTraceDiagnostics(): string {
    if (!ORDER_TRACE_ENABLED) return '';
    return `--- Order trace (last ${records.length}) ---\n${records.map(r => JSON.stringify(r)).join('\n') || '(none)'}`;
}

/** Test hook only. */
export function resetOrderTraceForTest() { records.length = 0; pendingEntry.clear(); }
