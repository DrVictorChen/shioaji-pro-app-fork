// A popped-out window with the Agent Harness on: the order goes to the main
// window (relay), never to this window's native bridge or plain HTTP; the
// relay's not-sent / unknown meanings reach the caller unchanged.
import { beforeEach, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ invoke: vi.fn(), relay: vi.fn() }));
vi.mock('./runtime', () => ({ getApiBase: () => 'http://127.0.0.1:21322', isTauri: true }));
vi.mock('./agent-harness-state', () => ({ isAgentHarnessEnabled: () => true }));
vi.mock('./server-identity', () => ({ serverIdentityVerified: () => true }));
vi.mock('./trading-mirror-lease', () => ({ getTradingMirrorFresh: () => true }));
vi.mock('./main-window-commands', () => ({ isMainWindow: () => false }));
vi.mock('./order-relay', () => ({ relayOrder: m.relay }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
const { apiPost } = await import('./api');

beforeEach(() => { m.invoke.mockReset(); m.relay.mockReset(); });

it('the exact request goes to the main window; its answer is the response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    m.relay.mockResolvedValue({ status: 200, body: '{"trade_id":"t-1"}' });
    const before = vi.fn();
    await expect(apiPost('/api/v1/order/place_order', { code: '2330', quantity: 1 }, { beforeDispatch: before })).resolves.toEqual({ trade_id: 't-1' });
    expect(m.relay).toHaveBeenCalledWith('/api/v1/order/place_order', '{"code":"2330","quantity":1}');
    expect(before).toHaveBeenCalledTimes(1);
    expect(m.invoke).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
});

it('refused by the caller right before relaying: nothing goes to the main window', async () => {
    await expect(apiPost('/api/v1/order/cancel_order', { trade_id: 't' }, { beforeDispatch: () => { throw Object.assign(new Error('帳戶已變更'), { mutationNotStarted: true }); } }))
        .rejects.toThrow('帳戶已變更');
    expect(m.relay).not.toHaveBeenCalled();
});

it('relay errors keep their meaning (not sent / outcome unknown)', async () => {
    m.relay.mockRejectedValue(Object.assign(new Error('主視窗沒有回應'), { mutationNotStarted: true }));
    await expect(apiPost('/api/v1/order/place_order', {})).rejects.toMatchObject({ mutationNotStarted: true });
    m.relay.mockRejectedValue(Object.assign(new Error('結果不確定'), { mutationOutcomeUnknown: true, orderOutcomeUnknown: true }));
    await expect(apiPost('/api/v1/order/place_order', {})).rejects.toMatchObject({ orderOutcomeUnknown: true });
});

it('an Agent-initiated call never relays', async () => {
    await expect(apiPost('/api/v1/order/place_order', {}, { agentInitiated: true })).rejects.toMatchObject({ mutationNotStarted: true });
    expect(m.relay).not.toHaveBeenCalled();
});
