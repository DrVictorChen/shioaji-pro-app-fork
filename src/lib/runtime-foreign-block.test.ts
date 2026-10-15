// #285 — while another program's server is not used, nothing on the page
// reads it: requests to that port fail at once in code. The API base itself
// is never rewritten (it keys caches / channels / environment checks; the
// first version pointed it at port 0 and every read on the QA build stalled:
// watchlist 「載入其餘商品…」, positions without names, empty rankings).
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.doUnmock('@tauri-apps/plugin-http'); vi.resetModules(); });

function stubStorage(init: [string, string][] = []) {
    const store = new Map<string, string>(init);
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
    return store;
}

function stubTransport() {
    const seen: string[] = [];
    vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: async (url: string) => { seen.push(url); return new Response('{}'); } }));
    return seen;
}

it('the API base is never rewritten; only requests to the blocked port are refused', async () => {
    stubStorage();
    vi.resetModules();
    const rt = await import('./runtime');
    expect(rt.getApiBase()).toBe('http://127.0.0.1:21322');
    rt.blockForeignServerPort(21322);
    expect(rt.getApiBase()).toBe('http://127.0.0.1:21322');
    expect(rt.getStreamBase()).toBe('http://127.0.0.1:21322');
    expect(rt.serverUrlBlocked('http://127.0.0.1:21322/api/v1/health')).toBe(21322);
    expect(rt.serverUrlBlocked('http://127.0.0.1:21323/api/v1/health')).toBeNull();
    expect(rt.serverUrlBlocked('/api/v1/health')).toBeNull(); // same-origin web build
    rt.blockForeignServerPort(null);
    expect(rt.serverUrlBlocked('http://127.0.0.1:21322/api/v1/health')).toBeNull();
});

it('a request to the blocked server fails at once and never reaches the transport', async () => {
    stubStorage([['sj-pro-foreign-port', '21322']]);
    const seen = stubTransport();
    vi.resetModules();
    const api = await import('./api');
    const t0 = Date.now();
    await expect(api.apiGet('/api/v1/data/contracts/2330/info')).rejects.toMatchObject({ foreignServerBlocked: true });
    await expect(api.apiPost('/api/v1/data/subscribe', {})).rejects.toMatchObject({ foreignServerBlocked: true, mutationNotStarted: true });
    expect(Date.now() - t0).toBeLessThan(200);
    expect(seen).toEqual([]);
});

it('reads wait for boot\'s decision, then go where it decided', async () => {
    stubStorage();
    const seen = stubTransport();
    vi.resetModules();
    const rt = await import('./runtime');
    const gate = await import('./server-read-gate');
    const api = await import('./api');
    gate.holdServerReads();
    const blocked = api.apiGet('/api/v1/auth/accounts');
    await new Promise(r => setTimeout(r, 10));
    expect(seen).toEqual([]); // nothing read yet
    rt.blockForeignServerPort(21322); // boot: another program's server, not used
    gate.releaseServerReads();
    await expect(blocked).rejects.toMatchObject({ foreignServerBlocked: true });
    expect(seen).toEqual([]);
    // boot moves the App to its own server: reads go there
    gate.holdServerReads();
    const moved = api.apiGet('/api/v1/auth/accounts');
    rt.setApiPort(21323);
    gate.releaseServerReads();
    await moved;
    expect(seen).toEqual(['http://127.0.0.1:21323/api/v1/auth/accounts']);
});
