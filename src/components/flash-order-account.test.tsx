import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('../hooks/use-flash-ladder', () => ({ useFlashLadder: () => ({ marks: new Map(), protectedQty: 0, background: false }) }));
vi.mock('../lib/flash-conditional', () => ({ flashStopProtections: async () => ({ stopped: 0, blocked: [], failed: [], restore: [] }) }));
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ cancel: vi.fn(), place: vi.fn(), stockExit: vi.fn(), notify: vi.fn(), selected: 'A' }));
const accounts: Account[] = ['A', 'B'].map(account_id => ({ account_type: 'F', broker_id: 'BR', account_id, signed: true, person_id: '', username: '' }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts.find(a => a.account_id === mocks.selected), selectedFutures: accounts.find(a => a.account_id === mocks.selected) }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: mocks.cancel,
    cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => mocks.cancel(id))) }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: mocks.stockExit }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
it('real FlashOrder switches ownership, cancels only selected trades, and captures the order account', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const contract = { code: 'TMF', security_type: 'FUT', reference: 100 } as ContractInfo;
    const trades = accounts.map(account => ({ account, contract, order: { id: account.account_id, account, price: 100, action: 'Buy', quantity: 1 }, status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, deals: [] } })) as unknown as Trade[];
    mocks.cancel.mockResolvedValue({ ...trades[0], status: { status: 'Cancelled' } });
    mocks.place.mockResolvedValue(trades[1]);
    let view!: ReactTestRenderer;
    const props = { contract, trades, positions: accounts.map((account, i) => ({ account, id: i, code: 'TMF', direction: 'Buy' as const, quantity: i === 0 ? 3 : 5, price: 100, last_price: 100, pnl: 0 })) };
    const button = (text: string) => view.root.findAllByType('button').find(b => b.children.filter(c => typeof c === 'string').join('').includes(text))!;
    try {
        await act(async () => { view = create(createElement(FlashOrder, props)); });
        await act(async () => { await button('全刪').props.onClick(); });
        expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual(['A']);
        await act(async () => { view.root.findByType('select').props.onChange({ target: { value: 'F:BR:B' } }); view.update(createElement(FlashOrder, { ...props })); });
        await act(async () => { await button('全刪').props.onClick(); });
        expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual(['A', 'B']);
        await act(async () => { button('啟用閃電下單').props.onClick(); });
        await act(async () => { await button('市價買').props.onClick(); });
        expect(mocks.place.mock.calls[0]![4]).toMatchObject({ account: accounts[1] });
        // panel choice is local — the app-wide selection is untouched
        expect(mocks.selected).toBe('A');
        await act(async () => { await button('平倉').props.onClick(); });
        expect(mocks.place.mock.calls[1]!.slice(1, 4)).toEqual(['Sell', null, 5]);
        expect(mocks.place.mock.calls[1]![4]).toMatchObject({ account: accounts[1], ocType: 'Cover' });
        await act(async () => { view.update(createElement(FlashOrder, { ...props, positions: [...props.positions, { ...props.positions[1]!, id: 9, direction: 'Sell' as const, quantity: 1 }] })); });
        expect(button('平倉').props.disabled).toBe(true);
        await act(async () => { view.update(createElement(FlashOrder, { ...props })); });
        mocks.place.mockRejectedValueOnce(new Error('timeout'));
        await act(async () => { await button('平倉').props.onClick(); });
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '⚡ 平倉未完整確認', body: expect.stringContaining('勿直接重送') });
        accounts.forEach(account => { account.account_type = 'S'; });
        const stockContract = { ...contract, security_type: 'STK', code: '2330' } as ContractInfo;
        await act(async () => { view.update(createElement(FlashOrder, { contract: stockContract, trades: [], positions: [{ ...props.positions[1]!, code: '2330', quantity: 1500, cond: 'Cash' }] })); });
        await act(async () => { view.root.findByType('select').props.onChange({ target: { value: 'S:BR:B' } }); });
        await act(async () => { button('啟用閃電下單').props.onClick(); });
        mocks.stockExit.mockRejectedValueOnce(new Error('second leg unknown'));
        await act(async () => { await button('平倉').props.onClick(); });
        expect(mocks.stockExit).toHaveBeenCalledWith(stockContract, 'Sell', 1500, accounts[1], expect.objectContaining({ isAccountCurrent: expect.any(Function) }));
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ title: '⚡ 平倉未完整確認', body: expect.stringContaining('可能已有部分委託送出或結果未知') });
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
it('flash 全刪 shows why a cancel failed (#244)', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    mocks.selected = 'A';
    accounts.forEach(account => { account.account_type = 'F'; });
    const contract = { code: 'TMF', security_type: 'FUT', reference: 100 } as ContractInfo;
    const trades = [{ account: accounts[0], contract, order: { id: 'ext-1', seqno: '38tQF4', account: accounts[0], price: 100, action: 'Buy', quantity: 1 }, status: { status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, deals: [] } }] as unknown as Trade[];
    let view!: ReactTestRenderer;
    const button = (text: string) => view.root.findAllByType('button').find(b => b.children.filter(c => typeof c === 'string').join('').includes(text))!;
    try {
        await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions: [] })); });
        // Native / HTTP rejections carry no outcome flag; a string reason is what Tauri invoke rejects with.
        mocks.cancel.mockRejectedValueOnce('400 CA not activated for: A123456789');
        await act(async () => { await button('全刪').props.onClick(); });
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({
            kind: 'err', title: '⚡ 全刪', body: expect.stringContaining('失敗或結果未知 1 筆（400 CA not activated for: ***）'),
        });
        mocks.cancel.mockRejectedValueOnce(Object.assign(new Error('此視窗無法送出交易指令'), { mutationNotStarted: true }));
        await act(async () => { await button('全刪').props.onClick(); });
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ body: expect.stringContaining('未送出 1 筆（此視窗無法送出交易指令）') });
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
// #244 An order placed in iLeader: no custom_field, ordno/seqno from the
// exchange, modified_price 0. Its ladder chip cancels exactly that order
// through the same cancel the orders tab uses, and a chip whose order is gone
// says so instead of doing nothing.
it('the ladder chip of an iLeader order cancels that order; a stale chip explains itself (#244)', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    mocks.selected = 'A'; mocks.cancel.mockReset(); mocks.notify.mockReset();
    accounts.forEach(account => { account.account_type = 'F'; });
    const contract = { code: 'KEFJ6', security_type: 'FUT', reference: 100 } as ContractInfo;
    const ileader = (id: string, action: 'Buy' | 'Sell') => ({ account: accounts[0], contract: { code: 'KEFJ6', security_type: 'FUT', exchange: 'TAIFEX', target_code: null },
        order: { id, seqno: `S-${id}`, ordno: `k-${id}`, account: accounts[0], price: 100, action, quantity: 1, price_type: 'LMT', order_type: 'ROD' },
        status: { id, status: 'Submitted', order_quantity: 1, deal_quantity: 0, cancel_quantity: 0, modified_price: 0, deals: [] } });
    const trades = [ileader('ext-buy', 'Buy'), ileader('ext-sell', 'Sell')] as unknown as Trade[];
    mocks.cancel.mockImplementation(async (id: string) => ({ ...trades.find(t => t.order.id === id)!, status: { status: 'Cancelled', cancel_quantity: 1, deal_quantity: 0 } }));
    let view!: ReactTestRenderer;
    const chip = (title: string) => view.root.findAllByType('button').find(b => typeof b.props.title === 'string' && b.props.title.startsWith(title));
    try {
        await act(async () => { view = create(createElement(FlashOrder, { contract, trades, positions: [] })); });
        await act(async () => { await chip('刪除 100.00 買單')!.props.onClick(); });
        expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['ext-buy']);
        await act(async () => { await chip('刪除 100.00 賣單')!.props.onClick(); });
        expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual(['ext-buy', 'ext-sell']);
        // the order left before the click landed: nothing is sent, and the user is told
        const stale = chip('刪除 100.00 買單')!.props.onClick;
        await act(async () => { view.update(createElement(FlashOrder, { contract, trades: [], positions: [] })); });
        await act(async () => { await stale(); });
        expect(mocks.cancel).toHaveBeenCalledTimes(2);
        expect(mocks.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', title: '⚡ 刪單', body: expect.stringContaining('沒有送出') });
    } finally { await act(async () => view?.unmount()); vi.unstubAllGlobals(); }
});
