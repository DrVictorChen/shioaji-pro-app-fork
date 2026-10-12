// src/lib/execution/background-orders.ts — what the window needs to know about
// the orders the background engine sent (#201), pure.

import type { OrderProgram } from './model';

/** The order code a background program sent `tradeId` for (the window's
 * report pipeline cannot learn it from a native New report alone). Only a
 * program of the report's account counts, and only one answer: several
 * programs claiming the id with different codes give none. */
export function orderCodeOf(list: readonly OrderProgram[], tradeId: string,
    account?: { broker_id?: string; account_id?: string } | null): string | null {
    if (!tradeId) return null;
    const codes = new Set<string>();
    for (const p of list) {
        const a = p.binding.account;
        if (account && (a.brokerId !== account.broker_id || a.accountId !== account.account_id)) continue;
        if (p.levels.some(lv => lv.orders.some(o => o.orderId === tradeId)) && p.binding.contract.orderCode) codes.add(p.binding.contract.orderCode);
    }
    return codes.size === 1 ? [...codes][0]! : null;
}

/** Fills per background order (program + slot key). */
export function backgroundFills(list: readonly OrderProgram[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const p of list) for (const lv of p.levels) for (const o of lv.orders) out.set(`${p.id}/${o.key}`, o.filled);
    return out;
}

/** Some background order filled more than before (a removed program does
 * not hide another one's fill). */
export function backgroundFillsIncreased(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): boolean {
    for (const [key, filled] of after) if (filled > (before.get(key) ?? 0)) return true;
    return false;
}
