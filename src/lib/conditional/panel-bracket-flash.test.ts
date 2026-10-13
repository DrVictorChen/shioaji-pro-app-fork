// src/lib/conditional/panel-bracket-flash.test.ts — #216 閃電下單的自動停損停利
// goes through the panel bracket: the entry keeps the flash panel's own
// order conditions (效期、倉別、範圍市價) and guards, in this window and in
// the background engine alike; the confirmation names the protection.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ place: vi.fn(), host: vi.fn(), register: vi.fn(), add: vi.fn(), create: vi.fn(),
    supported: false, owner: 'background' as unknown, notify: vi.fn() }));
vi.mock('../risk', () => ({ getRiskSettings: () => ({ enabled: false, maxDailyLoss: 0 }) }));
vi.mock('../bracket', () => ({ ensureBracketHost: m.host, registerBracket: m.register, registrationFailureText: (e: unknown) => String(e) }));
vi.mock('../protection-env', () => ({ currentProtectionEnv: () => 'http://x|simulation' }));
vi.mock('../trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../trigger-engine', () => ({ addTrigger: m.add }));
vi.mock('../tick-bands', () => ({ ensureTickBands: async () => undefined, prefetchTickBands: () => undefined, bandTickFor: () => undefined }));
vi.mock('../execution/background', () => ({ backgroundSupported: () => m.supported, backgroundOwnerForNew: async () => m.owner,
    createBackgroundBracket: m.create }));

const { placePanelBracket } = await import('./panel-bracket');
const { flashProtectPlan } = await import('../flash-trigger');
const TXF = { code: 'TXFR1', target_code: 'TXFJ6', security_type: 'FUT', exchange: 'TAIFEX', tick: 1 };
const A = { account_type: 'F', broker_id: 'b', account_id: 'a', person_id: '', signed: true, username: '' };
const plan = flashProtectPlan({ on: true, stopTicks: 8, takeTicks: 16, trail: { activateTicks: 4, distanceTicks: 3, stepTicks: 1 } }, 2);
const opts = () => m.place.mock.calls[0]![4] as Record<string, unknown> & { beforeSend: () => void };

beforeEach(() => {
    for (const f of [m.place, m.host, m.register, m.add, m.create, m.notify]) f.mockReset();
    m.supported = false;
    m.owner = 'background';
    m.create.mockResolvedValue('created');
    m.place.mockResolvedValue({ order: { id: 'E1', seqno: 'S1', ordno: '' }, contract: { code: 'TXFR1', target_code: 'TXFJ6' } });
});

describe('flash entry with 自動停損停利', () => {
    it('the plan is one tier of the whole quantity with the trailing stop on its take', () => {
        expect(plan).toEqual({ tiers: [{ quantity: 2, takeTicks: 16 }], stopTicks: 8, trail: { activateTicks: 4, distanceTicks: 3, stepTicks: 1 }, breakeven: null });
    });

    it('window: an IOC limit keeps its 效期 and 新倉, the guards run, then the tier is registered', async () => {
        const guard = vi.fn();
        const isAccountCurrent = () => true;
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'LMT', price: 48000 },
            plan, refPrice: 48000, order: { orderType: 'IOC', octype: 'New', beforeSend: guard, isAccountCurrent, confirmNote: '附自動停損停利' } })).toBe('placed');
        expect(m.host).toHaveBeenCalledTimes(1);
        expect(opts()).toMatchObject({ source: 'manual', orderType: 'IOC', ocType: 'New', isAccountCurrent, confirmNote: '附自動停損停利' });
        opts().beforeSend();
        expect(guard).toHaveBeenCalledTimes(1);
        expect(m.register).toHaveBeenCalledTimes(1);
        expect(m.register.mock.calls[0]![0]).toMatchObject({ quantity: 2, orderId: 'E1', rules: { stopTicks: 8, takeTicks: 16, trail: plan.trail } });
    });

    it('window: a market entry goes out as 範圍市價 when the panel says so (never a limit 效期)', async () => {
        await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Sell', entry: { type: 'MKT' }, plan, refPrice: 48000,
            order: { orderType: 'FOK', futuresPriceType: 'MKP' } });
        expect(m.place.mock.calls[0]![2]).toBeNull();
        expect(opts()).toMatchObject({ futuresPriceType: 'MKP', ocType: 'Auto' });
        expect(opts().orderType).toBeUndefined();
    });

    it('a guard that refuses at the last moment: nothing registered', async () => {
        m.place.mockImplementation(async (_c: unknown, _a: unknown, _p: unknown, _q: unknown, o: { beforeSend: () => void }) => {
            o.beforeSend();
            return { order: { id: 'E1' } };
        });
        await expect(placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'MKT' }, plan, refPrice: 48000,
            order: { beforeSend: () => { throw new Error('帳戶已變更'); } } })).rejects.toThrow('帳戶已變更');
        expect(m.register).not.toHaveBeenCalled();
    });

    it('background on: the flash entry is sent here with its conditions, then handed to the engine', async () => {
        m.supported = true;
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'LMT', price: 48000 },
            plan, refPrice: 48000, order: { orderType: 'IOC', octype: 'New' } })).toBe('placed');
        expect(opts()).toMatchObject({ orderType: 'IOC', ocType: 'New' });
        expect(m.register).not.toHaveBeenCalled();
        expect(m.create.mock.calls[0]![0]).toMatchObject({ side: 'Buy', qty: 2, entry: { tradeId: 'E1' },
            plan: { tiers: [{ quantity: 2, takeTicks: 16 }], stopTicks: 8 } });
    });

    it('background on but unusable: refused before anything is sent', async () => {
        m.supported = true;
        m.owner = { refused: '背景執行目前無法使用' };
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', entry: { type: 'MKT' }, plan, refPrice: 48000 }))
            .toEqual({ error: '背景執行目前無法使用' });
        expect(m.place).not.toHaveBeenCalled();
    });

    it('a 觸價 entry with protection: window trigger with 新倉 kept; background engine fires it itself', async () => {
        const validity = { type: 'today' as const, until: Date.now() + 60_000 };
        m.add.mockResolvedValue({ id: 't1' });
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 48100,
            entry: { type: 'touch', condition: 'above', price: 48100, send: { type: 'MKP' }, validity }, order: { octype: 'New' } })).toBe('trigger');
        expect(m.add.mock.calls[0]![0]).toMatchObject({ role: 'entry', kind: 'stop', octype: 'New', send: { type: 'MKP' }, bracketPlan: plan, quantity: 2 });
        m.supported = true;
        expect(await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 48100,
            entry: { type: 'touch', condition: 'above', price: 48100, send: { type: 'MKP' }, validity } })).toBe('trigger');
        expect(m.create.mock.calls[0]![0]).toMatchObject({ trigger: { condition: 'above', price: 48100, order: { priceType: 'MKP', timeInForce: 'IOC' } } });
        expect(m.create.mock.calls[0]![0].trigger.order.octype).toBeUndefined();
        // 新倉 stays new in the engine's entry order too
        await placePanelBracket({ contract: TXF as never, account: A as never, action: 'Buy', plan, refPrice: 48100,
            entry: { type: 'touch', condition: 'above', price: 48100, send: { type: 'LMT', ticks: 1 }, validity }, order: { octype: 'New' } });
        expect(m.create.mock.calls[1]![0].trigger.order).toEqual({ priceType: 'LMT', timeInForce: 'ROD', octype: 'New' });
        expect(m.place).not.toHaveBeenCalled();
    });
});
