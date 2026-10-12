// src/lib/order-code-hints.ts — the contract an order was sent for, when
// this window did not send it (#201: the App's background engine sends from
// the desktop process, so no HTTP response tells the window its full code).
// A native futures New report can omit full_code; without it the order row
// is never created and its deals stay parked (持倉暫未套用, QA 10/12).

type Account = { broker_id?: string; account_id?: string } | null | undefined;
type Hint = (tradeId: string, account: Account) => string | null;
let hint: Hint | null = null;
const listeners = new Set<() => void>();

/** The background engine registers how to look up the orders it sent. */
export function setOrderCodeHint(fn: Hint | null): void {
    hint = fn;
}

export function orderCodeHint(tradeId: string, account?: Account): string | null {
    try {
        return hint?.(tradeId, account) ?? null;
    } catch {
        return null;
    }
}

/** The engine learned new order ids: reports parked for want of a code can
 * be tried again (a New report can arrive before the engine's snapshot). */
export function orderCodeHintsChanged(): void {
    listeners.forEach(l => l());
}

export function onOrderCodeHintsChanged(l: () => void): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}
