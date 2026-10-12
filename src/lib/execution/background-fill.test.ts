// #201 — the window learns about orders the background engine sent: the
// order code for its report pipeline, and a positions / orders read after a
// background fill (QA 10/12: 持倉暫未套用 banner and stale rows).
import { expect, it } from 'vitest';
import { backgroundFills, backgroundFillsIncreased, orderCodeOf } from './background-orders';
import type { OrderProgram } from './model';

const program = (id: string, orderId: string | null, filled: number, code = 'TXFJ6', accountId = 'a1') => ({
    id, binding: { account: { accountType: 'F', brokerId: 'b', accountId }, contract: { orderCode: code, quoteCode: 'TXFR1' } },
    levels: [{ orders: [{ key: 'k', orderId, filled }] }],
}) as unknown as OrderProgram;
const A1 = { broker_id: 'b', account_id: 'a1' };

it('orderCodeOf: the program of that account that sent the trade id', () => {
    expect(orderCodeOf([program('p', 'T1', 0)], 'T1', A1)).toBe('TXFJ6');
    expect(orderCodeOf([program('p', 'T1', 0)], 'T2', A1)).toBeNull();
    expect(orderCodeOf([program('p', null, 0)], '', A1)).toBeNull();
    // another account's program never names the contract
    expect(orderCodeOf([program('p', 'T1', 0, 'TXFJ6', 'other')], 'T1', A1)).toBeNull();
    // ambiguous: two programs, two codes → no answer
    expect(orderCodeOf([program('p', 'T1', 0), program('q', 'T1', 0, 'MXFJ6')], 'T1', A1)).toBeNull();
});

it('a fill is noticed per order, even when another program disappears in the same snapshot', () => {
    const before = backgroundFills([program('p', 'T1', 1), program('q', 'T2', 0)]);
    expect(backgroundFillsIncreased(before, backgroundFills([program('p', 'T1', 1), program('q', 'T2', 0)]))).toBe(false);
    // p (1 lot) removed, q fills 1: the total is unchanged but q filled
    expect(backgroundFillsIncreased(before, backgroundFills([program('q', 'T2', 1)]))).toBe(true);
    expect(backgroundFillsIncreased(before, backgroundFills([program('r', 'T3', 1)]))).toBe(true);
});
