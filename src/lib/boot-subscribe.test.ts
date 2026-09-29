import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accounts: vi.fn(), health: vi.fn(), subscribe: vi.fn(), notify: vi.fn(),
}));
vi.mock('./features', () => ({ agentModule: null }));
vi.mock('./runtime', () => ({ EXPECTED_SERVER_VERSION: '', isTauri: false }));
vi.mock('./shioaji', () => ({
    fetchAccounts: mocks.accounts,
    fetchTradeCacheHealth: mocks.health,
    subscribeTradeEvents: mocks.subscribe,
}));
vi.mock('./trade', () => ({ notify: mocks.notify }));
vi.mock('./stream', () => ({}));
vi.mock('./tauri', () => ({}));
vi.mock('./window-role', () => ({}));

import { subscribeTradeReports } from './boot';

const stock = { account_type: 'S', broker_id: 'fixture', account_id: 'stock', signed: true };
const futures = { account_type: 'F', broker_id: 'fixture', account_id: 'futures', signed: true };
const health = (reason?: string) => ({
    state: reason ? 'Unknown' : 'Healthy',
    reasons: reason ? [{ event_type: 'StockOrder', reason }] : [],
});
function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.accounts.mockResolvedValue([stock, futures]);
    mocks.health.mockResolvedValue(health());
    mocks.subscribe.mockResolvedValue(undefined);
});

describe('subscribeTradeReports', () => {
    it('preserves existing subscriptions on cached login', async () => {
        await subscribeTradeReports();
        expect(mocks.health.mock.calls).toEqual([['S', stock], ['F', futures]]);
        expect(mocks.subscribe).not.toHaveBeenCalled();
    });

    it('subscribes only accounts with a NotSubscribed reason', async () => {
        mocks.health.mockResolvedValueOnce(health('NoBaseline'))
            .mockResolvedValueOnce(health('NotSubscribed'));
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual([[futures]]);
    });

    it('falls back to subscribe when health fails or the route is absent', async () => {
        mocks.health.mockRejectedValueOnce(new Error('404 Not Found'))
            .mockRejectedValueOnce(new Error('connection reset'));
        await subscribeTradeReports();
        expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]);
    });

    it('checks and subscribes multiple accounts in sequence', async () => {
        const first = deferred();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.subscribe.mockImplementationOnce(() => first.promise);
        const run = subscribeTradeReports();
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        expect(mocks.health.mock.calls).toEqual([['S', stock]]);
        first.resolve();
        await run;
        expect(mocks.health.mock.calls).toEqual([['S', stock], ['F', futures]]);
        expect(mocks.subscribe.mock.calls).toEqual([[stock], [futures]]);
    });

    it('shares an in-flight check across callers', async () => {
        const first = deferred();
        mocks.health.mockResolvedValue(health('NotSubscribed'));
        mocks.subscribe.mockImplementationOnce(() => first.promise);
        const a = subscribeTradeReports();
        const b = subscribeTradeReports();
        expect(b).toBe(a);
        await vi.waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1));
        first.resolve();
        await Promise.all([a, b]);
        expect(mocks.accounts).toHaveBeenCalledTimes(1);
        expect(mocks.subscribe).toHaveBeenCalledTimes(2);
    });
});
