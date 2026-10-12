// #285 — while another program's server is not used, nothing on the page
// talks to it: the API base points nowhere until the App moves to its own.
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('the blocked port is never requested; another port is unaffected', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
    vi.resetModules();
    const rt = await import('./runtime');
    expect(rt.getApiBase()).toBe('http://127.0.0.1:21322');
    rt.blockForeignServerPort(21322);
    expect(rt.getApiBase()).toBe('http://127.0.0.1:0');
    expect(rt.getStreamBase()).toBe('http://127.0.0.1:0');
    rt.setApiPort(21323); // this App's own server
    expect(rt.getApiBase()).toBe('http://127.0.0.1:21323');
});

it('blocks an override that points at the blocked server too', async () => {
    const store = new Map<string, string>([['sj-pro-foreign-port', '21322']]);
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
    vi.stubEnv('VITE_API_BASE', 'http://127.0.0.1:21322');
    vi.resetModules();
    const rt = await import('./runtime');
    expect(rt.getApiBase()).toBe('http://127.0.0.1:0');
    rt.blockForeignServerPort(null);
    expect(rt.getApiBase()).toBe('http://127.0.0.1:21322');
    vi.unstubAllEnvs();
});

it('reads wait for boot\'s decision, then go where it decided', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {} }));
    const seen: string[] = [];
    vi.doMock('@tauri-apps/plugin-http', () => ({ fetch: async (url: string) => { seen.push(url); return new Response('{}'); } }));
    vi.resetModules();
    const rt = await import('./runtime');
    const gate = await import('./server-read-gate');
    const api = await import('./api');
    gate.holdServerReads();
    const read = api.apiGet('/api/v1/auth/accounts');
    await new Promise(r => setTimeout(r, 10));
    expect(seen).toEqual([]); // nothing read yet
    rt.blockForeignServerPort(21322); // boot: another program's server, not used
    gate.releaseServerReads();
    await read;
    expect(seen).toEqual(['http://127.0.0.1:0/api/v1/auth/accounts']);
    vi.doUnmock('@tauri-apps/plugin-http');
});
