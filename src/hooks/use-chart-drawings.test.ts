import { createElement, createRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    chartHasFocus,
    orderLineMayTakePointer,
    toolShortcutOf,
    undoKeyOf,
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
import { resetEscCancelArm } from '../lib/esc-cancel-arm';

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
        resetEscCancelArm(); // 前一個測試留下的「第一下」不能帶過來
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

    it('選取中按 Esc 取消選取（關閉浮動工具列）並吃掉這一下 — 不算進 Esc×2 全刪單', async () => {
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

    it('Esc（武裝）→ 焦點在樣式面板勾選框上的 Esc → 點外面 → Esc：不會全部刪單', async () => {
        await act(async () => {
            roots.push(create(createElement(HotkeysProbe)));
        });
        await act(async () => {
            press('Escape'); // 第一下：武裝
        });
        expect(hk.notify).toHaveBeenCalledTimes(1);
        vi.stubGlobal('document', { activeElement: { tagName: 'INPUT' } }); // 勾選框
        await act(async () => {
            press('Escape'); // 控制項上的 Esc：清掉等待中的第一下
        });
        vi.stubGlobal('document', { activeElement: null }); // 點外面，焦點離開
        await act(async () => {
            press('Escape'); // 0.6 秒內，但只能算新的第一下
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

describe('第一期：多選、平行通道、量測、文字、復原、快捷鍵', () => {
    type L = (e: unknown) => void;
    const hostL = new Map<string, L>();
    const docL = new Map<string, L>();
    const keyL = new Set<L>();
    const inside = { tagName: 'CANVAS' };
    const scope = { contains: (n: unknown) => n === inside };
    const host = {
        style: { cursor: '' },
        dataset: {},
        parentElement: scope,
        addEventListener: (t: string, l: L) => hostL.set(t, l),
        removeEventListener: (t: string) => hostL.delete(t),
    };
    let layer: { state: { draft: unknown; measure: unknown } } | null = null;
    const series = {
        priceToCoordinate: (p: number) => 25200 - p,
        coordinateToPrice: (y: number) => 25200 - y,
        priceFormatter: () => ({ format: String }),
        attachPrimitive(l: {
            attached: (p: unknown) => void;
            noteCanvas: (c: unknown, s: unknown) => void;
            state: { draft: unknown; measure: unknown };
        }) {
            layer = l;
            l.attached({
                series,
                chart: { timeScale: () => ({ logicalToCoordinate: (x: number) => x * 10 }) },
                requestUpdate() {},
            });
            l.noteCanvas(
                { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 400 }) },
                { width: 800, height: 400 },
            );
        },
        detachPrimitive() {},
    };

    // 與真實元件一樣用穩定的 ref（每次 render 換新物件會讓 effect 重掛）
    const refs = {
        host: { current: host as unknown as HTMLDivElement },
        chart: { current: { applyOptions() {} } as never },
        series: { current: series as never },
    };
    const v2Bars = [
        { time: 1000, open: 24990, high: 25010, low: 24980, close: 25005 },
        { time: 1060, open: 25005, high: 25050, low: 25000, close: 25040 },
        { time: 1120, open: 25090, high: 25110, low: 25080, close: 25100 },
        { time: 1180, open: 25100, high: 25130, low: 25090, close: 25120 },
    ];
    function V2Probe({ receive }: { receive: (v: ChartDrawingsApi) => void }) {
        receive(
            useChartDrawings({
                contract,
                hostRef: refs.host,
                chartRef: refs.chart,
                seriesRef: refs.series,
                getTimes: () => [1000, 1060, 1120, 1180],
                tradeArmed: false,
                onEnterDrawingMode: () => {},
                pnlPerPoint: 200,
                getBars: () => v2Bars,
            }),
        );
        return null;
    }

    beforeEach(() => {
        hostL.clear();
        docL.clear();
        keyL.clear();
        vi.stubGlobal('document', {
            activeElement: inside,
            addEventListener: (t: string, l: L) => docL.set(t, l),
            removeEventListener: (t: string) => docL.delete(t),
        });
        vi.stubGlobal('window', {
            addEventListener: (t: string, l: L) => t === 'keydown' && keyL.add(l),
            removeEventListener: (t: string, l: L) => keyL.delete(l),
        });
    });

    async function setup() {
        let api!: ChartDrawingsApi;
        await act(async () => {
            roots.push(create(createElement(V2Probe, { receive: (v) => (api = v) })));
        });
        return () => api;
    }

    const ev = (x: number, y: number, extra: Record<string, unknown> = {}) => ({
        button: 0,
        clientX: x,
        clientY: y,
        shiftKey: false,
        defaultPrevented: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        ...extra,
    });
    const down = async (x: number, y: number, extra: Record<string, unknown> = {}) => {
        const e = ev(x, y, extra);
        await act(async () => hostL.get('mousedown')!(e));
        return e;
    };
    const up = async (x: number, y: number) => {
        await act(async () => docL.get('mouseup')?.(ev(x, y)));
    };
    const key = async (k: Record<string, unknown>) => {
        const e = {
            key: '',
            code: '',
            target: null,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            ...k,
        };
        await act(async () => {
            for (const l of [...keyL]) l(e);
        });
        return e;
    };

    it('平行通道點三下：基準線兩點＋決定寬度的第三點', async () => {
        const api = await setup();
        await act(async () => api().setTool('channel'));
        await down(100, 200);
        await down(300, 100);
        expect(api().drawings).toHaveLength(0); // 還在等第三點
        await down(200, 250);
        expect(api().drawings).toHaveLength(1);
        expect(api().drawings[0]!.tool).toBe('channel');
        expect(api().drawings[0]!.anchors).toHaveLength(3);
        expect(api().tool).toBeNull();
    });

    it('Shift 點選多選，一起拖曳、一起刪除', async () => {
        const api = await setup();
        const a = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24900 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(50, 200); // a（y=200）
        await up(50, 200);
        await down(50, 300, { shiftKey: true }); // b（y=300）
        expect(api().selectedIds).toEqual([a.id, b.id]);
        await up(50, 280); // 往上拖 20px
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25020, 24920]);
        const e = await key({ key: 'Delete' });
        expect(e.defaultPrevented).toBe(true);
        expect(api().drawings).toEqual([]);
    });

    it('復原／重做：Ctrl+Z、Ctrl+Shift+Z、Ctrl+Y；焦點不在圖上時不作用', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 150);
        expect(api().drawings).toHaveLength(1);
        expect(api().canUndo).toBe(true);
        let e = await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(api().drawings).toHaveLength(0);
        await key({ key: 'Z', code: 'KeyZ', metaKey: true, shiftKey: true });
        expect(api().drawings).toHaveLength(1);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        await key({ key: 'y', code: 'KeyY', ctrlKey: true });
        expect(api().drawings).toHaveLength(1);
        // 焦點在別的面板
        vi.stubGlobal('document', { activeElement: { tagName: 'BUTTON' }, addEventListener() {}, removeEventListener() {} });
        e = await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(e.defaultPrevented).toBe(false);
        expect(api().drawings).toHaveLength(1);
    });

    it('拖曳結束算一步，可復原回原位', async () => {
        const api = await setup();
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        await act(async () => {});
        await down(50, 200);
        await up(50, 150);
        expect(api().drawings[0]!.anchors[0]!.price).toBe(25050);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.anchors[0]!.price).toBe(25000);
    });

    it('Alt＋字母切換工具（依 code，不看 Option 產生的符號）', async () => {
        const api = await setup();
        await down(700, 50); // 點圖：握有鍵盤
        const e = await key({ key: '†', code: 'KeyT', altKey: true });
        expect(e.defaultPrevented).toBe(true);
        expect(api().tool).toBe('trend');
        await key({ key: '˙', code: 'KeyH', altKey: true });
        expect(api().tool).toBe('horizontal');
        expect(toolShortcutOf({ code: 'KeyF', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false })).toBe('fib');
        expect(undoKeyOf({ key: 'z', code: 'KeyZ', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false })).toBeNull();
    });

    it('價差量測：點兩下量完、Esc 清除且吃掉這一下（不算進 Esc×2）', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        expect(api().measuring).toBe(true);
        expect(api().tool).toBeNull();
        const m = layer!.state.measure as { label: string; stats: { points: number; bars: number; pnl: number } };
        expect(m.stats.points).toBe(120);
        expect(m.stats.bars).toBe(2);
        expect(m.stats.pnl).toBe(24000);
        expect(m.label).toContain('+120 點');
        expect(api().drawings).toEqual([]); // 量測不存檔
        const e = await key({ key: 'Escape' });
        expect(e.defaultPrevented).toBe(true);
        expect(api().measuring).toBe(false);
    });

    it('量完後點一下圖表就清除量測，這一下不做別的事', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        const e = await down(300, 300);
        expect(e.preventDefault).toHaveBeenCalled();
        expect(api().measuring).toBe(false);
    });

    it('文字註記：放下後開輸入框，確定才存；空白取消整筆不留、也不進復原', async () => {
        const api = await setup();
        await act(async () => api().setTool('text'));
        await down(100, 100);
        const id = api().editingTextId!;
        expect(id).toBeTruthy();
        await act(async () => api().commitText('月線支撐'));
        expect(api().drawings.find((d) => d.id === id)?.text).toBe('月線支撐');
        expect(api().canUndo).toBe(true);

        await act(async () => api().setTool('text'));
        await down(200, 100);
        expect(api().drawings).toHaveLength(2);
        await act(async () => api().commitText(null));
        expect(api().drawings).toHaveLength(1);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings).toHaveLength(0); // 復原的是第一筆文字
    });

    it('斐波那契設定：改選項會驗證、連續拉色帶合併成一步復原', async () => {
        const api = await setup();
        const f = addDrawing('TXF', 'fib', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(700, 350); // 取得鍵盤
        await act(async () => api().setFib(f.id, { labelH: 'right', fontSize: 99 }));
        expect(api().drawings[0]!.fib).toMatchObject({ labelH: 'right', fontSize: 16 });
        for (const o of [0.1, 0.2, 0.3]) await act(async () => api().setFib(f.id, { bandOpacity: o }));
        expect(api().drawings[0]!.fib!.bandOpacity).toBe(0.3);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.fib!.bandOpacity).toBe(0.12); // 三次拉動算一步
        expect(api().drawings[0]!.fib!.labelH).toBe('right');
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.fib!.labelH).toBe('left');
    });

    it('磁吸只作用在被拖的那一點，其他控制點維持原本的時間與價格', async () => {
        const api = await setup();
        const t = addDrawing('TXF', 'trend', [{ time: 1000, price: 25000 }, { time: 1180, price: 25100 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => api().setMagnet(true));
        await down(30, 100); // 第二點（x=30, y=100）
        await up(20, 95); // 拖到第三根 K 棒附近
        const d = api().drawings.find((x) => x.id === t.id)!;
        expect(d.anchors[0]).toEqual({ time: 1000, price: 25000 }); // 沒被吸走
        expect(d.anchors[1]!.time).toBe(1120);
        expect([25090, 25110, 25080, 25100]).toContain(d.anchors[1]!.price);
    });

    it('拖曳期間別的視窗的改動，復原拖曳時不會一起被復原', async () => {
        const api = await setup();
        addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000 }], DEFAULT_DRAWING_STYLE);
        await act(async () => {});
        await down(50, 200);
        // 拖曳中另一個視窗新增了一條線（同步進來）
        const theirs = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 24800 }], DEFAULT_DRAWING_STYLE)!;
        await up(50, 150);
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25050, 24800]);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings.map((d) => d.anchors[0]!.price)).toEqual([25000, 24800]);
        expect(api().drawings.some((d) => d.id === theirs.id)).toBe(true);
    });

    it('量測結果顯示中算「畫圖佔用滑鼠」：委託線只能從把手區拖', async () => {
        const api = await setup();
        await act(async () => api().setTool('measure'));
        await down(10, 200);
        await down(30, 80);
        expect(api().tool).toBeNull();
        expect(api().drawingBusy()).toBe(true);
        expect(orderLineMayTakePointer({ drawingArmed: false, defaultPrevented: false, drawingBusy: true })).toBe(false);
        await key({ key: 'Escape' });
        expect(api().drawingBusy()).toBe(false);
    });

    it('價格標籤依商品跳動價位顯示（TXF 1 點），存的仍是原始值', async () => {
        const api = await setup();
        expect(api().formatPrice(48692.46)).toBe('48,692');
        expect(api().formatPrice(48692.46, false)).toBe('48692');
        await act(async () => api().setTool('trend'));
        await act(async () => api().setTool(null)); // 觸發一次 pushState
        const l = layer as unknown as { formatPrice: (p: number) => string; formatAxis: (p: number) => string };
        expect(l.formatPrice(48692.46)).toBe('48,692');
        expect(l.formatAxis(48692.46)).toBe('48692');
        const f = addDrawing('TXF', 'horizontal', [{ time: 1000, price: 25000.4 }], DEFAULT_DRAWING_STYLE)!;
        expect(f.anchors[0]!.price).toBe(25000.4);
    });

    it('不透明度：套到選取的物件、記成下一個物件的預設，連續拖動合併成一步復原', async () => {
        const api = await setup();
        await act(async () => api().setTool('horizontal'));
        await down(50, 150);
        expect(api().selected!.style.opacity).toBe(0.85); // 深色主題預設略透明
        for (const o of [0.7, 0.6, 0.5]) await act(async () => api().applyStyle({ opacity: o }));
        expect(api().selected!.style.opacity).toBe(0.5);
        expect(getDrawingSettings().lineOpacity).toBe(0.5);
        await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings[0]!.style.opacity).toBe(0.85);
    });

    it('物件列表操作：改名、隱藏、鎖定、調整圖層都可復原', async () => {
        const api = await setup();
        const a = addDrawing('TXF', 'trend', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        const b = addDrawing('TXF', 'trend', [{ time: 1000, price: 1 }, { time: 1060, price: 2 }], DEFAULT_DRAWING_STYLE)!;
        await act(async () => {});
        await down(700, 350); // 取得鍵盤（空白處）
        await act(async () => api().rename(a.id, '  壓力線 '));
        expect(api().drawings[0]!.name).toBe('壓力線');
        await act(async () => api().reorder(b.id, 0));
        expect(api().drawings.map((d) => d.id)).toEqual([b.id, a.id]);
        await act(async () => api().setHidden(a.id, true));
        await act(async () => api().setLocked(a.id, true));
        expect(api().allLocked).toBe(false);
        for (let i = 0; i < 4; i++) await key({ key: 'z', code: 'KeyZ', ctrlKey: true });
        expect(api().drawings.map((d) => d.id)).toEqual([a.id, b.id]);
        expect(api().drawings[0]).toMatchObject({ hidden: false, locked: false });
        expect(api().drawings[0]!.name).toBeUndefined();
    });
});
