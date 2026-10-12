// #216 閃電「平倉／全刪」 end the panel's 停損停利 in both executors: the
// window's brackets (dismiss) and the background engine's (mark handled);
// an exit that is out or of unknown outcome blocks everything.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { protectionTargets, type BackgroundViewLike, type ProtectionScope, type WindowPlanLike } from './flash-trigger';

const m = vi.hoisted(() => ({ plans: [] as unknown[], exits: [] as unknown[], programs: [] as unknown[], views: [] as unknown[],
    dismiss: vi.fn(), handled: vi.fn() }));
vi.mock('./bracket', () => ({ getBrackets: () => m.plans, dismissBracket: m.dismiss }));
vi.mock('./bracket-core', () => ({ isLive: (p: { live?: boolean }) => p.live !== false }));
vi.mock('./trigger-engine', () => ({ getExits: () => m.exits }));
vi.mock('./execution/background', () => ({ getBackgroundPrograms: () => m.programs, markBackgroundHandled: m.handled }));
vi.mock('./execution/bracket-contract', () => ({ bracketViews: () => m.views }));
const { flashStopProtections } = await import('./flash-conditional');

const A = { account_type: 'F', broker_id: 'B', account_id: '1' };
const scope: ProtectionScope = { account: A, codes: ['TXFR1', 'TXFJ6'], odd: false };
const plan = (p: Partial<WindowPlanLike>): WindowPlanLike => ({ id: 'p1', account: A, quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT', live: true, exit: null, ...p });
const view = (v: Partial<BackgroundViewLike>): BackgroundViewLike => ({ programId: 'bkt-1', levelId: 't0', account: { accountType: 'F', brokerId: 'B', accountId: '1' },
    quoteCode: 'TXFR1', orderCode: 'TXFJ6', state: 'protected', canEnd: true, ...v });

describe('protectionTargets', () => {
    it('this account + product (+ unit) only; ended ones skipped', () => {
        const t = protectionTargets(scope, [plan({}), plan({ id: 'p2', account: { ...A, account_id: '2' } }), plan({ id: 'p3', quoteCode: 'MXFR1', orderCode: 'MXFJ6' }),
            plan({ id: 'p4', dismissed: true }), plan({ id: 'p5', live: false })], [],
            [view({}), view({ programId: 'bkt-2', state: 'done' }), view({ programId: 'bkt-3', quoteCode: 'MXFR1', orderCode: 'MXFJ6' })]);
        expect(t).toEqual({ window: ['p1'], background: [{ programId: 'bkt-1', levelId: 't0' }], blocked: [] });
        const S = { ...A, account_type: 'S' };
        const stock = { ...scope, account: S, codes: ['2330'] };
        const odd = plan({ id: 'o', account: S, quoteCode: '2330', orderCode: '2330', securityType: 'STK', orderLot: 'IntradayOdd' });
        const lot = plan({ id: 'l', account: S, quoteCode: '2330', orderCode: '2330', securityType: 'STK' });
        const bg = view({ account: { accountType: 'S', brokerId: 'B', accountId: '1' }, quoteCode: '2330', orderCode: '2330' });
        expect(protectionTargets(stock, [odd, lot], [], [bg])).toMatchObject({ window: ['l'], background: [{ programId: 'bkt-1' }] });
        expect(protectionTargets({ ...stock, odd: true }, [odd, lot], [], [bg])).toMatchObject({ window: ['o'], background: [] });
    });

    it('an exit out or unknown blocks: window plan exit, its trigger leg, background exiting / unknown / not endable', () => {
        expect(protectionTargets(scope, [plan({ exit: { status: 'sending' } })], [], []).blocked).toHaveLength(1);
        expect(protectionTargets(scope, [plan({ exit: { status: 'unknown' } })], [], []).blocked[0]).toContain('結果未知');
        expect(protectionTargets(scope, [plan({ exit: { status: 'unknown', acknowledged: true } })], [], []).blocked).toHaveLength(0);
        expect(protectionTargets(scope, [plan({})], [{ bracketId: 'p1', account: A, orderCode: 'TXFJ6', status: 'working' }], []).blocked).toHaveLength(1);
        for (const v of [view({ state: 'exiting' }), view({ state: 'unknown' }), view({ canEnd: false })]) {
            expect(protectionTargets(scope, [], [], [v])).toMatchObject({ background: [], blocked: [expect.stringContaining('背景執行')] });
        }
    });
});

describe('flashStopProtections', () => {
    beforeEach(() => {
        m.dismiss.mockReset().mockResolvedValue(true);
        m.handled.mockReset().mockResolvedValue(undefined);
        m.exits = [];
        m.programs = [];
    });

    it('ends the window bracket and the background bracket', async () => {
        m.plans = [plan({})];
        m.views = [{ ...view({}), actions: { markHandled: true } }];
        expect(await flashStopProtections(scope)).toEqual({ stopped: 2, blocked: [], failed: [] });
        expect(m.dismiss).toHaveBeenCalledWith('p1');
        expect(m.handled).toHaveBeenCalledWith('bkt-1', 't0');
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
        expect(await flashStopProtections(scope)).toEqual({ stopped: 0, blocked: [], failed: ['背景執行：引擎沒有回應'] });
    });
});
