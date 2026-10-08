// 閃電下單的委託條件：限價效期 ROD／IOC／FOK、期貨倉別與範圍市價，送出前照
// 下單面板同一套規則檢查，確認視窗寫出所有非預設條件。
import { beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { ContractBase } from './types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), future: vi.fn(), accounts: [] as Account[], confirmOn: true }));
vi.mock('./runtime', () => ({ getApiBase: () => 'fixture' }));
vi.mock('./account-store', () => ({ getAccountState: () => ({ accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: undefined }) }));
vi.mock('./activity', () => ({ trackActivity: vi.fn() }));
vi.mock('./order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => a.account_id }));
vi.mock('./risk', () => ({ checkOrderAllowed: () => null, getRiskSettings: () => ({ confirmManualOrders: m.confirmOn }) }));
vi.mock('./stream', () => ({ getStreamStatus: () => 'live' }));
vi.mock('./trading-mirror-lease', () => ({ getTradingMirrorFresh: () => true }));
vi.mock('./shioaji', () => ({ placeStockOrder: m.stock, placeFuturesOrder: m.future, fetchTrades: vi.fn(), cancelOrders: vi.fn() }));
import { placeQuickOrder } from './trade';
import { ODD_LOT_TEXT } from './odd-lot';
import { ORDER_CONDITION_TEXT } from './order-conditions';

const account = { account_type: 'S', account_id: 'a', broker_id: 'b', signed: true, person_id: '', username: '' } as Account;
const stock = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, day_trade: 'Yes' } as ContractBase;

beforeEach(() => {
    vi.clearAllMocks();
    m.accounts = [account];
    m.confirmOn = true;
    m.confirm.mockResolvedValue(true);
    m.stock.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});

const fut = { code: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: null } as ContractBase;
const futAccount = { ...account, account_type: 'F' } as Account;
const useFutures = () => { m.accounts = [futAccount]; m.future.mockResolvedValue({ status: { status: 'PendingSubmit' } }); };

it('futures: limit order type and 倉別 go out as chosen', async () => {
    useFutures();
    await placeQuickOrder(fut, 'Buy', 100, 1, { account: futAccount, orderType: 'IOC', ocType: 'New' });
    await placeQuickOrder(fut, 'Sell', 100, 1, { account: futAccount, orderType: 'FOK', ocType: 'DayTrade' });
    expect(m.future.mock.calls[0]![1]).toMatchObject({ price_type: 'LMT', order_type: 'IOC', octype: 'New' });
    expect(m.future.mock.calls[1]![1]).toMatchObject({ price_type: 'LMT', order_type: 'FOK', octype: 'DayTrade' });
    expect(m.confirm.mock.calls[0]![0].note).toBe('限價 IOC・新倉');
    expect(m.confirm.mock.calls[1]![0].note).toBe('限價 FOK・當沖');
});

it('futures market orders can be 範圍市價 (MKP), always IOC', async () => {
    useFutures();
    await placeQuickOrder(fut, 'Buy', null, 1, { account: futAccount, futuresPriceType: 'MKP', orderType: 'FOK' });
    await placeQuickOrder(fut, 'Buy', null, 1, { account: futAccount });
    expect(m.future.mock.calls[0]![1]).toMatchObject({ price_type: 'MKP', order_type: 'IOC' });
    expect(m.future.mock.calls[1]![1]).toMatchObject({ price_type: 'MKT', order_type: 'IOC' });
    expect(m.confirm.mock.calls[0]![0].note).toBe('範圍市價 IOC');
    expect(m.confirm.mock.calls[1]![0].note).toBeUndefined();
});

it('refuses 範圍市價 on stocks and unknown futures conditions before the confirmation', async () => {
    await expect(placeQuickOrder(stock, 'Buy', null, 1, { account, futuresPriceType: 'MKP' })).rejects.toMatchObject({ mutationNotStarted: true });
    useFutures();
    await expect(placeQuickOrder(fut, 'Buy', 100, 1, { account: futAccount, ocType: 'Close' as never })).rejects.toMatchObject({ mutationNotStarted: true, message: ORDER_CONDITION_TEXT.octype });
    await expect(placeQuickOrder(fut, 'Buy', 100, 1, { account: futAccount, orderType: 'GTC' as never })).rejects.toMatchObject({ mutationNotStarted: true, message: ORDER_CONDITION_TEXT.orderType });
    expect(m.confirm).not.toHaveBeenCalled();
    expect(m.stock).not.toHaveBeenCalled();
    expect(m.future).not.toHaveBeenCalled();
});

it('stocks: limit FOK goes out; odd lots refuse IOC/FOK before the confirmation', async () => {
    await placeQuickOrder(stock, 'Sell', 100, 1, { account, orderType: 'FOK', orderCond: 'MarginTrading' });
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ order_type: 'FOK', order_cond: 'MarginTrading' });
    expect(m.confirm.mock.calls[0]![0].note).toBe('限價 FOK・融資');
    await expect(placeQuickOrder(stock, 'Buy', 100, 1, { account, orderLot: 'IntradayOdd', orderType: 'IOC' })).rejects.toMatchObject({ mutationNotStarted: true, message: ODD_LOT_TEXT.orderType });
    expect(m.confirm).toHaveBeenCalledOnce();
});
