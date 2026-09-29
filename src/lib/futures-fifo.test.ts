import { describe, expect, it } from 'vitest';
import { collectFills, consumeFifo, fifoPosition as fifoAt, hasTwoWayFills, tradingDayStart, type FifoFill } from './futures-fifo';
import type { Action, Deal, Trade } from './types/order';

const trade = (id: string, action: Action, deals: Deal[], code = 'MXFI6', target: string | null = null, status = 'Filled'): Trade => ({
    contract: { code, target_code: target } as Trade['contract'],
    order: { id, seqno: id, ordno: id, action, price: 0, quantity: deals.reduce((s, d) => s + d.quantity, 0) },
    status: { id, status, status_code: '', order_quantity: 0, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, msg: '', deals },
}) as Trade;
const deal = (seq: string, price: number, quantity: number, ts: number): Deal => ({ seq, price, quantity, ts });
const row = (direction: Action, quantity: number, price: number, last_price: number) => ({ direction, quantity, price, last_price });
const fill = (key: string, action: Action, price: number, quantity: number, ts: number): FifoFill => {
    const [orderId = key, seq = '1'] = key.split(':');
    return { key, orderId, seq, action, price, quantity, ts };
};
// Rows' shared last price as the mark (the panel passes its live last price).
const fifoPosition = (rows: ReturnType<typeof row>[], fills: FifoFill[], multiplier: number) =>
    fifoAt(rows, fills, multiplier, rows[0]!.last_price);

describe('collectFills', () => {
    it('keeps the exact contract, resolves continuous aliases and sorts by fill time', () => {
        const fills = collectFills([
            trade('b', 'Buy', [deal('3', 45513, 1, 30)], 'MXFR1', 'MXFI6'),
            trade('a', 'Sell', [deal('1', 45546, 1, 10), deal('2', 45559, 1, 20)]),
            trade('x', 'Buy', [deal('9', 45000, 1, 5)], 'MXFJ6'),
        ], 'MXFI6');
        expect(fills?.map(f => [f.key, f.action, f.price])).toEqual([
            ['a:1', 'Sell', 45546], ['a:2', 'Sell', 45559], ['b:3', 'Buy', 45513],
        ]);
    });

    it('counts a deal seen in both the snapshot and a live report once', () => {
        const snapshot = trade('a', 'Sell', [deal('1', 100, 1, 10)], 'MXFI6', null, 'PartFilled');
        const live = trade('a', 'Sell', [deal('1', 100, 1, 10), deal('2', 101, 1, 11), deal('2', 101, 1, 11)]);
        expect(collectFills([snapshot, live], 'MXFI6')?.map(f => f.key)).toEqual(['a:1', 'a:2']);
    });

    it('refuses a fill without a finite time instead of sorting it first', () => {
        expect(collectFills([trade('a', 'Sell', [deal('1', 100, 1, Number.NaN)])], 'MXFI6')).toBeNull();
        expect(collectFills([trade('a', 'Sell', [{ seq: '1', price: 100, quantity: 1 } as Deal])], 'MXFI6')).toBeNull();
    });

    it('breaks same-time ties by exchange seq within one order only; refuses ties it cannot order', () => {
        const bySeq = collectFills([trade('a', 'Sell', [deal('000002', 45559, 1, 10), deal('000001', 45546, 1, 10)])], 'MXFI6');
        expect(bySeq?.map(f => f.price)).toEqual([45546, 45559]);
        // Exchange seq counts per order (both orders' first fill is 000001), so it cannot order two orders.
        expect(collectFills([
            trade('b', 'Sell', [deal('000001', 45559, 1, 10)]), trade('a', 'Sell', [deal('000001', 45546, 1, 10)]),
        ], 'MXFI6')).toBeNull();
        // Same side and price: order does not change the result.
        expect(collectFills([
            trade('b', 'Sell', [deal('000001', 45546, 1, 10)]), trade('a', 'Sell', [deal('000001', 45546, 1, 10)]),
        ], 'MXFI6')).toHaveLength(2);
    });

    it('drops fills from an earlier trading day (/order/trades returns the previous session)', () => {
        const since = 1000;
        const fills = collectFills([
            trade('old', 'Buy', [deal('1', 45000, 1, 999)]),
            trade('a', 'Sell', [deal('1', 45546, 1, 1000)]), trade('b', 'Buy', [deal('1', 45513, 1, 1001)]),
        ], 'MXFI6', since);
        expect(fills?.map(f => f.key)).toEqual(['a:1', 'b:1']);
        expect(hasTwoWayFills([trade('old', 'Buy', [deal('1', 45000, 1, 999)]), trade('a', 'Sell', [deal('1', 45546, 1, 1000)])], 'MXFI6', since)).toBe(false);
        // An old combo fill does not block today's FIFO either.
        expect(collectFills([trade('a', 'Sell', [deal('1', 45546, 1, 1000)]), trade('s', 'Buy', [deal('1', 30, 1, 5)], 'MXFI6/J6')], 'MXFI6', since)).toHaveLength(1);
    });

    it('refuses when a spread/combo fill touches this contract under another code', () => {
        const own = trade('a', 'Sell', [deal('1', 45546, 1, 1)]);
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MXFI6/J6')], 'MXFI6')).toBeNull();
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MX4I6/MXFI6')], 'MXFI6')).toBeNull();
        // a combo on other months, or one without fills, does not matter
        expect(collectFills([own, trade('s', 'Buy', [deal('2', 30, 1, 2)], 'MXFJ6/K6')], 'MXFI6')).toHaveLength(1);
        expect(collectFills([own, trade('s', 'Buy', [], 'MXFI6/J6', null, 'Submitted')], 'MXFI6')).toHaveLength(1);
    });

    it('ignores empty deals but refuses a fill it cannot identify', () => {
        expect(collectFills([trade('a', 'Buy', [deal('1', 100, 0, 1)], 'MXFI6', null, 'Cancelled')], 'MXFI6')).toEqual([]);
        expect(collectFills([trade('a', 'Buy', [deal('', 100, 1, 1)])], 'MXFI6')).toBeNull();
    });
});

describe('tradingDayStart', () => {
    // Taipei is UTC+8; the night session opening 15:00 belongs to the next trading day.
    const tpe = (iso: string) => Date.parse(`${iso}+08:00`) / 1000;
    it.each([
        ['2026-09-23T10:00:00', '2026-09-22T15:00:00'], // Wed day session
        ['2026-09-23T15:00:00', '2026-09-23T15:00:00'], // Wed night session opens Thu's trading day
        ['2026-09-24T03:00:00', '2026-09-23T15:00:00'], // after midnight, same night session
        ['2026-09-23T14:00:00', '2026-09-22T15:00:00'], // after the day close, before the night open
        ['2026-09-28T09:00:00', '2026-09-25T15:00:00'], // Monday: Friday's night session
        ['2026-09-26T04:00:00', '2026-09-25T15:00:00'], // Saturday early: still Friday's night session
    ])('%s → %s', (now, start) => {
        expect(tradingDayStart(tpe(now))).toBe(tpe(start));
    });
});

describe('fifoPosition', () => {
    it('matches eLeader on the reported case: 空 1 @ 45559, +1350', () => {
        // Broker rows are not netted intra-session: Sell 2 @ 45552.5 and Buy 1 @ 45513.
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        const fills = [fill('a:1', 'Sell', 45546, 1, 10), fill('a:2', 'Sell', 45559, 1, 20), fill('b:3', 'Buy', 45513, 1, 30)];
        expect(fifoPosition(rows, fills, 50)).toEqual({
            net: -1, avg: 45559, pnl: 1350, lots: [{ action: 'Sell', price: 45559, quantity: 1 }], seeded: false,
        });
    });

    it('also works on rows the live projection already netted at the average', () => {
        // applyPositionFill closes the buy against the Sell 2 @ 45552.5 row.
        const fills = [fill('a:1', 'Sell', 45546, 1, 10), fill('a:2', 'Sell', 45559, 1, 20), fill('b:3', 'Buy', 45513, 1, 30)];
        expect(fifoPosition([row('Sell', 1, 45552.5, 45532)], fills, 50)).toMatchObject({ net: -1, avg: 45559, pnl: 1350, seeded: false });
    });

    it('accepts a broker net row priced at the FIFO lot after reload', () => {
        // Only today's fills and the reloaded position row remain. The broker
        // nets Sell 2 @ 48065 / Buy 1 @ 48053 to Sell 1 @ 48053 (FIFO).
        const fills = [fill('a:1', 'Sell', 48077, 1, 10), fill('b:1', 'Sell', 48053, 1, 20), fill('c:1', 'Buy', 48053, 1, 30)];
        expect(fifoPosition([row('Sell', 1, 48053, 48040)], fills, 50)).toEqual({
            net: -1, avg: 48053, pnl: 650, lots: [{ action: 'Sell', price: 48053, quantity: 1 }], seeded: false,
        });
        expect(fifoPosition([row('Sell', 1, 48060, 48040)], fills, 50)).toBeNull();
    });

    it('a hidden buy/sell pair that balances quantities is caught by the row price', () => {
        // Visible: Buy 100, Buy 101, Sell 110 (FIFO would say long 1 @ 101). Hidden: Buy 105, Sell 106.
        // Live-netted row: Buy 1 @ 102.75, not the average replay's 100.5.
        const fills = [fill('a:1', 'Buy', 100, 1, 1), fill('b:1', 'Buy', 101, 1, 2), fill('c:1', 'Sell', 110, 1, 3)];
        expect(fifoPosition([row('Buy', 1, 102.75, 104)], fills, 10)).toBeNull();
        // Without the hidden pair the netted row is 100.5 and FIFO applies.
        expect(fifoPosition([row('Buy', 1, 100.5, 104)], fills, 10)).toMatchObject({ net: 1, avg: 101, pnl: 30, seeded: false });
    });

    it('a missing fill is indistinguishable from a carried lot, so the result is marked seeded', () => {
        // Sell @45559 not loaded: the rows' extra sell is seeded as a prior-session lot.
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        const r = fifoPosition(rows, [fill('a:1', 'Sell', 45546, 1, 10), fill('b:3', 'Buy', 45513, 1, 30)], 50);
        expect(r?.seeded).toBe(true);
    });

    it('seeds lots carried from earlier sessions as the oldest, at the rows\' remaining cost', () => {
        // Carried long 2 @ 100; today buy 1 @ 110 then sell 1 @ 120 closes a carried lot.
        const rows = [row('Buy', 2, 100, 115), row('Buy', 1, 110, 115), row('Sell', 1, 120, 115)];
        const fills = [fill('a:1', 'Buy', 110, 1, 1), fill('b:1', 'Sell', 120, 1, 2)];
        expect(fifoPosition(rows, fills, 50)).toEqual({
            net: 2, avg: 105, pnl: 1000,
            lots: [{ action: 'Buy', price: 100, quantity: 1 }, { action: 'Buy', price: 110, quantity: 1 }], seeded: true,
        });
    });

    it('works from partial fills of a later-cancelled order', () => {
        const fills = collectFills([
            trade('a', 'Sell', [deal('1', 100, 1, 1), deal('2', 101, 1, 2)], 'MXFI6', null, 'Cancelled'),
            trade('b', 'Buy', [deal('1', 99, 1, 3)]),
        ], 'MXFI6')!;
        const r = fifoPosition([row('Sell', 2, 100.5, 98), row('Buy', 1, 99, 98)], fills, 10);
        expect(r).toMatchObject({ net: -1, avg: 101, pnl: 30 });
    });

    it('reverses through zero: the remainder of a larger fill opens the other side', () => {
        const rows = [row('Sell', 2, 100, 95), row('Buy', 3, 90, 95)];
        const fills = [fill('a:1', 'Sell', 100, 2, 1), fill('b:1', 'Buy', 90, 3, 2)];
        expect(fifoPosition(rows, fills, 10)).toEqual({
            net: 1, avg: 90, pnl: 50, lots: [{ action: 'Buy', price: 90, quantity: 1 }], seeded: false,
        });
    });

    it('rounds P&L to whole dollars', () => {
        const rows = [row('Sell', 3, 45568.33, 45532), row('Buy', 1, 45513, 45532)];
        const fills = [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Sell', 45559, 1, 2), fill('c', 'Sell', 45600, 1, 3), fill('d', 'Buy', 45513, 1, 4)];
        expect(fifoPosition(rows, fills, 50)).toMatchObject({ net: -2, avg: 45579.5, pnl: 4750 });
        expect(fifoPosition([row('Buy', 2, 100.1, 100.4), row('Sell', 1, 100.2, 100.4)],
            [fill('a', 'Buy', 100, 1, 1), fill('b', 'Buy', 100.2, 1, 2), fill('c', 'Sell', 100.2, 1, 3)], 3)).toMatchObject({ pnl: 1 });
    });

    it('returns null when rows and fills disagree so the caller can fall back', () => {
        const rows = [row('Sell', 2, 45552.5, 45532), row('Buy', 1, 45513, 45532)];
        // more buys filled than the rows hold
        expect(fifoPosition(rows, [fill('a', 'Buy', 45513, 2, 1)], 50)).toBeNull();
        // no fills at all: both sides would have to be carried
        expect(fifoPosition(rows, [], 50)).toBeNull();
        // a buy/sell pair missing: rows hold more of each side than today filled
        expect(fifoPosition([row('Sell', 2, 45552.5, 45532), row('Buy', 2, 45520, 45532)],
            [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Buy', 45513, 1, 2)], 50)).toBeNull();
        // prices must follow from the fills too: un-netted rows whose cost differs
        expect(fifoPosition([row('Sell', 2, 45560, 45532), row('Buy', 1, 45513, 45532)],
            [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Sell', 45559, 1, 2), fill('c', 'Buy', 45513, 1, 3)], 50)).toBeNull();
        // carried lots on netted rows cannot be priced
        expect(fifoPosition([row('Buy', 2, 103.33, 115)], [fill('a', 'Buy', 110, 1, 1), fill('b', 'Sell', 120, 1, 2)], 50)).toBeNull();
        // unknown multiplier
        expect(fifoPosition(rows, [fill('a', 'Sell', 45546, 1, 1), fill('b', 'Sell', 45559, 1, 2), fill('c', 'Buy', 45513, 1, 3)], 0)).toBeNull();
    });
});

describe('consumeFifo (shared with the position projection, #85)', () => {
    it('closes the oldest lots first and splits a partly closed lot', () => {
        const lots = [{ price: 48520, quantity: 1 }, { price: 48525, quantity: 2 }];
        expect(consumeFifo(lots, 2)).toEqual({ open: [{ price: 48525, quantity: 1 }],
            closed: [{ price: 48520, quantity: 1 }, { price: 48525, quantity: 1 }] });
        expect(lots).toHaveLength(2); // input untouched
        expect(consumeFifo(lots, 5).open).toEqual([]);
        expect(consumeFifo(lots, 0)).toEqual({ open: lots, closed: [] });
    });
    it('agrees with the Flash replay on the live-QA reproduction', async () => {
        const { applyPositionFill } = await import('./portfolio-projection');
        const owner = { account_type: 'F', broker_id: 'b', account_id: 'a', person_id: '', signed: true, username: '' };
        const base = { key: '', tradeId: '', account: owner, code: 'TXFJ6', ts: 1, condition: '', openClose: 'New' };
        let rows = applyPositionFill([], { ...base, key: '1', action: 'Buy', quantity: 1, price: 48520 }, 200)!;
        rows = applyPositionFill(rows, { ...base, key: '2', action: 'Buy', quantity: 1, price: 48525 }, 200, 48525)!;
        // Flash replay sees the un-netted rows (New Sell opens its own row).
        const flash = fifoAt([row('Buy', 2, 48522.5, 48523), row('Sell', 1, 48523, 48523)], [
            fill('1', 'Buy', 48520, 1, 1), fill('2', 'Buy', 48525, 1, 2), fill('3', 'Sell', 48523, 1, 3)], 200, 48523)!;
        rows = applyPositionFill(rows, { ...base, key: '3', action: 'Sell', quantity: 1, price: 48523, openClose: 'Cover' }, 200, 48523)!;
        expect(flash).toMatchObject({ net: 1, avg: 48525, pnl: -400 });
        expect(rows[0]).toMatchObject({ quantity: 1, price: flash.avg, pnl: flash.pnl });
    });
});
