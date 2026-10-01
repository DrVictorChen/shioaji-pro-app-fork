// #204 K 線圖下單設定：工具列一顆按鈕（數量＋單位）、彈出面板只列適用選項、
// 點價與停損停利實際使用這組設定（帳號、單位、數量、委託、開平倉）
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Account } from '../lib/types/portfolio';

vi.mock('react-dom', () => ({ createPortal: (children: unknown) => children }));

vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
const m = vi.hoisted(() => ({
    place: vi.fn(), addTrigger: vi.fn(), notify: vi.fn(),
    click: [] as ((p: unknown) => void)[],
    accounts: [] as Account[],
    roundClose: 100 as number | null,
    oddClose: 100 as number | null,
    drawingBusy: false,
    skipDisarm: false,
}));
vi.mock('../hooks/use-chart-drawings', async (importOriginal) => {
    const real = await importOriginal<typeof import('../hooks/use-chart-drawings')>();
    return { ...real, useChartDrawings: (...args: Parameters<typeof real.useChartDrawings>) => {
        const api = real.useChartDrawings({ ...args[0], onEnterDrawingMode: () => {
            if (!m.skipDisarm) args[0].onEnterDrawingMode();
        } });
        return { ...api, drawingBusy: () => m.drawingBusy || api.drawingBusy() };
    } };
});
vi.mock('../lib/trade', () => ({ notify: m.notify, placeQuickOrder: m.place }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: async () => {}, updateOrderPrice: async () => {} }));
vi.mock('../lib/trigger-engine', () => ({ addTrigger: m.addTrigger, removeTrigger: vi.fn(), useTriggers: () => [] }));
vi.mock('../lib/account-store', () => ({ ensureAccounts: () => undefined,
    useAccounts: () => ({ loaded: true, accounts: m.accounts, selectedStock: m.accounts[0], selectedFutures: m.accounts[2] }) }));
vi.mock('../hooks/use-stream', () => ({ useQuote: (code: string | null, o?: { oddLot?: boolean }) => {
    if (!code) return undefined;
    const close = o?.oddLot ? m.oddClose : m.roundClose;
    return close === null ? undefined : { tick: { code, date: '2026/09/30', time: '11:00:00', close, volume: 1 }, seq: 1, lastDir: 0, flashSeq: 0 };
} }));
vi.mock('../lib/chart-history', () => ({ fetchChartHistory: async () => ({ candles: [], exhausted: true }), nextChartHistoryRevision: () => 1 }));
vi.mock('lightweight-charts', async () => {
    const h = await import('./chart-session.test-harness');
    const base = h.lwMock();
    const chart = () => {
        const inner = h.makeChart();
        return new Proxy({}, { get: (_t, p) => {
            if (p === 'subscribeClick') return (cb: (p: unknown) => void) => { m.click.push(cb); };
            if (p === 'addSeries') return (type: { kind: string }) => {
                const s = h.makeSeries(type.kind);
                return new Proxy(s, { get: (t, q) => (q === 'coordinateToPrice' ? () => 100 : t[q as keyof typeof t]) });
            };
            return inner[p];
        } });
    };
    return { ...base, createChart: chart };
});

import { CandleChart } from './candle-chart';
import { ChartDrawingTools, ChartDrawingOverlays, ChartObjectList, DrawingSettingsDialog, Popover, TextEditor } from './chart-drawing-tools';
import { __resetDrawingsForTest, addDrawing, DEFAULT_DRAWING_STYLE } from '../lib/chart-drawings';
import type { ChartDrawingsApi } from '../hooks/use-chart-drawings';

const S1 = { account_type: 'S', broker_id: 'B', account_id: '1111121', signed: true, person_id: '', username: '' } as Account;
const S2 = { ...S1, account_id: '2222207' } as Account;
const F1 = { ...S1, account_type: 'F', account_id: '3333307' } as Account;
const stk = { code: '2330', name: '台積電', security_type: 'STK', exchange: 'TSE', target_code: null, reference: 100, limit_up: 110, limit_down: 90 } as any;
const fut = { code: 'TXFR1', name: '臺股期貨', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TXFJ6', reference: 100 } as any;
const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
let view!: ReactTestRenderer;
const chip = () => view.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
const pop = () => view.root.findAll(n => n.props.role === 'dialog')[0];
const button = (root: ReactTestInstance, label: string) => root.findAll(n => n.type === 'button' && text(n) === label)[0]!;
const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => {}); };
async function mount(props: Record<string, unknown>) {
    await act(async () => {
        view = create(createElement(CandleChart, props as any), { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, contains: () => true, hasAttribute: () => true, focus() {}, style: {} }) });
    });
    await flush();
}
const clickChart = async () => { await act(async () => { m.click.at(-1)!({ point: { x: 10, y: 10 } }); }); await flush(); };
// react-test-renderer 不派送 DOM 事件；沿實際 host ancestry 執行 capture，
// 再執行子按鈕事件，保留 stopPropagation 無法阻擋 capture 的時序。
function capture(target: ReactTestInstance, kind: 'PointerDown' | 'KeyDown') {
    const path: ReactTestInstance[] = [];
    for (let n: ReactTestInstance | null = target; n; n = n.parent) path.unshift(n);
    for (const n of path) if (typeof n.type === 'string') n.props[`on${kind}Capture`]?.({});
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    m.place.mockReset().mockResolvedValue({ status: { status: 'PendingSubmit' } });
    m.addTrigger.mockReset().mockResolvedValue(null);
    m.notify.mockReset();
    m.click.length = 0;
    m.accounts = [S1, S2, F1];
    m.roundClose = 100; m.oddClose = 100;
    m.drawingBusy = false;
    m.skipDisarm = false;
    __resetDrawingsForTest();
    (globalThis as any).localStorage.setItem('sj-pro-chart-order-defaults', '{}');
});
afterEach(async () => { await act(async () => view?.unmount()); vi.unstubAllGlobals(); });

describe('chart order settings button', () => {
    const drawingApi = () => view.root.findByType(ChartDrawingTools).props.api as ChartDrawingsApi;

    it.each(['點價買', '點價賣'].flatMap(side => ['隱藏', '顯示', '鎖定', '解鎖', '刪除', '收起物件列表', '清除全部'].map(action => [side, action])))
    ('武裝%s後操作%s，capture 先解除武裝且後續空白點擊不下單', async (side, action) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        if (action === '顯示') await act(async () => drawingApi().setHidden(id, true));
        if (action === '解鎖') await act(async () => drawingApi().setLocked(id, true));
        await act(async () => drawingApi().setObjectListOpen(true));
        await act(async () => button(view.root, side!).props.onClick());
        const target = view.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith(action!))[0]!;
        expect(target).toBeDefined();
        await act(async () => {
            capture(target, 'PointerDown');
            // capture 本身已封住同步到達的 chart click，尚未執行子操作。
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
            target.props.onClick({ stopPropagation() {} });
        });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        await act(async () => button(view.root, side!).props.onClick());
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1); // 新武裝可正常下單
    });

    it.each(['PointerDown', 'KeyDown'] as const)('武裝後設定對話框的%s即使沒有改物件，也使後續空白點擊不下單', async (kind) => {
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!; });
        let dialog!: ReactTestRenderer;
        await act(async () => { dialog = create(createElement(DrawingSettingsDialog, { api: drawingApi(), drawing, onClose: vi.fn() })); });
        try {
            await act(async () => button(view.root, '點價買').props.onClick());
            const target = dialog.root.findAllByProps({ role: 'tab' })[0]!;
            await act(async () => capture(target, kind));
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => dialog.unmount()); }
    });

    it.each([false, true])('畫圖 API 操作即使未經 UI capture，也使本次武裝失效（模式解除遺漏=%s）', async (skipDisarm) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        await act(async () => button(view.root, '點價買').props.onClick());
        m.skipDisarm = skipDisarm;
        await act(async () => {
            drawingApi().setHidden(id, true);
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
        });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['浮動工具列', '文字編輯框', '彈出工具選單'].flatMap(surface => (['PointerDown', 'KeyDown'] as const).map(kind => [surface, kind] as const)))
    ('武裝後%s的%s先使武裝失效', async (surface, kind) => {
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'text', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE, { text: '註記' })!; });
        const api = drawingApi();
        const overlayApi = { ...api, selected: drawing, selectedList: [drawing], selectedIds: [drawing.id], selectionBox: { left: 10, top: 10, right: 50, bottom: 50 }, hostSize: { width: 800, height: 400 } };
        let ui!: ReactTestRenderer;
        await act(async () => {
            ui = create(surface === '浮動工具列' ? createElement(ChartDrawingOverlays, { api: overlayApi })
                : surface === '文字編輯框' ? createElement(TextEditor, { initial: '註記', box: { left: 0, top: 0 }, onCommit: api.commitText, onInteraction: api.onInteraction })
                : createElement(Popover, { anchor: null, label: '工具選單', onClose: vi.fn(), onInteraction: api.onInteraction, children: createElement('button', {}, '工具') }));
        });
        try {
            await act(async () => button(view.root, '點價賣').props.onClick());
            const target = surface === '文字編輯框' ? ui.root.findByType('textarea') : ui.root.findAllByType('button')[0]!;
            await act(async () => capture(target, kind));
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => ui.unmount()); }
    });

    it.each([
        { key: 'h', code: 'KeyH', altKey: true },
        { key: 'z', code: 'KeyZ', ctrlKey: true },
        { key: 'z', code: 'KeyZ', ctrlKey: true, shiftKey: true },
        { key: 'y', code: 'KeyY', ctrlKey: true },
        { key: 'Delete' }, { key: 'Backspace' }, { key: 'Escape' },
    ])('畫圖快捷鍵 $key（$code）後空白點擊不下單', async (key) => {
        const events = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener, active: document.activeElement };
        w.addEventListener = events.addEventListener.bind(events);
        w.removeEventListener = events.removeEventListener.bind(events);
        (document as any).activeElement = {};
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; (document as any).activeElement = saved.active; });
        await mount({ contract: stk });
        await act(async () => drawingApi().setTool('horizontal')); // 鍵盤歸此圖
        await act(async () => button(view.root, '點價買').props.onClick());
        const sequence = drawingApi().interactionSequence();
        await act(async () => { events.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), key)); });
        expect(drawingApi().interactionSequence()).toBeGreaterThan(sequence);
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['設定對話框', '彈出工具選單'])('%s的原生 Esc 關閉早於 UI capture，後續空白點擊仍不下單', async (surface) => {
        const events = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener };
        w.addEventListener = events.addEventListener.bind(events);
        w.removeEventListener = events.removeEventListener.bind(events);
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; });
        await mount({ contract: stk });
        let drawing!: NonNullable<ReturnType<typeof addDrawing>>;
        await act(async () => { drawing = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!; });
        let ui!: ReactTestRenderer;
        const onClose = vi.fn(() => ui.unmount());
        await act(async () => {
            ui = create(surface === '設定對話框' ? createElement(DrawingSettingsDialog, { api: drawingApi(), drawing, onClose })
                : createElement(Popover, { anchor: null, label: '工具選單', onClose, onInteraction: drawingApi().onInteraction, children: null }));
        });
        try {
            await act(async () => button(view.root, '點價買').props.onClick());
            await act(async () => { events.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' })); });
            expect(onClose).toHaveBeenCalledOnce();
            await clickChart();
            expect(m.place).not.toHaveBeenCalled();
        } finally { await act(async () => ui.unmount()); }
    });

    it.each(['點價買', '點價賣'])('武裝%s後物件列表選取，同一事件圖表 click 不會呼叫 placeQuickOrder', async (side) => {
        await mount({ contract: stk });
        let id!: string;
        await act(async () => { id = addDrawing('2330', 'horizontal', [{ time: 1, price: 100 }], DEFAULT_DRAWING_STYLE)!.id; });
        await act(async () => drawingApi().setObjectListOpen(true));
        await act(async () => button(view.root, side).props.onClick());
        const row = view.root.findByType(ChartObjectList).findByProps({ role: 'option' });
        await act(async () => {
            row.props.onClick({ shiftKey: false });
            m.click.at(-1)!({ point: { x: 10, y: 10 } });
        });
        expect(drawingApi().selected?.id).toBe(id);
        expect(m.place).not.toHaveBeenCalled();
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
    });

    it.each(['點價買', '點價賣'])('武裝%s時若畫圖仍忙碌，即使入口漏解除交易，click 防線也擋住快速下單', async (side) => {
        await mount({ contract: stk });
        await act(async () => button(view.root, side).props.onClick());
        m.drawingBusy = true;
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        m.drawingBusy = false;
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1); // 確認測試確實走到可下單路徑
    });

    it('replaces the 量 input and 零股 toggle with one chip that shows only quantity and unit', async () => {
        await mount({ contract: stk });
        expect(text(chip())).toBe('1 張');
        expect(view.root.findAll(n => n.type === 'button' && text(n) === '零股')).toHaveLength(0);
        expect(view.root.findAll(n => n.type === 'input' && String(n.props['aria-label']).startsWith('圖表下單數量'))).toHaveLength(0);
        expect(String(chip().props.title)).toContain('點價買／賣以 ROD 限價送出 1 張');
    });

    it('stock odd lot: hides the ROD/IOC/FOK row, summarises, and 點價買 sends IntradayOdd shares with the chosen account', async () => {
        const onOrderSettingsChange = vi.fn();
        let state: any = {};
        onOrderSettingsChange.mockImplementation(v => { state = v; });
        await mount({ contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange });
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(text(pop()!)).toContain('委託'); // round lot: ROD / IOC / FOK shown
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        const select = pop()!.findAll(n => n.type === 'select')[0]!;
        await act(async () => { select.props.onChange({ target: { value: 'S:B:2222207' } }); });
        await act(async () => view.update(createElement(CandleChart, { contract: stk, panelId: 'c1', orderSettings: state, onOrderSettingsChange } as any)));
        expect(state).toEqual({ S: { qty: 500, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:2222207' } });
        const t = text(pop()!);
        expect(t).not.toContain('IOC');
        expect(t).not.toContain('當沖');
        expect(t).not.toContain('開平倉');
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toMatch(/^點價買／賣以 ROD 限價送出 500 股盤中零股，帳號 .*2207；停損停利觸發後以漲跌停價送零股限價 ROD/);
        expect(text(chip())).toBe('500 股');
        await act(async () => { button(pop()!, '完成').props.onClick(); });
        expect(pop()).toBeUndefined();

        await act(async () => { button(view.root, '點價買').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價買進 500 股');
        await clickChart();
        expect(m.place).toHaveBeenCalledTimes(1);
        const [, action, price, qty, opts] = m.place.mock.calls[0]!;
        expect([action, price, qty]).toEqual(['Buy', 100, 500]);
        expect(opts).toMatchObject({ orderLot: 'IntradayOdd', account: S2 });
        expect(opts.orderType).toBeUndefined();

        // a stop from the same settings: odd-lot trigger pinned to the chosen account
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).toHaveBeenCalledTimes(1);
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 500, kind: 'stop', orderLot: 'IntradayOdd' });
        expect(m.addTrigger.mock.calls[0]![2]).toEqual({ account: S2 });
    });

    it('round lot IOC following the main account: the order uses IOC and no odd lot', async () => {
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, 'IOC').props.onClick(); });
        await act(async () => { button(pop()!, '5').props.onClick(); });
        expect(text(chip())).toBe('5 張');
        await act(async () => { button(view.root, '點價賣').props.onClick(); });
        expect(text(view.root)).toContain('點擊價位 → 限價賣出 IOC 5 張');
        await clickChart();
        const [, action, , qty, opts] = m.place.mock.calls[0]!;
        expect([action, qty]).toEqual(['Sell', 5]);
        expect(opts).toMatchObject({ orderType: 'IOC', account: S1 });
        expect(opts.orderLot).toBeUndefined();
        // following the main selection: triggers use the default account path
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![2]).toBeUndefined();
    });

    it('futures: unit fixed at 口, no 單位 row, 類別 自動／新倉／平倉 flows into orders and stops', async () => {
        await mount({ contract: fut });
        expect(text(chip())).toBe('1 口');
        await act(async () => { chip().props.onClick(); });
        const t = text(pop()!);
        expect(t).not.toContain('整股');
        expect(t).toContain('自動');
        await act(async () => { button(pop()!, '平倉').props.onClick(); });
        await act(async () => { button(pop()!, '2').props.onClick(); });
        expect(text(view.root.findAll(n => n.props['data-testid'] === 'order-settings-summary')[0]!)).toContain('2 口（平倉）');
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place.mock.calls[0]![4]).toMatchObject({ ocType: 'Cover', account: F1 });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ quantity: 2, octype: 'Cover' });
        expect(m.addTrigger.mock.calls[0]![0].orderLot).toBeUndefined();
    });

    it('Esc closes the popover; a pinned account that disappeared blocks the order', async () => {
        const target = new EventTarget();
        const w = window as any;
        const saved = { add: w.addEventListener, remove: w.removeEventListener, dispatch: w.dispatchEvent };
        w.addEventListener = vi.fn((...a: Parameters<EventTarget['addEventListener']>) => target.addEventListener(...a));
        w.removeEventListener = target.removeEventListener.bind(target);
        w.dispatchEvent = target.dispatchEvent.bind(target);
        onTestFinished(() => { w.addEventListener = saved.add; w.removeEventListener = saved.remove; w.dispatchEvent = saved.dispatch; });
        await mount({ contract: stk, orderSettings: { S: { qty: 1, lot: 'Common', orderType: 'ROD', octype: 'Auto', accountKey: 'S:B:gone' } }, onOrderSettingsChange: vi.fn() });
        // closed: no key listener is installed (chart hotkeys untouched)
        const spy = w.addEventListener as ReturnType<typeof vi.fn>;
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(false);
        await act(async () => { chip().props.onClick(); });
        expect(pop()).toBeDefined();
        expect(spy.mock.calls.some(c => c[0] === 'keydown')).toBe(true);
        await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
        expect(pop()).toBeUndefined();
        await act(async () => { button(view.root, '點價買').props.onClick(); });
        await clickChart();
        expect(m.place).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('固定帳號已不可用') });
    });

    it('odd-lot stop/take pick their side from the odd-lot price, not the round-lot one', async () => {
        // round-lot last 105 and odd-lot last 95 straddle the click at 100
        m.roundClose = 105; m.oddClose = 95;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        // 100 is ABOVE the odd-lot price → a buy stop on a rise (round-lot would say below/sell)
        expect(m.addTrigger.mock.calls[0]![0]).toMatchObject({ condition: 'above', action: 'Buy', orderLot: 'IntradayOdd', quantity: 300 });
        await act(async () => { button(view.root, '停利').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[1]![0]).toMatchObject({ condition: 'above', action: 'Sell', kind: 'take' });
        // alerts keep the round-lot price
        await act(async () => { button(view.root, '警示').props.onClick(); });
        await clickChart();
        expect(m.addTrigger.mock.calls[2]![0]).toMatchObject({ condition: 'below', kind: 'alert' });
    });

    it('odd-lot stop without any odd-lot trade yet is refused with 等待零股行情', async () => {
        m.oddClose = null;
        await mount({ contract: stk, orderSettings: { S: { qty: 300, lot: 'IntradayOdd', orderType: 'ROD', octype: 'Auto' } }, onOrderSettingsChange: vi.fn() });
        await act(async () => { button(view.root, '停損').props.onClick(); });
        await clickChart();
        expect(m.addTrigger).not.toHaveBeenCalled();
        expect(m.notify.mock.calls.at(-1)![0]).toMatchObject({ kind: 'err', body: expect.stringContaining('等待零股行情') });
    });

    it('another chart saving 設為預設 does not change an existing chart that never customised its settings', async () => {
        const nodeMock = { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }) };
        let other!: ReactTestRenderer;
        // a workspace chart (controlled, nothing saved yet for its market)
        const otherProps = { contract: stk, panelId: 'b', orderSettings: undefined, onOrderSettingsChange: vi.fn() };
        await act(async () => { other = create(createElement(CandleChart, otherProps as any), nodeMock); });
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => { button(pop()!, '設為預設').props.onClick(); });
        expect(JSON.parse((globalThis as any).localStorage.getItem('sj-pro-chart-order-defaults')).S).toMatchObject({ qty: 500, lot: 'IntradayOdd' });
        const otherChip = () => other.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
        // the other chart re-renders (new quote / props) and keeps 1 張
        await act(async () => { other.update(createElement(CandleChart, { ...otherProps, contract: { ...stk } } as any)); });
        await flush();
        expect(text(otherChip())).toBe('1 張');
        // a chart opened afterwards starts from the new default
        let fresh!: ReactTestRenderer;
        await act(async () => { fresh = create(createElement(CandleChart, { contract: stk } as any), nodeMock); });
        expect(text(fresh.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!)).toBe('500 股');
        await act(async () => { other.unmount(); fresh.unmount(); });
    });

    it('a futures chart that later switches to a stock keeps the stock default it had when it was created', async () => {
        const nodeMock = { createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }) };
        const futProps = { contract: fut, panelId: 'f', orderSettings: undefined, onOrderSettingsChange: vi.fn() };
        let futChart!: ReactTestRenderer;
        await act(async () => { futChart = create(createElement(CandleChart, futProps as any), nodeMock); });
        // another chart saves 500 股 odd lot as the stock default
        await mount({ contract: stk });
        await act(async () => { chip().props.onClick(); });
        await act(async () => { button(pop()!, '盤中零股（股）').props.onClick(); });
        await act(async () => { button(pop()!, '500').props.onClick(); });
        await act(async () => { button(pop()!, '設為預設').props.onClick(); });
        // the futures chart moves to a stock: 1 張, not 500 股
        await act(async () => { futChart.update(createElement(CandleChart, { ...futProps, contract: stk } as any)); });
        await flush();
        const futChip = futChart.root.findAll(n => n.type === 'button' && String(n.props['aria-label'] ?? '').startsWith('圖表下單設定'))[0]!;
        expect(text(futChip)).toBe('1 張');
        await act(async () => futChart.unmount());
    });
});
