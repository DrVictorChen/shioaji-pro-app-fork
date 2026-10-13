// 彈出視窗的委託由主視窗代送：主視窗檢查（一次性 id、伺服器／模式、時間、
// 帳戶）後用自己的簽送路徑送出一次；主視窗不在就不送；沒有回覆是結果不確定，
// 絕不重送。
import { describe, expect, it, vi } from 'vitest';
import { CommandNotAcknowledged, createCommandBus } from './main-window-commands';
import { createRelayHost, relayProblem, relayThroughMain, RELAY_MAX_AGE_MS, RELAY_NO_ANSWER, RELAY_NO_MAIN, type RelayRequest } from './order-relay';

const ENV = 'http://127.0.0.1:21322|simulation';
const NOW = 1_800_000_000_000;
const A = { account_type: 'F', broker_id: 'B', account_id: '1' };
const body = JSON.stringify({ contract: { code: 'TXFJ6' }, futures_order: { action: 'Buy', price: 0, quantity: 1, account: A } });
const req = (over: Partial<RelayRequest> = {}): RelayRequest => ({ v: 1, id: 'r-1', path: '/api/v1/order/place_order', body, env: ENV, issuedAt: NOW, ...over });
const ctx = { env: ENV, now: NOW, seen: () => false, accounts: [A] };

describe('relayProblem (the main window checks before sending)', () => {
    it('a fresh request of this server, mode and account may go', () => {
        expect(relayProblem(req(), ctx)).toBeNull();
    });
    it('refuses a replayed id, another server or mode, a stale or future time, an unknown account, another path', () => {
        expect(relayProblem(req(), { ...ctx, seen: () => true })).toContain('已處理過');
        expect(relayProblem(req(), { ...ctx, env: 'http://127.0.0.1:21322|production' })).toContain('模擬／正式');
        expect(relayProblem(req(), { ...ctx, env: null })).toContain('模擬／正式');
        expect(relayProblem(req({ issuedAt: NOW - RELAY_MAX_AGE_MS - 1 }), ctx)).toContain('逾時');
        expect(relayProblem(req({ issuedAt: NOW + 60_000 }), ctx)).toContain('逾時');
        expect(relayProblem(req(), { ...ctx, accounts: [{ ...A, account_id: '2' }] })).toContain('帳戶');
        expect(relayProblem(req({ path: '/api/v1/data/snapshots' }), ctx)).toContain('不能由主視窗代送');
        // a cancel by trade id carries no account: fine
        expect(relayProblem(req({ path: '/api/v1/order/cancel_order', body: '{"trade_id":"t1"}' }), { ...ctx, accounts: [] })).toBeNull();
    });
});

describe('createRelayHost (main window)', () => {
    const host = (post = vi.fn(async () => ({ status: 200, body: '{"ok":1}' })), env = ENV) => ({
        post, run: createRelayHost({ env: () => env, now: () => NOW, accounts: async () => [A], post }),
    });
    it('sends once to exactly the approved server; the same id again (any envelope) gets the same answer, never a second send', async () => {
        const h = host();
        expect(await h.run({ op: 'post', req: req() })).toEqual({ ok: { status: 200, body: '{"ok":1}' } });
        expect(await h.run({ op: 'post', req: req() })).toEqual({ ok: { status: 200, body: '{"ok":1}' } });
        expect(h.post).toHaveBeenCalledTimes(1);
        expect(h.post).toHaveBeenCalledWith('/api/v1/order/place_order', body, ENV);
    });

    it('a replay while the first send is still out waits for that answer — never "not sent"', async () => {
        let release!: (v: { status: number; body: string }) => void;
        const post = vi.fn(() => new Promise<{ status: number; body: string }>(r => { release = r; }));
        const run = createRelayHost({ env: () => ENV, now: () => NOW, accounts: async () => [A], post });
        const first = run({ op: 'post', req: req() });
        await Promise.resolve(); await Promise.resolve();
        const replay = run({ op: 'post', req: req() });
        release({ status: 200, body: '{}' });
        expect(await replay).toEqual({ ok: { status: 200, body: '{}' } });
        expect(await first).toEqual({ ok: { status: 200, body: '{}' } });
        expect(post).toHaveBeenCalledTimes(1);
    });

    it('the server / mode changes while the main window reads its accounts: not sent', async () => {
        let env = ENV;
        const post = vi.fn();
        const run = createRelayHost({ env: () => env, now: () => NOW, post,
            accounts: async () => { env = 'http://127.0.0.1:21323|simulation'; return [A]; } });
        expect(await run({ op: 'post', req: req() })).toEqual({ notStarted: expect.stringContaining('模擬／正式') });
        expect(post).not.toHaveBeenCalled();
    });
    it('a server / mode change since the popout approved it: not sent', async () => {
        const h = host(undefined, 'http://127.0.0.1:21322|production');
        expect(await h.run({ op: 'post', req: req() })).toEqual({ notStarted: expect.stringContaining('模擬／正式') });
        expect(h.post).not.toHaveBeenCalled();
    });
    it('the signed send refused before leaving: not sent; any other failure: outcome unknown', async () => {
        const refused = host(vi.fn(async () => { throw Object.assign(new Error('Harness 未啟用'), { mutationNotStarted: true }); }));
        expect(await refused.run({ op: 'post', req: req() })).toEqual({ notStarted: 'Harness 未啟用' });
        const lost = host(vi.fn(async () => { throw new Error('connection reset'); }));
        expect(await lost.run({ op: 'post', req: req({ id: 'r-2' }) })).toEqual({ unknown: 'connection reset' });
    });
});

describe('relayThroughMain (popout)', () => {
    const flags = (e: unknown) => ({ notStarted: !!(e as { mutationNotStarted?: boolean }).mutationNotStarted,
        unknown: !!(e as { mutationOutcomeUnknown?: boolean }).mutationOutcomeUnknown, message: (e as Error).message });

    it('main window absent (no answer to the ping): not sent, and the order is never posted', async () => {
        const send = vi.fn(async (cmd: { op: string }) => { if (cmd.op === 'ping') throw new CommandNotAcknowledged(); return 'x'; });
        const e = await relayThroughMain({ send } as never, '/api/v1/order/place_order', body, { env: ENV }).catch(x => x);
        expect(flags(e)).toEqual({ notStarted: true, unknown: false, message: RELAY_NO_MAIN });
        expect(send).toHaveBeenCalledTimes(1);
    });

    it('the caller\'s checks run after the ping, right before the order leaves; a refusal there sends nothing', async () => {
        const order: string[] = [];
        const send = vi.fn(async (cmd: { op: string }) => { order.push(cmd.op); return cmd.op === 'ping' ? 'pong' : { ok: { status: 200, body: '{}' } }; });
        await relayThroughMain({ send } as never, '/p', body, { env: ENV, beforeSend: () => order.push('check') });
        expect(order).toEqual(['ping', 'check', 'post']);
        const refused = vi.fn(async (cmd: { op: string }) => (cmd.op === 'ping' ? 'pong' : { ok: { status: 200, body: '{}' } }));
        const e = await relayThroughMain({ send: refused } as never, '/p', body, { env: ENV, beforeSend: () => { throw new Error('帳戶已變更'); } }).catch(x => x);
        expect(flags(e)).toMatchObject({ notStarted: true, message: '帳戶已變更' });
        expect(refused).toHaveBeenCalledTimes(1);
    });

    it('no answer to the order in time: outcome unknown, sent once, never resent', async () => {
        const send = vi.fn(async (cmd: { op: string }) => { if (cmd.op === 'ping') return 'pong'; throw new CommandNotAcknowledged(); });
        const e = await relayThroughMain({ send } as never, '/api/v1/order/place_order', body, { env: ENV }).catch(x => x);
        expect(flags(e)).toEqual({ notStarted: false, unknown: true, message: RELAY_NO_ANSWER });
        expect(send.mock.calls.filter(([c]) => (c as { op: string }).op === 'post')).toHaveLength(1);
    });

    it('server mode unknown in the popout: not sent; main refusals and unknowns keep their meaning', async () => {
        const never = vi.fn();
        expect(flags(await relayThroughMain({ send: never } as never, '/p', body, { env: null }).catch(x => x)).notStarted).toBe(true);
        expect(never).not.toHaveBeenCalled();
        const answer = (a: unknown) => ({ send: vi.fn(async (cmd: { op: string }) => (cmd.op === 'ping' ? 'pong' : a)) });
        expect(flags(await relayThroughMain(answer({ notStarted: '帳戶不可用' }) as never, '/p', body, { env: ENV }).catch(x => x)))
            .toMatchObject({ notStarted: true, message: '主視窗沒有送出：帳戶不可用' });
        expect(flags(await relayThroughMain(answer({ unknown: 'reset' }) as never, '/p', body, { env: ENV }).catch(x => x)))
            .toMatchObject({ unknown: true });
        expect(await relayThroughMain(answer({ ok: { status: 200, body: '{}' } }) as never, '/p', body, { env: ENV })).toEqual({ status: 200, body: '{}' });
    });

    it('end to end over the window bus: a lost message is retransmitted with the same envelope, the main sends once', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        type L = (e: MessageEvent) => void;
        const listeners: { main: L[]; pop: L[] } = { main: [], pop: [] };
        let dropFirstPost = true;
        const chan = (me: 'main' | 'pop') => ({
            addEventListener: (_: string, l: L) => { listeners[me].push(l); },
            close: () => undefined,
            postMessage: (data: { kind: string; cmd?: { op: string } }) => {
                if (me === 'pop' && data.kind === 'cmd' && data.cmd?.op === 'post' && dropFirstPost) { dropFirstPost = false; return; }
                const to = me === 'main' ? listeners.pop : listeners.main;
                queueMicrotask(() => to.forEach(l => l({ data } as MessageEvent)));
            },
        });
        const post = vi.fn(async () => ({ status: 200, body: '{"trade":1}' }));
        const host = createRelayHost({ env: () => ENV, now: () => Date.now(), accounts: async () => [A], post });
        createCommandBus({ channel: chan('main') as never, main: true, handle: host, snapshot: () => null });
        const popBus = createCommandBus({ channel: chan('pop') as never, main: false, handle: () => undefined, snapshot: () => null, retryMs: 100, timeoutMs: 5000 });
        const p = relayThroughMain(popBus as never, '/api/v1/order/place_order', body, { env: ENV });
        await vi.advanceTimersByTimeAsync(500);
        expect(await p).toEqual({ status: 200, body: '{"trade":1}' });
        expect(post).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});
