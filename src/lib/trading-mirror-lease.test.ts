import { afterEach, expect, it, vi } from 'vitest';

vi.mock('./runtime', () => ({ getApiBase: () => 'http://fixture.invalid', isTauri: false }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('blocks direct place and cancel paths on a popout until a fresh main snapshot, and again at handoff', async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal('location', { search: '?popout=ticket' });
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const lease = await import('./trading-mirror-lease');
    const { apiPost } = await import('./api');
    await expect(apiPost('/api/v1/order/place_order', {})).rejects.toMatchObject({ mutationNotStarted: true });
    lease.markTradingMirrorSnapshot();
    await expect(apiPost('/api/v1/order/place_order', {})).resolves.toEqual({});
    lease.invalidateTradingMirror(); // child acquires SSE ownership
    await expect(apiPost('/api/v1/order/cancel_order', {})).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lease.markTradingMirrorSnapshot();
    await vi.advanceTimersByTimeAsync(2500);
    await expect(apiPost('/api/v1/order/place_order', {})).rejects.toMatchObject({ mutationNotStarted: true });
});
