// #201 — the window learns about orders the background engine sent: the
// order code for its report pipeline, and a positions / orders read after a
// background fill (QA 10/12: 持倉暫未套用 banner and stale rows).
import { expect, it } from 'vitest';
import { backgroundFillCount, orderCodeOf } from './background-orders';
import type { OrderProgram } from './model';

const program = (orderId: string | null, filled: number) => ({
    id: 'p', binding: { contract: { orderCode: 'TXFJ6', quoteCode: 'TXFR1' } },
    levels: [{ orders: [{ key: 'k', orderId, filled }] }],
}) as unknown as OrderProgram;

it('orderCodeOf: the program that sent the trade id', () => {
    expect(orderCodeOf([program('T1', 0)], 'T1')).toBe('TXFJ6');
    expect(orderCodeOf([program('T1', 0)], 'T2')).toBeNull();
    expect(orderCodeOf([program(null, 0)], '')).toBeNull();
});

it('backgroundFillCount rises with each fill', () => {
    expect(backgroundFillCount([program('T1', 0)])).toBe(0);
    expect(backgroundFillCount([program('T1', 1), program('T2', 2)])).toBe(3);
});
