// 閃電彈出視窗的委託走自己的原生命令：一次一個新 id、帶核可時的模式；原生端
// 送出前的拒絕＝沒有送出，送出後的錯誤＝結果不確定（不重送）。
import { describe, expect, it, vi } from 'vitest';
import { popoutOrderPost, POPOUT_UNSUPPORTED } from './popout-order';

const deps = (invoke: (cmd: string, args: Record<string, unknown>) => Promise<unknown>, simulation: boolean | null = true) => ({
    invoke: invoke as never, base: () => 'http://127.0.0.1:21322', simulation: () => simulation, newId: (() => { let n = 0; return () => `req-000000${++n}`; })(),
});
const flags = (e: unknown) => ({ notStarted: !!(e as { mutationNotStarted?: boolean }).mutationNotStarted,
    unknown: !!(e as { mutationOutcomeUnknown?: boolean }).mutationOutcomeUnknown, message: (e as Error).message });

describe('popoutOrderPost', () => {
    it('one call, one fresh id, the exact body and the approved mode', async () => {
        const invoke = vi.fn(async () => ({ status: 200, body: '{"trade":1}' }));
        expect(await popoutOrderPost('/api/v1/order/place_order', '{"a":1}', undefined, deps(invoke))).toEqual({ status: 200, body: '{"trade":1}' });
        expect(invoke).toHaveBeenCalledWith('flash_popout_order_post', { requestId: 'req-0000001', url: 'http://127.0.0.1:21322/api/v1/order/place_order', body: '{"a":1}', simulation: true });
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('a window that is not a flash popout, a replayed id, another server mode: refused natively → not sent', async () => {
        for (const reason of ['此視窗不能送出委託', '這筆請求已處理過，不會再送一次', '伺服器模式（模擬／正式）與彈出視窗確認時不同']) {
            const e = await popoutOrderPost('/p', '{}', undefined, deps(async () => { throw `ORDER_NOT_STARTED: ${reason}`; })).catch(x => x);
            expect(flags(e)).toEqual({ notStarted: true, unknown: false, message: reason });
        }
    });

    it('a failure after the request may have left: outcome unknown, sent once, never retried', async () => {
        const invoke = vi.fn(async () => { throw '彈出視窗委託請求失敗：timeout'; });
        const e = await popoutOrderPost('/p', '{}', undefined, deps(invoke)).catch(x => x);
        expect(flags(e)).toMatchObject({ notStarted: false, unknown: true });
        expect(flags(e).message).toContain('不要直接重送');
        expect(invoke).toHaveBeenCalledTimes(1);
    });

    it('mode unknown, or the caller refuses right before sending: nothing is invoked', async () => {
        const invoke = vi.fn();
        expect(flags(await popoutOrderPost('/p', '{}', undefined, deps(invoke, null)).catch(x => x)).notStarted).toBe(true);
        expect(flags(await popoutOrderPost('/p', '{}', () => { throw new Error('帳戶已變更'); }, deps(invoke)).catch(x => x)))
            .toMatchObject({ notStarted: true, message: '帳戶已變更' });
        expect(invoke).not.toHaveBeenCalled();
    });

    it('an App build without the command: not sent, plainly said', async () => {
        const e = await popoutOrderPost('/p', '{}', undefined, deps(async () => { throw 'command flash_popout_order_post not found'; })).catch(x => x);
        expect(flags(e)).toEqual({ notStarted: true, unknown: false, message: POPOUT_UNSUPPORTED });
    });
});
