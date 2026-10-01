import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ServerInfo } from './shioaji';

const m = vi.hoisted(() => ({
    accounts: [] as Account[], nativeFetch: vi.fn(), loading: vi.fn(), desktop: true,
}));
vi.mock('./runtime', () => ({ getApiBase: () => '', get isTauri() { return m.desktop; }, EXPECTED_SERVER_VERSION: '' }));
vi.mock('./account-store', () => ({
    getAccountState: () => ({ accounts: m.accounts }), accountFor: () => m.accounts[0],
    loadAccountsShared: async () => m.accounts,
}));
vi.mock('./features', () => ({ agentModule: null }));
vi.mock('./trading-state', () => ({ refreshTradingStateForModeChange: vi.fn() }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('./stream', () => ({}));
vi.mock('./tauri', () => ({}));
vi.mock('./window-role', () => ({}));
vi.mock('./frontend-ready', () => ({}));

let api: typeof import('./api');
let shioaji: typeof import('./shioaji');
let info: typeof import('./server-info-store');
let release: () => void;
const mode = (simulation: boolean | undefined) => info.observeServerInfo(info.beginServerInfoRequest(),
    simulation === undefined ? undefined : { simulation } as ServerInfo);

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    m.desktop = true;
    m.accounts = [{ account_type: 'F', broker_id: 'fixture', account_id: 'unsigned', signed: false, username: '', person_id: '' }];
    const ready = new Promise<void>(resolve => { release = resolve; });
    vi.doMock('@tauri-apps/plugin-http', async () => {
        m.loading();
        await ready;
        return { fetch: m.nativeFetch };
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    vi.stubGlobal('BroadcastChannel', undefined);
    api = await import('./api');
    shioaji = await import('./shioaji');
    info = await import('./server-info-store');
    mode(true);
    m.nativeFetch.mockImplementation(async () => new Response('{}'));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['production', 'unknown', 'roundtrip', 'removed', 'unsigned'] as const)(
    'rejects a trade subscription after %s during native module loading', async change => {
        // A stale signed selector must never override the current account row.
        const captured = { ...m.accounts[0]!, signed: true };
        if (change === 'unsigned') { m.accounts[0]!.signed = true; mode(false); }
        const pending = shioaji.subscribeTradeEvents(captured);
        const rejected = expect(pending).rejects.toThrow(/已變更|不可用/);
        await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
        if (change === 'removed') m.accounts = [];
        else if (change === 'unsigned') m.accounts[0]!.signed = false;
        else {
            mode(change === 'unknown' ? undefined : false);
            if (change === 'roundtrip') mode(true);
        }
        release();
        await rejected;
        expect(m.nativeFetch).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    },
);

it('keeps the boot health → subscription path guarded during native module loading', async () => {
    // Let health complete, then hold the subscription transport's await.
    const health = vi.spyOn(shioaji, 'fetchTradeCacheHealth').mockResolvedValue({
        reasons: [{ reason: 'NotSubscribed' }],
    } as Awaited<ReturnType<typeof shioaji.fetchTradeCacheHealth>>);
    const { subscribeTradeReports } = await import('./boot');
    const pending = subscribeTradeReports();
    const rejected = expect(pending).rejects.toThrow('已變更');
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    expect(health).toHaveBeenCalledOnce();
    mode(false);
    release();
    await rejected;
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each([true, false, undefined])('sends eligible trade subscriptions in mode %s', async simulation => {
    mode(simulation);
    m.accounts[0]!.signed = simulation !== true;
    const pending = shioaji.subscribeTradeEvents(m.accounts[0]!);
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    release();
    await pending;
    expect(m.nativeFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(m.nativeFetch.mock.calls[0]![1].body)).toEqual({
        broker_id: 'fixture', account_id: 'unsigned', account_type: 'F',
    });
    expect(m.accounts[0]!.signed).toBe(simulation !== true);
});

const paths = [
    '/api/v1/auth/subscribe_trade', '/api/v1/stream/subscribe', '/api/v1/stream/unsubscribe',
    ...['calculated_index', 'index_contribution', 'industry_contribution', 'index_components', 'scanner']
        .flatMap(capability => ['subscribe', 'unsubscribe'].map(action => `/api/v1/stream/${action}/${capability}`)),
];
it.each(paths)('rechecks the mode at native dispatch for %s', async path => {
    const pending = api.apiPost(path, {});
    const rejected = expect(pending).rejects.toThrow('已變更');
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(false);
    mode(true); // Same final mode, different generation.
    release();
    await rejected;
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each(paths)('rechecks the mode after browser request serialization for %s', async path => {
    m.desktop = false;
    await expect(api.apiPost(path, { toJSON() { mode(false); return {}; } })).rejects.toThrow('已變更');
    expect(fetch).not.toHaveBeenCalled();
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it('does not retry a capability subscription rejected at dispatch after a mode change', async () => {
    const pending = shioaji.subscribeMarketSignal('suspend', 'TSE');
    const rejected = expect(pending).rejects.toMatchObject({ subscriptionNotStarted: true });
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    mode(false);
    release();
    await rejected;
    expect(m.nativeFetch).not.toHaveBeenCalled();
});

it.each(paths)('sends a subscription request when the mode stays current for %s', async path => {
    const pending = api.apiPost(path, {});
    await vi.waitFor(() => expect(m.loading).toHaveBeenCalledOnce());
    release();
    await pending;
    expect(m.nativeFetch).toHaveBeenCalledOnce();
});
