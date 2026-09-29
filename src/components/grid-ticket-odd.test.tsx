// #204 鋪單盤中零股：每檔以股計、送出 IntradayOdd 限價 ROD、跟隨只管同單位的網格單
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), cancel: vi.fn(), notify: vi.fn(), risk: vi.fn() }));
const h = vi.hoisted(() => ({ account: { account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' } }));
vi.mock('../lib/account-store', () => ({ getAccountState: () => ({ accounts: [h.account], selectedStock: h.account, selectedFutures: null, loaded: true }) }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: m.cancel, cancelOrders: vi.fn(), placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: m.notify, isFuturesContract: () => false }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { GridTicket } from './grid-ticket';

const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', reference: 100, limit_up: 0, limit_down: 0 } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b).includes(label))!;
const gridTrade = (price: number, id: string, lot: string) => ({ account: h.account, contract: { code: '2330' },
    order: { id, account: h.account, action: 'Buy', price, custom_field: 'sjgrid', order_lot: lot }, status: { status: 'Submitted' } }) as unknown as Trade;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    m.confirm.mockResolvedValue(true);
    m.stock.mockResolvedValue({});
    m.cancel.mockResolvedValue({});
    m.risk.mockReturnValue(null);
});
afterEach(async () => { await act(async () => view?.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('lays an odd-lot grid in shares as IntradayOdd LMT ROD, confirmed and risk-checked in 股', async () => {
    await act(async () => { view = create(createElement(GridTicket, { contract, trades: [] })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    const qty = view.root.findAllByType('input')[3]!; // 起始檔距, 檔數, 間隔, 每檔量
    await act(async () => { qty.props.onChange({ target: { value: '250' } }); });
    expect(text(view.root)).toContain('每檔量(股)');
    expect(text(view.root)).toContain('× 250 股・盤中零股限價');
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { await btn('鋪 ').props.onClick(); });
    expect(m.risk).toHaveBeenCalledWith(1250, 'IntradayOdd');
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ unit: '股', quantity: 1250, note: expect.stringContaining('盤中零股') });
    expect(m.stock).toHaveBeenCalledTimes(5);
    expect(m.stock.mock.calls.every(c => c[1].order_lot === 'IntradayOdd' && c[1].quantity === 250 && c[1].price_type === 'LMT' && c[1].order_type === 'ROD')).toBe(true);
});

it('odd-lot follow ignores whole-lot grid orders at the same prices', async () => {
    // whole-lot grid orders at 99/98 must not count as the odd grid, and the stray whole-lot 90 is not cancelled
    const trades = [gridTrade(99, 'c99', 'Common'), gridTrade(98, 'c98', 'Common'), gridTrade(90, 'c90', 'Common'), gridTrade(99, 'o99', 'IntradayOdd')];
    await act(async () => { view = create(createElement(GridTicket, { contract, trades })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { btn('解鎖鋪單').props.onClick(); });
    await act(async () => { btn('動態跟隨現價').props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2600); });
    expect(m.cancel).not.toHaveBeenCalled();
    expect(m.stock.mock.calls.map(c => [c[1].price, c[1].order_lot])).toEqual([[98, 'IntradayOdd'], [97, 'IntradayOdd'], [96, 'IntradayOdd'], [95, 'IntradayOdd']]);
    expect(m.risk).toHaveBeenCalledWith(1, 'IntradayOdd');
});
