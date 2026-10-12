// src/lib/boot-early-stream.test.ts — bootstrap opens the quote/order stream
// early only in the main window, only on the reload a timing run triggered
// after the server was healthy (#142)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
    child: false,
    navType: 'reload' as string,
    ensureStream: vi.fn(),
    holdStream: vi.fn(),
    releaseStream: vi.fn(),
    startTrading: vi.fn(),
}));
vi.mock('./runtime', async (orig) => ({ ...(await orig<object>()), isTauri: true }));
vi.mock('./window-role', () => ({ isChildWindow: () => m.child }));
vi.mock('./features', () => ({ agentModule: undefined }));
vi.mock('./stream', () => ({ ensureStream: m.ensureStream, holdStream: m.holdStream, releaseStream: m.releaseStream, onOrderEvent: vi.fn(), getStreamStatus: () => 'disconnected', subscribeStatusStore: vi.fn() }));
vi.mock('./trade', () => ({ notify: vi.fn(), logNotice: vi.fn() }));
vi.mock('./frontend-ready', () => ({ appReadySignals: () => [], watchFrontendReady: vi.fn(), startStallProbe: vi.fn() }));
vi.mock('./trading-state', () => ({ startTradingState: m.startTrading }));
vi.mock('./account-store', () => ({ ensureAccounts: vi.fn(), loadAccountsShared: vi.fn() }));
vi.mock('./shioaji', () => ({
    fetchHealth: vi.fn(async () => ({ status: 'healthy' })),
    fetchInfo: vi.fn(async () => ({ version: '' })),
    subscribeTradeEvents: vi.fn(),
}));
vi.mock('./tauri', () => ({
    // autostart off: run() goes straight to its health check
    loadDesktopSettings: vi.fn(async () => ({ autoStart: false, apiKey: '', secretKey: '' })),
    serverStatus: vi.fn(async () => ({ running: false })),
    serverStart: vi.fn(),
    reloadWhenHealthy: vi.fn(),
    localTlsCertExists: vi.fn(async () => false),
    nativeOwnsHarnessSidecar: vi.fn(async () => false),
    caActive: vi.fn(async () => false),
    harnessOwnershipCompatible: () => true,
    // #285: by default the server is this App's own spawn
    foreignServerCheck: vi.fn(async () => null),
    isOwnSpawn: vi.fn(() => true),
    learnOwnIdentity: vi.fn(async () => undefined),
    consumeTrayReadyOnReload: () => false,
    markTrayReadyOnReload: vi.fn(),
    setTrayStatus: vi.fn(),
}));

const store = new Map<string, string>();
const bootTimers = new Set<ReturnType<typeof setTimeout>>();

async function boot(lastStage: 'reload' | 'wait-health' | null, configure?: () => Promise<void>) {
    vi.resetModules();
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
        setTimeout: (fn: (...args: unknown[]) => void, ms: number) => {
            const timer = setTimeout(fn, ms);
            bootTimers.add(timer);
            return timer;
        },
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
            clearTimeout(timer);
            bootTimers.delete(timer);
        },
        setInterval, clearInterval,
        matchMedia: () => ({ addEventListener: vi.fn() }),
        location: { search: '', reload: vi.fn() },
    }));
    vi.stubGlobal('performance', { getEntriesByType: () => [{ type: m.navType }], timeOrigin: Date.now(), now: () => 0 });
    await configure?.();
    const timing = await import('./startup-timing');
    if (lastStage) {
        timing.beginTiming('restart');
        timing.markStage('healthy');
        timing.markStage(lastStage);
    }
    const { bootstrap } = await import('./boot');
    bootstrap();
}

beforeEach(() => {
    vi.clearAllMocks();
    m.child = false;
    m.navType = 'reload';
    m.ensureStream.mockClear();
    m.startTrading.mockClear();
    m.holdStream.mockClear();
    m.releaseStream.mockClear();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
});
afterEach(() => {
    for (const timer of bootTimers) clearTimeout(timer);
    bootTimers.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('early stream at bootstrap', () => {
    it('opens it synchronously on the post-health reload in the main window', async () => {
        await boot('reload');
        expect(m.ensureStream).toHaveBeenCalledTimes(1);
        // the trading snapshot starts at page load too, not after React mounts
        expect(m.startTrading).toHaveBeenCalledTimes(1);
        const timing = await import('./startup-timing');
        expect(timing.getActiveTiming()?.marks.filter(mark => mark.stage === 'trading-start')).toHaveLength(1);
    });

    it('records trading-start when a cold launch attaches to a healthy server', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322,
                simulation: true, version: '1.7.7', scheme: 'http',
            });
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const timing = await import('./startup-timing');
        expect(timing.getActiveTiming()?.marks.filter(mark => mark.stage === 'trading-start')).toHaveLength(1);
    });

    it('ends the continued timing run if desktop settings cannot be read', async () => {
        await boot('reload', async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockRejectedValueOnce(new Error('settings unavailable'));
        });
        const timing = await import('./startup-timing');
        await vi.waitFor(() => expect(timing.getTimingHistory()[0]?.outcome).toBe('failed'));
        expect(timing.getActiveTiming()).toBeNull();
    });

    it('never in a child window', async () => {
        m.child = true;
        await boot('reload');
        expect(m.ensureStream).not.toHaveBeenCalled();
        expect(m.startTrading).not.toHaveBeenCalled();
    });

    it('a child window cannot clear the main window trade block', async () => {
        m.child = true;
        await boot(null, async () => {
            store.set('sj-pro-server-identity-verified', '0');
        });
        const shioaji = await import('./shioaji');
        await vi.waitFor(() => expect(shioaji.fetchHealth).toHaveBeenCalled());
        expect(store.get('sj-pro-server-identity-verified')).toBe('0');
    });

    it('not on an app launch, without a run, or before the server was healthy', async () => {
        m.navType = 'navigate';
        await boot('reload');
        expect(m.ensureStream).not.toHaveBeenCalled();
        m.navType = 'reload';
        await boot(null);
        expect(m.ensureStream).not.toHaveBeenCalled();
        await boot('wait-health');
        expect(m.ensureStream).not.toHaveBeenCalled();
    });

    it('an App launch holds the stream until boot keeps the page', async () => {
        m.navType = 'navigate';
        await boot(null);
        expect(m.holdStream).toHaveBeenCalledTimes(1);
        // autostart off in this fixture → boot keeps the page → released
        await vi.waitFor(() => expect(m.releaseStream).toHaveBeenCalled());
    });

    it('no hold on a reload or in a child window', async () => {
        await boot('reload');
        expect(m.holdStream).not.toHaveBeenCalled();
        m.navType = 'navigate';
        m.child = true;
        await boot(null);
        expect(m.holdStream).not.toHaveBeenCalled();
    });

    it('does not adopt an incompatible server after autostart refuses it', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: true,
                version: '1.7.6', scheme: 'http',
            });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'foreign server', port: 21322,
                attached: false, portChanged: false,
            });
        });
        const tauri = await import('./tauri');
        const shioaji = await import('./shioaji');
        const timing = await import('./startup-timing');
        await vi.waitFor(() => expect(timing.getTimingHistory()[0]?.outcome).toBe('failed'));
        expect(tauri.serverStart).toHaveBeenCalledTimes(1);
        expect(shioaji.fetchHealth).not.toHaveBeenCalled();
        expect(m.releaseStream).toHaveBeenCalledWith('boot kept page');
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(window.location.reload).not.toHaveBeenCalled();
    });

    it('keeps watching after a spawn failure and adopts only a compatible healthy server', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus)
                .mockResolvedValueOnce({ running: false })
                .mockResolvedValueOnce({ running: true, healthy: true, port: 21322,
                    simulation: true, version: '1.7.7', scheme: 'http' });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'spawn failed', port: 21322,
                attached: false, portChanged: false,
            });
        });
        await vi.waitFor(() => expect(window.location.reload).toHaveBeenCalledTimes(1));
        expect(m.releaseStream).toHaveBeenCalledWith('boot kept page');
    });

    it('refuses a production listener whose configured CA is inactive', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
                caPath: '/qa/cert.pfx',
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce({
                running: true, healthy: true, port: 21322, simulation: false,
                version: '1.7.7', scheme: 'http',
            });
            vi.mocked(tauri.serverStart).mockResolvedValueOnce({
                ok: false, output: 'CA inactive', port: 21322,
                attached: false, portChanged: false,
            });
        });
        const tauri = await import('./tauri');
        await vi.waitFor(() => expect(tauri.caActive).toHaveBeenCalledWith(21322, 'http'));
        expect(tauri.serverStart).not.toHaveBeenCalled();
        expect(m.startTrading).not.toHaveBeenCalled();
    });

    // #285 — another program's server is used only in the right environment
    // and on the same account; otherwise never adopted, never read
    const prodElsewhere = { running: true, healthy: true, port: 21322, simulation: false, version: '1.7.7', scheme: 'http' as const };
    const refusal = { reason: 'mode' as const, text: ':21322 上另一個程式啟動的正式伺服器與本 App 設定（模擬）不符，未連上' };

    it('autostart: another App\'s production server is not adopted; this App starts its own elsewhere', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.isOwnSpawn).mockReturnValueOnce(false);
            vi.mocked(tauri.foreignServerCheck).mockResolvedValueOnce(refusal);
            vi.mocked(tauri.serverStart).mockReset().mockResolvedValueOnce({
                ok: true, output: '', port: 21323, attached: false, portChanged: true,
                foreign: { port: 21322, simulation: false, text: refusal.text },
            });
        });
        const tauri = await import('./tauri');
        const trade = await import('./trade');
        await vi.waitFor(() => expect(tauri.serverStart).toHaveBeenCalledTimes(1));
        expect(vi.mocked(tauri.serverStart).mock.calls[0]![0]).toMatchObject({ knownStatus: prodElsewhere });
        await vi.waitFor(() => expect(trade.notify).toHaveBeenCalledWith(expect.objectContaining({
            title: '未使用另一個程式的伺服器', body: expect.stringContaining('port 21323') })));
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(tauri.learnOwnIdentity).not.toHaveBeenCalled();
    });

    it('autostart off: a refused foreign server is never read and the header offers this App\'s own', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: false, apiKey: 'k', secretKey: 's', production: false,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.isOwnSpawn).mockReturnValueOnce(false);
            vi.mocked(tauri.foreignServerCheck).mockResolvedValueOnce(refusal);
        });
        const adoption = await import('./server-adoption');
        const runtime = await import('./runtime');
        await vi.waitFor(() => expect(adoption.getServerAttachment()).toMatchObject({ kind: 'refused', port: 21322, simulation: false }));
        expect(runtime.foreignServerPortBlocked()).toBe(21322);
        const tauri = await import('./tauri');
        expect(tauri.serverStart).not.toHaveBeenCalled(); // offered, not forced
        expect(m.startTrading).not.toHaveBeenCalled();
        expect(window.location.reload).not.toHaveBeenCalled();
    });

    it('a server another program started, checked and adopted, is labelled as such', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
            vi.mocked(tauri.isOwnSpawn).mockReturnValueOnce(false);
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const adoption = await import('./server-adoption');
        expect(adoption.getServerAttachment()).toEqual({ kind: 'external', port: 21322, simulation: false });
        const tauri = await import('./tauri');
        expect(tauri.learnOwnIdentity).not.toHaveBeenCalled();
    });

    it('this App\'s own server: its account is learned for later comparisons', async () => {
        m.navType = 'navigate';
        await boot(null, async () => {
            const tauri = await import('./tauri');
            vi.mocked(tauri.loadDesktopSettings).mockResolvedValueOnce({
                autoStart: true, apiKey: 'k', secretKey: 's', production: true,
            } as Awaited<ReturnType<typeof tauri.loadDesktopSettings>>);
            vi.mocked(tauri.serverStatus).mockResolvedValueOnce(prodElsewhere);
        });
        await vi.waitFor(() => expect(m.startTrading).toHaveBeenCalledTimes(1));
        const adoption = await import('./server-adoption');
        expect(adoption.getServerAttachment()).toEqual({ kind: 'own', port: 21322 });
        const tauri = await import('./tauri');
        expect(tauri.learnOwnIdentity).toHaveBeenCalledWith(prodElsewhere);
    });
});
