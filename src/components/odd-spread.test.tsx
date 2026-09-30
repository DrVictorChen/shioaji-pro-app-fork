// 整零價差面板：設計稿數字、按鈕啟用規則、點價下單與兩腳送單接線
import { createElement, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { Trade } from '../lib/types/order';
import type { ContractInfo } from '../lib/types/contract';

const mocks = vi.hoisted(() => ({ place: vi.fn(), cancel: vi.fn(), notify: vi.fn(), confirm: vi.fn(), risk: { confirmManualOrders: false } }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts: [], selectedStock: undefined }) }));
vi.mock('../hooks/use-stream', () => ({ useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: undefined, snapshot: undefined, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrders: (ids: string[]) => Promise.allSettled(ids.map(id => mocks.cancel(id))) }));
vi.mock('../lib/trade', () => ({
    notify: mocks.notify,
    placeQuickOrder: mocks.place,
    OrderConfirmCancelled: class extends Error {},
}));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => mocks.risk }));
vi.mock('../lib/order-confirm', () => ({ requestOrderConfirm: mocks.confirm, accountConfirmLabel: () => 'BR-***A' }));
vi.mock('../lib/utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, d: number) => p + d * 5 }));

import { OddSpreadView } from './odd-spread';
import { useOddSpreadExec, type SpreadExecution } from '../hooks/use-odd-spread-exec';
import type { OddSpreadFeed } from '../hooks/use-odd-spread-feed';

const account: Account = { account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
const contract = { code: '2330', name: '台積電', security_type: 'STK', reference: 1080, limit_up: 1185, limit_down: 975 } as unknown as ContractInfo;
const feed: OddSpreadFeed = {
    round: {
        asks: [{ price: 1085, vol: 2317 }, { price: 1090, vol: 1038 }, { price: 1095, vol: 655 }, { price: 1100, vol: 412 }],
        bids: [{ price: 1080, vol: 1904 }, { price: 1075, vol: 822 }, { price: 1070, vol: 530 }],
    },
    odd: {
        asks: [{ price: 1100, vol: 86 }],
        bids: [{ price: 1095, vol: 380 }, { price: 1090, vol: 1020 }, { price: 1085, vol: 640 }, { price: 1080, vol: 3410 }, { price: 1075, vol: 2200 }, { price: 1070, vol: 150 }],
    },
    roundLast: 1085, roundChange: 5, oddLast: 1095, oddChange: 15, oddTime: '10:52:57', oddAvailable: true,
};

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const buttons = () => view.root.findAllByType('button');
const button = (label: string) => buttons().find(b => text(b).includes(label))!;
const input = (label: string) => view.root.findAll(n => n.type === 'input' && n.props['aria-label'] === label)[0]!;

// 以真的 useOddSpreadExec 接線，trades 由測試控制
let setTrades: (t: Trade[]) => void = () => undefined;
function Harness({ trades: initial, fd = feed }: { trades: Trade[]; fd?: OddSpreadFeed }) {
    const [trades, set] = useState(initial);
    setTrades = set;
    const execution: SpreadExecution = useOddSpreadExec({ contract, account, trades });
    return createElement(OddSpreadView, { contract, feed: fd, inventoryShares: 3420, live: true, account, execution });
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.risk.confirmManualOrders = false;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ discount: 0.6, taxRate: null }), setItem: vi.fn() });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

it('顯示設計稿的兩個方向與價格梯', async () => {
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    const all = text(view.root);
    expect(all).toContain('台積電');
    expect(all).toContain('零股撮合');
    expect(all).toContain('10:52:57');
    expect(all).toContain('+10.00');
    expect(all).toContain('92 bps');
    expect(all).toContain('+4.85 元/股');
    expect(all).toContain('1,095×380、1,090×620');
    expect(all).toContain('+1.76 元/股');
    expect(all).toContain('+1,763 元');
    expect(all).toContain('−20.00');
    expect(all).toContain('−182 bps');
    expect(all).toContain('−25.10 元/股');
    expect(all).toContain('整 3 張／零 420 股');
    expect(button('以 1 張執行').props.disabled).toBe(false);
    expect(button('價差未達成本').props.disabled).toBe(true);
    expect(button('買整賣零').props.disabled).toBe(false);
    expect(button('買零賣整').props.disabled).toBe(true);
    // 可套利價位 1,095、1,090 以琥珀色標出；整／零最後成交標記
    const rows = view.root.findAll(n => n.type === 'div' && typeof n.props.className === 'string' && n.props.className.includes('ladderRow'));
    expect(rows.length).toBe(7);
});

it('未接上零股行情時兩個方向都停用', async () => {
    const fd = { ...feed, odd: { bids: [], asks: [] }, oddAvailable: false, oddLast: null, oddTime: null };
    await act(async () => { view = create(createElement(Harness, { trades: [], fd })); });
    expect(text(view.root)).toContain('零股行情尚未接上');
    expect(button('買整賣零').props.disabled).toBe(true);
    expect(button('買零賣整').props.disabled).toBe(true);
});

it('張數改 2 → 加權後不賺，停用並說明', async () => {
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    await act(async () => { input('整股張數').props.onChange({ target: { value: '2' } }); });
    expect(input('零股股數').props.value).toBe('2,000');
    expect(button('買整賣零').props.disabled).toBe(true);
    expect(buttons().filter(b => text(b) === '價差未達成本')).toHaveLength(2);
});

it('執行：先送零股（每檔一筆 IntradayOdd），全部成交後才送整股 1 張', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, action: string, price: number, quantity: number, opts: { orderLot?: string }) => ({
        order: { id: `T${++n}`, action, price, quantity, order_lot: opts.orderLot ?? 'Common' },
        status: { status: 'Submitted', deal_quantity: 0, deals: [] },
    }));
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(mocks.place.mock.calls.map(c => [c[1], c[2], c[3], c[4].orderLot, c[4].source])).toEqual([
        ['Sell', 1095, 380, 'IntradayOdd', 'auto'],
        ['Sell', 1090, 620, 'IntradayOdd', 'auto'],
    ]);
    expect(text(view.root)).toContain('零股委託中');
    const filled = (id: string, q: number) => ({ order: { id }, status: { status: 'Filled', deal_quantity: q, deals: [] } }) as unknown as Trade;
    await act(async () => { setTrades([filled('T1', 380)]); });
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(text(view.root)).toContain('零股部分成交');
    await act(async () => { setTrades([filled('T1', 380), filled('T2', 620)]); });
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
    expect(mocks.place.mock.calls[2]![4].orderLot).toBeUndefined();
    await act(async () => { setTrades([filled('T1', 380), filled('T2', 620), filled('T3', 1)]); });
    expect(text(view.root)).toContain('完成');
    // 再點一次不會重送
    expect(mocks.place).toHaveBeenCalledTimes(3);
});

it('開啟委託確認時整筆價差確認一次，取消就不送', async () => {
    mocks.risk.confirmManualOrders = true;
    mocks.confirm.mockResolvedValue(false);
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    await act(async () => { button('以 1 張執行').props.onClick(); });
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.confirm.mock.calls[0]![0].note).toContain('整零價差');
    expect(mocks.place).not.toHaveBeenCalled();
});

it('點價下單：未啟用不送；啟用後點零股買量＝零股限價，1,000 股拆 999＋1', async () => {
    mocks.place.mockResolvedValue({ order: { id: 'X' }, status: { status: 'Submitted', deal_quantity: 0, deals: [] } });
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    const cell = () => view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('零股限價買'))[0];
    const locked = view.root.findAll(n => n.type === 'span' && n.props.title === '先啟用點價')[0]!;
    await act(async () => { locked.props.onClick(); });
    expect(mocks.place).not.toHaveBeenCalled();
    await act(async () => { button('啟用點價').props.onClick(); });
    await act(async () => { cell()!.props.onClick(); });
    expect(mocks.place.mock.calls.map(c => [c[1], c[3], c[4].orderLot])).toEqual([
        ['Buy', 999, 'IntradayOdd'],
        ['Buy', 1, 'IntradayOdd'],
    ]);
    const roundAsk = view.root.findAll(n => n.type === 'span' && String(n.props.title ?? '').startsWith('整股限價賣'))[0]!;
    await act(async () => { roundAsk.props.onClick(); });
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Sell', expect.any(Number), 1]);
    expect(mocks.place.mock.calls[2]![4].orderLot).toBeUndefined();
    expect(mocks.place.mock.calls[2]![4].source).toBeUndefined(); // 手動：依設定跳確認
});

it('手續費折數與稅率存本機', async () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => null, setItem });
    await act(async () => { view = create(createElement(Harness, { trades: [] })); });
    await act(async () => { input('手續費折數').props.onChange({ target: { value: '2.8' } }); });
    await act(async () => { input('證交稅率（%）').props.onChange({ target: { value: '0.15' } }); });
    const last = JSON.parse(setItem.mock.calls.at(-1)![1]);
    expect(last).toEqual({ discount: 0.28, taxRate: 0.0015 });
});
