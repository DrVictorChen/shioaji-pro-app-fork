// #204 下單面板零股：盤中／盤後零股只限價 ROD、僅現股；數量以股計並送出正確 order_lot
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const m = vi.hoisted(() => ({ confirm: vi.fn(), stock: vi.fn(), risk: vi.fn() }));
const h = vi.hoisted(() => ({ account: { account_type: 'S', broker_id: 'BR', account_id: '99887766A', signed: true, person_id: '', username: '' } }));
vi.mock('../lib/account-store', () => {
    const state = () => ({ accounts: [h.account], selectedStock: h.account, selectedFutures: null, loaded: true });
    return { useAccounts: state, getAccountState: state, selectAccount: vi.fn() };
});
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: m.confirm, accountConfirmLabel: (a: Account) => `${a.broker_id}-${a.account_id}` }));
vi.mock('../lib/risk', () => ({ checkOrderAllowed: m.risk, getRiskSettings: () => ({ confirmManualOrders: true }) }));
vi.mock('../lib/shioaji', () => ({ fetchInfo: () => new Promise(() => undefined), placeFuturesOrder: vi.fn(), placeStockOrder: m.stock }));
vi.mock('../lib/trade', () => ({ notify: vi.fn() }));
vi.mock('../lib/bracket', () => ({ ensureBracketHost: vi.fn(), registerBracket: vi.fn(), registrationFailureText: String, validateBracketRequest: () => null }));
vi.mock('./bracket-status', () => ({ BracketStatusList: () => null }));
vi.mock('../lib/protection-env', () => ({ currentProtectionEnv: () => 'sim' }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => ({ tick: { close: '100' } }), useTradingLive: () => true }));
vi.mock('../lib/price-sync', () => ({ usePickedPrice: () => null }));
vi.mock('../lib/allocation', () => ({ allocateByRatio: (t: number, w: number[]) => w.map(() => t), loadAllocPresets: () => [], saveAllocPreset: () => [], deleteAllocPreset: () => [] }));
import { OrderTicket } from './order-ticket';

const contract = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', reference: 100, day_trade: 'Yes' } as unknown as ContractInfo;
const text = (n: ReactTestInstance): string => n.children.map(c => typeof c === 'string' ? c : text(c)).join('');
let view!: ReactTestRenderer;
const btn = (label: string) => view.root.findAllByType('button').find(b => text(b) === label)!;
const exec = () => view.root.findAllByType('button').find(b => /(買進|賣出)下單|確認(買進|賣出)/.test(text(b)))!;
const qtyInput = () => view.root.findAll(n => n.type === 'input' && String(n.props['aria-label'] ?? '').startsWith('數量'))[0]!;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    m.confirm.mockResolvedValue(true);
    m.risk.mockReturnValue(null);
    m.stock.mockResolvedValue({ status: { status: 'Submitted' }, order: { id: 'o1', seqno: '1' } });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it.each([['盤中零股', 'IntradayOdd'], ['盤後零股', 'Odd']])('%s: margin/day-trade/market are cleared or disabled; sends %s LMT ROD in shares', async (label, lot) => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    // pick 融資 + MKT on whole lots first
    await act(async () => { btn('賣出 Sell').props.onClick(); });
    await act(async () => { btn('融資').props.onClick(); });
    await act(async () => { btn('MKT').props.onClick(); });
    await act(async () => { btn(label).props.onClick(); });
    // odd lots: no credit row, no day-trade toggle, MKT / IOC / FOK disabled with the reason
    expect(btn('融資')).toBeUndefined();
    expect(btn('現股當沖先賣')).toBeUndefined();
    expect(btn('MKT').props.disabled).toBe(true);
    expect(btn('MKT').props.title).toContain('限價');
    expect(btn('IOC').props.disabled).toBe(true);
    expect(text(view.root)).toContain(`${label}：以股計`);
    if (lot === 'Odd') expect(btn('停損停利保護')).toBeUndefined();
    await act(async () => { qtyInput().props.onChange({ target: { value: '1200' } }); }); // >999 ignored
    await act(async () => { qtyInput().props.onChange({ target: { value: '350' } }); });
    await act(async () => { await exec().props.onClick(); });
    await act(async () => { await exec().props.onClick(); });
    expect(m.risk).toHaveBeenCalledWith(350, lot);
    expect(m.confirm.mock.calls[0]![0]).toMatchObject({ unit: '股', quantity: 350, note: expect.stringContaining(label) });
    expect(m.stock.mock.calls[0]![1]).toMatchObject({ quantity: 350, price_type: 'LMT', order_type: 'ROD', order_lot: lot, order_cond: undefined, daytrade_short: undefined });
});

it('switching unit resets the quantity so shares never become lots', async () => {
    await act(async () => { view = create(createElement(OrderTicket, { contract, onPlaced: vi.fn() })); });
    await act(async () => { btn('盤中零股').props.onClick(); });
    await act(async () => { qtyInput().props.onChange({ target: { value: '500' } }); });
    await act(async () => { btn('整股').props.onClick(); });
    expect(qtyInput().props.value).toBe(1);
    expect(qtyInput().props['aria-label']).toBe('數量（張）');
});
