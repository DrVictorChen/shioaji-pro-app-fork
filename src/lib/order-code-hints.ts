// src/lib/order-code-hints.ts — the contract an order was sent for, when
// this window did not send it (#201: the App's background engine sends from
// the desktop process, so no HTTP response tells the window its full code).
// A native futures New report can omit full_code; without it the order row
// is never created and its deals stay parked (持倉暫未套用, QA 10/12).

type Hint = (tradeId: string) => string | null;
let hint: Hint | null = null;

/** The background engine registers how to look up the orders it sent. */
export function setOrderCodeHint(fn: Hint | null): void {
    hint = fn;
}

export function orderCodeHint(tradeId: string): string | null {
    try {
        return hint?.(tradeId) ?? null;
    } catch {
        return null;
    }
}
