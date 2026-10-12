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
