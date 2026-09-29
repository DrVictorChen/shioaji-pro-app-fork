import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiPost, shouldProxyAgentHarnessMutation } from './api';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('agent harness mutation routing', () => {
    it('keeps normal UI orders on the direct HTTP path while disabled', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                false,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });

    it('uses the native capability proxy only for enabled desktop mutations', () => {
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(true);
        expect(
            shouldProxyAgentHarnessMutation(
                true,
                true,
                '/api/v1/data/snapshots',
            ),
        ).toBe(false);
        expect(
            shouldProxyAgentHarnessMutation(
                false,
                true,
                '/api/v1/order/place_order',
            ),
        ).toBe(false);
    });
});

it.each(['/api/v1/order/place_order', '/api/v1/order/cancel_order'])('aborts a queued %s request after three seconds and never sends it later', async path => {
    vi.useFakeTimers();
    let sent = false;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        setTimeout(() => { if (!init.signal?.aborted) sent = true; resolve(new Response('{}')); }, 5000);
    }));
    vi.stubGlobal('fetch', fetchMock);
    const pending = apiPost(path, {});
    const failure = expect(pending).rejects.toMatchObject({ requestTimedOut: true });
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    await vi.advanceTimersByTimeAsync(3000);
    expect(sent).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});
