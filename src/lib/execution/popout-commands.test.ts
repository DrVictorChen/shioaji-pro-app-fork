// The background-engine commands a flash popout (閃電下單彈出視窗) sends for
// its own actions. The App lets flash popout windows call exactly these
// (shioaji-pro-desktop: execution_create / execution_remove /
// execution_create_bracket for every popout; execution_mark_handled,
// execution_replace, execution_replace_bracket for flash popouts) — a new
// command here needs the same window rule there (QA 10/13: 平倉 in a popout
// first ends its protection with execution_mark_handled).
import { afterEach, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    const g = globalThis as Record<string, unknown>;
    g.window ??= { addEventListener: () => undefined, removeEventListener: () => undefined };
    g.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
});
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));
const bg = await import('./background');

afterEach(() => bg.__setBackgroundInvokeForTest(null));

it('平倉／全刪 end a protection, drag moves a trigger, delete removes it: these commands only', async () => {
    const calls: string[] = [];
    const args: unknown[] = [];
    bg.__setBackgroundInvokeForTest((async (cmd: string, a?: unknown) => {
        calls.push(cmd);
        if (cmd === 'execution_mark_handled') args.push(a);
        if (cmd === 'execution_programs') return { revision: 1, programs: [] };
        if (cmd === 'execution_status') return null;
        return { accepted: true, notices: [], revision: 2 };
    }) as never, { desktop: true });
    await bg.markBackgroundHandled('bkt-1', 't0', { account: { accountType: 'F', brokerId: 'B', accountId: '1' }, codes: ['TXFR1'] });
    await bg.replaceBackgroundTrigger('trg-1', { id: 'trg-2' } as never);
    await bg.replaceBackgroundBracket('bkt-2', { id: 'bkt-3' } as never);
    await bg.removeBackgroundTrigger('trg-2');
    await bg.removeBackgroundBracket('bkt-3');
    const actions = calls.filter(c => !['execution_programs', 'execution_status', 'execution_get_enabled', 'execution_list_pending_confirm'].includes(c));
    expect(actions).toEqual(['execution_mark_handled', 'execution_replace', 'execution_replace_bracket', 'execution_remove', 'execution_remove']);
    // ending a protection carries the panel's scope (checked natively for popouts)
    expect(args[0]).toEqual({ programId: 'bkt-1', levelId: 't0', scope: { account: { accountType: 'F', brokerId: 'B', accountId: '1' }, codes: ['TXFR1'] } });
});
