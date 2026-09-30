import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartHasFocus,
    orderLineMayTakePointer,
    useChartDrawings,
    type ChartDrawingsApi,
} from './use-chart-drawings';
import {
    __resetDrawingsForTest,
    addDrawing,
    DEFAULT_DRAWING_STYLE,
    getDrawingSettings,
    TOOL_DEFAULT_COLORS,
} from '../lib/chart-drawings';
import type { ContractBase } from '../lib/types/contract';
import { useHotkeys } from './use-hotkeys';

// Esc×2 全部刪單的整合測試：開啟風控設定、攔下刪單
const hk = vi.hoisted(() => ({ cancelAll: vi.fn(async () => {}), notify: vi.fn() }));
vi.mock('../lib/trade', () => ({ cancelAllOrders: hk.cancelAll, notify: hk.notify }));
vi.mock('../lib/risk', () => ({ getRiskSettings: () => ({ escCancelAll: true }) }));

// 圖表相關的 ref 一律給 null：本檔只驗模式互斥與對外操作，不碰 canvas。
// hook 的滑鼠 effect 在 hostRef 為 null 時直接跳出，鍵盤 effect 需要
// window，所以補一個最小的替身。
const store = new Map<string, string>();
const roots: ReactTestRenderer[] = [];

const contract = { code: 'TXFR1', security_type: 'FUT' } as ContractBase;

function Probe({
    receive,
    tradeArmed,
    onEnterDrawingMode,
    host,
}: {
    receive: (v: ChartDrawingsApi) => void;
    tradeArmed: boolean;
    onEnterDrawingMode: () => void;
    host?: unknown;
}) {
    const hostRef = createRef<HTMLDivElement>();
    (hostRef as { current: unknown }).current = host ?? null;
    receive(
        useChartDrawings({
            contract,
            hostRef,
            chartRef: createRef(),
            seriesRef: createRef(),
            getTimes: () => [],
            tradeArmed,
            onEnterDrawingMode,
        }),
    );
    return null;
}

async function mount(props: Parameters<typeof Probe>[0]) {
    let root!: ReactTestRenderer;
    await act(async () => {
        root = create(createElement(Probe, props));
    });
    roots.push(root);
    return root;
}

beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    __resetDrawingsForTest();
});

afterEach(async () => {
    await act(async () => {
        for (const root of roots.splice(0)) root.unmount();
    });
    vi.unstubAllGlobals();
});

describe('交易模式與畫圖模式一次只有一種', () => {
    it('選畫圖工具會請頂端解除交易模式', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode });
        await act(async () => api.setTool('trend'));
        expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
        expect(api.tool).toBe('trend');
    });

    it('按「游標」同樣解除交易模式 — 那是從交易模式脫身的方式之一', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode });
        await act(async () => api.setTool(null));
        expect(onEnterDrawingMode).toHaveBeenCalledTimes(1);
        expect(api.tool).toBeNull();
    });

    it('頂端武裝交易模式時，已選的畫圖工具自動收起', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        const root = await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode,
        });
        await act(async () => api.setTool('box'));
        expect(api.tool).toBe('box');
        await act(async () => {
            root.update(
                createElement(Probe, {
                    receive: (v: ChartDrawingsApi) => (api = v),
                    tradeArmed: true,
                    onEnterDrawingMode,
                }),
            );
        });
        expect(api.tool).toBeNull();
    });

    it('交易模式收起畫圖工具時不會反過來再解除交易模式（避免互踢）', async () => {
        const onEnterDrawingMode = vi.fn();
        let api!: ChartDrawingsApi;
        const root = await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode,
        });
        await act(async () => api.setTool('ray'));
        onEnterDrawingMode.mockClear();
        await act(async () => {
            root.update(
                createElement(Probe, {
                    receive: (v: ChartDrawingsApi) => (api = v),
                    tradeArmed: true,
                    onEnterDrawingMode,
                }),
            );
        });
        expect(api.tool).toBeNull();
        expect(onEnterDrawingMode).not.toHaveBeenCalled();
    });
});

describe('鎖定只擋移動，不擋選取與編輯', () => {
    async function mountWithLocked() {
        let api!: ChartDrawingsApi;
        await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode: vi.fn(),
        });
        const created = addDrawing(
            api.symbolKey,
            'trend',
            [
                { time: 1000, price: 25000 },
                { time: 2000, price: 25100 },
            ],
            DEFAULT_DRAWING_STYLE,
        )!;
        await act(async () => api.select(created.id));
        await act(async () => api.toggleLock());
        return { api: () => api, id: created.id };
    }

    it('鎖定後仍選得到，且能解鎖 — 不會永遠黏在圖上', async () => {
        const { api, id } = await mountWithLocked();
        expect(api().selected?.locked).toBe(true);
        await act(async () => api().toggleLock());
        expect(api().selected?.id).toBe(id);
        expect(api().selected?.locked).toBe(false);
    });

    it('鎖定中仍可改樣式 — 鎖的是位置，不是顏色', async () => {
        const { api } = await mountWithLocked();
        await act(async () => api().applyStyle({ color: '#ef5350', width: 4 }));
        expect(api().selected?.locked).toBe(true);
        expect(api().selected?.style.color).toBe('#ef5350');
        expect(api().selected?.style.width).toBe(4);
    });

    it('鎖定中不可刪除也不可改價，解鎖後才可以', async () => {
        const { api, id } = await mountWithLocked();
        await act(async () => api().setSelectedPrice(24000));
        await act(async () => api().remove());
        expect(api().drawings.map((d) => d.id)).toEqual([id]);
        expect(api().selected?.anchors[0]!.price).toBe(25000);

        await act(async () => api().toggleLock());
        await act(async () => api().remove());
        expect(api().drawings).toEqual([]);
    });

    it('隱藏的物件不影響鎖定語意，兩者各自獨立', async () => {
        const { api } = await mountWithLocked();
        await act(async () => api().toggleHidden());
        expect(api().selected?.hidden).toBe(true);
        expect(api().selected?.locked).toBe(true);
    });
});

describe('商品鍵隨設定切換', () => {
    it('預設期貨收斂到根代碼，關閉共用後改用完整合約代碼', async () => {
        let api!: ChartDrawingsApi;
        await mount({
            receive: (v) => (api = v),
            tradeArmed: false,
            onEnterDrawingMode: vi.fn(),
        });
        expect(api.symbolKey).toBe('TXF');
        await act(async () => api.setShareContinuousMonth(false));
        expect(api.symbolKey).toBe('TXFR1');
    });
});

describe('鍵盤只歸一張圖，且不擋 Esc×2 全部刪單', () => {
    // 這組需要真的派送 keydown：把 window 換成記錄 listener 的替身
    // capture listener 先於 bubble listener — 與瀏覽器派送 window 事件的順序一致
    const keyListeners = new Map<(e: KeyboardEvent) => void, boolean>();
    beforeEach(() => {
        keyListeners.clear();
        hk.cancelAll.mockClear();
        hk.notify.mockClear();
        vi.stubGlobal('window', {
            addEventListener: (type: string, l: (e: KeyboardEvent) => void, capture?: boolean) => {
                if (type === 'keydown') keyListeners.set(l, !!capture);
            },
            removeEventListener: (type: string, l: (e: KeyboardEvent) => void) => {
                if (type === 'keydown') keyListeners.delete(l);
            },
        });
        vi.stubGlobal('performance', { now: () => 1000 });
        vi.stubGlobal('document', { activeElement: null });
    });

    function press(key: string) {
        const e = {
            key,
            target: null,
            repeat: false,
            metaKey: false,
            ctrlKey: false,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };
        const all = [...keyListeners];
        for (const [l, capture] of all) if (capture) l(e as unknown as KeyboardEvent);
        for (const [l, capture] of all) if (!capture) l(e as unknown as KeyboardEvent);
        return e;
    }

    // 圖表 host 的替身：scope（host 的父元素＝圖表列）含有哪些「元素」
    function fakeHost() {
        const inside = { tagName: 'DIV' };
        const scope = { contains: (n: unknown) => n === inside || n === host };
        const host: Record<string, unknown> = {
            parentElement: scope,
            style: { cursor: '' },
            addEventListener() {},
            removeEventListener() {},
        };
        return { host, inside };
    }
    function focus(el: unknown) {
        vi.stubGlobal('document', { activeElement: el });
    }

    function HotkeysProbe() {
        useHotkeys({ onOpenPalette: () => {}, onAfterCancelAll: () => {} });
        return null;
    }

    const line = (price: number) =>
        addDrawing('TXF', 'horizontal', [{ time: 1000, price }], DEFAULT_DRAWING_STYLE)!;

    async function mountChart() {
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode: vi.fn() });
        return () => api;
    }

    it('沒有選取也沒有工具時不聽鍵盤', async () => {
        await mountChart();
        expect(keyListeners.size).toBe(0);
    });

    it('選取中按 Esc 取消選取並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
        const api = await mountChart();
        const d = line(25000);
        await act(async () => api().select(d.id));
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Escape');
        });
        expect(api().selected).toBeNull();
        expect(e.defaultPrevented).toBe(true);
    });

    it('武裝畫圖工具時按 Esc 退出工具並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
        const api = await mountChart();
        await act(async () => api().setTool('trend'));
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Escape');
        });
        expect(api().tool).toBeNull();
        expect(e.defaultPrevented).toBe(true);
    });

    it('開啟 Esc×2 全部刪單時：畫圖中連按兩下 Esc 不會撤掉委託', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        const api = await mountChart();
        await act(async () => api().setTool('ray'));
        await act(async () => {
            press('Escape'); // 退出畫圖（被吃掉）
        });
        await act(async () => {
            press('Escape'); // 0.6 秒內第二下 — 只當成全刪單的第一下
        });
        expect(api().tool).toBeNull();
        expect(hk.cancelAll).not.toHaveBeenCalled();
        // 沒有畫圖狀態時，Esc×2 照常作用（快捷鍵本身沒被弄壞）
        await act(async () => {
            press('Escape');
        });
        expect(hk.cancelAll).toHaveBeenCalledTimes(1);
    });

    it('Esc（武裝全刪單）→ 畫圖 UI 用掉的 Esc → Esc：第三下不會跟第一下湊成 Esc×2', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        const api = await mountChart();
        const d = line(25000);
        await act(async () => {
            press('Escape'); // 什麼都沒選：算第一下（武裝）
        });
        expect(hk.notify).toHaveBeenCalledTimes(1);
        await act(async () => api().select(d.id));
        await act(async () => {
            press('Escape'); // 取消選取：被畫圖吃掉，並清掉第一下
        });
        await act(async () => {
            press('Escape'); // 0.6 秒內 — 只能算新的第一下
        });
        expect(hk.cancelAll).not.toHaveBeenCalled();
        expect(hk.notify).toHaveBeenCalledTimes(2);
    });

    it('兩張圖：後選取的那張接手鍵盤，Delete 只刪它的物件，前一張放掉選取', async () => {
        const ha = fakeHost();
        const hb = fakeHost();
        let a!: ChartDrawingsApi;
        let b!: ChartDrawingsApi;
        await mount({ receive: (v) => (a = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: ha.host });
        await mount({ receive: (v) => (b = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: hb.host });
        const la = line(25000);
        const lb = line(25100);
        await act(async () => a.select(la.id));
        await act(async () => b.select(lb.id));
        expect(a.selected).toBeNull();
        expect(b.selected?.id).toBe(lb.id);
        focus(hb.inside);
        await act(async () => {
            press('Delete');
        });
        expect(b.drawings.map((d) => d.id)).toEqual([la.id]);
    });

    it('焦點已移到別的面板（按鈕）時，Delete 不刪圖上選取的物件', async () => {
        const h = fakeHost();
        let api!: ChartDrawingsApi;
        await mount({ receive: (v) => (api = v), tradeArmed: false, onEnterDrawingMode: vi.fn(), host: h.host });
        const d = line(25000);
        await act(async () => api.select(d.id));
        focus({ tagName: 'BUTTON' }); // 別的面板的按鈕
        let e!: ReturnType<typeof press>;
        await act(async () => {
            e = press('Delete');
        });
        expect(api.drawings.map((x) => x.id)).toEqual([d.id]);
        expect(e.defaultPrevented).toBe(false);
        // 焦點回到圖上才刪
        focus(h.inside);
        await act(async () => {
            press('Backspace');
        });
        expect(api.drawings).toEqual([]);
    });

    it('chartHasFocus：沒有 scope 或焦點在外面都算沒有焦點', () => {
        const h = fakeHost();
        focus(h.inside);
        expect(chartHasFocus(h.host.parentElement as never)).toBe(true);
        expect(chartHasFocus(null)).toBe(false);
        focus(null);
        expect(chartHasFocus(h.host.parentElement as never)).toBe(false);
    });

    it('武裝點價買賣時清掉畫圖選取 — Delete 不會刪到剛才選著的物件', async () => {
        const h = fakeHost();
        let api!: ChartDrawingsApi;
        const props = { receive: (v: ChartDrawingsApi) => (api = v), onEnterDrawingMode: vi.fn(), host: h.host };
        const root = await mount({ ...props, tradeArmed: false });
        const d = line(25000);
        await act(async () => api.select(d.id));
        expect(api.selected?.id).toBe(d.id);
        await act(async () => root.update(createElement(Probe, { ...props, tradeArmed: true })));
        expect(api.selected).toBeNull();
        focus(h.inside);
        await act(async () => {
            press('Delete');
        });
        expect(api.drawings.map((x) => x.id)).toEqual([d.id]);
    });
});

describe('滑鼠：交易模式與委託線優先於畫圖物件', () => {
    // 最小的圖表替身：y = 25200 - price，時間軸每根 10px
    type L = (e: MouseEvent) => void;
    const hostListeners = new Map<string, L>();
    let axisCalls = 0;
    let attachedLayer: { state: { draft: unknown } } | null = null;
    const host = {
        style: { cursor: '' },
        dataset: {},
        addEventListener: (t: string, l: L) => hostListeners.set(t, l),
        removeEventListener: (t: string) => hostListeners.delete(t),
    };
    const series = {
        priceToCoordinate: (p: number) => 25200 - p,
        coordinateToPrice: (y: number) => 25200 - y,
        priceFormatter: () => ({ format: String }),
        attachPrimitive(layer: {
            attached: (p: unknown) => void;
            noteCanvas: (c: unknown, s: unknown) => void;
            state: { draft: unknown };
        }) {
            attachedLayer = layer;
            layer.attached({
                series,
                chart: {
                    timeScale: () => ({
                        logicalToCoordinate: (l: number) => (axisCalls++, l * 10),
                    }),
                },
                requestUpdate() {},
            });
            layer.noteCanvas(
                { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) },
                { width: 800, height: 400 },
            );
        },
        detachPrimitive() {},
    };

    function DrawProbe({
        tradeArmed,
        receive,
        code = 'TXFR1',
        themeMode = 'dark',
    }: {
        tradeArmed: boolean;
        receive: (v: ChartDrawingsApi) => void;
        code?: string;
        themeMode?: 'dark' | 'light';
    }) {
        receive(
            useChartDrawings({
                contract: { code, security_type: code === '2330' ? 'STK' : 'FUT' } as ContractBase,
                themeMode,
                hostRef: { current: host as unknown as HTMLDivElement },
                chartRef: { current: { applyOptions() {} } as never },
                seriesRef: { current: series as never },
                getTimes: () => [1000, 1060, 1120, 1180],
                tradeArmed,
                onEnterDrawingMode: vi.fn(),
            }),
        );
        return null;
    }

    beforeEach(() => {
        hostListeners.clear();
        vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
    });

    // 在水平線（25000 → y=200）上按下
    function pressOnLine(prevented = false, x = 20, y = 200) {
        const e = {
            button: 0,
            clientX: x,
            clientY: y,
            defaultPrevented: prevented,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
        };
        hostListeners.get('mousedown')!(e as unknown as MouseEvent);
        return e;
    }

    async function setup(tradeArmed: boolean, withLine = true, themeMode: 'dark' | 'light' = 'dark') {
        let api!: ChartDrawingsApi;
        let root!: ReactTestRenderer;
        await act(async () => {
            root = create(
                createElement(DrawProbe, { tradeArmed, themeMode, receive: (v) => (api = v) }),
            );
        });
        roots.push(root);
        if (withLine) {
            addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        }
        await act(async () => {});
        return Object.assign(() => api, { root });
    }

    it('委託線只在瀏覽模式接手滑鼠 — 武裝畫圖工具時不接手，不會誤改委託價', () => {
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false })).toBe(true);
        expect(orderLineMayTakePointer({ drawingArmed: true, defaultPrevented: false })).toBe(false);
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: true })).toBe(false);
    });

    it('武裝趨勢線時在委託線附近按下：這一下由畫圖接手（開始繪製），不是改價', async () => {
        const api = await setup(false, false);
        await act(async () => api().setTool('trend'));
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine(false, 40, 200);
        });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(attachedLayer?.state.draft).not.toBeNull();
    });

    it('換商品時立刻清掉畫到一半的草稿（不等下一次重繪）', async () => {
        const api = await setup(false, false);
        await act(async () => api().setTool('trend'));
        await act(async () => {
            pressOnLine(false, 40, 200);
        });
        expect(attachedLayer?.state.draft).not.toBeNull();
        await act(async () =>
            api.root.update(
                createElement(DrawProbe, {
                    tradeArmed: false,
                    code: '2330',
                    receive: () => {},
                }),
            ),
        );
        expect(attachedLayer?.state.draft).toBeNull();
    });

    it('沒有任何畫圖物件時，hover 不建 projector、不做任何投影', async () => {
        await setup(false, false);
        axisCalls = 0;
        hostListeners.get('mousemove')!({ clientX: 50, clientY: 50 } as MouseEvent);
        expect(axisCalls).toBe(0);
    });

    it('新物件的預設色依工具與主題；使用者挑過的顏色只覆蓋那種工具', async () => {
        const dark = await setup(false, false, 'dark');
        await act(async () => dark().setTool('horizontal'));
        await act(async () => {
            pressOnLine(false, 40, 150);
        });
        expect(dark().selected?.style.color).toBe(TOOL_DEFAULT_COLORS.dark.horizontal);
        // 選著水平線改色 → 只記住水平線的顏色
        await act(async () => dark().applyStyle({ color: '#26a69a' }));
        expect(getDrawingSettings().toolColors).toEqual({ horizontal: '#26a69a' });
        await act(async () => dark().setTool('box'));
        expect(dark().style.color).toBe(TOOL_DEFAULT_COLORS.dark.box);
        await act(async () => dark().setTool('horizontal'));
        expect(dark().style.color).toBe('#26a69a');
    });

    it('淺色主題用較深的預設色', async () => {
        const light = await setup(false, false, 'light');
        await act(async () => light().setTool('trend'));
        expect(light().style.color).toBe(TOOL_DEFAULT_COLORS.light.trend);
        expect(TOOL_DEFAULT_COLORS.light.trend).not.toBe(TOOL_DEFAULT_COLORS.dark.trend);
    });

    it('委託線與畫圖物件重疊：選取中的物件絕不讓；有畫圖時只能從右側把手區拖委託線', () => {
        const base = { drawingArmed: false, defaultPrevented: false };
        expect(orderLineMayTakePointer({ ...base })).toBe(true);
        expect(orderLineMayTakePointer({ ...base, drawingArmed: true, inGrip: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'selected', inGrip: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'other' })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingHit: 'other', inGrip: true })).toBe(true);
        expect(orderLineMayTakePointer({ ...base, drawingBusy: true })).toBe(false);
        expect(orderLineMayTakePointer({ ...base, drawingBusy: true, inGrip: true })).toBe(true);
    });

    it('drawingAt：游標下的畫圖物件是選取中的還是其他的', async () => {
        const api = await setup(false);
        expect(api().drawingAt({ clientX: 20, clientY: 200 })).toBe('other');
        expect(api().drawingAt({ clientX: 20, clientY: 350 })).toBeNull();
        expect(api().drawingBusy()).toBe(false);
        await act(async () => {
            pressOnLine();
        });
        expect(api().drawingAt({ clientX: 20, clientY: 200 })).toBe('selected');
        expect(api().drawingBusy()).toBe(true);
    });

    it('沒武裝交易時，按在畫圖物件上會選取並接手這一下', async () => {
        const api = await setup(false);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine();
        });
        expect(e.preventDefault).toHaveBeenCalled();
        expect(api().selected?.tool).toBe('horizontal');
    });

    it('武裝點價買賣時，按在畫圖物件上不攔截 — 這一下要變成下單', async () => {
        const api = await setup(true);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine();
        });
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(e.stopPropagation).not.toHaveBeenCalled();
        expect(api().selected).toBeNull();
    });

    it('委託線已接手的一下（defaultPrevented），畫圖物件不跟著拖', async () => {
        const api = await setup(false);
        let e!: ReturnType<typeof pressOnLine>;
        await act(async () => {
            e = pressOnLine(true);
        });
        expect(e.stopPropagation).not.toHaveBeenCalled();
        expect(api().selected).toBeNull();
    });
});
