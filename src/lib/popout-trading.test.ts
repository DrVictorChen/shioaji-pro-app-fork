// #216 QA: a popped-out window cannot send orders while the Agent Harness
// signs them (main window only); the flash panel says so up front.
import { afterEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ tauri: true, main: false, harness: true }));
vi.mock('./runtime', () => ({ get isTauri() { return m.tauri; } }));
vi.mock('./main-window-commands', () => ({ isMainWindow: () => m.main }));
vi.mock('./agent-harness-state', () => ({ isAgentHarnessEnabled: () => m.harness }));
const { popoutTradingBlocked, POPOUT_VIEW_ONLY } = await import('./popout-trading');

afterEach(() => Object.assign(m, { tauri: true, main: false, harness: true }));

it('desktop popout with the Harness on: view only, in plain words', () => {
    expect(popoutTradingBlocked()).toBe(POPOUT_VIEW_ONLY);
    expect(POPOUT_VIEW_ONLY).not.toMatch(/原生|Agent/);
});

it('the main window, the Harness off, or the web build: can trade', () => {
    m.main = true;
    expect(popoutTradingBlocked()).toBeNull();
    m.main = false; m.harness = false;
    expect(popoutTradingBlocked()).toBeNull();
    m.harness = true; m.tauri = false;
    expect(popoutTradingBlocked()).toBeNull();
});

it('follows the setting the main window saved after this popout opened', () => {
    const store = new Map<string, string>([['sj-agent-harness-enabled', 'false']]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null });
    expect(popoutTradingBlocked()).toBeNull(); // cache says on, the saved setting says off
    store.set('sj-agent-harness-enabled', 'true');
    m.harness = false;
    expect(popoutTradingBlocked()).toBe(POPOUT_VIEW_ONLY);
    vi.unstubAllGlobals();
});
