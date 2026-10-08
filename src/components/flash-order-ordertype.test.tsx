// 閃電下單的委託條件（同下單面板）：點價限價單的效期 ROD／IOC／FOK、期貨
// 倉別 自動／新倉／平倉／當沖、期貨市價鈕 市價／範圍市價。記在面板上、換商品
// 保留；不適用的商品類別（零股只能 ROD）停用並說明、回來恢復；非預設才顯示
// 標籤；換條件立即解除點價下單；送出與通知帶出所有非預設條件。
import { createElement, useLayoutEffect } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), post: vi.fn(), base: 'fixture', store: new Map<string, string>() }));
const accounts: Account[] = [
    { account_type: 'S', broker_id: 'BR', account_id: 'A1234', signed: true, person_id: '', username: '' },
    { account_type: 'F', broker_id: 'BR', account_id: 'F5678', signed: true, person_id: '', username: '' },
];
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined, useAccounts: () => ({ loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined, useTradingLive: () => true }));
vi.mock('../hooks/use-display-book', () => ({ useDisplayBook: () => ({ quote: { tick: { close: '100', volume: 1 } }, snapshot: { close: 100 }, book: undefined }) }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: vi.fn(), cancelOrders: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify, placeQuickOrder: mocks.place, placeStockExitByShares: vi.fn() }));
vi.mock('../lib/stream', () => ({ getAliasFor: () => undefined }));
vi.mock('../lib/tick-bands', () => ({ useTickBandsVersion: () => 0 }));
vi.mock('../lib/api', () => ({ apiPost: mocks.post }));
vi.mock('../lib/runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';
import { resetCreditEnquireCache } from '../lib/credit-eligibility';
import type { FlashOrderOpts } from '../lib/flash-account';

const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', day_trade: 'Yes', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const hon = { ...stk, code: '2317', name: '鴻海' } as ContractInfo;
const onlyBuy = { ...stk, code: '1101', name: '台泥', day_trade: 'OnlyBuy' } as ContractInfo;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', reference: 100 } as unknown as ContractInfo;
const enquire = (code: string, patch: Record<string, number> = {}) => [{ stock_id: code, system: 'ALL', update_time: '', margin_unit: 100, short_unit: 50, margin_loan_ratio: 60, short_margin_ratio: 90, ...patch }];

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b) === label);
const creditBtn = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '單位與信用條件')[0];
const menu = (r: ReactTestRenderer) => r.root.findAll(n => n.props.role === 'menu')[0];
const item = (r: ReactTestRenderer, label: string) => menu(r)!.findAll(n => n.type === 'button' && String(n.props.role).startsWith('menuitem') && text(n).startsWith(label))[0]!;
const tags = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-testid'] === 'flash-order-tag').map(text);
const banner = (r: ReactTestRenderer) => r.root.findAll(n => n.props['data-testid'] === 'flash-credit-banner')[0];
const cell = (r: ReactTestRenderer, side: 'buy' | 'sell') => r.root.findAll(n => n.type === 'div' && n.props['data-side'] === side)[0]!;
const arm = async (r: ReactTestRenderer) => { await act(async () => { button(r, '啟用閃電下單')!.props.onClick(); }); };
const flush = async () => { await act(async () => { await Promise.resolve(); }); };

const keyListeners = new Set<(e: unknown) => void>();
const pressEscape = async () => {
    await act(async () => {
        const e = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
        // capture listeners (the menu's) run first, like the browser
        for (const fn of [...keyListeners]) { if (e.stopped) break; fn(e); }
    });
};
const owned = (order?: FlashOrderOpts, lot?: 'Common' | 'IntradayOdd') => {
    const state = { order, lot, changes: [] as FlashOrderOpts[] };
    const extra = () => ({
        orderOpts: state.order, onOrderOptsChange: (o: FlashOrderOpts) => { state.order = o; state.changes.push(o); },
        lot: state.lot, onLotChange: (l: 'Common' | 'IntradayOdd') => { state.lot = l; },
    });
    return { state, extra };
};
const props = (contract: ContractInfo, extra: Record<string, unknown> = {}) => ({ contract, trades: [], positions: [], ...extra });
const mount = async (contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, props(contract, extra))); });
    roots.push(r);
    await flush();
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, extra))); });
    await flush();
};
const pick = async (r: ReactTestRenderer, label: string, rerender?: () => Promise<void>) => {
    await act(async () => { creditBtn(r)!.props.onClick(); });
    await act(async () => { item(r, label).props.onClick(); });
    if (rerender) await rerender();
    await flush();
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mocks.base = 'fixture';
    mocks.store.clear();
    resetCreditEnquireCache();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    keyListeners.clear();
    vi.stubGlobal('window', {
        addEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') keyListeners.add(fn); },
        removeEventListener: (t: string, fn: (e: unknown) => void) => { if (t === 'keydown') keyListeners.delete(fn); },
    });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
    mocks.post.mockImplementation(async (_p: string, body: { contracts: { code: string }[] }) => enquire(body.contracts[0]!.code));
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
});

const D: FlashOrderOpts = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT' };
const unitBtn = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '單位與委託條件')[0];
const choose = async (r: ReactTestRenderer, label: string, rerender?: () => Promise<void>) => {
    await act(async () => { unitBtn(r)!.props.onClick(); });
    await act(async () => { item(r, label).props.onClick(); });
    if (rerender) await rerender();
    await flush();
};

it('defaults look exactly like today: no tags, ROD limit clicks, IOC market, 自動', async () => {
    const r = await mount(fut);
    expect(tags(r)).toEqual([]);
    expect(text(unitBtn(r)!)).toBe('口');
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await act(async () => { button(r, '市價賣')!.props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderType: 'ROD', ocType: 'Auto' });
    expect(mocks.place.mock.calls[1]![2]).toBeNull();
    expect(mocks.place.mock.calls[1]![4]).toMatchObject({ ocType: 'Auto', futuresPriceType: 'MKT' });
});

it('futures: 效期 IOC, 倉別 新倉 and 範圍市價 are saved on the panel, tagged, and sent', async () => {
    const owner = owned();
    const r = await mount(fut, owner.extra());
    await choose(r, 'IOC', () => show(r, fut, owner.extra()));
    await choose(r, '新倉', () => show(r, fut, owner.extra()));
    await choose(r, '範圍市價', () => show(r, fut, owner.extra()));
    expect(owner.state.order).toEqual({ orderType: 'IOC', octype: 'New', futuresPriceType: 'MKP' });
    expect(tags(r)).toEqual(['IOC', '新倉', '範圍市價']);
    expect(text(unitBtn(r)!)).toBe('口·新倉');
    expect(button(r, '範圍市價買')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'sell').props.onClick(); });
    await act(async () => { button(r, '範圍市價買')!.props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderType: 'IOC', ocType: 'New' });
    expect(mocks.place.mock.calls[1]![4]).toMatchObject({ ocType: 'New', futuresPriceType: 'MKP' });
    // the notice names every non-default condition
    expect(mocks.notify.mock.calls[0]![0].body).toContain('限價 IOC・新倉');
    expect(mocks.notify.mock.calls[1]![0].body).toContain('範圍市價 IOC・新倉');
});

it('futures 當沖 倉別 goes out as DayTrade', async () => {
    const r = await mount(fut, owned({ ...D, octype: 'DayTrade' }).extra());
    expect(tags(r)).toEqual(['當沖']);
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ ocType: 'DayTrade' });
});

it('stocks: 效期 FOK on limit clicks; market stays IOC; no 倉別 or 範圍市價 even if saved', async () => {
    const owner = owned({ orderType: 'ROD', octype: 'New', futuresPriceType: 'MKP' });
    const r = await mount(stk, owner.extra());
    expect(tags(r)).toEqual([]);
    await choose(r, 'FOK', () => show(r, stk, owner.extra()));
    expect(tags(r)).toEqual(['FOK']);
    expect(button(r, '市價買')).toBeDefined();
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await act(async () => { button(r, '市價買')!.props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderType: 'FOK' });
    expect(mocks.place.mock.calls[0]![4]).not.toHaveProperty('ocType');
    expect(mocks.place.mock.calls[0]![4]).not.toHaveProperty('futuresPriceType');
    expect(mocks.place.mock.calls[1]![2]).toBeNull();
});

it('odd lots: IOC/FOK disabled with the reason, orders are ROD; back to 張 restores FOK', async () => {
    const owner = owned({ ...D, orderType: 'FOK' }, 'IntradayOdd');
    const r = await mount(stk, owner.extra());
    expect(tags(r)).toEqual([]);
    await act(async () => { unitBtn(r)!.props.onClick(); });
    expect(item(r, 'IOC').props.disabled).toBe(true);
    expect(item(r, 'FOK').props.disabled).toBe(true);
    expect(text(menu(r)!)).toContain('零股只接受當日有效（ROD）');
    await act(async () => { item(r, '張（整股）').props.onClick(); });
    await show(r, stk, owner.extra());
    expect(tags(r)).toEqual(['FOK']);
    owner.state.lot = 'IntradayOdd';
    await show(r, stk, owner.extra());
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderType: 'ROD', orderLot: 'IntradayOdd' });
});

it('the panel keeps its conditions across symbol changes (stock ↔ futures): futures-only ones return with futures', async () => {
    const owner = owned({ orderType: 'IOC', octype: 'Cover', futuresPriceType: 'MKP' });
    const r = await mount(fut, owner.extra());
    expect(tags(r)).toEqual(['IOC', '平倉', '範圍市價']);
    await show(r, stk, owner.extra());
    expect(tags(r)).toEqual(['IOC']);
    await show(r, fut, owner.extra());
    expect(tags(r)).toEqual(['IOC', '平倉', '範圍市價']);
    expect(owner.state.changes).toEqual([]);
});

it('changing a condition disarms in the same render — even when the owner changes it', async () => {
    let r!: ReactTestRenderer;
    const Wrapped = ({ order, click }: { order: FlashOrderOpts; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            cell(r, 'buy').props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(fut, { orderOpts: order, onOrderOptsChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { order: D, click: false })); });
    roots.push(r);
    await arm(r);
    await act(async () => { r.update(createElement(Wrapped, { order: { ...D, orderType: 'IOC' }, click: true })); });
    await flush();
    expect(mocks.place).not.toHaveBeenCalled();
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('a pending order is refused at dispatch when a condition changes meanwhile', async () => {
    let guard!: () => void;
    mocks.place.mockImplementation((_c: unknown, _a: unknown, _p: unknown, _q: unknown, opts: { beforeSend: () => void }) => {
        guard = opts.beforeSend;
        return new Promise(() => undefined);
    });
    const owner = owned();
    const r = await mount(fut, owner.extra());
    await arm(r);
    await act(async () => { cell(r, 'buy').props.onClick(); });
    await flush();
    expect(() => guard()).not.toThrow();
    owner.state.order = { ...D, octype: 'New' };
    await show(r, fut, owner.extra());
    expect(() => guard()).toThrow();
});

it('futures panels fold the gear into the 口 menu too (更多設定…)', async () => {
    const gear = (x: ReactTestRenderer) => x.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!;
    const r = await mount(fut);
    expect(gear(r).props.hidden).toBe(true);
    await act(async () => { unitBtn(r)!.props.onClick(); });
    await act(async () => { item(r, '更多設定').props.onClick(); });
    expect(r.root.findAll(n => n.props.role === 'dialog' && n.props['aria-label'] === '閃電下單設定')).toHaveLength(1);
});
