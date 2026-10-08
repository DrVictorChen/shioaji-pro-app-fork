// 可否融資／融券（閃電信用條件）：用 App 已有的 credit_enquire（籌碼卡在用）。
// 只有「確定不可」（成數或單位為 0）才擋；查詢失敗或欄位缺漏＝無法確認，不擋。
import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ post: vi.fn(), base: 'http://a' }));
vi.mock('./api', () => ({ apiPost: m.post }));
vi.mock('./runtime', () => ({ getApiBase: () => m.base }));
import { creditStatus, loadCreditEnquire, resetCreditEnquireCache, type CreditEnquire } from './credit-eligibility';

const row = (patch: Partial<CreditEnquire> = {}): CreditEnquire => ({
    stock_id: '2330', system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90, ...patch,
});
const stk = { code: '2330', security_type: 'STK', exchange: 'TSE' } as const;

beforeEach(() => {
    vi.useRealTimers();
    m.post.mockReset();
    m.base = 'http://a';
    resetCreditEnquireCache();
});

it('blocks only when the ratio or the unit is exactly 0', () => {
    expect(creditStatus(row(), 'MarginTrading')).toBe('ok');
    expect(creditStatus(row(), 'ShortSelling')).toBe('ok');
    expect(creditStatus(row({ margin_unit: 0 }), 'MarginTrading')).toBe('blocked');
    expect(creditStatus(row({ margin_loan_ratio: 0 }), 'MarginTrading')).toBe('blocked');
    expect(creditStatus(row({ short_unit: 0 }), 'ShortSelling')).toBe('blocked');
    expect(creditStatus(row({ short_margin_ratio: 0 }), 'ShortSelling')).toBe('blocked');
    // the other side does not matter
    expect(creditStatus(row({ short_unit: 0 }), 'MarginTrading')).toBe('ok');
    // negative units come back from the server (meaning unconfirmed) — not a definite 0
    expect(creditStatus(row({ margin_unit: -95, short_unit: -1 }), 'ShortSelling')).toBe('ok');
});

it('missing or malformed answers are "unknown", never blocked', () => {
    expect(creditStatus(undefined, 'MarginTrading')).toBe('unknown');
    expect(creditStatus(row({ short_unit: undefined as unknown as number }), 'ShortSelling')).toBe('unknown');
    expect(creditStatus(row({ margin_loan_ratio: 'x' as unknown as number }), 'MarginTrading')).toBe('unknown');
});

it('queries once per stock per day and server, and does not cache a failure', async () => {
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledOnce();
    expect(m.post.mock.calls[0]).toEqual(['/api/v1/data/credit_enquire', { contracts: [stk] }]);
    m.base = 'http://b';
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledTimes(2);
    m.post.mockRejectedValueOnce(new Error('down'));
    await expect(loadCreditEnquire({ ...stk, code: '2317' })).rejects.toThrow('down');
    m.post.mockResolvedValue([row({ stock_id: '2317' })]);
    await expect(loadCreditEnquire({ ...stk, code: '2317' })).resolves.toMatchObject({ stock_id: '2317' });
});

it('a new Taipei trading day queries again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-08T15:00:00+08:00'));
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    vi.setSystemTime(new Date('2026-10-09T08:30:00+08:00'));
    await loadCreditEnquire(stk);
    expect(m.post).toHaveBeenCalledTimes(2);
});

it('an empty answer, or one for another stock only, resolves to undefined (unknown)', async () => {
    m.post.mockResolvedValue([]);
    await expect(loadCreditEnquire(stk)).resolves.toBeUndefined();
    m.post.mockResolvedValue([row({ stock_id: '2317', short_unit: 0 })]);
    await expect(loadCreditEnquire({ ...stk, code: '2454' })).resolves.toBeUndefined();
});

it('a fresh load bypasses the cached answer and replaces it', async () => {
    m.post.mockResolvedValue([row()]);
    await loadCreditEnquire(stk);
    m.post.mockResolvedValue([row({ margin_unit: 0 })]);
    await expect(loadCreditEnquire(stk, { fresh: true })).resolves.toMatchObject({ margin_unit: 0 });
    await expect(loadCreditEnquire(stk)).resolves.toMatchObject({ margin_unit: 0 });
    expect(m.post).toHaveBeenCalledTimes(2);
});
