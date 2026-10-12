// src/lib/execution/background-orders.ts — what the window needs to know about
// the orders the background engine sent (#201), pure.

import type { OrderProgram } from './model';

/** The order code a background program sent `tradeId` for (the window's
 * report pipeline cannot learn it from a native New report alone). */
export function orderCodeOf(list: readonly OrderProgram[], tradeId: string): string | null {
    if (!tradeId) return null;
    for (const p of list) {
        for (const lv of p.levels) {
            if (lv.orders.some(o => o.orderId === tradeId)) return p.binding.contract.orderCode || null;
        }
    }
    return null;
}

/** Lots filled across every background order (rises with each fill). */
export function backgroundFillCount(list: readonly OrderProgram[]): number {
    let n = 0;
    for (const p of list) for (const lv of p.levels) for (const o of lv.orders) n += o.filled;
    return n;
}
