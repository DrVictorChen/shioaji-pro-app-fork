// 閃電「對應商品」的純規則：照選取／現股／個股期，個股期的規格與月份、
// 近月到期自動換月、非個股暫停，以及價差對照的計算。
import { describe, expect, it } from 'vitest';
import type { ContractInfo } from './types/contract';
import {
    DEFAULT_FLASH_LINK,
    linkedStockCode,
    normalizeFlashLink,
    pickStockFuture,
    spreadOf,
    lotsPerContract,
    expiryTime,
    isStockFuture,
} from './flash-link';

const fut = (code: string, root: string, month: string, ltd: string, multiplier: number, target: string | null = null) => ({
    code, root, delivery_month: month, last_trading_date: ltd, multiplier, target_code: target,
    security_type: 'FUT', underlying_code: '2330', underlying_kind: 'S', name: `${root} ${month}`,
}) as unknown as ContractInfo;
const rows = [
    fut('CDFR1', 'CDF', '202610', '2026-10-21', 2000, 'CDFJ6'),
    fut('CDFK6', 'CDF', '202611', '2026-11-18', 2000),
    fut('CDFJ6', 'CDF', '202610', '2026-10-21', 2000),
    fut('CDFL6', 'CDF', '202612', '2026-12-16', 2000),
    fut('QFFJ6', 'QFF', '202610', '2026-10-21', 100),
    fut('QFFK6', 'QFF', '202611', '2026-11-18', 100),
];
const stdOnly = rows.filter(r => r.root === 'CDF');
// 2026-10-08 10:00 台北
const now = Date.UTC(2026, 9, 8, 2, 0);
const link = (patch: Partial<typeof DEFAULT_FLASH_LINK> = {}) => ({ ...DEFAULT_FLASH_LINK, kind: 'future' as const, ...patch });

describe('linkedStockCode', () => {
    it('a stock maps to itself, a stock future to its underlying, anything else is not a stock', () => {
        expect(linkedStockCode({ code: '2330', security_type: 'STK' } as ContractInfo)).toBe('2330');
        expect(linkedStockCode(rows[2]!)).toBe('2330');
        expect(linkedStockCode({ code: 'TXFR1', security_type: 'FUT', underlying_code: 'IX0001', underlying_kind: 'I' } as ContractInfo)).toBeNull();
        expect(linkedStockCode({ code: 'TSE001', security_type: 'IND' } as ContractInfo)).toBeNull();
        expect(linkedStockCode({ code: 'TXO', security_type: 'OPT', underlying_code: '2330', underlying_kind: 'S' } as ContractInfo)).toBeNull();
    });
});

describe('normalizeFlashLink', () => {
    it('defaults to 照選取, standard spec, near month, spread row on', () => {
        expect(normalizeFlashLink(undefined)).toEqual({ kind: 'select', spec: 'std', month: 'near', ref: true });
        expect(normalizeFlashLink({ kind: 'bogus', spec: 'x', month: '20261', ref: 'no' })).toEqual({ kind: 'select', spec: 'std', month: 'near', ref: true });
        expect(normalizeFlashLink({ kind: 'future', spec: 'mini', month: '202612', ref: false })).toEqual({ kind: 'future', spec: 'mini', month: '202612', ref: false });
    });
});

describe('pickStockFuture', () => {
    it('near month is the earliest real month (never the R1 alias)', () => {
        const r = pickStockFuture(rows, link(), now);
        expect(r).toMatchObject({ status: 'ok', contract: { code: 'CDFJ6' }, hasMini: true, expiresToday: false });
    });
    it('next month and a chosen month', () => {
        expect(pickStockFuture(rows, link({ month: 'next' }), now)).toMatchObject({ contract: { code: 'CDFK6' } });
        expect(pickStockFuture(rows, link({ month: '202612' }), now)).toMatchObject({ contract: { code: 'CDFL6' } });
    });
    it('mini spec picks the smaller multiplier; a stock without a mini says so instead of using standard', () => {
        expect(pickStockFuture(rows, link({ spec: 'mini' }), now)).toMatchObject({ contract: { code: 'QFFJ6' } });
        expect(pickStockFuture(stdOnly, link({ spec: 'mini' }), now)).toEqual({ status: 'noMini' });
        expect(pickStockFuture(stdOnly, link(), now)).toMatchObject({ hasMini: false });
    });
    it('no futures at all', () => {
        expect(pickStockFuture([], link(), now)).toEqual({ status: 'none' });
    });
    it('last trading day: 今日到期 before the close, rolls to the next month after it', () => {
        const day = Date.UTC(2026, 9, 21, 3, 0); // 11:00 台北
        expect(pickStockFuture(rows, link(), day)).toMatchObject({ contract: { code: 'CDFJ6' }, expiresToday: true });
        const after = Date.UTC(2026, 9, 21, 6, 0); // 14:00 台北
        expect(pickStockFuture(rows, link(), after)).toMatchObject({ contract: { code: 'CDFK6' }, expiresToday: false });
        expect(pickStockFuture(rows, link({ month: 'next' }), after)).toMatchObject({ contract: { code: 'CDFL6' } });
    });
    it('a chosen month that has expired is reported, never replaced', () => {
        const later = Date.UTC(2026, 9, 22, 2, 0);
        expect(pickStockFuture(rows, link({ month: '202610' }), later)).toEqual({ status: 'expired', month: '202610' });
    });
    it('lists the live months of the chosen spec for the picker', () => {
        const r = pickStockFuture(rows, link(), now);
        expect(r.status === 'ok' && r.months).toEqual(['202610', '202611', '202612']);
    });
});

describe('stock futures only', () => {
    it('ETF futures are not stock futures: an ETF has no 個股期', () => {
        const etf = [{ ...fut('NYFJ6', 'NYF', '202610', '2026-10-21', 10000), spec_kind: 'etf_fut', underlying_code: '0050' } as ContractInfo];
        expect(pickStockFuture(etf, link(), now)).toEqual({ status: 'none' });
    });
    it('a chosen month that is simply not listed is not called expired', () => {
        expect(pickStockFuture(rows, link({ month: '202704' }), now)).toEqual({ status: 'unlisted', month: '202704' });
    });
    it('expiry instant is 13:30 Taipei on the last trading day', () => {
        expect(expiryTime(rows[2]!)).toBe(Date.UTC(2026, 9, 21, 5, 30));
    });
    it('the picked contract carries the instant its pick goes stale', () => {
        const r = pickStockFuture(rows, link(), now);
        expect(r.status === 'ok' && r.expiresAt).toBe(Date.UTC(2026, 9, 21, 5, 30));
        // 次月 (11 月) changes to 12 月 when the near month expires, not at its own expiry
        const next = pickStockFuture(rows, link({ month: 'next' }), now);
        expect(next.status === 'ok' && next.expiresAt).toBe(Date.UTC(2026, 9, 21, 5, 30));
        // a chosen month is valid until its own expiry
        const chosen = pickStockFuture(rows, link({ month: '202611' }), now);
        expect(chosen.status === 'ok' && chosen.expiresAt).toBe(Date.UTC(2026, 10, 18, 5, 30));
    });
    it('an ETF future is not a stock future anywhere', () => {
        expect(isStockFuture({ security_type: 'FUT', underlying_kind: 'S', underlying_code: '0050', spec_kind: 'etf_fut' } as ContractInfo)).toBe(false);
        expect(linkedStockCode({ code: 'NYFJ6', security_type: 'FUT', underlying_kind: 'S', underlying_code: '0050', spec_kind: 'etf_fut' } as ContractInfo)).toBeNull();
    });
});

describe('spread row', () => {
    it('difference and percentage against the base; missing side → null', () => {
        expect(spreadOf(1080, 1085)).toEqual({ diff: -5, pct: -5 / 1085 * 100 });
        expect(spreadOf(null, 1085)).toBeNull();
        expect(spreadOf(1080, 0)).toBeNull();
    });
    it('1 口 in 張 (or 股 for a mini)', () => {
        expect(lotsPerContract(2000)).toBe('1口=2張');
        expect(lotsPerContract(100)).toBe('1口=100股');
        expect(lotsPerContract(undefined)).toBe('');
    });
});
