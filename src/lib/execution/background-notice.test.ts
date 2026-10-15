// execution://notice → notification: the engine's note (`handledByUser`) is
// an internal code and never the body (QA 10/14: 平倉 showed 「handledByUser」).
import { expect, it, vi } from 'vitest';

const m = vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener: () => undefined, removeEventListener: () => undefined };
    g.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const handlers: Record<string, (e: { payload: unknown }) => void> = {};
    return {
        handlers,
        notify: vi.fn(),
        listen: async (name: string, fn: (e: { payload: unknown }) => void) => { handlers[name] = fn; return () => undefined; },
    };
});
vi.mock('../trade', () => ({ notify: m.notify }));
vi.mock('../main-window-commands', () => ({ isMainWindow: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: m.listen }));
const bg = await import('./background');

const bracket = (id: string) => ({ id, kind: 'bracket', status: 'running', version: 1,
    binding: { env: 'simulation', serverId: 's', account: { accountType: 'F', brokerId: 'B', accountId: '1' },
        contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
    levels: [{ id: 't0', phase: 'holding', exit: { type: 'oco' }, orders: [], entry: { type: 'external', orderId: 'x' } }], issues: [] });
const handledNotes = () => m.notify.mock.calls.map(c => c[0]).filter(n => n.title === '括號單已改由你自行處理');

it('平倉 ends a protection: the notice says why, never 「handledByUser」', async () => {
    bg.__setBackgroundInvokeForTest((async (cmd: string) => {
        if (cmd === 'execution_programs') return { revision: 1, programs: ['bkt-1', 'bkt-2'].map(bracket) };
        if (cmd === 'execution_status') return null;
        return { accepted: true, notices: [], revision: 2 };
    }) as never, { desktop: true });
    bg.startBackgroundExecution();
    await vi.waitFor(() => expect(bg.getBackgroundPrograms().length).toBe(2));
    await vi.waitFor(() => expect(m.handlers['execution://notice']).toBeTruthy());
    const fire = (programId: string, detail: string) =>
        m.handlers['execution://notice']!({ payload: [{ code: 'handled', programId, levelId: 't0', detail }] });

    await bg.markBackgroundHandled('bkt-1', 't0', { account: { accountType: 'F', brokerId: 'B', accountId: '1' }, codes: ['TXFR1'] });
    fire('bkt-1', 'handledByUser');
    expect(handledNotes().at(-1)).toEqual({ kind: 'info', title: '括號單已改由你自行處理', body: '平倉前先結束這筆的停損停利' });

    // 「我已自行處理」 (no scope): a Chinese explanation
    await bg.markBackgroundHandled('bkt-2', 't0');
    fire('bkt-2', 'handledByUser');
    expect(handledNotes().at(-1)).toEqual({ kind: 'info', title: '括號單已改由你自行處理', body: '不再追蹤這筆的停損停利；不會送出或刪除任何委託' });

    // the flatten mark is used once
    fire('bkt-1', 'handledByUser');
    expect(handledNotes().at(-1).body).toBe('不再追蹤這筆的停損停利；不會送出或刪除任何委託');
    expect(handledNotes()).toHaveLength(3);
    for (const [n] of m.notify.mock.calls) expect(JSON.stringify(n)).not.toContain('handledByUser');
});
