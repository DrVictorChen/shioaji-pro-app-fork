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
        expect(on.maskTraceText('CA not activated for: A123456789 arc AB12345678 acct 1234567 seq 12345'))
            .toBe('CA not activated for: *** arc *** acct *** seq 12345');
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

describe('order trace across windows and reports (#244 QA: second cancel missing)', () => {
    it('records who changed an order: reports say whether this App had a mutation running', async () => {
        vi.stubEnv('VITE_DEBUG_ORDER_TRACE', '1');
        vi.stubGlobal('BroadcastChannel', undefined);
        const t = await import('./order-trace');
        vi.spyOn(console, 'info').mockImplementation(() => {});
        const { normalizeOrderEvent } = await import('./order-report');
        const cancel = (id: string) => normalizeOrderEvent({ state: 'StockOrder', data: { StockOrder: {
            operation: { op_type: 'Cancel', op_code: '00', op_msg: '' },
            order: { id, seqno: '475UKT', ordno: 'kY001', account: { account_type: 'S', broker_id: '9A95', account_id: '1234567' }, action: 'Buy', price: 43.85, quantity: 1, order_lot: 'Common', order_cond: 'Cash', price_type: 'LMT', order_type: 'ROD' },
            status: { exchange_ts: 1789200000, order_quantity: 0, cancel_quantity: 1, modified_price: 0 },
            contract: { code: '2890', security_type: 'STK', exchange: 'TSE' },
        } } })!;
        // nobody here was cancelling it
        t.noteOrderReport(cancel('0094ef67'));
        // cancelled by this window
        const record = t.beginOrderTrace('cancel', 'mine');
        t.noteOrderReport(cancel('mine'));
        await t.finishOrderTrace(record, Promise.resolve({ status: { status: 'Cancelled' } }));
        const reports = t.getOrderTrace().filter(r => r.kind === 'report');
        expect(reports.map(r => [r.trade_id, r.seqno, r.report?.op_type, r.report?.app_mutation_in_flight])).toEqual([
            ['0094ef67', '475UKT', 'Cancel', false], ['mine', '475UKT', 'Cancel', true]]);
        expect(reports[0]!.report?.app_mutation_ms_ago).toBeNull();
        expect(t.getOrderTrace().every(r => r.window === 'main')).toBe(true);
        vi.unstubAllGlobals();
    });
    it('records from a popout window reach the main window diagnostics', async () => {
        vi.stubEnv('VITE_DEBUG_ORDER_TRACE', '1');
        const listeners: Array<(e: { data: unknown }) => void> = [];
        const posted: unknown[] = [];
        class Channel {
            constructor(public name: string) {}
            addEventListener(_n: string, l: (e: { data: unknown }) => void) { if (this.name === 'sj-order-trace') listeners.push(l); }
            postMessage(data: unknown) { if (this.name === 'sj-order-trace') posted.push(data); }
        }
        vi.stubGlobal('BroadcastChannel', Channel);
        const t = await import('./order-trace');
        vi.spyOn(console, 'info').mockImplementation(() => {});
        // listening from load: a popout's refused cancel arrives before any local activity
        expect(listeners).toHaveLength(1);
        listeners.forEach(l => l({ data: { record: { ts: 'w', window: 'popout-flash-1', kind: 'cancel', entry: 'flash cell', trade_id: 'early', summary: 'failed' } } }));
        const own = t.beginOrderTrace('cancel', 'a');
        await t.finishOrderTrace(own, Promise.resolve({ status: { status: 'Cancelled' } }));
        expect(posted).toHaveLength(1);
        listeners.forEach(l => l({ data: { record: { ts: 'x', window: 'popout-flash-1', kind: 'cancel', entry: 'flash cell', trade_id: '0094ef67', summary: 'ok (Cancelled)' } } }));
        expect(t.getOrderTrace().map(r => [r.window, r.trade_id])).toEqual([['popout-flash-1', 'early'], ['main', 'a'], ['popout-flash-1', '0094ef67']]);
        expect(t.orderTraceDiagnostics()).toContain('popout-flash-1');
        vi.unstubAllGlobals();
    });
});
