// 整零價差主視窗服務：唯一標記對帳、結果不明、環境綁定、晚到成交保留、本機保存、刪單失敗
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
    infoListener: null as null | (() => void),
    quotes: new Map<string, unknown>(),
    main: true,
    executor: true,
    base: 'http://127.0.0.1:21322',
    info: { simulation: true } as { simulation: boolean } | undefined,
    gen: 0,
}));
vi.mock('./trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place }));
vi.mock('./shioaji', () => ({ cancelOrders: (ids: string[]) => mocks.cancel(ids) }));
vi.mock('./trading-state', () => ({
    getTradingState: () => ({ trades: mocks.trades }),
    subscribeTradingState: (l: () => void) => { mocks.tradeListener = l; return () => undefined; },
    ordersBaselineLostMark: () => mocks.gen,
}));
vi.mock('./server-info-store', () => ({
    knownServerInfo: () => mocks.info,
    subscribeServerInfo: (l: () => void) => { mocks.infoListener = l; return () => undefined; },
}));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./stream', () => ({ getQuote: (code: string, odd = false) => mocks.quotes.get(`${code}:${odd}`) }));
vi.mock('./quote-ownership', () => ({ retainContractQuotes: () => () => undefined }));
vi.mock('./main-window-commands', () => ({
    isMainWindow: () => mocks.main,
    isExecutor: () => mocks.executor,
    claimExecutor: () => ({ acquired: new Promise(() => undefined), settled: Promise.resolve() }),
}));
vi.mock('./utils/ticksize', () => ({ stepPrice: (_c: unknown, p: number, d: number) => p + d * 5 }));

import { isTerminalPhase } from './odd-spread-exec';
import {
    acceptHedge,
    addClickLock,
    clearClickLock,
    clickLocksFor,
    executionsFor,
    isSettled,
    updateClickLock,
    candidateOrders,
    claimOrder,
    dismissSpreadExecution,
    hasLiveSpreadExecution,
    liveExecutionFor,
    oddSpreadExecUnavailable,
    pruneRecords,
    reconcile,
    resetOddSpreadServiceForTest,
    slotTag,
    spreadExecAction,
    startOddSpreadService,
    startSpreadExecution,
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
const req = () => ({ contract, account, plan, fees, maxSlipTicks: 2, env: { base: mocks.base, simulation: mocks.info!.simulation } });

const flush = () => new Promise(r => setTimeout(r, 0));
function trade(id: string, price: number, quantity: number, filled: number, status: string, tag: string | undefined, lot = 'IntradayOdd', action = 'Sell', cancelQty?: number): AccountedTrade {
    // 券商確認的刪單：刪單量＝未成交量（可覆寫成落後的數字）
    const cancel_quantity = cancelQty ?? (status === 'Cancelled' ? quantity - filled : 0);
    return {
        account,
        contract: { code: '2330' },
        order: { id, ordno: `N${id}`, action, price, quantity, order_lot: lot, ...(tag !== undefined ? { custom_field: tag } : {}), account },
        status: { id, status, deal_quantity: filled, deals: [], order_quantity: quantity, cancel_quantity, modified_price: 0, msg: '', status_code: '' },
    } as unknown as AccountedTrade;
}
const setTrades = (t: AccountedTrade[]) => { mocks.trades = t; mocks.tradeListener?.(); };
const saved = (): SpreadExecRecord[] => JSON.parse(store.get('sj-pro-odd-spread-exec-v1')!);
const record = (): SpreadExecRecord => saved().at(-1)!;
const tagOf = (key: string) => slotTag(record().tagBase, key);

beforeEach(() => {
    vi.clearAllMocks();
    resetOddSpreadServiceForTest();
    store.clear();
    mocks.trades = [];
    mocks.tradeListener = null;
    mocks.infoListener = null;
    mocks.main = true;
    mocks.executor = true;
    mocks.base = 'http://127.0.0.1:21322';
    mocks.info = { simulation: true };
    mocks.gen = 0;
    mocks.quotes.clear();
    mocks.quotes.set('2330:false', { bidask: { code: '2330', date: '2026/09/30', time: '10:00:00', bid_price: ['1080'], bid_volume: [100], ask_price: ['1085'], ask_volume: [100] } });
    mocks.cancel.mockResolvedValue([{ status: 'fulfilled', value: {} }]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) });
});
afterEach(() => vi.unstubAllGlobals());

it('每筆委託帶唯一標記（≤6 字元英數），同一執行不同筆、不同執行不同前綴', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, _a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined));
    startSpreadExecution(req());
    const tags = mocks.place.mock.calls.map(c => c[4].customField as string);
    expect(tags).toEqual([tagOf('odd:0'), tagOf('odd:1')]);
    for (const t of tags) expect(t).toMatch(/^[0-9a-z]{6}$/);
    expect(new Set(tags).size).toBe(2);
    expect(mocks.place.mock.calls.map(c => [c[1], c[2], c[3], c[4].orderLot, c[4].source])).toEqual([
        ['Sell', 1095, 380, 'IntradayOdd', 'auto'],
        ['Sell', 1090, 620, 'IntradayOdd', 'auto'],
    ]);
    await flush();
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tags[0]), trade('T2', 1090, 620, 620, 'Filled', tags[1])]);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
    const first = record().tagBase;
    // 另一檔的新執行用不同前綴
    startSpreadExecution({ ...req(), contract: { ...contract, code: '2317' } as ContractInfo });
    expect(record().tagBase).not.toBe(first);
});

it('成交先於下單回應：只以自己的標記對上，回應到了不重送', async () => {
    let resolve!: (v: unknown) => void;
    mocks.place.mockImplementationOnce(() => new Promise(r => { resolve = r; }))
        .mockImplementationOnce(async () => trade('T2', 1090, 620, 0, 'Submitted', undefined))
        .mockImplementation(async () => trade('R', 1085, 1, 0, 'Submitted', undefined, 'Common', 'Buy'));
    startSpreadExecution(req());
    await flush();
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tagOf('odd:0')), trade('T2', 1090, 620, 620, 'Filled', tagOf('odd:1'))]);
    expect(mocks.place).toHaveBeenCalledTimes(3);
    resolve(trade('T1', 1095, 380, 380, 'Filled', tagOf('odd:0')));
    await flush();
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(record().state.slots[0]!.orderId).toBe('T1');
});

it('沒有標記或標記不同的同價量委託絕不自動認領；列為候選由使用者指定', async () => {
    mocks.place.mockImplementationOnce(async () => trade('T1', 1095, 380, 380, 'Filled', undefined))
        .mockImplementationOnce(async () => { throw new Error('連線逾時'); })
        .mockImplementation(async () => trade('R', 1085, 1, 0, 'Submitted', undefined, 'Common', 'Buy'));
    const id = startSpreadExecution(req());
    await flush();
    expect(record().state.phase).toBe('unknown');
    setTrades([trade('T1', 1095, 380, 380, 'Filled', undefined), trade('X1', 1090, 620, 620, 'Filled', undefined), trade('X2', 1090, 620, 620, 'Filled', 'sjgrid')]);
    expect(record().state.slots[1]!.orderId).toBeUndefined();
    expect(record().state.phase).toBe('unknown');
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(candidateOrders(id, 'odd:1').map(t => t.order.id)).toEqual(['X1']);
    expect(() => startSpreadExecution(req())).toThrow('已有執行中的價差單');
    claimOrder(id, 'odd:1', 'X1');
    expect(record().state.slots[1]).toMatchObject({ orderId: 'X1', filled: 620, status: 'filled' });
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
});

it('重新整理後：先前一筆相同價量（別的標記、沒有標記）不會被認成這次的首腳；真正的首腳出現才接回', () => {
    mocks.place.mockImplementation(() => new Promise(() => undefined));
    startSpreadExecution(req());
    const t0 = tagOf('odd:0');
    resetOddSpreadServiceForTest(); // 模擬重新整理
    mocks.place.mockReset();
    mocks.trades = [trade('OLD', 1095, 380, 380, 'Filled', 'oabc00'), trade('MAN', 1095, 380, 380, 'Filled', undefined)];
    startOddSpreadService();
    let s = record().state;
    expect(s.slots.map(x => [x.status, x.orderId])).toEqual([['unknown', undefined], ['unknown', undefined]]);
    expect(mocks.place).not.toHaveBeenCalled();
    setTrades([...mocks.trades as AccountedTrade[], trade('REAL', 1095, 380, 380, 'Filled', t0)]);
    s = record().state;
    expect(s.slots[0]).toMatchObject({ orderId: 'REAL', status: 'filled' });
    expect(s.slots[1]!.status).toBe('unknown');
});

it('環境綁定：切到別的伺服器或正式／模擬不同時暫停送單與對帳，回來後才繼續', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, _a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined));
    const id = startSpreadExecution(req());
    expect(record().env).toEqual({ base: 'http://127.0.0.1:21322', simulation: true });
    await flush();
    mocks.info = { simulation: false };
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tagOf('odd:0')), trade('T2', 1090, 620, 620, 'Filled', tagOf('odd:1'))]);
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(record().state.slots.every(x => x.filled === 0)).toBe(true);
    spreadExecAction(id, { type: 'cancel' });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.notify.mock.calls.at(-1)![0].body).toContain('環境已切換，執行暫停');
    mocks.info = { simulation: true };
    mocks.base = 'http://127.0.0.1:21323';
    mocks.infoListener?.();
    expect(mocks.place).toHaveBeenCalledTimes(2);
    mocks.base = 'http://127.0.0.1:21322';
    mocks.infoListener?.();
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
});

it('環境切換期間到達的下單回應先保留，回到原環境才處理', async () => {
    let resolve!: (v: unknown) => void;
    mocks.place.mockImplementationOnce(async () => trade('T1', 1095, 380, 380, 'Filled', undefined))
        .mockImplementationOnce(() => new Promise(r => { resolve = r; }))
        .mockImplementation(async () => trade('R', 1085, 1, 0, 'Submitted', undefined, 'Common', 'Buy'));
    startSpreadExecution(req());
    await flush();
    mocks.info = { simulation: false };
    resolve(trade('T2', 1090, 620, 620, 'Filled', undefined));
    await flush();
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(record().held?.length).toBeGreaterThan(0);
    mocks.info = { simulation: true };
    mocks.infoListener?.();
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(record().held).toEqual([]);
});

it('開始時的環境必須與按下時綁定的相同（含模擬／正式未知）', () => {
    const bound = req();
    mocks.info = undefined;
    expect(() => startSpreadExecution(bound)).toThrow('環境已切換');
    mocks.info = { simulation: false };
    expect(() => startSpreadExecution(bound)).toThrow('環境已切換');
    mocks.info = { simulation: true };
    mocks.base = 'http://127.0.0.1:21323';
    expect(() => startSpreadExecution(bound)).toThrow('環境已切換');
    mocks.base = 'http://127.0.0.1:21322';
    mocks.place.mockImplementation(() => new Promise(() => undefined));
    expect(() => startSpreadExecution(bound)).not.toThrow();
});

it('送出前最後一刻環境不同 → 不送（beforeSend 拒絕）', () => {
    mocks.place.mockImplementation(() => new Promise(() => undefined));
    startSpreadExecution(req());
    const beforeSend = mocks.place.mock.calls[0]![4].beforeSend as () => void;
    expect(() => beforeSend()).not.toThrow();
    mocks.info = { simulation: false };
    expect(() => beforeSend()).toThrow('環境已切換');
});

it('sidecar 重啟後委託換了 id：以唯一標記重新接回；舊 id 被別的委託重用也不會誤計', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined, 'IntradayOdd', a));
    startSpreadExecution(req());
    await flush();
    const tags = [tagOf('odd:0'), tagOf('odd:1')];
    expect(record().state.slots.map(s => [s.orderId, s.idGen])).toEqual([['T1', 0], ['T2', 0]]);
    // sidecar 重啟：同樣兩筆換成新 id；舊 id T1 被一筆無關（沒標記）的委託重用、已成交
    mocks.gen = 1;
    setTrades([
        trade('T1', 1095, 380, 380, 'Filled', undefined),
        trade('N1', 1095, 380, 0, 'Submitted', tags[0]),
        trade('N2', 1090, 620, 0, 'Submitted', tags[1]),
    ]);
    const s = record().state;
    expect(s.slots.map(x => [x.orderId, x.idGen, x.filled])).toEqual([['N1', 1, 0], ['N2', 1, 0]]);
    // 新 id 上的成交照常對帳 → 送整股
    setTrades([trade('N1', 1095, 380, 380, 'Filled', tags[0]), trade('N2', 1090, 620, 620, 'Filled', tags[1])]);
    expect(mocks.place.mock.calls.at(-1)!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
});

it('世代變了、委託列又沒有標記：舊 id 不採用，列為候選由使用者指定', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined, 'IntradayOdd', a));
    const id = startSpreadExecution(req());
    await flush();
    mocks.gen = 2;
    setTrades([trade('T1', 1095, 380, 380, 'Filled', undefined)]);
    expect(record().state.slots[0]!.filled).toBe(0);
    expect(candidateOrders(id, 'odd:0').map(t => t.order.id)).toEqual(['T1']);
});

it('刪單回報的數量對不上（成交回報晚到）：不當作終態，晚到成交仍對帳並補第二腳', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined, 'IntradayOdd', a));
    const first = startSpreadExecution(req());
    await flush();
    spreadExecAction(first, { type: 'cancel' });
    await flush();
    const tags = [tagOf('odd:0'), tagOf('odd:1')];
    // T1 已成交；T2 回報「已刪單」但成交量與刪單量都是 0（對不上 620）
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tags[0]), trade('T2', 1090, 620, 0, 'Cancelled', tags[1], 'IntradayOdd', 'Sell', 0)]);
    const rec0 = record();
    expect(isTerminalPhase(rec0.state.phase)).toBe(false);
    expect(isSettled(rec0)).toBe(false);
    expect(mocks.place).toHaveBeenCalledTimes(2);
    // 刪單前其實已成交（晚到回報）
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tags[0]), trade('T2', 1090, 620, 620, 'Filled', tags[1])]);
    expect(mocks.place).toHaveBeenCalledTimes(3);
    expect(mocks.place.mock.calls.at(-1)!.slice(1, 4)).toEqual(['Buy', 1085, 1]);
});

it('新執行不會刪掉同商品較早的執行（含已結束的），之後的回報仍對帳', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined, 'IntradayOdd', a));
    const first = startSpreadExecution(req());
    await flush();
    const tags = [tagOf('odd:0'), tagOf('odd:1')];
    spreadExecAction(first, { type: 'cancel' });
    await flush();
    setTrades([trade('T1', 1095, 380, 0, 'Cancelled', tags[0]), trade('T2', 1090, 620, 0, 'Cancelled', tags[1])]);
    expect(saved()[0]!.state.phase).toBe('cancelled');
    dismissSpreadExecution(first);
    startSpreadExecution(req());
    await flush();
    expect(saved().map(r => r.id)).toContain(first);
});

it('本機保存：未了結的永不丟棄；只有已了結的限當日、限量', () => {
    const now = Date.parse('2026-09-30T13:00:00+08:00');
    const yesterday = Date.parse('2026-09-29T10:00:00+08:00');
    // 券商確認的刪單：刪單量＋成交量＝委託量
    const slot = (filled: number, status = 'cancelled') => ({ key: 'odd:0', leg: 'odd', action: 'Sell', price: 1095, quantity: 1000, status, filled, cancelledQty: 1000 - filled });
    const mk = (id: string, phase: string, startedAt: number, slots: unknown[] = [], extra: Partial<SpreadExecRecord> = {}): SpreadExecRecord => ({
        id, tagBase: 'abc', env: { base: 'b', simulation: true }, contract, account, fees, maxSlipTicks: 2, startedAt,
        state: { plan, phase, slots, started: true, cancelRequested: true, seq: 1, waived: { odd: 0, round: 0 }, pendingHedge: null } as unknown as SpreadExecRecord['state'],
        ...extra,
    });
    const list = [
        mk('unknown', 'unknown', yesterday, [slot(0, 'unknown')]),
        mk('live', 'oddPending', yesterday, [slot(0, 'working')]),
        // 昨天取消、有 400 股未配對且使用者沒關閉 → 保留
        mk('unhedged', 'failed', yesterday, [slot(400)]),
        // 刪單結果不明 → 保留
        mk('cancelUnknown', 'cancelled', yesterday, [{ ...slot(0, 'working'), cancelledQty: undefined, cancelState: 'unknown' }]),
        // 環境切換期間保留的回報 → 保留
        mk('held', 'cancelled', yesterday, [slot(0)], { held: [{ type: 'report', key: 'odd:0', filled: 0, status: 'cancelled' }] }),
        // 使用者已關閉的未配對 → 視為了結
        mk('dismissed', 'failed', yesterday, [slot(400)], { dismissed: true }),
        mk('settledOld', 'cancelled', yesterday, [slot(0)]),
        // 零成交的刪單但刪單量尚未對上（晚到成交仍可能）→ 保留
        mk('cancelNoQty', 'cancelled', yesterday, [{ ...slot(0), cancelledQty: undefined }]),
        // 使用者標記未送出（暫定）→ 保留
        mk('marked', 'cancelled', yesterday, [{ ...slot(0, 'unknown'), markedUnsent: true }]),
        ...Array.from({ length: 60 }, (_, i) => mk(`s${i}`, 'cancelled', now - 60 + i, [slot(0)])),
    ];
    expect(isSettled(list[2]!)).toBe(false);
    expect(isSettled(list[5]!)).toBe(true);
    const kept = pruneRecords(list, now).map(r => r.id);
    for (const id of ['unknown', 'live', 'unhedged', 'cancelUnknown', 'held', 'cancelNoQty', 'marked']) expect(kept).toContain(id);
    expect(kept).not.toContain('dismissed');
    expect(kept).not.toContain('settledOld');
    expect(kept.filter(id => /^s\d+$/.test(id))).toHaveLength(50);
    expect(kept).toContain('s59');
    expect(kept).not.toContain('s0');
});

it('重新整理時刪單等待結果 → 刪單結果不明；委託仍在委託中可再取消', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, _a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined));
    const id = startSpreadExecution(req());
    await flush();
    mocks.cancel.mockImplementation(() => new Promise(() => undefined)); // 刪單回應永遠不到
    spreadExecAction(id, { type: 'cancel' });
    expect(record().state.slots.map(s => s.cancelState)).toEqual(['pending', 'pending']);
    const tags = [tagOf('odd:0'), tagOf('odd:1')];
    resetOddSpreadServiceForTest(); // 重新整理
    mocks.cancel.mockReset();
    mocks.cancel.mockResolvedValue([{ status: 'fulfilled', value: {} }]);
    // T1 已刪除、T2 仍在委託中
    mocks.trades = [trade('T1', 1095, 380, 0, 'Cancelled', tags[0]), trade('T2', 1090, 620, 0, 'Submitted', tags[1])];
    startOddSpreadService();
    const s = record().state;
    expect(s.slots[0]).toMatchObject({ status: 'cancelled', cancelState: 'unknown' });
    expect(s.slots[1]).toMatchObject({ status: 'working', cancelState: 'unknown' });
    spreadExecAction(id, { type: 'cancel' });
    expect(mocks.cancel.mock.calls.map(c => c[0])).toEqual([['T2']]);
});

it('點價鎖持久化：重新整理（或重開面板）後仍在，核對後才解除；只影響同商品同帳戶', () => {
    const id = addClickLock('2330', account, '送出中');
    updateClickLock(id, '已送出 999 股；第 2/2 筆 1 股未送出');
    resetOddSpreadServiceForTest(); // 重新整理：記憶體清空
    expect(clickLocksFor('2330', account).map(l => l.text)).toEqual(['已送出 999 股；第 2/2 筆 1 股未送出']);
    expect(clickLocksFor('2317', account)).toEqual([]);
    expect(clickLocksFor('2330', { ...account, account_id: 'B' })).toEqual([]);
    clearClickLock(id);
    resetOddSpreadServiceForTest();
    expect(clickLocksFor('2330', account)).toEqual([]);
});

it('新執行不會蓋掉較早仍需處理的執行：兩筆都列出', async () => {
    mocks.place.mockImplementationOnce(async () => trade('T1', 1095, 380, 380, 'Filled', undefined))
        .mockImplementationOnce(async () => trade('T2', 1090, 620, 620, 'Filled', undefined))
        .mockImplementationOnce(async () => { throw Object.assign(new Error('整股被拒'), { mutationNotStarted: true }); })
        .mockImplementation(() => new Promise(() => undefined));
    const first = startSpreadExecution(req());
    await flush();
    await flush();
    expect(record().state.phase).toBe('hedgeDecision');
    // 未配對待處理仍未結束 → 同商品同帳戶不可再開
    expect(() => startSpreadExecution(req())).toThrow('已有執行中的價差單');
    spreadExecAction(first, { type: 'hedgeDecline' });
    expect(saved().find(r => r.id === first)!.state.phase).toBe('failed');
    const second = startSpreadExecution(req());
    const list = executionsFor(saved(), '2330', account).map(r => r.id);
    expect(list).toEqual([second, first]);
});

it('刪單失敗：記錄並通知，可再按取消重試', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, _a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined));
    const id = startSpreadExecution(req());
    await flush();
    mocks.cancel.mockResolvedValueOnce([{ status: 'rejected', reason: new Error('伺服器忙碌') }])
        .mockResolvedValueOnce([{ status: 'fulfilled', value: {} }]);
    spreadExecAction(id, { type: 'cancel' });
    await flush();
    expect(record().state.slots[0]).toMatchObject({ cancelState: 'failed', cancelError: '伺服器忙碌' });
    expect(record().state.slots[1]).toMatchObject({ cancelState: 'sent' });
    expect(mocks.notify.mock.calls.some(c => c[0].title === '整零價差：刪單失敗')).toBe(true);
    spreadExecAction(id, { type: 'cancel' });
    expect(mocks.cancel).toHaveBeenCalledTimes(4);
    expect(mocks.cancel.mock.calls.slice(2).map(c => c[0])).toEqual([['T1'], ['T2']]);
});

it('確定未送出（mutationNotStarted）→ 第一腳全失敗就結束', async () => {
    mocks.place.mockRejectedValue(Object.assign(new Error('庫存不足'), { mutationNotStarted: true }));
    startSpreadExecution(req());
    await flush();
    expect(record().state.phase).toBe('failed');
    expect(hasLiveSpreadExecution()).toBe(false);
    expect(liveExecutionFor('2330', account)).toBeUndefined();
});

it('補單超出滑價上限：不送，列未配對待處理；以最新價補單才送', async () => {
    let n = 0;
    mocks.place.mockImplementation(async (_c: unknown, a: string, price: number, quantity: number) => trade(`T${++n}`, price, quantity, 0, 'Submitted', undefined, 'IntradayOdd', a));
    mocks.quotes.set('2330:false', { bidask: { code: '2330', date: '2026/09/30', time: '10:00:00', bid_price: ['1095'], bid_volume: [5], ask_price: ['1100'], ask_volume: [5] } });
    const id = startSpreadExecution(req());
    await flush();
    setTrades([trade('T1', 1095, 380, 380, 'Filled', tagOf('odd:0')), trade('T2', 1090, 620, 620, 'Filled', tagOf('odd:1'))]);
    expect(mocks.place).toHaveBeenCalledTimes(2);
    expect(record().state.phase).toBe('hedgeDecision');
    expect(acceptHedge(id, 2, [{ price: 1100, quantity: 2 }])).toBe(false); // 與待補數量不符 → 不送
    expect(acceptHedge(id, 1, [{ price: 1100, quantity: 1 }])).toBe(true);
    expect(mocks.place.mock.calls[2]!.slice(1, 4)).toEqual(['Buy', 1100, 1]);
});

it('彈出視窗與非執行中的主視窗不可執行', () => {
    mocks.main = false;
    expect(oddSpreadExecUnavailable()).toContain('只能在主視窗');
    expect(() => startSpreadExecution(req())).toThrow('只能在主視窗');
    mocks.main = true;
    mocks.executor = false;
    expect(oddSpreadExecUnavailable()).toContain('另一個主視窗');
});

it('對帳只認同帳戶、同商品、同方向價量與單位，且標記完全相同', () => {
    mocks.place.mockImplementation(() => new Promise(() => undefined));
    startSpreadExecution(req());
    const t0 = tagOf('odd:0');
    reconcile([
        { ...trade('W1', 1095, 380, 380, 'Filled', t0), account: { ...account, account_id: 'B' } } as AccountedTrade,
        trade('W2', 1095, 380, 380, 'Filled', t0, 'Common'),
        trade('W3', 1095, 381, 380, 'Filled', t0),
        trade('W4', 1095, 380, 380, 'Filled', undefined),
        trade('W5', 1095, 380, 380, 'Filled', tagOf('odd:1')),
    ]);
    expect(record().state.slots.every(s => !s.orderId)).toBe(true);
    reconcile([trade('W6', 1095, 380, 380, 'Filled', t0)]);
    expect(record().state.slots[0]!.orderId).toBe('W6');
});
