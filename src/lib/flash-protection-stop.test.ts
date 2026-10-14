// #216 閃電「平倉／全刪」 end the panel's 停損停利 in both executors: the
// window's brackets (dismiss) and the background engine's (mark handled);
// an exit that is out or of unknown outcome blocks everything.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { protectionTargets, type BackgroundViewLike, type ProtectionScope, type WindowPlanLike } from './flash-trigger';

const m = vi.hoisted(() => ({ display: [] as unknown[], removeTrigger: vi.fn(), group: vi.fn(), triggers: [] as unknown[], plans: [] as unknown[], exits: [] as unknown[], programs: [] as unknown[], views: [] as unknown[],
    dismiss: vi.fn(), handled: vi.fn(), stale: false, health: { state: 'live' } as unknown, env: 'http://x|simulation' as string | null }));
vi.mock('./bracket', () => ({ getBrackets: () => m.plans, dismissBracket: m.dismiss, bracketSnapshotStale: () => m.stale }));
vi.mock('./protection-env', () => ({ currentProtectionEnv: () => m.env }));
vi.mock('./bracket-core', () => ({ isLive: (p: { live?: boolean }) => p.live !== false }));
vi.mock('./trigger-engine', () => ({ getExits: () => m.exits, getTriggers: () => m.triggers, getDisplayTriggers: () => m.display,
    removeTriggerStrict: m.removeTrigger, setTriggerGroup: m.group }));
vi.mock('./execution/background', () => ({ getBackgroundPrograms: () => m.programs, markBackgroundHandled: m.handled, backgroundSupported: () => true,
    getBackgroundHealth: () => m.health }));
vi.mock('./execution/bracket-contract', () => ({ bracketViews: () => m.views }));
const { flashStopProtections } = await import('./flash-conditional');

const A = { account_type: 'F', broker_id: 'B', account_id: '1' };
const ENV = 'http://x|simulation';
const scope: ProtectionScope = { account: A, codes: ['TXFR1', 'TXFJ6'], odd: false, env: ENV };
const plan = (p: Partial<WindowPlanLike>): WindowPlanLike => ({ id: 'p1', env: ENV, account: A, quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', live: true, exit: null, ...p });
const view = (v: Partial<BackgroundViewLike>): BackgroundViewLike => ({ programId: 'bkt-1', env: ENV, exitBusy: false, levelId: 't0', account: { accountType: 'F', brokerId: 'B', accountId: '1' },
    quoteCode: 'TXFR1', orderCode: 'TXFJ6', state: 'protected', canEnd: true, ...v });

describe('protectionTargets', () => {
    it('this account + product (+ unit) only; ended ones skipped', () => {
        const t = protectionTargets(scope, [plan({}), plan({ id: 'p2', account: { ...A, account_id: '2' } }), plan({ id: 'p3', quoteCode: 'MXFR1', orderCode: 'MXFJ6' }),
            plan({ id: 'p4', dismissed: true }), plan({ id: 'p5', live: false })], [],
            [view({}), view({ programId: 'bkt-2', state: 'done' }), view({ programId: 'bkt-3', quoteCode: 'MXFR1', orderCode: 'MXFJ6' })]);
        expect(t).toEqual({ window: ['p1'], background: [{ programId: 'bkt-1', levelId: 't0' }], blocked: [], snapshots: [] });
        const S = { ...A, account_type: 'S' };
        const stock = { ...scope, account: S, codes: ['2330'] };
        const odd = plan({ id: 'o', account: S, quoteCode: '2330', orderCode: '2330', securityType: 'STK', orderLot: 'IntradayOdd' });
        const lot = plan({ id: 'l', account: S, quoteCode: '2330', orderCode: '2330', securityType: 'STK' });
        const bg = view({ account: { accountType: 'S', brokerId: 'B', accountId: '1' }, quoteCode: '2330', orderCode: '2330' });
        expect(protectionTargets(stock, [odd, lot], [], [bg])).toMatchObject({ window: ['l'], background: [{ programId: 'bkt-1' }] });
        expect(protectionTargets({ ...stock, odd: true }, [odd, lot], [], [bg])).toMatchObject({ window: ['o'], background: [] });
        // a stock 平倉 closes both units: both units' protection
        expect(protectionTargets({ ...stock, odd: null }, [odd, lot], [], [bg])).toMatchObject({ window: ['o', 'l'], background: [{ programId: 'bkt-1' }] });
        // another server / mode is never touched
        expect(protectionTargets(scope, [plan({ env: 'http://x|production' })], [], [view({ env: 'http://x|production' })]))
            .toEqual({ window: [], background: [], blocked: [], snapshots: [] });
    });

    it('an exit out or unknown blocks: window plan exit, its trigger leg, background exiting / unknown / not endable', () => {
        expect(protectionTargets(scope, [plan({ exit: { status: 'sending' } })], [], []).blocked).toHaveLength(1);
        expect(protectionTargets(scope, [plan({ exit: { status: 'unknown' } })], [], []).blocked[0]).toContain('結果未知');
        expect(protectionTargets(scope, [plan({ exit: { status: 'unknown', acknowledged: true } })], [], []).blocked).toHaveLength(0);
        expect(protectionTargets(scope, [plan({})], [{ bracketId: 'p1', account: A, orderCode: 'TXFJ6', status: 'working' }], []).blocked).toHaveLength(1);
        for (const v of [view({ state: 'exiting' }), view({ state: 'unknown' }), view({ canEnd: false }), view({ state: 'unprotected', exitBusy: true })]) {
            expect(protectionTargets(scope, [], [], [v])).toMatchObject({ background: [], blocked: [expect.stringContaining('背景執行')] });
        }
    });
});

describe('snapshots (what an unfilled 平倉 puts back)', () => {
    it('a window bracket by its armed legs, a background bracket by its view; stocks mark odd lots', () => {
        const t = protectionTargets(scope, [plan({ legs: [
            { kind: 'stop', price: 95, quantity: 2, action: 'Sell' }, { kind: 'take', price: 110, quantity: 2, action: 'Sell' }] })], [],
        [view({ side: 'Sell', stop: 120, take: 90, position: 1 }), view({ programId: 'bkt-9', side: 'Buy', stop: null, take: null, position: 1 })]);
        expect(t.snapshots).toEqual([
            { exitAction: 'Sell', stop: 95, take: 110, quantity: 2 },
            { exitAction: 'Buy', stop: 120, take: 90, quantity: 1 },
        ]);
        const S = { ...A, account_type: 'S' };
        const odd = plan({ id: 'o', account: S, quoteCode: '2330', orderCode: '2330', securityType: 'STK', orderLot: 'IntradayOdd',
            legs: [{ kind: 'stop', price: 1000, quantity: 300, action: 'Sell' }] });
        expect(protectionTargets({ ...scope, account: S, codes: ['2330'], odd: null }, [odd], [], []).snapshots)
            .toEqual([{ exitAction: 'Sell', stop: 1000, take: null, quantity: 300, odd: true }]);
    });
});

describe('plain protective triggers (a 觸價欄 exit, a restore after an unfilled 平倉)', () => {
    const t = (o: Record<string, unknown>) => ({ id: 'tg-1', code: 'TXFR1', orderCode: 'TXFJ6', env: ENV, account: A, kind: 'stop', action: 'Sell', price: 95, quantity: 2, ...o });
    it('are ended too (singles and 二擇一 groups), with snapshots; entries, bracket legs and other accounts are not', () => {
        const r = protectionTargets(scope, [], [], [], [
            t({}), t({ id: 'g1', group: 'G', kind: 'stop', price: 94 }), t({ id: 'g2', group: 'G', kind: 'take', price: 112 }),
            t({ id: 'e', role: 'entry' }), t({ id: 'b', bracketId: 'p1' }), t({ id: 'x', account: { ...A, account_id: '2' } }),
        ] as never);
        expect(r.triggers).toEqual({ single: ['tg-1'], groups: [['g1', 'g2']] });
        expect(r.snapshots).toEqual([
            { exitAction: 'Sell', stop: 95, take: null, quantity: 2 },
            expect.objectContaining({ exitAction: 'Sell', stop: 94, take: 112, quantity: 2 }),
        ]);
    });
    it('a pending one blocks', () => {
        expect(protectionTargets(scope, [], [], [], [t({ pending: { price: 1, at: 1 } })] as never).blocked).toHaveLength(1);
    });
});

describe('flashStopProtections', () => {
    beforeEach(() => {
        m.dismiss.mockReset().mockResolvedValue(true);
        m.handled.mockReset().mockResolvedValue(undefined);
        m.exits = [];
        m.programs = [];
        m.display = [];
        m.stale = false;
        m.health = { state: 'live' };
        m.env = ENV;
    });

    it('never trusts a list that may be out of date, or an unknown mode', async () => {
        m.plans = [plan({})];
        m.views = [];
        m.stale = true;
        expect((await flashStopProtections(scope)).blocked[0]).toContain('主視窗');
        m.stale = false;
        m.health = null;
        expect((await flashStopProtections(scope)).blocked[0]).toContain('背景執行');
        m.health = { state: 'live' };
        m.env = null;
        expect((await flashStopProtections(scope)).blocked[0]).toContain('伺服器模式');
        expect(m.dismiss).not.toHaveBeenCalled();
    });

    it('a protection that fires while being ended blocks the close', async () => {
        m.plans = [plan({})];
        m.views = [];
        m.dismiss.mockImplementation(async () => {
            m.exits = [{ bracketId: 'p1', account: A, orderCode: 'TXFJ6', status: 'sending' }];
            m.plans = [plan({ dismissed: true })];
            return true;
        });
        const r = await flashStopProtections(scope);
        expect(r.blocked[0]).toContain('取消期間停損停利已觸發');
    });

    it('still tracked after its end was accepted: not confirmed', async () => {
        m.plans = [];
        m.views = [{ ...view({}), actions: { markHandled: true } }];
        expect((await flashStopProtections(scope)).failed).toEqual(['停損停利仍在執行中，取消未確認']);
    });

    it('ends the window bracket and the background bracket', async () => {
        m.plans = [plan({})];
        m.views = [{ ...view({}), actions: { markHandled: true } }];
        m.dismiss.mockImplementation(async () => { m.plans = [plan({ dismissed: true })]; return true; });
        m.handled.mockImplementation(async () => { m.views = [{ ...view({ state: 'handled' }), actions: { markHandled: false } }]; });
        expect(await flashStopProtections(scope)).toEqual({ stopped: 2, blocked: [], failed: [], restore: [], env: ENV });
        expect(m.dismiss).toHaveBeenCalledWith('p1');
        // with the panel's account + product (a flash popout's end is scoped natively)
        expect(m.handled).toHaveBeenCalledWith('bkt-1', 't0', { account: { accountType: 'F', brokerId: 'B', accountId: '1' }, codes: ['TXFR1', 'TXFJ6'] });
    });

    it('blocked: nothing is ended in either engine', async () => {
        m.plans = [plan({}), plan({ id: 'p2', exit: { status: 'sending' } })];
        m.views = [{ ...view({}), actions: { markHandled: true } }];
        const r = await flashStopProtections(scope);
        expect(r.blocked).toHaveLength(1);
        expect(m.dismiss).not.toHaveBeenCalled();
        expect(m.handled).not.toHaveBeenCalled();
    });

    it('an end that is not confirmed is reported as failed', async () => {
        m.plans = [];
        m.views = [{ ...view({}), actions: { markHandled: true } }];
        m.handled.mockRejectedValue(new Error('引擎沒有回應'));
        expect(await flashStopProtections(scope)).toEqual({ stopped: 0, blocked: [], failed: ['背景執行：引擎沒有回應'], restore: [], env: ENV });
    });
});
