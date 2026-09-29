import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadWith(saved: unknown) {
    vi.resetModules();
    const store = new Map<string, string>();
    if (saved !== undefined) store.set('sj-pro-theme', JSON.stringify(saved));
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.stubGlobal('document', { documentElement: { classList: { add() {}, remove() {} }, style: {} } });
    vi.doMock('../theme.css', () => ({ themeClasses: {} }));
    const mod = await import('./theme-store');
    return mod;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock('../theme.css');
});

describe('theme settings migration', () => {
    it('defaults to dark with the standard (enlarged) font size', async () => {
        const m = await loadWith(undefined);
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'tw', fontScale: 1.15 });
    });

    it('maps the old 純黑 mode to dark and the removed 0.85 size to the smallest', async () => {
        const m = await loadWith({ mode: 'midnight', convention: 'intl', fontScale: 0.85 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'dark', convention: 'intl', fontScale: 1 });
    });

    it('keeps an existing size and light mode as saved', async () => {
        const m = await loadWith({ mode: 'light', convention: 'tw', fontScale: 1.3 });
        m.setThemeSettings({});
        expect(JSON.parse((globalThis.localStorage as Storage).getItem('sj-pro-theme')!)).toEqual({ mode: 'light', convention: 'tw', fontScale: 1.3 });
    });
});
