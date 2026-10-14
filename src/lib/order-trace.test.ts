import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); vi.restoreAllMocks(); });

describe('order trace (#244 debug)', () => {
    it('is a no-op unless VITE_DEBUG_ORDER_TRACE=1, records and masks when on', async () => {
        vi.stubEnv('VITE_DEBUG_ORDER_TRACE', '');
        const off = await import('./order-trace');
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(off.ORDER_TRACE_ENABLED).toBe(false);
        off.noteOrderTraceEntry(['t1'], 'flash cell');
        const none = off.beginOrderTrace('cancel', 't1');
        expect(none).toBeNull();
        await expect(off.finishOrderTrace(none, Promise.reject(new Error('A123456789')))).rejects.toThrow('A123456789');
        expect(off.getOrderTrace()).toEqual([]);
        expect(off.orderTraceDiagnostics()).toBe('');
        expect(info).not.toHaveBeenCalled();

        vi.resetModules();
        vi.stubEnv('VITE_DEBUG_ORDER_TRACE', '1');
        const on = await import('./order-trace');
        expect(on.ORDER_TRACE_ENABLED).toBe(true);
        expect(on.maskTraceText('CA not activated for: A123456789 acct 9876543210 seq 12345'))
            .toBe('CA not activated for: *** acct *** seq 12345');
        on.noteOrderTraceEntry(['t2'], 'flash 全刪');
        const record = on.beginOrderTrace('cancel', 't2');
        on.traceSet(record, { account: on.accountShape({ broker_id: '9A95', account_id: '1234567', account_type: 'S', person_id: 'A123456789' }) });
        await expect(on.finishOrderTrace(record, Promise.reject(Object.assign(new Error('refused B223456789'), { status: 400, mutationNotStarted: true }))))
            .rejects.toThrow();
        const [entry] = on.getOrderTrace();
        expect(entry).toMatchObject({ entry: 'flash 全刪', trade_id: 't2', http_status: 400, error: 'refused ***', summary: 'not sent',
            account: { broker_id_present: true, account_id_tail: '67', person_id_present: true, person_id_length: 10 } });
        const text = on.orderTraceDiagnostics();
        expect(text).toContain('Order trace');
        expect(text).not.toMatch(/[A-Z]\d{9}/);
        expect(info).toHaveBeenCalledWith('[order-trace]', expect.any(String));
    });
});
