// 整零價差主視窗服務：送單、結果不明、成交先於回應、委託列對帳、本機保存
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ContractInfo } from './types/contract';
import type { AccountedTrade } from './types/order';
import type { Account } from './types/portfolio';

const mocks = vi.hoisted(() => ({
    place: vi.fn(),
    cancel: vi.fn(),
    notify: vi.fn(),
    trades: [] as unknown[],
    tradeListener: null as null | (() => void),
    quotes: new Map<string, unknown>(),
    main: true,
    executor: true,
}));
vi.mock('./trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place }));
vi.mock('./shioaji', () => ({ cancelOrders: (ids: string[]) => { mocks.cancel(ids); return Promise.resolve([]); } }));
vi.mock('./trading-state', () => ({
    getTradingState: () => ({ trades: mocks.trades }),
    subscribeTradingState: (l: () => void) => { mocks.tradeListener = l; return () => undefined; },
}));
vi.mock('./stream', () => ({ getQuote: (code: string, odd = false) => mocks.quotes.get(`${code}:${odd}`) }));
vi.mock('./quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('./main-window-commands', () => ({
    isMainWindow: () => mocks.main,
    isExecutor: () => mocks.executor,
    claimExecutor: () => ({ acquired: new Promise(() => undefined), settled: Promise.resolve() }),
}));
vi.mock('./utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, d: number) => p + d * 5 }));

import {
    ODD_SPREAD_TAG,
    oddSpreadExecUnavailable,
    reconcile,
    resetOddSpreadServiceForTest,
    spreadExecAction,
    startOddSpreadService,
    startSpreadExecution,
    liveExecutionFor,
    hasLiveSpreadExecution,
    type SpreadExecRecord,
} from './odd-spread-service';

const account: Account = { account_type: 'S', broker_id: 'BR', account_id: 'A', signed: true, person_id: '', username: '' };
const contract = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as unknown as ContractInfo;
const plan = {
    direction: 'buyRoundSellOdd' as const,
    mode: 'sequential' as const,
    lots: 1,
    roundPrice: 1085,
    oddOrders: [{ price: 1095, quantity: 380 }, { price: 1090, quantity: 620 }],
    netPerShare: 1.76,
};
const fees = { discount: 0.6, taxRate: 0.003 };
const store = new Map<string, string>();

const flush = () => new Promise(r => setTimeout(r, 0));
function trade(id: string, price: number, quantity: number, filled: number, status: string, lot = 'IntradayOdd', action = 'Sell'): AccountedTrade {
    return {
        account,
        contract: { code: '2330' },
        order: { id, action, price, quantity, order_lot: lot, custom_field: ODD_SPREAD_TAG, account },
        status: { id, status, deal_quantity: filled, deals: [], order_quantity: quantity, cancel_quantity: 0, modified_price: 0, msg: '', status_code: '' },
    } as unknown as AccountedTrade;
}
const setTrades = (t: AccountedTrade[]) => { mocks.trades = t; mocks.tradeListener?.(); };
const record = (): SpreadExecRecord => JSON.parse(store.get('sj-pro-odd-spread-exec-v1')!).at(-1);

beforeEach(() => {
    vi.clearAllMocks();
    resetOddSpreadServiceForTest();
    store.clear();
    mocks.trades = [];
    mocks.tradeListener = null;
    mocks.main = true;
    mocks.executor = true;
    mocks.quotes.clear();
    mocks.quotes.set('2330:false', { bidask: { code: '2330', date: '2026/09/30', time: '10:00:00', bid_price: ['1080'], bid_volume: [100], ask_price: ['1085'], ask_volume: [100] } });
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

it('送零股兩筆（帶標記、IntradayOdd、auto），全部成交後以當下整股賣一送整股', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, _a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted'));
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    expect(mocks.place.mock.calls.map(c => [c[1], c[2], c[3], c[4].orderLot, c[4].source, c[4].customField])).toEqual([
        ['Sell', 1095, 380, 'IntradayOdd', 'auto', ODD_SPREAD_TAG],
        ['Sell', 1090, 620, 'IntradayOdd', 'auto', ODD_SPREAD_TAG],
    ]);
    await flush();
    setTrades([trade('T1', 1095, 380, 380, 'Filled'), trade('T2', 1090, 620, 620, 'Filled')]);
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
    expect(mocks.place.mock.calls[2]![4].orderLot).toBeUndefined();
    expect(hasLiveSpreadExecution()).toBe(true);
});

it('成交先於下單回應：委託列以標記對上，第二腳照送；回應到了不重送', async () => {
    let resolve!: (v: unknown) => void;
    mocks.place.mockImplementationOnce(() => new Promise(r => { resolve = r; }))
        .mockImplementationOnce(async () => trade('T2', 1090, 620, 0, 'Submitted'))
        .mockImplementation(async () => trade('R', 1085, 1, 0, 'Submitted', 'Common', 'Buy'));
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    await flush();
    // T1 的 HTTP 回應還沒到，委託列已看到它全數成交
    setTrades([trade('T1', 1095, 380, 380, 'Filled'), trade('T2', 1090, 620, 620, 'Filled')]);
    expect(mocks.place).toHaveBeenCalledTimes(3);
    resolve(trade('T1', 1095, 380, 380, 'Filled'));
    await flush();
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(record().state.slots[0]!.orderId).toBe('T1');
});

it('可能已送出的錯誤 → unknown：不送第二腳、同商品不可再執行；委託列出現後接回', async () => {
    mocks.place.mockImplementationOnce(async () => trade('T1', 1095, 380, 380, 'Filled'))
        .mockImplementationOnce(async () => { throw new Error('連線逾時'); })
        .mockImplementation(async () => trade('R', 1085, 1, 0, 'Submitted', 'Common', 'Buy'));
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    await flush();
    expect(record().state.phase).toBe('unknown');
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(() => startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 })).toThrow('已有執行中的價差單');
    expect(liveExecutionFor('2330', account)).toBeDefined();
    // 原單其實有送到、成交了
    setTrades([trade('T1', 1095, 380, 380, 'Filled'), trade('X9', 1090, 620, 620, 'Filled')]);
    expect(record().state.slots[1]).toMatchObject({ orderId: 'X9', filled: 620, status: 'filled' });
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
});

it('確定未送出（mutationNotStarted）→ placeFailed；第一腳全失敗就結束', async () => {
    mocks.place.mockRejectedValue(Object.assign(new Error('庫存不足'), { mutationNotStarted: true }));
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    await flush();
    expect(record().state.phase).toBe('failed');
    expect(hasLiveSpreadExecution()).toBe(false);
});

it('補單超出滑價上限：不送，列未配對待處理；以最新價補單才送', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', 'IntradayOdd', a));
    // 整股賣一已漲到 1,100（計畫 1,085，差 3 檔 > 2 檔）
    mocks.quotes.set('2330:false', { bidask: { code: '2330', date: '2026/09/30', time: '10:00:00', bid_price: ['1095'], bid_volume: [5], ask_price: ['1100'], ask_volume: [5] } });
    const id = startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    await flush();
    setTrades([trade('T1', 1095, 380, 380, 'Filled'), trade('T2', 1090, 620, 620, 'Filled')]);
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(record().state.phase).toBe('hedgeDecision');
    expect(record().state.pendingHedge?.reason).toContain('超過 2 檔');
    spreadExecAction(id, { type: 'hedgeAccept' });
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1100, 1]);
});

it('本機保存：重新啟動後接回，送出中的委託改為結果不明並以委託列對帳', async () => {
    mocks.place.mockImplementation(() => new Promise(() => undefined)); // 回應永遠不到
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    expect(record().state.slots.map(s => s.status)).toEqual(['sending', 'sending']);
    resetOddSpreadServiceForTest(); // 模擬重新整理
    mocks.place.mockReset();
    mocks.trades = [trade('T1', 1095, 380, 380, 'Filled')];
    startOddSpreadService();
    const s = record().state;
    expect(s.slots[0]).toMatchObject({ orderId: 'T1', status: 'filled' });
    expect(s.slots[1]!.status).toBe('unknown');
    expect(s.phase).toBe('unknown');
    expect(mocks.place).not.toHaveBeenCalled();
});

it('彈出視窗與非執行中的主視窗不可執行', () => {
    mocks.main = false;
    expect(oddSpreadExecUnavailable()).toContain('只能在主視窗');
    expect(() => startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 })).toThrow('只能在主視窗');
    mocks.main = true;
    mocks.executor = false;
    expect(oddSpreadExecUnavailable()).toContain('另一個主視窗');
});

it('對帳只認同帳戶、同商品、同方向價量與單位、未被認領的委託', () => {
    mocks.place.mockImplementation(() => new Promise(() => undefined));
    startSpreadExecution({ contract, account, plan, fees, maxSlipTicks: 2 });
    const other = { ...account, account_id: 'B' };
    reconcile([
        { ...trade('W1', 1095, 380, 380, 'Filled'), account: other } as AccountedTrade,
        trade('W2', 1095, 380, 380, 'Filled', 'Common'),
        trade('W3', 1095, 381, 380, 'Filled'),
        { ...trade('W4', 1095, 380, 380, 'Filled'), order: { ...trade('W4', 1095, 380, 380, 'Filled').order, custom_field: 'sjgrid' } } as AccountedTrade,
    ]);
    expect(record().state.slots.every(s => !s.orderId)).toBe(true);
    reconcile([trade('W5', 1095, 380, 380, 'Filled')]);
    expect(record().state.slots[0]!.orderId).toBe('W5');
});
