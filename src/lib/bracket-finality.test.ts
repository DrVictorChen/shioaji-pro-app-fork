// #177 — the window (TS) bracket uses the background engine's rule for when
// an entry order is over: a successful cancel report, or a final row in a
// listing refreshed now (update_status). Fills after that are anomalies:
// shown 未受保護, never protected. Inactive is still working.
import { describe, expect, it } from 'vitest';
import {
    allocatedFill,
    averageFillPrice,
    applyEntryFill,
    applyEntryOrderReport,
    applyEntryTrade,
    bracketPhase,
    listingRowFinality,
    needsAttention,
    protectionQuantity,
    unprotectedQuantity,
    type AccountRef,
    type BracketPlan,
} from './bracket-core';
import { normalizeOrderEvent } from './order-report';
import fixture from './fixtures/native-simulation-bracket-reports-1.7.6.json';
import shared from './bracket-finality-scenarios.json';
import type { Trade } from './types/order';

describe('shared with the background engine: is a listing row final?', () => {
    for (const c of shared.rows) {
        it(c.name, () => expect(listingRowFinality(c.row)).toBe(c.expect));
    }
});

const F: AccountRef = { account_type: 'F', broker_id: 'fixture-broker-F', account_id: 'fixture-account-F' };
const reports = (fixture as unknown[]).map(f => normalizeOrderEvent(f)!);
const raws = fixture as unknown as { state: string; data: Record<string, Record<string, unknown>> }[];

/** The entry's order report (fixture #1) as a Cancel with this op_code. */
function cancelReport(opCode: string) {
    const raw = raws[1]!;
    return normalizeOrderEvent({ ...raw, data: { [raw.state]: { ...raw.data[raw.state],
        operation: { op_type: 'Cancel', op_code: opCode, op_msg: opCode === '00' ? '' : '刪單失敗' } } } })!;
}

function plan(over: Partial<BracketPlan> = {}): BracketPlan {
    return {
        id: 'p', env: 'sim', account: F, market: 'futures', orderId: 'fixture-f1', seqno: 'fixture-f1',
        quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 2,
        stopPrice: 48000, takePrice: 48600, group: 'g', fills: {}, filled: 0, entryClosed: false, exit: null,
        issues: [], createdAt: 0, updatedAt: 0, ...over,
    };
}

function row(status: string, deals: { seq: string; quantity: number }[], cancelled: number): Trade {
    return {
        contract: { code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
        order: { id: 'fixture-f1', seqno: 'fixture-f1', ordno: 'o', action: 'Buy', price: 0, quantity: 2 },
        status: { id: 'fixture-f1', status, status_code: '00', order_quantity: 2, modified_price: 0, msg: '',
            deal_quantity: deals.reduce((s, d) => s + d.quantity, 0), cancel_quantity: cancelled,
            deals: deals.map((d, i) => ({ ...d, price: 100, ts: i + 1 })) },
    } as unknown as Trade;
}

describe('when the entry is over', () => {
    it('Inactive is still working, from the cache or a refreshed listing', () => {
        expect(applyEntryTrade(plan(), row('Inactive', [], 0), 1, 'cache').entryClosed).toBe(false);
        expect(applyEntryTrade(plan(), row('Inactive', [], 0), 1, 'refreshed').entryClosed).toBe(false);
    });

    it('a cache-only read never closes it; a refreshed final row does', () => {
        const cancelled = row('Cancelled', [{ seq: '000001', quantity: 1 }], 1);
        const cached = applyEntryTrade(plan(), cancelled, 1, 'cache');
        expect(cached.entryClosed).toBe(false);
        expect(cached.filled).toBe(1); // its fills still count
        const refreshed = applyEntryTrade(cached, cancelled, 2, 'refreshed');
        expect(refreshed.entryClosed).toBe(true);
        expect(protectionQuantity(refreshed)).toBe(1); // a fill before the close stays protected
        expect(unprotectedQuantity(refreshed)).toBe(0);
    });

    it('fills listed in the same refreshed row that closes it are protected, not anomalies', () => {
        const p = applyEntryTrade(plan(), row('Filled', [{ seq: '000001', quantity: 1 }, { seq: '000002', quantity: 1 }], 0), 1, 'refreshed');
        expect(p.entryClosed).toBe(true);
        expect(protectionQuantity(p)).toBe(2);
        expect(p.issues).toEqual([]);
    });

    it('a refreshed row whose counts contradict each other closes nothing and is flagged', () => {
        const p = applyEntryTrade(plan(), row('Cancelled', [], 1), 1, 'refreshed'); // one lot unaccounted
        expect(p.entryClosed).toBe(false);
        expect(p.issues.map(i => i.code)).toContain('report-mismatch');
    });

    it('only an explicitly successful cancel report closes it', () => {
        expect(applyEntryOrderReport(plan(), cancelReport('88'), 1).entryClosed).toBe(false);
        expect(applyEntryOrderReport(plan(), cancelReport(''), 1).entryClosed).toBe(false); // no code: no evidence
        expect(applyEntryOrderReport(plan(), cancelReport('00'), 1).entryClosed).toBe(true);
    });

    it('fills listed with whole-number string quantities count, as the engine reads them', () => {
        const t = row('Filled', [], 0);
        (t.status as { deals: unknown[] }).deals = [{ seq: '000001', quantity: '2', price: 100, ts: 1 }];
        (t.status as { deal_quantity: unknown }).deal_quantity = 2;
        const p = applyEntryTrade(plan(), t, 1, 'refreshed');
        expect([p.filled, p.entryClosed, protectionQuantity(p)]).toEqual([2, true, 2]);
    });
});

describe('a fill after the entry is over', () => {
    const cancelOk = cancelReport('00');

    it('from a deal report: counted once, 未受保護, never protected, needs attention', () => {
        let p = applyEntryOrderReport(plan(), cancelOk, 1);
        const deal = reports[0]!;
        const m = { orderId: 'fixture-f1', key: 'fixture-f1:000001', quantity: deal.quantity };
        p = applyEntryFill(p, m, 2);
        p = applyEntryFill(p, m, 3); // the same fill again
        expect(p.lateFilled).toBe(1);
        expect(protectionQuantity(p)).toBe(0);
        expect(unprotectedQuantity(p)).toBe(1);
        expect(bracketPhase(p)).toBe('closed');
        expect(needsAttention(p)).toBe(true);
        expect(p.issues.filter(i => i.code === 'fill-after-close')).toHaveLength(1);
    });

    it('found later by a listing: still an anomaly, protection unchanged', () => {
        let p = applyEntryTrade(plan(), row('PartFilled', [{ seq: '000001', quantity: 1 }], 0), 1, 'cache');
        p = applyEntryOrderReport(p, cancelOk, 2);
        expect(protectionQuantity(p)).toBe(1);
        p = applyEntryTrade(p, row('Filled', [{ seq: '000001', quantity: 1 }, { seq: '000002', quantity: 1 }], 0), 3, 'refreshed');
        expect(protectionQuantity(p)).toBe(1); // never grows after the close
        expect(unprotectedQuantity(p)).toBe(1);
        expect(p.issues.map(i => i.code)).toContain('fill-after-close');
    });

    it('a late fill never prices the protection', () => {
        let p = applyEntryFill(plan(), { orderId: 'fixture-f1', key: 'fixture-f1:000001', quantity: 1 }, 1); // no price
        p = applyEntryOrderReport(p, cancelOk, 2);
        p = applyEntryFill(p, { orderId: 'fixture-f1', key: 'fixture-f1:000002', quantity: 1, price: 120 }, 3);
        expect(averageFillPrice(p)).toBeNull();
    });

    it('tiers of one entry: never protected by any tier, reported once', () => {
        const tier = (index: number, offset: number) => plan({ id: `t${index}`, quantity: 1, entryClosed: true,
            tier: { index, count: 2, offset, entryQuantity: 2 } });
        const fill = { orderId: 'fixture-f1', key: 'fixture-f1:000009', quantity: 1 };
        const t0 = applyEntryFill(tier(0, 0), fill, 1);
        const t1 = applyEntryFill(tier(1, 1), fill, 1);
        expect([allocatedFill(t0), allocatedFill(t1)]).toEqual([0, 0]);
        expect([unprotectedQuantity(t0), unprotectedQuantity(t1)]).toEqual([1, 0]);
    });
});
