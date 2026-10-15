import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGNOSTICS_REFRESH_MS, freshDiagnostics } from './diagnostics-snapshot';

describe('複製診斷資訊時重讀伺服器狀態（#287）', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('用當下讀到的值取代開機忙碌時輪詢的 healthy=false／health: —', async () => {
        const out = await freshDiagnostics(
            async () => ({ healthy: true }),
            async () => ({ status: 'healthy' }),
            { status: { healthy: false }, health: undefined },
        );
        expect(out).toEqual({ status: { healthy: true }, health: { status: 'healthy' } });
    });

    it('重讀失敗沿用輪詢值', async () => {
        const out = await freshDiagnostics(
            () => Promise.reject(new Error('down')),
            () => Promise.reject(new Error('down')),
            { status: { healthy: false }, health: { status: 'healthy' } },
        );
        expect(out).toEqual({ status: { healthy: false }, health: { status: 'healthy' } });
    });

    it('逾時不卡住複製：沿用輪詢值並中止 /health 請求', async () => {
        let signal: AbortSignal | undefined;
        const pending = freshDiagnostics(
            () => new Promise<{ healthy: boolean }>(() => undefined),
            (s) => { signal = s; return new Promise<{ status: string }>(() => undefined); },
            { status: { healthy: false }, health: undefined },
        );
        await vi.advanceTimersByTimeAsync(DIAGNOSTICS_REFRESH_MS);
        await expect(pending).resolves.toEqual({ status: { healthy: false }, health: undefined });
        expect(signal?.aborted).toBe(true);
    });
});
