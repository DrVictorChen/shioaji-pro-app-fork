// 閃電下單「記住數量」：每個面板一個開關（預設開，新面板與升級前的面板都開），
// 開啟時張／股／口各記一個數量，跟面板設定一起存；關閉時清掉。還原前重新檢查
// 單位上限，不合法回到 1 並提示；還原或換單位後點價下單仍是解除狀態。
import { createElement, StrictMode, useLayoutEffect, useState } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';
import type { ContractInfo } from '../lib/types/contract';
const mocks = vi.hoisted(() => ({ place: vi.fn(), notify: vi.fn(), store: new Map<string, string>() }));
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
vi.mock('../lib/utils/ticksize', () => ({ roundToTick: (_c: unknown, p: number) => p, stepPrice: (_c: unknown, p: number, step: number) => p + step }));
import { FlashOrder } from './flash-order';

type Lot = 'Common' | 'IntradayOdd';
const stk = { code: '2330', name: '台積電', security_type: 'STK', reference: 100, limit_up: 110, limit_down: 90 } as unknown as ContractInfo;
const hon = { ...stk, code: '2317', name: '鴻海' } as ContractInfo;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', reference: 100 } as unknown as ContractInfo;
const DEFAULTS_KEY = 'sj-pro-flash-order-defaults';
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const roots: ReactTestRenderer[] = [];
const gear = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-label'] === '閃電下單設定')[0]!;
const pop = (r: ReactTestRenderer) => r.root.findAll(n => n.props.role === 'dialog')[0];
const btnIn = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label)[0]!;
const button = (r: ReactTestRenderer, label: string) => r.root.findAllByType('button').find(b => text(b).includes(label))!;
const qty = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('數量'))[0]!;
const unit = (r: ReactTestRenderer) => (qty(r).props['aria-label'] === '數量（股）' ? '股' : text(r.root).includes('口') && !text(r.root).includes('張') ? '口' : '張');

const props = (contract: ContractInfo, extra: Record<string, unknown> = {}) => ({ contract, trades: [], positions: [], ...extra });
const mount = async (contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(FlashOrder, props(contract, extra))); });
    roots.push(r);
    return r;
};
const show = async (r: ReactTestRenderer, contract: ContractInfo, extra: Record<string, unknown> = {}) => {
    await act(async () => { r.update(createElement(FlashOrder, props(contract, extra))); });
};
const pickUnit = async (r: ReactTestRenderer, lot: Lot, shares?: string) => {
    await act(async () => { gear(r).props.onClick(); });
    await act(async () => { btnIn(pop(r)!, lot === 'IntradayOdd' ? '盤中零股（股）' : '整股（張）').props.onClick(); });
    if (shares) await act(async () => { btnIn(pop(r)!, shares).props.onClick(); });
    await act(async () => { btnIn(pop(r)!, '完成').props.onClick(); });
};


type Setting = Partial<Record<'Common' | 'IntradayOdd' | 'F', number>> | false | undefined;
/**
 * A workspace-like owner of the panel's unit and remembered quantities: like
 * the App, it re-renders the panel whenever the panel saves a setting.
 */
const owner = (lot?: Lot, qtyMemory?: Setting) => {
    const state = { lot, qtyMemory, writes: [] as Setting[] };
    const Owned = ({ contract }: { contract: ContractInfo }) => {
        const [, bump] = useState(0);
        return createElement(FlashOrder, props(contract, {
            lot: state.lot, onLotChange: (l: Lot) => { state.lot = l; bump(n => n + 1); },
            qtyMemory: state.qtyMemory, onQtyMemoryChange: (m: Setting) => { state.qtyMemory = m; state.writes.push(m); bump(n => n + 1); },
        }));
    };
    return { state, Owned };
};
const mountOwned = async (o: ReturnType<typeof owner>, contract: ContractInfo) => {
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(o.Owned, { contract })); });
    roots.push(r);
    return r;
};
const showOwned = async (o: ReturnType<typeof owner>, r: ReactTestRenderer, contract: ContractInfo) => {
    await act(async () => { r.update(createElement(o.Owned, { contract })); });
};
const remember = (r: ReactTestRenderer) => pop(r)!.findAll(n => n.props.role === 'group' && n.props['aria-label'] === '記住數量')[0]!;
const setRemember = async (r: ReactTestRenderer, on: boolean) => {
    await act(async () => { gear(r).props.onClick(); });
    await act(async () => { btnIn(remember(r), on ? '開' : '關').props.onClick(); });
    await act(async () => { btnIn(pop(r)!, '完成').props.onClick(); });
};
const typeQty = async (r: ReactTestRenderer, v: number) => { await act(async () => { qty(r).props.onChange({ target: { value: String(v) } }); }); };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (k: string) => mocks.store.get(k) ?? null, setItem: (k: string, v: string) => { mocks.store.set(k, v); } });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    mocks.place.mockResolvedValue({ status: { status: 'PendingSubmit' } });
});
afterEach(async () => {
    for (const r of roots.splice(0)) await act(async () => r.unmount());
    vi.unstubAllGlobals();
});

it('is on by default for new and upgraded panels, shown in the settings with explicit units', async () => {
    const o = owner('Common');
    const r = await mountOwned(o, stk);
    await act(async () => { gear(r).props.onClick(); });
    expect(btnIn(remember(r), '開').props['aria-pressed']).toBe(true);
    expect(btnIn(remember(r), '關').props['aria-pressed']).toBe(false);
    expect(text(pop(r)!)).toContain('尚未記住');
    await act(async () => { btnIn(pop(r)!, '完成').props.onClick(); });
    // nothing is written until the user changes the quantity
    expect(o.state.writes).toEqual([]);
    await typeQty(r, 3);
    expect(o.state.qtyMemory).toEqual({ Common: 3 });
    await act(async () => { gear(r).props.onClick(); });
    expect(text(pop(r)!)).toContain('整股 3 張');
});

it('remembers one quantity per unit and restores it after reload and on unit / class changes', async () => {
    const o = owner('Common');
    const r = await mountOwned(o, stk);
    await typeQty(r, 3);
    await pickUnit(r, 'IntradayOdd', '500');
    expect(qty(r).props.value).toBe(500);
    await showOwned(o, r, fut);
    expect(unit(r)).toBe('口');
    expect(qty(r).props.value).toBe(1);
    await typeQty(r, 2);
    expect(o.state.qtyMemory).toEqual({ Common: 3, IntradayOdd: 500, F: 2 });
    // 零股 500 → 期貨 → 回零股仍 500
    await showOwned(o, r, hon);
    expect(unit(r)).toBe('股');
    expect(qty(r).props.value).toBe(500);
    // switching back to 張 brings 3 張 (never 500 張), and does not overwrite the 股 slot
    await pickUnit(r, 'Common');
    expect(unit(r)).toBe('張');
    expect(qty(r).props.value).toBe(3);
    expect(o.state.qtyMemory).toEqual({ Common: 3, IntradayOdd: 500, F: 2 });
    // reload / layout switch / app restart: a fresh mount from the saved panel setting
    const again = await mountOwned(owner('IntradayOdd', o.state.qtyMemory), hon);
    expect(qty(again).props.value).toBe(500);
    const futAgain = await mountOwned(owner('IntradayOdd', o.state.qtyMemory), fut);
    expect(qty(futAgain).props.value).toBe(2);
    const lots = await mountOwned(owner('Common', o.state.qtyMemory), stk);
    expect(qty(lots).props.value).toBe(3);
    // restored panels are never armed
    for (const p of [again, futAgain, lots]) expect(text(p.root)).toContain('啟用閃電下單');
});

it('turning it off clears the remembered quantities; quantities go back to 1 after reload or unit changes', async () => {
    const o = owner('IntradayOdd', { Common: 3, IntradayOdd: 500 });
    const r = await mountOwned(o, stk);
    expect(qty(r).props.value).toBe(500);
    await setRemember(r, false);
    expect(o.state.qtyMemory).toBe(false);
    await typeQty(r, 300);
    expect(o.state.qtyMemory).toBe(false);
    await showOwned(o, r, fut);
    await showOwned(o, r, stk);
    expect(qty(r).props.value).toBe(1);
    const reloaded = await mountOwned(o, stk);
    expect(qty(reloaded).props.value).toBe(1);
    await act(async () => { gear(reloaded).props.onClick(); });
    expect(btnIn(remember(reloaded), '關').props['aria-pressed']).toBe(true);
    // turning it back on starts from the quantity shown now
    await act(async () => { btnIn(remember(reloaded), '開').props.onClick(); });
    expect(o.state.qtyMemory).toEqual({ IntradayOdd: 1 });
});

it.each([
    ['over the 999-share odd-lot limit', { IntradayOdd: 5000 }],
    ['zero', { IntradayOdd: 0 }],
    ['fractional', { IntradayOdd: 1.5 }],
    ['not a number', { IntradayOdd: '500' as unknown as number }],
])('an invalid remembered quantity (%s) is restored as 1 with a notice and dropped', async (_label, mem) => {
    const o = owner('IntradayOdd', { Common: 3, ...mem });
    const r = await mountOwned(o, stk);
    expect(unit(r)).toBe('股');
    expect(qty(r).props.value).toBe(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '記住的數量已改為 1' }));
    expect(o.state.qtyMemory).toEqual({ Common: 3 });
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('an invalid quantity met on a unit change is also replaced by 1 with a notice', async () => {
    const o = owner('Common', { Common: 3, F: 99999 });
    const r = await mountOwned(o, stk);
    expect(qty(r).props.value).toBe(3);
    await showOwned(o, r, fut);
    expect(qty(r).props.value).toBe(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '記住的數量已改為 1' }));
    expect(o.state.qtyMemory).toEqual({ Common: 3 });
});

it('a unit change that brings a remembered quantity is still disarmed, even before effects run', async () => {
    let r!: ReactTestRenderer;
    const mem = { Common: 3, IntradayOdd: 500 };
    const Wrapped = ({ lot, click }: { lot: Lot; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!.props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(stk, { lot, onLotChange: () => undefined, qtyMemory: mem, onQtyMemoryChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { lot: 'IntradayOdd', click: false })); });
    roots.push(r);
    expect(qty(r).props.value).toBe(500);
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await act(async () => { r.update(createElement(Wrapped, { lot: 'Common', click: true })); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(unit(r)).toBe('張');
    expect(qty(r).props.value).toBe(3);
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('an invalid remembered quantity is 1 even when the 設為預設 quantity of that unit is larger', async () => {
    mocks.store.set(DEFAULTS_KEY, JSON.stringify({ S: { lot: 'IntradayOdd', qty: 300 } }));
    const o = owner('IntradayOdd', { IntradayOdd: 5000 });
    const r = await mountOwned(o, stk);
    expect(qty(r).props.value).toBe(1);
    expect(o.state.qtyMemory).toEqual({});
});

it('an invalid remembered quantity gives exactly one notice (StrictMode re-runs effects)', async () => {
    const o = owner('IntradayOdd', { Common: 3, IntradayOdd: 5000 });
    let r!: ReactTestRenderer;
    await act(async () => { r = create(createElement(StrictMode, null, createElement(o.Owned, { contract: stk }))); });
    roots.push(r);
    expect(qty(r).props.value).toBe(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(String(mocks.notify.mock.calls[0]![0].body)).toContain('5000 股');
    expect(o.state.qtyMemory).toEqual({ Common: 3 });
});

it('a layout switch that brings another remembered quantity for the same unit shows it at once and is disarmed', async () => {
    let r!: ReactTestRenderer;
    const Wrapped = ({ mem, click }: { mem: Setting; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!.props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(stk, { lot: 'Common', onLotChange: () => undefined, qtyMemory: mem, onQtyMemoryChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { mem: { Common: 3 }, click: false })); });
    roots.push(r);
    expect(qty(r).props.value).toBe(3);
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    // the saved layout (same block id) remembers 8 張
    await act(async () => { r.update(createElement(Wrapped, { mem: { Common: 8 }, click: true })); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(qty(r).props.value).toBe(8);
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('editing the quantity while armed keeps it armed and sends the new quantity', async () => {
    const o = owner('Common', { Common: 3 });
    const r = await mountOwned(o, stk);
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await typeQty(r, 4);
    expect(o.state.qtyMemory).toEqual({ Common: 4 });
    const cell = r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!;
    await act(async () => { cell.props.onClick(); });
    expect(mocks.place.mock.calls[0]![3]).toBe(4);
});

it('with it off, a reload is 1 even when 設為預設 has a larger quantity', async () => {
    mocks.store.set(DEFAULTS_KEY, JSON.stringify({ S: { lot: 'Common', qty: 7 } }));
    const r = await mountOwned(owner('Common', false), stk);
    expect(qty(r).props.value).toBe(1);
    // …while a panel with it on (nothing remembered yet) starts from 設為預設
    const on = await mountOwned(owner('Common'), stk);
    expect(qty(on).props.value).toBe(7);
});

it('clearing the quantity field drops that unit from memory instead of snapping back', async () => {
    const o = owner('Common', { Common: 3, IntradayOdd: 500 });
    const r = await mountOwned(o, stk);
    await typeQty(r, 0);
    expect(qty(r).props.value).toBe(0);
    expect(o.state.qtyMemory).toEqual({ IntradayOdd: 500 });
    await typeQty(r, 6);
    expect(o.state.qtyMemory).toEqual({ Common: 6, IntradayOdd: 500 });
});

it('an invalid quantity restored into a mounted panel (same unit) is 1 at once and disarmed', async () => {
    let r!: ReactTestRenderer;
    const Wrapped = ({ mem, click }: { mem: Setting; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!.props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(stk, { lot: 'Common', onLotChange: () => undefined, qtyMemory: mem, onQtyMemoryChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { mem: { Common: 3 }, click: false })); });
    roots.push(r);
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await act(async () => { r.update(createElement(Wrapped, { mem: { Common: 10000 }, click: true })); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(qty(r).props.value).toBe(1);
    // after the notice drops the invalid record, it stays 1 (not the old 3)
    await act(async () => { r.update(createElement(Wrapped, { mem: {}, click: false })); });
    expect(qty(r).props.value).toBe(1);
    expect(text(r.root)).toContain('啟用閃電下單');
});
