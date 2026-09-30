// src/lib/chart-drawing-layer.ts — 把畫圖物件畫到主圖的 series primitive
//
// lightweight-charts v5 沒有線段／射線／方框這類自由物件（createPriceLine
// 只有水平線），跟 price-band 一樣用官方 plugin primitive 機制補上。
// 走 primitive 而不是另外疊一層 DOM／SVG 的理由：primitive 的 draw() 由
// 圖表自己的重繪迴圈驅動，平移縮放時不會比 K 棒慢一拍。

import type {
    IPrimitivePaneRenderer,
    IPrimitivePaneView,
    ISeriesPrimitiveAxisView,
    ISeriesApi,
    ISeriesPrimitive,
    IChartApi,
    Logical,
    PrimitivePaneViewZOrder,
    SeriesAttachedParameter,
    SeriesType,
    Time,
} from 'lightweight-charts';
import {
    fibLabel,
    fibLabelPlacement,
    fibLevelColor,
    fibLevelPrice,
    type FibOptions,
} from './chart-drawing-fib';
import {
    fibOptionsOf,
    contrastTextColor,
    type Drawing,
    type DrawingAnchor,
    type DrawingStyle,
    type DrawingTool,
} from './chart-drawings';
import {
    ANCHOR_RADIUS,
    estimateBarSeconds,
    formatSpan,
    logicalOfX,
    logicalToTime,
    measureXAxis,
    projectAnchors,
    shapeOf,
    TEXT_FONT_PX,
    TEXT_LINE_PX,
    TEXT_PAD_X,
    TEXT_PAD_Y,
    timeToLogical,
    xOfLogical,
    type MeasureStats,
    type PaneSize,
    type Point,
    type Projector,
    type Segment,
    type Shape,
} from './chart-drawing-geometry';

// 繪製中的物件（第一點已定、其餘跟著游標跑）
export interface DrawingDraft {
    tool: DrawingTool;
    anchors: DrawingAnchor[];
    style: DrawingStyle;
    text?: string;
    fib?: FibOptions;
}

// 價差量測（暫時的覆蓋層）
export interface MeasureOverlay {
    a: DrawingAnchor;
    b: DrawingAnchor;
    stats: MeasureStats;
    color: string;
    // 價格格式化（跳動價位的小數位數）與損益顯示交給呼叫端
    label: string;
}

export interface DrawingLayerState {
    drawings: Drawing[];
    draft: DrawingDraft | null;
    selectedIds: readonly string[];
    hoverId: string | null;
    measure: MeasureOverlay | null;
    // 目前正在編輯文字的物件：畫布上不畫它的文字（由輸入框蓋在上面）
    editingId: string | null;
}

const EMPTY_STATE: DrawingLayerState = {
    drawings: [],
    draft: null,
    selectedIds: [],
    hoverId: null,
    measure: null,
    editingId: null,
};

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

function withAlpha(hex: string, alpha: number): string {
    const m = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex.trim()) : null;
    if (!m) return hex;
    const n = parseInt(m[1]!, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}


class DrawingRenderer implements IPrimitivePaneRenderer {
    constructor(private readonly _layer: DrawingLayer) {}

    draw(target: DrawTarget): void {
        const layer = this._layer;
        const projector = layer.projector();
        if (!projector) return;
        target.useBitmapCoordinateSpace((scope) => {
            // pane 的畫布就是命中判定的座標系來源 — 兩邊共用同一個
            // 元素，游標座標與畫出來的位置不可能對不上
            layer.noteCanvas(scope.context.canvas, scope.mediaSize);
            const ctx = scope.context;
            const hr = scope.horizontalPixelRatio;
            const vr = scope.verticalPixelRatio;
            const size: PaneSize = scope.mediaSize;
            const state = layer.state;
            const selected = new Set(state.selectedIds);
            const multi = selected.size > 1;
            const fmt = layer.formatPrice;

            for (const d of state.drawings) {
                if (d.hidden) continue;
                const pts = projectAnchors(projector, d.anchors);
                if (!pts) continue;
                const isSel = selected.has(d.id);
                this._paint(ctx, hr, vr, size, d, pts, isSel, d.locked, fmt, state.editingId === d.id);
                // 多選時不畫控制點（拖控制點只對單一物件有意義），改畫外框提示
                if (isSel && !d.locked && !multi) this._paintHandles(ctx, hr, vr, pts, d.style.color);
                if (isSel && multi) this._paintHandles(ctx, hr, vr, pts, d.style.color, true);
            }

            const draft = state.draft;
            if (draft) {
                const pts = projectAnchors(projector, draft.anchors);
                if (pts && pts.length === draft.anchors.length) {
                    this._paint(
                        ctx,
                        hr,
                        vr,
                        size,
                        { ...draft, fib: draft.fib, text: draft.text },
                        pts,
                        false,
                        false,
                        fmt,
                        false,
                    );
                    this._paintHandles(ctx, hr, vr, pts, draft.style.color);
                }
            }

            if (state.measure) this._paintMeasure(ctx, hr, vr, projector, state.measure);
        });
        layer.notifyDrawn();
    }

    private _stroke(ctx: CanvasRenderingContext2D, hr: number, vr: number, seg: Segment) {
        ctx.beginPath();
        ctx.moveTo(seg.a.x * hr, seg.a.y * vr);
        ctx.lineTo(seg.b.x * hr, seg.b.y * vr);
        ctx.stroke();
    }

    private _paint(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        size: PaneSize,
        d: Pick<Drawing, 'tool' | 'anchors' | 'style' | 'text' | 'fib'>,
        pts: Point[],
        selected: boolean,
        locked: boolean,
        fmt: (p: number) => string,
        editing: boolean,
    ): void {
        const style = d.style;
        const shape: Shape | null = shapeOf(d.tool, pts, size, d);
        if (!shape) return;
        ctx.save();
        ctx.strokeStyle = style.color;
        // 選取中加粗一點當作視覺回饋
        ctx.lineWidth = (style.width + (selected ? 1 : 0)) * hr;
        // 鎖定的物件畫淡一些表示「不會被拖到」；但選取中要看得清楚
        // （選它通常就是為了解鎖或改樣式），所以選取時不淡化
        const baseAlpha = locked && !selected ? 0.55 : 1;
        // 線條／文字再乘上物件的不透明度；填色有自己的透明度，不再疊乘
        const lineAlpha = baseAlpha * (style.opacity ?? 1);
        ctx.globalAlpha = lineAlpha;
        const fillWith = (paint: () => void) => {
            ctx.globalAlpha = baseAlpha;
            paint();
            ctx.globalAlpha = lineAlpha;
        };
        const dash = style.dash === 'dashed' ? [6 * hr, 4 * hr] : [];
        ctx.setLineDash(dash);
        switch (shape.kind) {
            case 'line':
                this._stroke(ctx, hr, vr, shape);
                break;
            case 'rect': {
                const x = shape.left * hr;
                const y = shape.top * vr;
                const w = (shape.right - shape.left) * hr;
                const h = (shape.bottom - shape.top) * vr;
                if (style.fillOpacity > 0) {
                    fillWith(() => {
                        ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
                        ctx.fillRect(x, y, w, h);
                    });
                }
                ctx.strokeRect(x, y, w, h);
                break;
            }
            case 'channel': {
                if (style.fillOpacity > 0) {
                    fillWith(() => {
                        ctx.fillStyle = withAlpha(style.color, style.fillOpacity);
                        ctx.beginPath();
                        shape.fill.forEach((p, i) =>
                            i ? ctx.lineTo(p.x * hr, p.y * vr) : ctx.moveTo(p.x * hr, p.y * vr),
                        );
                        ctx.closePath();
                        ctx.fill();
                    });
                }
                this._stroke(ctx, hr, vr, shape.base);
                this._stroke(ctx, hr, vr, shape.parallel);
                ctx.setLineDash([4 * hr, 4 * hr]);
                ctx.lineWidth = Math.max(1, style.width - 1) * hr;
                this._stroke(ctx, hr, vr, shape.mid);
                break;
            }
            case 'fib': {
                const fib = fibOptionsOf(d);
                const start = d.anchors[0]!.price;
                const end = d.anchors[1]!.price;
                const mode = this._layer.themeMode;
                const colorOf = (index: number) =>
                    fibLevelColor(fib.levels[index]!, fib, style.color, mode);
                // 相鄰兩條比例線之間的半透明色帶（TradingView 式）：顏色取
                // 離 0 較遠的那一條
                if (fib.bandOpacity > 0) {
                    ctx.globalAlpha = baseAlpha;
                    const sorted = [...shape.levels].sort((p, q) => p.level - q.level);
                    for (let i = 0; i + 1 < sorted.length; i++) {
                        const lo = sorted[i]!;
                        const hi = sorted[i + 1]!;
                        ctx.fillStyle = withAlpha(colorOf(hi.index), fib.bandOpacity);
                        ctx.fillRect(
                            shape.left * hr,
                            Math.min(lo.y, hi.y) * vr,
                            (shape.right - shape.left) * hr,
                            Math.abs(hi.y - lo.y) * vr,
                        );
                    }
                    ctx.globalAlpha = lineAlpha;
                }
                for (const l of shape.levels) {
                    ctx.strokeStyle = colorOf(l.index);
                    this._stroke(ctx, hr, vr, {
                        a: { x: shape.left, y: l.y },
                        b: { x: shape.right, y: l.y },
                    });
                }
                if (shape.diag) {
                    ctx.strokeStyle = style.color;
                    ctx.setLineDash([3 * hr, 3 * hr]);
                    ctx.globalAlpha *= 0.7;
                    this._stroke(ctx, hr, vr, shape.diag);
                    ctx.globalAlpha /= 0.7;
                }
                // 標籤：回撤範圍外側、線的顏色＋圖表背景色描邊，蓋在 K 棒上
                // 也讀得清楚（不用實心底框）
                if (fib.showLevel || fib.showPrice) {
                    ctx.setLineDash([]);
                    ctx.font = `${fib.fontSize * vr}px sans-serif`;
                    for (const l of shape.levels) {
                        const text = fibLabel(
                            l.level,
                            fibLevelPrice(start, end, l.level, fib.reverse),
                            fib,
                            fmt,
                        );
                        const at = fibLabelPlacement(
                            { min: shape.anchorLeft, max: shape.anchorRight },
                            fib,
                            size.width,
                            l.y,
                            fib.fontSize,
                        );
                        ctx.textAlign = at.align;
                        ctx.textBaseline = at.baseline;
                        this._haloText(ctx, text, at.x * hr, at.y * vr, colorOf(l.index), hr);
                    }
                }
                break;
            }
            case 'text': {
                const x = shape.left * hr;
                const y = shape.top * vr;
                const w = (shape.right - shape.left) * hr;
                const h = (shape.bottom - shape.top) * vr;
                ctx.setLineDash([]);
                // 底色先鋪一層圖表背景色（半透明），再疊物件色：蓋在 K 棒上
                // 的文字也讀得清楚
                fillWith(() => {
                    ctx.fillStyle = withAlpha(this._layer.background, 0.82 * (style.opacity ?? 1));
                    ctx.fillRect(x, y, w, h);
                    ctx.fillStyle = withAlpha(style.color, 0.16);
                    ctx.fillRect(x, y, w, h);
                });
                ctx.lineWidth = (selected ? 1.5 : 1) * hr;
                ctx.strokeRect(x, y, w, h);
                if (!editing) {
                    ctx.fillStyle = style.color;
                    ctx.font = `${TEXT_FONT_PX * vr}px sans-serif`;
                    ctx.textBaseline = 'top';
                    shape.lines.forEach((line, i) =>
                        ctx.fillText(
                            line,
                            (shape.left + TEXT_PAD_X) * hr,
                            (shape.top + TEXT_PAD_Y + i * TEXT_LINE_PX + 2) * vr,
                        ),
                    );
                }
                break;
            }
        }
        ctx.restore();
    }

    // 文字加一圈圖表背景色的描邊（halo）：蓋在 K 棒、格線上仍讀得清楚，
    // 又不像實心底框那樣擋住後面的 K 棒
    private _haloText(
        ctx: CanvasRenderingContext2D,
        text: string,
        x: number,
        y: number,
        color: string,
        hr: number,
    ) {
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineWidth = 4 * hr;
        ctx.strokeStyle = withAlpha(this._layer.background, 0.92);
        ctx.strokeText(text, x, y);
        ctx.fillStyle = color;
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    private _paintMeasure(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        projector: Projector,
        m: MeasureOverlay,
    ): void {
        const pts = projectAnchors(projector, [m.a, m.b]);
        if (!pts) return;
        const [a, b] = pts as [Point, Point];
        const left = Math.min(a.x, b.x);
        const top = Math.min(a.y, b.y);
        const w = Math.abs(b.x - a.x);
        const h = Math.abs(b.y - a.y);
        ctx.save();
        ctx.fillStyle = withAlpha(m.color, 0.12);
        ctx.fillRect(left * hr, top * vr, w * hr, h * vr);
        ctx.strokeStyle = m.color;
        ctx.lineWidth = hr;
        ctx.setLineDash([4 * hr, 3 * hr]);
        ctx.strokeRect(left * hr, top * vr, w * hr, h * vr);
        ctx.setLineDash([]);
        // 起點到終點的箭頭線
        ctx.beginPath();
        ctx.moveTo(a.x * hr, a.y * vr);
        ctx.lineTo(b.x * hr, b.y * vr);
        ctx.stroke();
        // 標籤：放在終點那一側的框外
        ctx.font = `${11 * vr}px sans-serif`;
        const tw = ctx.measureText(m.label).width;
        const lx = (left + w / 2) * hr - tw / 2 - 6 * hr;
        const below = b.y >= a.y;
        const ly = below ? (top + h + 6) * vr : (top - 6) * vr - 18 * vr;
        ctx.fillStyle = m.color;
        ctx.fillRect(lx, ly, tw + 12 * hr, 18 * vr);
        ctx.fillStyle = contrastTextColor(m.color);
        ctx.textBaseline = 'middle';
        ctx.fillText(m.label, lx + 6 * hr, ly + 9 * vr);
        ctx.restore();
    }

    private _paintHandles(
        ctx: CanvasRenderingContext2D,
        hr: number,
        vr: number,
        pts: Point[],
        color: string,
        muted = false,
    ): void {
        ctx.save();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5 * hr;
        ctx.strokeStyle = color;
        ctx.fillStyle = muted ? color : '#ffffff';
        for (const p of pts) {
            ctx.beginPath();
            ctx.arc(p.x * hr, p.y * vr, (muted ? 3 : ANCHOR_RADIUS) * hr, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        ctx.restore();
    }
}

class DrawingPaneView implements IPrimitivePaneView {
    constructor(private readonly _layer: DrawingLayer) {}
    zOrder(): PrimitivePaneViewZOrder {
        return 'top'; // 畫在 K 棒之上 — 壓力線被 K 棒蓋住就沒意義了
    }
    renderer(): IPrimitivePaneRenderer {
        return new DrawingRenderer(this._layer);
    }
}

// 水平線在價格軸上的色塊標籤 — 與現價游標、委託單價格線同一種呈現，
// 線是什麼顏色，標籤就是什麼顏色，一眼看得出這個價位屬於哪一條線。
//
// 物件本身可變（座標每次重繪都在動）：lightweight-charts 用陣列 reference
// 當快取鍵，每次都 new 一批會讓它每幀重建標籤，所以只在「有哪些線」變了
// 的時候換陣列，座標就地更新。
class DrawingAxisView implements ISeriesPrimitiveAxisView {
    y = 0;
    label = '';
    color = '#ffffff';
    ok = false; // 價位在可視範圍外時 priceToCoordinate 會回 null
    coordinate(): number {
        return this.y;
    }
    text(): string {
        return this.label;
    }
    textColor(): string {
        return contrastTextColor(this.color);
    }
    backColor(): string {
        return this.color;
    }
    visible(): boolean {
        return this.ok;
    }
}

const NO_AXIS_VIEWS: readonly ISeriesPrimitiveAxisView[] = [];

export class DrawingLayer implements ISeriesPrimitive<Time> {
    state: DrawingLayerState = EMPTY_STATE;
    paneSize: PaneSize = { width: 0, height: 0 };
    private _series: ISeriesApi<SeriesType> | null = null;
    private _chart: IChartApi | null = null;
    private _requestUpdate: (() => void) | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private readonly _views: DrawingPaneView[];
    private _axisViews: DrawingAxisView[] = [];
    private _axisKey = '';
    // 棒距估計要排序全部 K 棒間距 — 依時間陣列（資料變更才換新陣列）
    // 快取，滑鼠事件與每幀重繪都不重算
    private _barTimes: number[] | null = null;
    private _barSeconds = 60;
    // 每次重繪完成後呼叫（浮動工具列、文字輸入框跟著物件移動）
    onDrawn: (() => void) | null = null;
    // 主題：斐波那契的預設色依深淺取；文字描邊用圖表背景色
    themeMode: 'dark' | 'light' = 'dark';
    background = '#000000';
    private _drawnQueued = false;

    // getTimes：目前圖上 K 棒的時間陣列（遞增）。切換週期／載入更舊的
    // 歷史都會換一份，所以用 callback 每次重讀，不快照。
    constructor(private readonly _getTimes: () => number[]) {
        this._views = [new DrawingPaneView(this)];
    }

    attached(param: SeriesAttachedParameter<Time>): void {
        this._series = param.series;
        this._chart = param.chart;
        this._requestUpdate = param.requestUpdate;
    }

    detached(): void {
        this._series = null;
        this._chart = null;
        this._requestUpdate = null;
        this._canvas = null;
        this._axisViews = [];
        this._axisKey = '';
    }

    paneViews(): readonly IPrimitivePaneView[] {
        return this._views;
    }

    // 只有水平線有標籤：斜線與方框沒有單一價位可標，硬標一個（例如端點）
    // 反而會在拖曳時跳來跳去。繪製中的水平線也標，跟游標十字線一樣即時。
    priceAxisViews(): readonly ISeriesPrimitiveAxisView[] {
        const series = this._series;
        if (!series) return NO_AXIS_VIEWS;
        const rows: { id: string; price: number; color: string }[] = [];
        for (const d of this.state.drawings) {
            if (d.tool !== 'horizontal' || d.hidden) continue;
            const price = d.anchors[0]?.price;
            if (price === undefined) continue;
            rows.push({ id: d.id, price, color: d.style.color });
        }
        const draft = this.state.draft;
        if (draft?.tool === 'horizontal') {
            const price = draft.anchors[0]?.price;
            if (price !== undefined) {
                rows.push({ id: 'draft', price, color: draft.style.color });
            }
        }
        if (!rows.length) {
            this._axisKey = '';
            this._axisViews = [];
            return NO_AXIS_VIEWS;
        }
        // 價格不進 key：改價時標籤文字跟著 format 出來就好，不必換陣列
        const key = rows.map((r) => `${r.id}|${r.color}`).join(';');
        if (key !== this._axisKey) {
            this._axisKey = key;
            this._axisViews = rows.map(() => new DrawingAxisView());
        }
        rows.forEach((r, i) => {
            const view = this._axisViews[i]!;
            const y = series.priceToCoordinate(r.price);
            view.ok = y !== null;
            view.y = y ?? 0;
            view.label = this.formatAxis(r.price);
            view.color = r.color;
        });
        return this._axisViews;
    }

    setState(state: DrawingLayerState): void {
        this.state = state;
        this._requestUpdate?.();
    }

    noteCanvas(canvas: HTMLCanvasElement, size: PaneSize): void {
        this._canvas = canvas;
        this.paneSize = size;
    }

    notifyDrawn(): void {
        // 繪製中不能動 React state — 排到下一個 microtask
        if (!this.onDrawn || this._drawnQueued) return;
        this._drawnQueued = true;
        queueMicrotask(() => {
            this._drawnQueued = false;
            this.onDrawn?.();
        });
    }

    // 價格顯示（畫圖標籤）：由 hook 依商品跳動價位設定；還沒設定時退回
    // series 的格式
    formatPrice = (price: number): string => {
        const series = this._series;
        return series ? series.priceFormatter().format(price) : String(price);
    };
    // 價格軸標籤（水平線）：同樣依跳動價位，但不加千分位（與價格軸一致）
    formatAxis = (price: number): string => this.formatPrice(price);

    barSecondsOf(times: number[]): number {
        if (times !== this._barTimes) {
            this._barTimes = times;
            this._barSeconds = estimateBarSeconds(times);
        }
        return this._barSeconds;
    }

    // pane 畫布在視窗中的位置（浮動工具列換算成 host 內座標用）
    canvasRect(): { left: number; top: number } | null {
        const canvas = this._canvas;
        if (!canvas) return null;
        const r = canvas.getBoundingClientRect();
        return { left: r.left, top: r.top };
    }

    // 把滑鼠事件換算成 pane 內座標；pane 畫布尚未建立時回 null
    pointOf(ev: { clientX: number; clientY: number }): Point | null {
        const canvas = this._canvas;
        if (!canvas) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null;
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    }

    // 時間／價格 ↔ 畫面座標。時間方向刻意繞過 timeToCoordinate() 與
    // logicalToCoordinate()：前者只認 K 棒格點上的時間，後者只認整數
    // logical（小數一律回 0＝pane 左緣），錨點落在別的週期或棒與棒之間
    // 就會消失或被釘在畫面最左邊。改成自己量出 logical→x 的線性映射。
    projector(): Projector | null {
        const series = this._series;
        const chart = this._chart;
        if (!series || !chart) return null;
        const timeScale = chart.timeScale();
        const times = this._getTimes();
        const bar = this.barSecondsOf(times);
        // 一幀內時間軸不會動 — 量一次給下面兩個方向共用
        const axis = measureXAxis((logical) => timeScale.logicalToCoordinate(logical as Logical));
        return {
            xOfTime: (time) => {
                if (!times.length || !axis) return null;
                const logical = timeToLogical(times, bar, time);
                if (!Number.isFinite(logical)) return null;
                return xOfLogical(axis, logical);
            },
            yOfPrice: (price) => series.priceToCoordinate(price),
            timeOfX: (x) => {
                if (!times.length || !axis) return null;
                return logicalToTime(times, bar, logicalOfX(axis, x));
            },
            priceOfY: (y) => {
                const p = series.coordinateToPrice(y);
                return p === null ? null : Number(p);
            },
        };
    }
}
