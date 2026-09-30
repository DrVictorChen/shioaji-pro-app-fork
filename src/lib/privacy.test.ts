// #85 B-2 — privacy toggles made in one window reach already-open popouts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

type Handler = (e: Partial<StorageEvent>) => void;
let handlers: Handler[] = [];
const store = new Map<string, string>();

beforeEach(() => {
    vi.resetModules();
    handlers = [];
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    });
    vi.stubGlobal('window', { addEventListener: (type: string, h: Handler) => { if (type === 'storage') handlers.push(h); } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const fire = (key: string | null, newValue: string | null) => handlers.forEach(h => h({ key, newValue }));

it('follows privacy-mode and money-mode toggles from another window', async () => {
    store.set('sj-pro-privacy-money', '1');
    const privacy = await import('./privacy');
    expect(privacy.getPrivacyMoney()).toBe(true);
    expect(privacy.getPrivacyMode()).toBe(false);
    expect(handlers).toHaveLength(1);

    fire('sj-pro-privacy-money', '0');
    expect(privacy.getPrivacyMoney()).toBe(false);
    fire('sj-pro-privacy-mode', '1');
    expect(privacy.getPrivacyMode()).toBe(true);
    fire('unrelated', '0');
    expect(privacy.getPrivacyMode()).toBe(true);
    fire(null, null); // localStorage.clear() in another window
    expect([privacy.getPrivacyMode(), privacy.getPrivacyMoney()]).toEqual([false, false]);
});
