// 閃電下單的整股／零股是「面板」的設定，不是股票的：一個閃電放張、一個放股，
// 換股票各自維持；單位跟版面（workspace block）或彈出視窗一起存。下單面板、
// 鋪單、K 線圖仍依股票記憶（#232），不在這裡。
import { createElement, useLayoutEffect } from 'react';
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
const LEGACY_KEY = 'sj-pro-order-lot-preferences';
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

/** A workspace-like owner: the block's flashLot lives outside the component. */
const owned = (initial?: Lot) => {
    const state = { lot: initial, changes: [] as Lot[] };
    const extra = () => ({ lot: state.lot, onLotChange: (l: Lot) => { state.lot = l; state.changes.push(l); } });
    return { state, extra };
};

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

it('an odd-lot panel stays 股 and keeps 500 股 when it moves to another stock, and disarms', async () => {
    const r = await mount(stk);
    await pickUnit(r, 'IntradayOdd', '500');
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    expect(text(r.root)).toContain('點價即下單');
    await show(r, hon);
    expect(unit(r)).toBe('股');
    expect(qty(r).props.value).toBe(500);
    // changing symbol still disarms click-to-trade
    expect(text(r.root)).toContain('啟用閃電下單');
    expect(text(r.root)).not.toContain('點價即下單');
    // orders on the new stock go out as odd-lot shares
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    const cell = r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!;
    await act(async () => { cell.props.onClick(); });
    expect(mocks.place.mock.calls[0]![0]).toMatchObject({ code: '2317' });
    expect(mocks.place.mock.calls[0]![3]).toBe(500);
    expect(mocks.place.mock.calls[0]![4]).toMatchObject({ orderLot: 'IntradayOdd' });
});

it('two side-by-side panels — one 張, one 股 — each keep their unit across symbol changes', async () => {
    const round = await mount(stk);
    const odd = await mount(stk);
    await pickUnit(odd, 'IntradayOdd', '100');
    await act(async () => { qty(round).props.onChange({ target: { value: '2' } }); });
    for (const c of [hon, { ...stk, code: '2454' } as ContractInfo, stk]) {
        await show(round, c);
        await show(odd, c);
        expect(unit(round)).toBe('張');
        expect(qty(round).props.value).toBe(2);
        expect(unit(odd)).toBe('股');
        expect(qty(odd).props.value).toBe(100);
    }
});

it('ignores the old per-symbol flash records and never writes them', async () => {
    mocks.store.set(LEGACY_KEY, JSON.stringify({ flash: { '2317': 'IntradayOdd' } }));
    const r = await mount(stk);
    await show(r, hon);
    expect(unit(r)).toBe('張');
    await pickUnit(r, 'IntradayOdd');
    await show(r, stk);
    expect(unit(r)).toBe('股');
    expect(JSON.parse(mocks.store.get(LEGACY_KEY)!)).toEqual({ flash: { '2317': 'IntradayOdd' } });
});

it('reports the unit to its owner and restores it from the owner (reload / layout switch / popout)', async () => {
    const owner = owned();
    const r = await mount(stk, owner.extra());
    // the default-derived unit is saved once on mount, then the user's pick
    expect(owner.state.changes).toEqual(['Common']);
    await pickUnit(r, 'IntradayOdd');
    expect(owner.state.changes).toEqual(['Common', 'IntradayOdd']);
    await show(r, stk, owner.extra());
    expect(unit(r)).toBe('股');
    // a fresh mount (reload) reads the saved unit, on any stock
    const again = await mount(hon, owned('IntradayOdd').extra());
    expect(unit(again)).toBe('股');
    const round = await mount(hon, owned('Common').extra());
    expect(unit(round)).toBe('張');
});

it('a panel with no saved unit (upgraded) starts from the 設為預設 unit, not the old per-symbol record', async () => {
    mocks.store.set(LEGACY_KEY, JSON.stringify({ flash: { '2330': 'IntradayOdd' } }));
    const plainOwner = owned();
    const plain = await mount(stk, plainOwner.extra());
    expect(unit(plain)).toBe('張');
    expect(plainOwner.state.lot).toBe('Common');
    mocks.store.set(DEFAULTS_KEY, JSON.stringify({ S: { lot: 'IntradayOdd', qty: 300 } }));
    const odd = await mount(hon, owned().extra());
    expect(unit(odd)).toBe('股');
    expect(qty(odd).props.value).toBe(300);
});

it('futures show 口 without changing the panel unit; back on a stock the panel is 股 again', async () => {
    const owner = owned('IntradayOdd');
    const r = await mount(stk, owner.extra());
    await act(async () => { qty(r).props.onChange({ target: { value: '500' } }); });
    await show(r, fut, owner.extra());
    expect(unit(r)).toBe('口');
    expect(qty(r).props.value).toBe(1); // never 500 口
    await act(async () => { gear(r).props.onClick(); });
    expect(text(pop(r)!)).not.toContain('盤中零股');
    await act(async () => { btnIn(pop(r)!, '完成').props.onClick(); });
    await show(r, hon, owner.extra());
    expect(unit(r)).toBe('股');
    expect(qty(r).props.value).toBe(1); // class changed → 1, never 500 張
    expect(owner.state.changes).toEqual([]);
    expect(owner.state.lot).toBe('IntradayOdd');
});

it('a unit change from outside (another layout) resets the quantity and disarms', async () => {
    const r = await mount(stk, owned('IntradayOdd').extra());
    await act(async () => { qty(r).props.onChange({ target: { value: '500' } }); });
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await show(r, stk, owned('Common').extra());
    expect(unit(r)).toBe('張');
    expect(qty(r).props.value).toBe(1); // 500 股 must never become 500 張
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('changing the unit in settings still resets the quantity to 1 and disarms', async () => {
    const r = await mount(stk);
    await act(async () => { qty(r).props.onChange({ target: { value: '7' } }); });
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await pickUnit(r, 'IntradayOdd');
    expect(qty(r).props.value).toBe(1);
    expect(text(r.root)).toContain('啟用閃電下單');
});

it('saves the default-derived unit once, so a later default change does not flip it on reload or popout', async () => {
    const owner = owned();
    await mount(stk, owner.extra());
    expect(owner.state.lot).toBe('Common');
    // another panel makes 零股 the default
    mocks.store.set(DEFAULTS_KEY, JSON.stringify({ S: { lot: 'IntradayOdd', qty: 300 } }));
    const reloaded = await mount(stk, owner.extra());
    expect(unit(reloaded)).toBe('張');
    expect(owner.state.changes).toEqual(['Common']);
});

it('an outside unit change can never send the old quantity in the new unit, even before effects run', async () => {
    let r!: ReactTestRenderer;
    const Wrapped = ({ lot, click }: { lot: Lot; click: boolean }) => {
        // fires in the same commit as the new unit, before FlashOrder's passive effects
        useLayoutEffect(() => {
            if (!click) return;
            r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!.props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(stk, { lot, onLotChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { lot: 'IntradayOdd', click: false })); });
    roots.push(r);
    await act(async () => { qty(r).props.onChange({ target: { value: '500' } }); });
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await act(async () => { r.update(createElement(Wrapped, { lot: 'Common', click: true })); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(qty(r).props.value).toBe(1);
});

it('a symbol change keeping the unit and quantity never stays armed, even before effects run', async () => {
    let r!: ReactTestRenderer;
    const Wrapped = ({ contract, click }: { contract: ContractInfo; click: boolean }) => {
        useLayoutEffect(() => {
            if (!click) return;
            r.root.findAll(n => n.type === 'div' && String(n.props.title ?? '').startsWith('限價買 '))[0]!.props.onClick();
        }, [click]);
        return createElement(FlashOrder, props(contract, { lot: 'IntradayOdd', onLotChange: () => undefined }));
    };
    await act(async () => { r = create(createElement(Wrapped, { contract: stk, click: false })); });
    roots.push(r);
    await act(async () => { qty(r).props.onChange({ target: { value: '500' } }); });
    await act(async () => { button(r, '啟用閃電下單').props.onClick(); });
    await act(async () => { r.update(createElement(Wrapped, { contract: hon, click: true })); });
    expect(mocks.place).not.toHaveBeenCalled();
    expect(qty(r).props.value).toBe(500);
});

it('keeps the quantity when the panel remounts on another stock (pinned code still loading), per panel id', async () => {
    const first = await mount(stk, { ...owned('IntradayOdd').extra(), panelId: 'flash-1' });
    await act(async () => { qty(first).props.onChange({ target: { value: '500' } }); });
    await act(async () => first.unmount());
    roots.splice(roots.indexOf(first), 1);
    const again = await mount(hon, { ...owned('IntradayOdd').extra(), panelId: 'flash-1' });
    expect(unit(again)).toBe('股');
    expect(qty(again).props.value).toBe(500);
    // another panel id does not inherit it, and a different unit never carries it
    const other = await mount(hon, { ...owned('IntradayOdd').extra(), panelId: 'flash-2' });
    expect(qty(other).props.value).toBe(1);
    await act(async () => again.unmount());
    roots.splice(roots.indexOf(again), 1);
    const round = await mount(hon, { ...owned('Common').extra(), panelId: 'flash-1' });
    expect(qty(round).props.value).toBe(1);
});
