import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    healthy: false,
    reload: vi.fn(),
    invoke: vi.fn(),
}));

vi.mock('./runtime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./runtime')>()),
    isTauri: true,
    getApiBase: () => 'http://127.0.0.1:21322',
}));
vi.mock('./sidecar-ownership', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./sidecar-ownership')>()),
    recoverHarnessOwnership: vi.fn().mockResolvedValue({ ok: true, output: '', portChanged: false }),
}));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: async () => { throw new Error('offline'); } }));
vi.mock('@tauri-apps/plugin-shell', () => ({
    Command: { sidecar: () => ({ execute: async () => ({ code: 0, stdout: '{"running":false}', stderr: '' }) }) },
}));
vi.mock('@tauri-apps/plugin-store', () => ({
    LazyStore: class {
        async get(key: string) {
            const values: Record<string, unknown> = {
                apiKey: 'TEST-KEY', secretKey: 'TEST-SECRET',
                agentHarnessSafeDefaultV1: true, agentHarnessEnabled: false,
            };
            return values[key];
        }
    },
}));

const data = new Map<string, string>();
const { setAgentHarnessEnabled } = await import('./tauri');

beforeEach(() => {
    data.clear();
    mocks.healthy = false;
    mocks.reload.mockReset();
    mocks.invoke.mockReset().mockRejectedValue(new Error('harness command failed'));
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.stubGlobal('window', {
        location: { search: '', reload: mocks.reload },
        setTimeout, clearTimeout,
    });
    vi.stubGlobal('localStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => void data.set(key, value),
        removeItem: (key: string) => void data.delete(key),
    });
    vi.stubGlobal('fetch', async (url: string) => {
        if (!url.startsWith('http://127.0.0.1:21322/')) throw new Error('offline');
        return new Response(JSON.stringify(url.endsWith('/info')
            ? { version: '1.7.7', simulation: true }
            : { status: mocks.healthy ? 'healthy' : 'unhealthy' }));
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it('keeps the mutation gate closed after Harness failure, then reloads when the same server becomes healthy', async () => {
    // the server on 21322 is this App's own spawn, still running (#285)
    data.set('sj-pro-server-port', '21322');
    data.set('sj-pro-server-pid', '4242');
    mocks.invoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'process_alive') return true;
        throw new Error('harness command failed');
    });
    await expect(setAgentHarnessEnabled(true)).rejects.toThrow('harness command failed');
    expect(data.get('sj-pro-server-identity-verified')).not.toBe('1');
    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.reload).not.toHaveBeenCalled();

    mocks.healthy = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.reload).toHaveBeenCalledTimes(1);
    expect(data.get('sj-pro-server-identity-verified')).not.toBe('1');
});

it('#285: never reloads onto another program\'s server whose account cannot be confirmed', async () => {
    await expect(setAgentHarnessEnabled(true)).rejects.toThrow('harness command failed');
    mocks.healthy = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.reload).not.toHaveBeenCalled();
    // end the watch (identity proven elsewhere) before the globals go away
    const { setServerIdentityVerified } = await import('./server-identity');
    setServerIdentityVerified(true);
    await vi.advanceTimersByTimeAsync(5000);
});
