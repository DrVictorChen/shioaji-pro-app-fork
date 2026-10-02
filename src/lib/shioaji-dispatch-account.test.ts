import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { Trade } from './types/order';
import type { ContractBase } from './types/contract';

const m = vi.hoisted(() => ({ accounts: [] as Account[], trades: [] as Trade[], baseline: vi.fn() }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts }), accountFor: () => m.accounts[0] }));
vi.mock('./trading-state', () => ({ getTradingState: () => ({ trades: m.trades }), hasOrdersBaseline: m.baseline, cancelCacheTrusted: vi.fn(), locallyCancelled: vi.fn() }));
import { cancelComboOrder, cancelOrder, placeComboOrder, placeFuturesOrder, placeStockOrder, updateOrderPrice, updateOrderQty, type ServerInfo } from './shioaji';
import { beginServerInfoRequest, forgetServerInfo, observeServerInfo } from './server-info-store';

const mode = (simulation: boolean) => observeServerInfo(beginServerInfoRequest(), { simulation } as ServerInfo);
const contract = { code: 'fixture', security_type: 'FUT', exchange: 'TAIFEX' } as ContractBase;
const order = { action: 'Buy' as const, price: 100, quantity: 1, price_type: 'LMT' as const, order_type: 'ROD' as const, octype: 'Auto' as const };
const fetchMock = vi.fn();
beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('BroadcastChannel', undefined);
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: (lock: object) => unknown) => callback({}) } });
    m.accounts = [{ account_type: 'F', broker_id: 'fixture', account_id: 'unsigned', signed: false, username: '', person_id: '' }];
    m.trades = [{ account: m.accounts[0], contract, order: { ...order, account: m.accounts[0], id: 'id' }, status: { status: 'Submitted' } } as unknown as Trade];
    m.baseline.mockReturnValue(true);
    forgetServerInfo('');
    mode(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(m.trades[0])));
});
afterEach(() => vi.unstubAllGlobals());

it.each(['F', 'S'] as const)('dispatches an unsigned %s account in simulation without rewriting signed', async type => {
    m.accounts[0]!.account_type = type;
    if (type === 'F') await placeFuturesOrder(contract, order, m.accounts[0]);
    else await placeStockOrder({ ...contract, security_type: 'STK' }, { ...order, order_lot: 'Common' }, m.accounts[0]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect((body.futures_order ?? body.stock_order).account.signed).toBe(false);
    expect(m.accounts[0]!.signed).toBe(false);
});

it.each([false, undefined])('all placement paths reject unsigned accounts in mode %s without HTTP', async simulation => {
    if (simulation === undefined) forgetServerInfo(''); else mode(simulation);
    await expect(placeFuturesOrder(contract, order, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    m.accounts[0]!.account_type = 'S';
    await expect(placeStockOrder(contract, { ...order, order_lot: 'Common' }, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true });
    m.accounts[0]!.account_type = 'F';
    await expect(placeComboOrder({ legs: [] }, order, m.accounts[0])).rejects.toMatchObject({ mutationNotStarted: true });
    await expect(cancelComboOrder('id')).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it('checks mode again at the actual HTTP boundary after request serialization', async () => {
    const account = m.accounts[0]!;
    Object.assign(account, { toJSON: () => { mode(false); return { ...account, toJSON: undefined }; } });
    await expect(placeFuturesOrder(contract, order, account)).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it('uses the current account row rather than a captured signed flag', async () => {
    const captured = { ...m.accounts[0]!, signed: true };
    mode(false);
    await expect(placeFuturesOrder(contract, order, captured)).rejects.toMatchObject({ mutationNotStarted: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

const mutations = [
    () => cancelOrder('id'),
    () => updateOrderPrice('id', 101),
    () => updateOrderQty('id', 1),
] as const;
it.each(mutations)('revalidates mutations when mode changes after account preflight', async call => {
    m.baseline.mockImplementation(() => { mode(false); return true; });
    await expect(call()).rejects.toMatchObject({ mutationNotStarted: true, tradingGateRejected: true });
    expect(fetchMock).not.toHaveBeenCalled();
});

it.each(mutations)('rejects mutations without Web Locks before account preflight', async call => {
    vi.stubGlobal('navigator', {});
    expect(navigator.locks).toBeUndefined();
    const error = await call().catch(error => error);
    expect(error).toMatchObject({ message: expect.stringContaining('Web Locks'), mutationNotStarted: true });
    expect(error).not.toHaveProperty('tradingGateRejected');
    expect(m.baseline).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
});
