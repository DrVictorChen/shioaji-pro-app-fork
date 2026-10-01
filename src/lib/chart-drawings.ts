// src/lib/chart-drawings.ts — 圖表畫圖物件的資料模型與儲存（issue #122 二／三）
//
// 三個設計要點：
// 1. 座標一律存「時間＋價格」，不存 K 棒 index — 切換週期後同一條線
//    still 落在同一個時間／價位（幾何投影見 chart-drawing-geometry.ts）。
// 2. 依商品保存，不依面板保存 — 多開的 K 線面板與彈出視窗看同一份資料。
// 3. popout 是另一個 window，module state 不共用；跟 risk.ts 一樣靠
//    storage 事件把另一個 window 的寫入同步回來。

import { useSyncExternalStore } from 'react';
import type { ContractBase } from './types/contract';
import { defaultFibOptions, sanitizeFibOptions, type FibOptions } from './chart-drawing-fib';
import { applyChanges, type HistoryStep } from './chart-drawing-history';
import { drawingRevision, tombRevision, isRevision, isTombstone, type Revision, type Tombstone } from './chart-drawing-revision';

export type DrawingTool =
    | 'horizontal' // 水平線：單一價位，橫貫整個 pane
    | 'vertical' // 垂直線：單一時間，縱貫整個 pane
    | 'trend' // 趨勢線：兩點之間的線段
    | 'ray' // 射線：由起點經第二點向右無限延伸
    | 'extended' // 延伸線：兩點決定斜率，向左右無限延伸
    | 'channel' // 平行通道：兩點決定基準線，第三點決定平行線的價差
    | 'box' // 方框：兩個對角決定的矩形
    | 'fib' // 斐波那契回撤：兩點（起點＝1、終點＝0）間的比例價位
    | 'text'; // 文字註記：錨定在時間／價格上的文字框

// 工具列分組。部位工具（第二期）還沒有工具，工具列不顯示空的組。
export type DrawingGroup = 'lines' | 'shapes' | 'fib' | 'notes' | 'measure' | 'position';

export const DRAWING_GROUPS: { group: DrawingGroup; label: string }[] = [
    { group: 'lines', label: '線條' },
    { group: 'shapes', label: '形狀' },
    { group: 'fib', label: '斐波那契' },
    { group: 'notes', label: '文字註記' },
    { group: 'measure', label: '量測' },
    { group: 'position', label: '部位工具' },
];

// 量測不是存下來的物件（量完就清），但在工具列上跟畫圖工具並列
export type DrawingToolId = DrawingTool | 'measure';

export interface DrawingToolDef {
    tool: DrawingToolId;
    group: DrawingGroup;
    label: string;
    hint: string;
    // Alt＋字母（用 KeyboardEvent.code 判斷 — macOS 的 Option 會把
    // e.key 變成特殊符號）
    shortcut?: string;
}

export const DRAWING_TOOL_DEFS: DrawingToolDef[] = [
    { tool: 'trend', group: 'lines', label: '趨勢線', hint: '兩點決定的線段', shortcut: 'T' },
    { tool: 'ray', group: 'lines', label: '射線', hint: '由起點經第二點向右延伸' },
    { tool: 'extended', group: 'lines', label: '延伸線', hint: '兩點決定斜率，向左右延伸' },
    { tool: 'horizontal', group: 'lines', label: '水平線', hint: '支撐、壓力、前高前低（點一下）', shortcut: 'H' },
    { tool: 'vertical', group: 'lines', label: '垂直線', hint: '標記時間點（點一下）', shortcut: 'V' },
    { tool: 'channel', group: 'lines', label: '平行通道', hint: '兩點畫基準線，第三點決定通道寬度', shortcut: 'P' },
    { tool: 'box', group: 'shapes', label: '方框', hint: '兩個對角決定的區域', shortcut: 'R' },
    { tool: 'fib', group: 'fib', label: '斐波那契回撤', hint: '起點到終點的回撤比例價位', shortcut: 'F' },
    { tool: 'text', group: 'notes', label: '文字註記', hint: '點一下放置文字，雙擊可編輯', shortcut: 'N' },
    { tool: 'measure', group: 'measure', label: '價差量測', hint: '點兩下量點數、漲跌幅、K 棒數與時間（Esc 或點一下清除）', shortcut: 'M' },
];

export function toolDef(tool: DrawingToolId): DrawingToolDef {
    return DRAWING_TOOL_DEFS.find((d) => d.tool === tool)!;
}

// 存下來的物件工具（不含量測）
export const DRAWING_TOOLS = DRAWING_TOOL_DEFS.filter(
    (d): d is DrawingToolDef & { tool: DrawingTool } => d.tool !== 'measure',
);

export function isDrawingTool(v: unknown): v is DrawingTool {
    return typeof v === 'string' && DRAWING_TOOLS.some((t) => t.tool === v);
}

// 每種工具的控制點數
export function anchorCount(tool: DrawingToolId): 1 | 2 | 3 {
    switch (tool) {
        case 'horizontal':
        case 'vertical':
        case 'text':
            return 1;
        case 'channel':
            return 3;
        default:
            return 2;
    }
}


export interface DrawingAnchor {
    time: number; // UTC 秒（與 lightweight-charts 的 UTCTimestamp 同一刻度）
    price: number;
}

export interface DrawingStyle {
    color: string; // 線色（#rrggbb）
    width: number; // 線寬 1–4
    dash: 'solid' | 'dashed';
    fillOpacity: number; // 方框／通道的填色透明度 0–1
    // 線條（與文字）的不透明度 0.1–1：蓋在 K 棒上時可以半透明，不把 K 棒
    // 擋住。舊資料沒有這個欄位，載入時補 1（外觀不變）
    opacity: number;
}

export const MIN_LINE_OPACITY = 0.1;

// 新物件線條的預設不透明度：略透明，蓋在 K 棒上仍看得到 K 棒；淺色底上
// 同樣的透明度看起來較淡，所以淺色主題稍微不透明一點
export const DEFAULT_LINE_OPACITY: Record<'dark' | 'light', number> = {
    dark: 0.85,
    light: 0.9,
};

export interface Drawing {
    id: string;
    tool: DrawingTool;
    anchors: DrawingAnchor[];
    style: DrawingStyle;
    locked: boolean; // 鎖定：不可拖曳、改價、刪除（仍可選取與改樣式）
    hidden: boolean; // 隱藏：不繪製，但仍保存
    createdAt: number;
    // 時間只供顯示；跨視窗合併與歷史檢查一律使用 revision。
    updatedAt: number;
    revision?: Revision; // 舊資料載入時以 updatedAt 轉成 legacy revision
    name?: string; // 物件列表裡的名稱（沒設就用工具名稱）
    text?: string; // 文字註記的內容
    fib?: FibOptions; // 斐波那契的比例、色帶、標籤、延伸（沒設就用預設）
}

export const MAX_TEXT_LENGTH = 200;
export const MAX_NAME_LENGTH = 40;

export function drawingLabel(d: Pick<Drawing, 'tool' | 'name' | 'text'>): string {
    if (d.name) return d.name;
    if (d.tool === 'text' && d.text) return d.text.split('\n')[0]!.slice(0, 24);
    return toolDef(d.tool).label;
}

// TradingView 風格的固定色盤 — 不跟主題走，使用者選什麼就是什麼，
// 換深／淺色主題不會把使用者挑的顏色換掉
export const DRAWING_PALETTE = [
    '#2962ff',
    '#00bcd4',
    '#26a69a',
    '#66bb6a',
    '#ffb300',
    '#ff7043',
    '#ef5350',
    '#ec407a',
    '#ab47bc',
    '#9e9e9e',
] as const;

// 價格軸標籤的字色。刻意照抄 lightweight-charts 內部的 generateContrastColors
// （NTSC 灰階加權、門檻 160），我們的標籤才會跟現價、委託單價格線那些
// 內建標籤長得一模一樣；自己另訂一套門檻會出現同色系標籤字色不同的怪畫面。
export function contrastTextColor(hex: string): string {
    const m = typeof hex === 'string' ? /^#([0-9a-f]{6})$/i.exec(hex.trim()) : null;
    if (!m) return '#ffffff';
    const n = parseInt(m[1]!, 16);
    const gray = 0.199 * ((n >> 16) & 255) + 0.687 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return gray > 160 ? '#000000' : '#ffffff';
}

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
    color: DRAWING_PALETTE[0],
    width: 2,
    dash: 'solid',
    fillOpacity: 0.08,
    opacity: 1,
};

export type DrawingThemeMode = 'dark' | 'light';

// 各工具的預設色（使用者沒挑過顏色時）。刻意避開圖上已有語意的顏色：
// 委託線的紅／綠（買賣）、停損觸價線與 MA 的琥珀 #e0a43c、警示線的灰
// #8b94a7、MACD／KD 的藍 #3d8bff。水平線用偏紅的橘（讀價位用，要醒目），
// 斜線類用紫，方框用中性灰描邊＋淡填色（框的是區域，不該搶 K 棒）。
// 深／淺主題各一組：淺色底上同一個色相要更深才看得清楚。
export const TOOL_DEFAULT_COLORS: Record<DrawingThemeMode, Record<DrawingTool, string>> = {
    dark: {
        horizontal: '#ff7a2f',
        vertical: '#ff7a2f',
        trend: '#9b87f5',
        ray: '#9b87f5',
        extended: '#9b87f5',
        channel: '#9b87f5',
        box: '#9aa3b5',
        fib: '#3bc9db',
        text: '#b197fc',
    },
    light: {
        horizontal: '#e8590c',
        vertical: '#e8590c',
        trend: '#6741d9',
        ray: '#6741d9',
        extended: '#6741d9',
        channel: '#6741d9',
        box: '#6b7280',
        fib: '#0c8599',
        text: '#7048e8',
    },
};

// 價差量測（暫時的覆蓋層，不存檔）的顏色
export const MEASURE_COLORS: Record<DrawingThemeMode, string> = {
    dark: '#4c8dff',
    light: '#1c64f2',
};

// 新物件除了顏色、不透明度以外的預設（線寬、線型、方框填色）
export type DrawingBaseStyle = Omit<DrawingStyle, 'color' | 'opacity'>;

export interface DrawingSettings {
    // 期貨連續月（TXFR1）與月份合約（TXFI6）共用同一份畫圖。
    // 連續月只是近月的別名，交易者畫在 R1 上的壓力線換月後仍然有效；
    // 關掉則每個合約代碼各自獨立（TradingView 式）。
    shareContinuousMonth: boolean;
    // 下一個新物件的樣式（改樣式時記住，跟 TradingView 一樣）
    defaultStyle: DrawingBaseStyle;
    // 使用者挑過的顏色，依工具記住；沒挑過的工具用 TOOL_DEFAULT_COLORS
    toolColors: Partial<Record<DrawingTool, string>>;
    // 磁吸：畫點與拖曳控制點時貼齊最近 K 棒的開高低收
    magnet: boolean;
    // ★ 釘在工具列上的工具
    favorites: DrawingToolId[];
    // 每組最後用的工具（組按鈕顯示它、點一下直接武裝它）
    groupLast: Partial<Record<DrawingGroup, DrawingToolId>>;
    // 右側物件列表是否展開
    objectListOpen: boolean;
    // 使用者挑過的線條不透明度；沒挑過依主題用 DEFAULT_LINE_OPACITY
    lineOpacity?: number;
}

const DEFAULT_SETTINGS: DrawingSettings = {
    shareContinuousMonth: true,
    defaultStyle: {
        width: DEFAULT_DRAWING_STYLE.width,
        dash: DEFAULT_DRAWING_STYLE.dash,
        fillOpacity: DEFAULT_DRAWING_STYLE.fillOpacity,
    },
    toolColors: {},
    magnet: false,
    // 預設不釘：工具列在預設版面（矮面板）要放得下全部分組與下方操作
    favorites: [],
    groupLast: {},
    objectListOpen: false,
};

// 某個工具的下一個新物件樣式：使用者挑過的顏色優先，否則依主題取預設色
export function defaultStyleFor(
    s: DrawingSettings,
    tool: DrawingTool,
    mode: DrawingThemeMode,
): DrawingStyle {
    return {
        ...s.defaultStyle,
        color: s.toolColors[tool] ?? TOOL_DEFAULT_COLORS[mode][tool],
        opacity: s.lineOpacity ?? DEFAULT_LINE_OPACITY[mode],
    };
}

const STORAGE_KEY = 'sj-pro-chart-drawings';

// 每個商品鍵的上限。整份 store 是一個 localStorage 項目，無上限地長下去
// 每次寫入與跨視窗解析都會變慢，也會吃掉其他設定的配額。
// （放在檔案前段：module 初始化載入資料時 capDrawings 就要用到）
export const MAX_DRAWINGS_PER_SYMBOL = 200;
const SETTINGS_KEY = 'sj-pro-chart-drawing-settings';

// ── 商品鍵 ───────────────────────────────────────────────────────────
//
// 期貨代碼 = 根代碼＋月份碼＋年尾數（TXFI6、CCFI6），連續月為 R1／R2
// 別名（TXFR1）。共用開啟時全部收斂到根代碼（TXF）。
// 選擇權不收斂 — TXO21000I6 與 TXO21500I6 是不同履約價，不是同一商品。
const FUT_CODE = /^([A-Z]{2,4})(?:R[12]|[A-X]\d)$/;

export function drawingSymbolKey(
    contract: Pick<ContractBase, 'code' | 'security_type'>,
    share: boolean,
): string {
    const code = contract.code.toUpperCase();
    if (!share || contract.security_type !== 'FUT') return code;
    const m = FUT_CODE.exec(code);
    return m ? m[1]! : code;
}

// ── 驗證 ─────────────────────────────────────────────────────────────
//
// 舊版本或手改過的 localStorage 都可能餵進形狀不對的資料 — 投影時 NaN
// 會整張圖畫不出來、非字串的顏色會讓價格軸標籤 .trim() 拋錯，所以每個
// 欄位都在入口驗過；看不懂的樣式欄位退回預設，而不是整筆丟掉。

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function isDrawingColor(v: unknown): v is string {
    return typeof v === 'string' && HEX_COLOR.test(v);
}

function sanitizeBaseStyle(v: unknown, fallback: DrawingBaseStyle): DrawingBaseStyle {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const width =
        typeof o.width === 'number' && Number.isFinite(o.width)
            ? Math.min(4, Math.max(1, Math.round(o.width)))
            : fallback.width;
    const dash = o.dash === 'solid' || o.dash === 'dashed' ? o.dash : fallback.dash;
    const fillOpacity =
        typeof o.fillOpacity === 'number' && Number.isFinite(o.fillOpacity)
            ? Math.min(1, Math.max(0, o.fillOpacity))
            : fallback.fillOpacity;
    return { width, dash, fillOpacity };
}

export function clampOpacity(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v)
        ? Math.min(1, Math.max(MIN_LINE_OPACITY, v))
        : fallback;
}

export function sanitizeStyle(v: unknown, fallbackColor: string): DrawingStyle {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        color: isDrawingColor(o.color) ? o.color : fallbackColor,
        ...sanitizeBaseStyle(o, DEFAULT_SETTINGS.defaultStyle),
        opacity: clampOpacity(o.opacity, 1),
    };
}

// 形狀不對（工具、控制點）就整筆丟掉；樣式與旗標則修成合法值
export function sanitizeDrawing(v: unknown): Drawing | null {
    if (!v || typeof v !== 'object') return null;
    const d = v as Record<string, unknown>;
    if (typeof d.id !== 'string' || !d.id || typeof d.tool !== 'string') return null;
    if (!isDrawingTool(d.tool)) return null;
    const tool = d.tool;
    if (!Array.isArray(d.anchors) || d.anchors.length !== anchorCount(tool)) return null;
    const anchors: DrawingAnchor[] = [];
    for (const a of d.anchors as unknown[]) {
        const o = (a && typeof a === 'object' ? a : null) as Record<string, unknown> | null;
        if (
            !o ||
            typeof o.time !== 'number' ||
            !Number.isFinite(o.time) ||
            typeof o.price !== 'number' ||
            !Number.isFinite(o.price)
        ) {
            return null;
        }
        anchors.push({ time: o.time, price: o.price });
    }
    return {
        id: d.id,
        tool,
        anchors,
        style: sanitizeStyle(d.style, TOOL_DEFAULT_COLORS.dark[tool]),
        locked: d.locked === true,
        hidden: d.hidden === true,
        createdAt: typeof d.createdAt === 'number' && Number.isFinite(d.createdAt) ? d.createdAt : 0,
        updatedAt:
            typeof d.updatedAt === 'number' && Number.isFinite(d.updatedAt)
                ? d.updatedAt
                : typeof d.createdAt === 'number' && Number.isFinite(d.createdAt)
                  ? d.createdAt
                  : 0,
        ...(isRevision(d.revision) ? { revision: d.revision } : {}),
        ...(typeof d.name === 'string' && d.name.trim()
            ? { name: d.name.trim().slice(0, MAX_NAME_LENGTH) }
            : {}),
        ...(tool === 'text'
            ? { text: typeof d.text === 'string' ? d.text.slice(0, MAX_TEXT_LENGTH) : '' }
            : {}),
        // #224 第一版的 levels（數字陣列）轉成新的 fib.levels
        ...(tool === 'fib' ? { fib: sanitizeFibOptions(d.fib, d.levels) } : {}),
    };
}

export function fibOptionsOf(d: Pick<Drawing, 'fib'>): FibOptions {
    return d.fib ?? defaultFibOptions();
}

export function sanitizeSettings(v: unknown): DrawingSettings {
    const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
    const toolColors: Partial<Record<DrawingTool, string>> = {};
    const rawColors = o.toolColors;
    if (rawColors && typeof rawColors === 'object') {
        for (const { tool } of DRAWING_TOOLS) {
            const c = (rawColors as Record<string, unknown>)[tool];
            if (isDrawingColor(c)) toolColors[tool] = c;
        }
    }
    const toolIds = new Set<string>(DRAWING_TOOL_DEFS.map((t) => t.tool));
    const favorites = Array.isArray(o.favorites)
        ? [...new Set(o.favorites.filter((t): t is DrawingToolId => typeof t === 'string' && toolIds.has(t)))]
        : DEFAULT_SETTINGS.favorites;
    const groupLast: Partial<Record<DrawingGroup, DrawingToolId>> = {};
    if (o.groupLast && typeof o.groupLast === 'object') {
        for (const def of DRAWING_TOOL_DEFS) {
            const v = (o.groupLast as Record<string, unknown>)[def.group];
            if (v === def.tool) groupLast[def.group] = def.tool;
        }
    }
    return {
        shareContinuousMonth:
            typeof o.shareContinuousMonth === 'boolean'
                ? o.shareContinuousMonth
                : DEFAULT_SETTINGS.shareContinuousMonth,
        defaultStyle: sanitizeBaseStyle(o.defaultStyle, DEFAULT_SETTINGS.defaultStyle),
        toolColors,
        magnet: o.magnet === true,
        favorites,
        groupLast,
        objectListOpen: o.objectListOpen === true,
        ...(typeof o.lineOpacity === 'number' && Number.isFinite(o.lineOpacity)
            ? { lineOpacity: clampOpacity(o.lineOpacity, 1) }
            : {}),
    };
}

// ── 儲存 ─────────────────────────────────────────────────────────────

type Store = Record<string, Drawing[]>;

// 刪除墓碑：{ 商品鍵: { 物件 id: { revision, updatedAt } } }，另存一個項目。別的視窗
// 手上還有這個物件的舊版本時，寫出或同步都不會讓它復活；超過 TTL 的
// 墓碑在寫出時清掉，不會無限長大。
type Tombs = Record<string, Record<string, Tombstone>>;
const TOMB_KEY = 'sj-pro-chart-drawing-tombstones';
export const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000;

function loadTombs(): Tombs {
    try {
        const raw = localStorage.getItem(TOMB_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Tombs = {};
        for (const [key, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!ids || typeof ids !== 'object') continue;
            for (const [id, at] of Object.entries(ids as Record<string, unknown>)) {
                if (isTombstone(at)) (out[key] ??= {})[id] = at;
            }
        }
        return out;
    } catch {
        return {};
    }
}

// 墓碑 revision 不比物件舊 → 物件已被刪除。
function buried(tombs: Tombs, key: string, d: Drawing): boolean {
    const at = tombs[key]?.[d.id];
    return at !== undefined && tombRevision(at) >= drawingRevision(d);
}

// 保留既有時間欄位的遞增行為；版本先後由 revision 決定。
let lastStamp = 0;
export function stamp(): number {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return lastStamp;
}

// 載入時的硬上限：只擋損壞或異常巨大的資料（正常使用最多到軟上限
// MAX_DRAWINGS_PER_SYMBOL 附近）。超過時保留最新的 HARD_MAX 個並通知
export const HARD_MAX_DRAWINGS_PER_SYMBOL = 1000;

export function capDrawings(list: Drawing[], max = HARD_MAX_DRAWINGS_PER_SYMBOL): Drawing[] {
    if (list.length <= max) return list;
    const keep = new Set(
        [...list]
            .sort((x, y) => y.createdAt - x.createdAt)
            .slice(0, max)
            .map((d) => d.id),
    );
    return list.filter((d) => keep.has(d.id));
}

// 給 UI 顯示的通知（物件上限、載入截斷、復原／重做衝突）
let notices: string[] = [];
const noticed = new Set<string>(); // 同一則只通知一次（載入／同步會重跑）
function noteDrawings(msg: string) {
    if (noticed.has(msg)) return;
    noticed.add(msg);
    notices = [...notices, msg];
    // 在 module 初始化期間 listeners 還是空的，emit 無副作用
    for (const l of listeners) l();
}
export function takeDrawingNotices(): string[] {
    const out = notices;
    if (out.length) notices = [];
    return out;
}
export function useDrawingNotices(): readonly string[] {
    return useSyncExternalStore(subscribe, () => notices, () => EMPTY_NOTICES);
}
const EMPTY_NOTICES: string[] = [];

function loadStore(tombs: Tombs = loadTombs()): Store {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Store = {};
        for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            const clean: Drawing[] = [];
            const seen = new Set<string>();
            for (const item of list) {
                const d = sanitizeDrawing(item);
                if (!d || seen.has(d.id) || buried(tombs, key, d)) continue;
                seen.add(d.id);
                clean.push(d);
            }
            // 硬上限只擋損壞／異常巨大的資料；正常的軟上限超量不在這裡刪
            if (clean.length > HARD_MAX_DRAWINGS_PER_SYMBOL) {
                noteDrawings(
                    `${key} 的畫圖資料有 ${clean.length} 筆，超過 ${HARD_MAX_DRAWINGS_PER_SYMBOL} 筆，已只載入最新的 ${HARD_MAX_DRAWINGS_PER_SYMBOL} 筆。`,
                );
            }
            if (clean.length) out[key] = capDrawings(clean);
        }
        return out;
    } catch {
        return {}; // 壞掉的資料不能讓圖表開不起來
    }
}

function loadSettings(): DrawingSettings {
    try {
        const raw = localStorage.getItem(SETTINGS_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        return sanitizeSettings(JSON.parse(raw));
    } catch {
        return DEFAULT_SETTINGS;
    }
}

// ── 關窗日誌 ─────────────────────────────────────────────────────────
//
// 關視窗（pagehide）時等不到非同步的 Web Lock，但也不能在鎖外做「讀→
// 合併→寫」主項目 — 會蓋掉正在鎖內寫入的視窗，或被它蓋掉而永久遺失。
// 所以關窗時只把本視窗還沒寫出去的改動（逐物件、設定逐欄位）同步寫到
// 自己專屬的日誌項目 sj-chart-drawings-pending:<視窗 id>，不碰主項目。
// 之後任何一個視窗在鎖內寫入時把所有日誌併進主項目並刪掉日誌；讀取時
// 也把日誌疊上去，還沒被併進去之前畫面就看得到。
const JOURNAL_PREFIX = 'sj-chart-drawings-pending:';
const WINDOW_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
let journalSeq = 0;
let revisionCounter = 0;
function observeRevision(revision: Revision) {
    revisionCounter = Math.max(revisionCounter, Number(revision.split(':')[0]));
}
function nextRevision(): Revision {
    return `${(++revisionCounter).toString().padStart(16, '0')}:${WINDOW_ID}`;
}

type OrderMove = { id: string; after: string | null; revision: Revision };
type OrderOps = Map<string, OrderMove[]>;

interface Journal {
    name: string; // localStorage 項目名稱
    raw: string; // 讀到的原始內容：刪除前比對，只刪「併進去的那一版」
    ops: Map<string, Map<string, Op>>;
    order: OrderOps;
    settings: Partial<DrawingSettings>;
}

function journalNames(): string[] {
    try {
        const out: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(JOURNAL_PREFIX)) out.push(k);
        }
        return out.sort();
    } catch {
        return [];
    }
}

function loadJournals(): Journal[] {
    const out: Journal[] = [];
    for (const name of journalNames()) {
        try {
            const text = localStorage.getItem(name);
            if (text === null) continue;
            const raw = JSON.parse(text) as {
                ops?: Record<string, Record<string, unknown>>;
                order?: Record<string, unknown>;
                settings?: Record<string, unknown>;
            } | null;
            if (!raw || typeof raw !== 'object') continue;
            const ops = new Map<string, Map<string, Op>>();
            for (const [key, byId] of Object.entries(raw.ops ?? {})) {
                if (!byId || typeof byId !== 'object') continue;
                const m = new Map<string, Op>();
                for (const [id, v] of Object.entries(byId)) {
                    if (isTombstone(v)) m.set(id, v);
                    else {
                        const d = sanitizeDrawing(v);
                        if (d && d.id === id) m.set(id, d);
                    }
                }
                if (m.size) ops.set(key, m);
            }
            const settingsPatch =
                raw.settings && typeof raw.settings === 'object' ? (raw.settings as Partial<DrawingSettings>) : {};
            const order: OrderOps = new Map();
            for (const [key, ids] of Object.entries(raw.order ?? {})) {
                if (!Array.isArray(ids)) continue;
                const moves: OrderMove[] = [];
                for (const v of ids) {
                    if (v && typeof v === 'object' && typeof v.id === 'string' &&
                        (v.after === null || typeof v.after === 'string') && isRevision(v.revision)) moves.push(v);
                }
                // 相容舊關窗日誌：只替有物件改動的 id 產生相對移動。
                if (ids.every((v) => typeof v === 'string')) {
                    ids.forEach((id: string, i: number) => {
                        const op = ops.get(key)?.get(id);
                        if (op && !isTombstone(op)) moves.push({ id, after: ids[i - 1] ?? null, revision: drawingRevision(op) });
                    });
                }
                if (moves.length) order.set(key, moves);
            }
            out.push({ name, raw: text, ops, order, settings: settingsPatch });
        } catch {
            // 壞掉的日誌略過（寫入者會把它刪掉）
        }
    }
    return out;
}

function applyJournals(base: Store, tombs: Tombs, journals: Journal[]): Store {
    return journals.reduce((acc, j) => applyOps(acc, j.ops, tombs, j.order), base);
}

// 主項目＋所有日誌（讀取時看到的樣子）
function loadView(tombs: Tombs = loadTombs(), journals: Journal[] = loadJournals()): Store {
    return applyJournals(loadStore(tombs), tombs, journals);
}

function loadSettingsView(journals: Journal[] = loadJournals()): DrawingSettings {
    if (!journals.some((j) => Object.keys(j.settings).length)) return loadSettings();
    return sanitizeSettings(Object.assign({}, loadSettings(), ...journals.map((j) => j.settings)));
}

// 實際的初始載入在檔案最後面（所有常數都初始化之後才讀 localStorage，
// 不會碰到尚未初始化的 const — TDZ）
let store: Store = {};
let settings: DrawingSettings = DEFAULT_SETTINGS;
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

// ── 待寫入的改動（依物件 id）──────────────────────────────────────────
//
// popout 是另一個 window，module state 不共用，靠同一個 localStorage 項目
// 與 storage 事件同步。本視窗的改動先記成「每個物件 id 的最新版本」，
// 刪除記成刪除時間（墓碑）。寫出時一律「讀最新的 localStorage → 疊上本
// 視窗的改動 → 寫回」，而且整段在跨視窗的 Web Lock 裡做（見 withLock），
// 兩個視窗不會同時讀到同一份舊資料再各自寫回。收到別的視窗寫入時也是
// 「對方版本 → 疊上本視窗還沒寫出去的改動」。同一個物件兩邊都改時，
// revision 較大的一方勝出；刪除比修改新就維持刪除。
type Op = Drawing | Tombstone;
const pending = new Map<string, Map<string, Op>>();
// 只重放實際移動的物件，不覆蓋遠端對其他物件的排序。
const pendingOrder: OrderOps = new Map();

function record(key: string, id: string, op: Op) {
    let ops = pending.get(key);
    if (!ops) {
        ops = new Map();
        pending.set(key, ops);
    }
    ops.set(id, op);
    if (!isTombstone(op)) {
        const moves = pendingOrder.get(key);
        if (moves) pendingOrder.set(key, moves.map((m) => m.id === id ? { ...m, revision: drawingRevision(op) } : m));
    }
}

function applyOps(
    base: Store,
    ops: Map<string, Map<string, Op>>,
    tombs: Tombs,
    order: OrderOps = pendingOrder,
): Store {
    if (!ops.size && !order.size) return base;
    const out: Store = { ...base };
    for (const [key, byId] of ops) {
        const list = [...(out[key] ?? [])];
        for (const [id, op] of byId) {
            const i = list.findIndex((x) => x.id === id);
            if (isTombstone(op)) {
                if (i >= 0 && drawingRevision(list[i]!) <= tombRevision(op)) list.splice(i, 1);
                const t = (tombs[key] ??= {});
                if (t[id] === undefined || tombRevision(t[id]!) < tombRevision(op)) t[id] = op;
            } else if (buried(tombs, key, op)) {
                // 別的視窗在本視窗修改之後刪掉了它 — 這筆（較舊的）修改作廢。
                // 主項目裡同 id 的版本只有「不比刪除新」時才跟著移除；比刪除
                // 還新的版本是刪除之後重建／復原的，要保留
                const at = tombs[key]![id]!;
                if (i >= 0 && drawingRevision(list[i]!) <= tombRevision(at)) list.splice(i, 1);
            } else if (i >= 0) {
                if (drawingRevision(list[i]!) <= drawingRevision(op)) list[i] = op;
            } else {
                list.push(op);
            }
        }
        // 合併時不刪使用者的物件：兩個視窗各自在 199 個時再加一個，合併
        // 後暫時超過上限（軟上限）— 通知使用者，新增在 UI 端擋住
        if (list.length > MAX_DRAWINGS_PER_SYMBOL && (base[key]?.length ?? 0) <= MAX_DRAWINGS_PER_SYMBOL) {
            noteDrawings(
                `${key} 的畫圖物件合併後有 ${list.length} 個，超過 ${MAX_DRAWINGS_PER_SYMBOL} 個上限；刪除部分物件之前無法再新增。`,
            );
        }
        if (list.length) out[key] = list;
        else delete out[key];
    }
    for (const [key, moves] of order) {
        const list = out[key];
        if (!list) continue;
        const next = [...list];
        for (const move of moves) {
            const i = next.findIndex((d) => d.id === move.id);
            // 遠端已改過同一物件時，舊排序操作也作廢。
            if (i < 0 || drawingRevision(next[i]!) !== move.revision) continue;
            const anchor = move.after === null ? -1 : next.findIndex((d) => d.id === move.after);
            if (move.after !== null && anchor < 0) continue;
            const [item] = next.splice(i, 1);
            const at = move.after === null ? 0 : next.findIndex((d) => d.id === move.after) + 1;
            next.splice(at, 0, item!);
        }
        out[key] = next;
    }
    return out;
}

function applyPending(base: Store, tombs: Tombs = loadTombs()): Store {
    return applyOps(base, pending, tombs);
}

// 儲存失敗（多半是配額滿）— 畫面上的物件還在，但關掉就沒了，要讓
// 使用者知道。saveError 給 UI 顯示；notice 每一段連續失敗只發一次。
let saveError = false;
let saveErrorNoticePending = false;

// cross-window sync — 沒有這段，在主視窗畫的線不會出現在已開啟的彈出視窗
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY || e.key === TOMB_KEY) {
            reloadDrawingsFromStorage();
        } else if (e.key === SETTINGS_KEY) {
            reloadDrawingSettingsFromStorage();
        } else if (e.key?.startsWith(JOURNAL_PREFIX) && e.newValue) {
            // 別的視窗關掉時留下日誌：先顯示出來，再排一次（鎖內的）寫入把它併進主項目
            reloadDrawingsFromStorage();
            reloadDrawingSettingsFromStorage();
            writeTimer ??= setTimeout(flushDrawingWrites, WRITE_THROTTLE_MS);
        }
    });
}

// ── 跨視窗鎖 ─────────────────────────────────────────────────────────
//
// localStorage 沒有跨視窗鎖（HTML 規範明說不能假設有），「讀→合併→寫」
// 要自己序列化。Web Locks API（Chromium／WebView2、WebKit 都有）以同一個
// origin 為範圍排隊；沒有這個 API 的環境直接同步做（至少同一視窗內仍是
// 原子的）。
const LOCK_NAME = 'sj-chart-drawings';
type LockManagerLike = { request: (name: string, cb: () => unknown) => Promise<unknown> };
let lockOverride: LockManagerLike | null | undefined; // 測試用；undefined＝用 navigator.locks

function lockManager(): LockManagerLike | null {
    if (lockOverride !== undefined) return lockOverride;
    const nav = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }) : undefined;
    return nav?.locks && typeof nav.locks.request === 'function' ? nav.locks : null;
}

function withLock(fn: () => void, failed?: () => void) {
    const locks = lockManager();
    if (!locks) {
        fn();
        return;
    }
    locks.request(LOCK_NAME, () => fn()).catch(() => {
        noteDrawings('畫圖資料鎖定失敗，請稍後再試。');
        failed?.();
    });
}

export function __setDrawingLocksForTest(locks: LockManagerLike | null | undefined) {
    lockOverride = locks;
}

// 落地節流：拖曳、拉透明度滑桿時每個 mousemove 都會改 store。畫面照常
// 即時更新（emit），localStorage 最多每 WRITE_THROTTLE_MS 寫一次 — 每寫
// 一次其他視窗就要重新解析整份 JSON。
const WRITE_THROTTLE_MS = 300;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | null = null;

// 讀→合併→寫（在鎖內呼叫）。寫出的是「當下」的 pending；寫出期間又有
// 新改動的物件保留在 pending，下一輪再寫
function writeDrawingsNow() {
    const journals = loadJournals();
    if (!pending.size && !pendingOrder.size && !journals.length) return;
    const tombs = loadTombs();
    const base = loadView(tombs, journals);
    acceptRemoteVersions(base, tombs);
    const snapshot = new Map([...pending].map(([k, ops]) => [k, new Map(ops)]));
    const orderSnap = new Map(pendingOrder);
    const next = applyOps(base, snapshot, tombs, orderSnap);
    const journalSettings = journals.filter((j) => Object.keys(j.settings).length);
    const now = Date.now();
    for (const [key, ids] of Object.entries(tombs)) {
        for (const [id, at] of Object.entries(ids)) if (now - (typeof at === 'number' ? at : at.updatedAt) > TOMBSTONE_TTL_MS) delete ids[id];
        if (!Object.keys(ids).length) delete tombs[key];
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        localStorage.setItem(TOMB_KEY, JSON.stringify(tombs));
        if (journalSettings.length) {
            // 關窗日誌裡的設定也併進主設定（本視窗還沒寫出的欄位之後照常寫）
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(loadSettingsView(journalSettings)));
        }
        // 已併進主項目的日誌刪掉 — 只刪內容與讀到時相同的那一版（每次
        // 關窗寫的是新的項目名稱，照理不會變；比對內容是第二道保險）
        for (const j of journals) {
            if (localStorage.getItem(j.name) === j.raw) localStorage.removeItem(j.name);
        }
    } catch {
        // 配額滿或隱私模式：改動留在 pending（跨視窗同步不會把它們蓋掉，
        // 下一次改動會再試著寫出），並讓 UI 提示使用者
        if (!saveError) {
            saveError = true;
            saveErrorNoticePending = true;
            emit();
        }
        return;
    }
    for (const [key, ops] of snapshot) {
        const cur = pending.get(key);
        if (!cur) continue;
        for (const [id, op] of ops) if (cur.get(id) === op) cur.delete(id);
        if (!cur.size) pending.delete(key);
    }
    for (const [key, order] of orderSnap) if (pendingOrder.get(key) === order) pendingOrder.delete(key);
    rememberVersions(next, tombs);
    store = applyPending(next, tombs);
    emit();
    if (saveError) {
        saveError = false;
        emit();
    }
}

export function flushDrawingWrites() {
    if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (!pending.size && !pendingOrder.size && !journalNames().length) return;
    withLock(writeDrawingsNow);
}

// 設定依欄位合併：本視窗改過哪幾個欄位就只寫那幾個，別的視窗同時改的
// 其他欄位（例如一邊開共用、一邊改樣式）都留下
const pendingSettingKeys = new Set<keyof DrawingSettings>();

function pickSettings(from: DrawingSettings, keys: Iterable<keyof DrawingSettings>): Partial<DrawingSettings> {
    const out: Partial<DrawingSettings> = {};
    for (const k of keys) (out as Record<string, unknown>)[k] = from[k];
    return out;
}

function writeSettingsNow() {
    if (!pendingSettingKeys.size) return;
    const keys = [...pendingSettingKeys];
    const written = pickSettings(settings, keys);
    const merged = { ...loadSettingsView(), ...written };
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
    } catch {
        return; // 設定寫不進去只影響下次開啟的預設樣式，不另外提示
    }
    for (const k of keys) if (settings[k] === written[k]) pendingSettingKeys.delete(k);
}

export function flushDrawingSettings() {
    if (settingsTimer !== null) {
        clearTimeout(settingsTimer);
        settingsTimer = null;
    }
    if (!pendingSettingKeys.size) return;
    withLock(writeSettingsNow);
}

if (typeof window !== 'undefined') {
    // 還在節流窗內就關視窗 — 最後一筆不能丟。pagehide 裡等不到非同步
    // 的鎖：只寫本視窗的日誌（見「關窗日誌」），不在鎖外動主項目
    window.addEventListener('pagehide', writeDrawingJournal);
}

// pagehide：本視窗還沒寫出去的改動同步寫進自己的日誌項目
export function writeDrawingJournal() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    if (settingsTimer !== null) clearTimeout(settingsTimer);
    writeTimer = null;
    settingsTimer = null;
    if (!pending.size && !pendingOrder.size && !pendingSettingKeys.size) return;
    // 每次都寫新的項目名稱（時間＋視窗＋序號）：bfcache 回來後又改了東西
    // 再關一次時，另一個視窗正在合併、準備刪除的舊日誌不會連新內容一起
    // 被刪掉。名稱以時間開頭，依名稱排序就是寫入順序
    const name = `${JOURNAL_PREFIX}${Date.now().toString(36).padStart(9, '0')}:${WINDOW_ID}:${++journalSeq}`;
    const ops: Record<string, Record<string, Op>> = {};
    for (const [key, byId] of pending) ops[key] = Object.fromEntries(byId);
    const order: Record<string, OrderMove[]> = Object.fromEntries(pendingOrder);
    const journal = {
        at: Date.now(),
        ops,
        order,
        settings: pickSettings(settings, pendingSettingKeys),
    };
    try {
        localStorage.setItem(name, JSON.stringify(journal));
    } catch {
        return; // 配額滿：已經在關窗，沒有別的地方可放
    }
    // 自己的日誌再次被讀到時不是遠端更新，不應清除自己的歷史。
    const tombs = loadTombs();
    for (const [key, byId] of pending) for (const [id, op] of byId) {
        if (isTombstone(op)) (tombs[key] ??= {})[id] = op;
    }
    rememberVersions(store, tombs);
    pending.clear();
    pendingOrder.clear();
    pendingSettingKeys.clear();
}

function persist() {
    writeTimer ??= setTimeout(flushDrawingWrites, WRITE_THROTTLE_MS);
    emit();
}

// 別的視窗寫入了 — 以它的版本為準，再疊上本視窗還沒寫出去的改動
export function reloadDrawingsFromStorage() {
    const tombs = loadTombs();
    const base = loadView(tombs);
    acceptRemoteVersions(base, tombs);
    store = applyPending(base, tombs);
    emit();
}

export function reloadDrawingSettingsFromStorage() {
    // 本視窗還沒寫出去的欄位保留自己的
    settings = { ...loadSettingsView(), ...pickSettings(settings, pendingSettingKeys) };
    emit();
}

// 儲存是否失敗中（UI 顯示警示）
export function drawingsSaveFailed(): boolean {
    return saveError;
}

// 本段連續失敗還沒提示過就回 true（只回一次）— 多張圖同時訂閱時只會
// 有一張圖發出通知
export function takeDrawingSaveErrorNotice(): boolean {
    if (!saveErrorNoticePending) return false;
    saveErrorNoticePending = false;
    return true;
}

// 設定變動（改預設樣式、拉填色滑桿）同樣節流落地，畫面即時更新
function persistSettings() {
    settingsTimer ??= setTimeout(flushDrawingSettings, WRITE_THROTTLE_MS);
    emit();
}

const EMPTY: Drawing[] = [];

export function getDrawings(key: string): Drawing[] {
    return store[key] ?? EMPTY;
}

// 目前版本包含尚未落地的刪除；缺席的物件以墓碑版本識別。
export function getDrawingVersion(key: string, id: string, tombs: Tombs = loadTombs()): Revision | null {
    const drawing = getDrawings(key).find((d) => d.id === id);
    if (drawing) return drawingRevision(drawing);
    const op = pending.get(key)?.get(id);
    const at = tombs[key]?.[id];
    if (op !== undefined && isTombstone(op)) {
        return at === undefined || tombRevision(op) > tombRevision(at) ? tombRevision(op) : tombRevision(at);
    }
    return at === undefined ? null : tombRevision(at);
}

const remoteListeners = new Set<(key: string, ids: ReadonlySet<string>) => void>();
const observedVersions = new Map<string, Map<string, Revision>>();
export function subscribeDrawingRemoteChanges(listener: (key: string, ids: ReadonlySet<string>) => void) {
    remoteListeners.add(listener);
    return () => { remoteListeners.delete(listener); };
}
function versionsOf(base: Store, tombs: Tombs) {
    const all = new Map<string, Map<string, Revision>>();
    const put = (key: string, id: string, revision: Revision) => {
        observeRevision(revision);
        const byId = all.get(key) ?? new Map<string, Revision>();
        if (!byId.has(id) || byId.get(id)! < revision) byId.set(id, revision);
        all.set(key, byId);
    };
    for (const [key, list] of Object.entries(base)) for (const d of list) put(key, d.id, drawingRevision(d));
    for (const [key, ids] of Object.entries(tombs)) for (const [id, t] of Object.entries(ids)) put(key, id, tombRevision(t));
    return all;
}
function rememberVersions(base: Store, tombs: Tombs) {
    for (const [key, ids] of versionsOf(base, tombs)) observedVersions.set(key, ids);
}
function acceptRemoteVersions(base: Store, tombs: Tombs) {
    for (const [key, ids] of versionsOf(base, tombs)) {
        const known = observedVersions.get(key);
        const changed = new Set<string>();
        for (const [id, revision] of ids) {
            if (!known?.has(id) || known.get(id)! < revision) {
                changed.add(id);
                const op = pending.get(key)?.get(id);
                if (op !== undefined && (isTombstone(op) ? tombRevision(op) : drawingRevision(op)) < revision) {
                    pending.get(key)!.delete(id);
                }
            }
        }
        observedVersions.set(key, ids);
        if (changed.size) for (const listener of remoteListeners) listener(key, changed);
    }
}

export function noteDrawingHistoryConflict() {
    noteDrawings('部分畫圖物件已被其他視窗修改或刪除，已略過這些物件的復原／重做。');
}

// 在替歷史快照蓋新 revision 以前，先合併最新持久化資料（storage 事件可能
// 還沒送達）。僅允許反向操作仍是歷史預期版本的物件，含刪除墓碑。
export function applyDrawingHistory(step: HistoryStep, applied: (versions: Map<string, Revision | null>) => void) {
    // 複製候選項目：鎖等待期間遠端同步可能會移除原歷史中的項目。
    const candidates = [...step.changes];
    withLock(() => {
        const tombs = loadTombs();
        const base = loadView(tombs);
        acceptRemoteVersions(base, tombs);
        store = applyPending(base, tombs);
        const current = getDrawings(step.key);
        const expectedSide = step.side === 'before' ? 'after' : 'before';
        const changes = candidates.filter((c) => {
            if (!step.changes.some((valid) => valid.id === c.id)) return false;
            const exists = current.some((d) => d.id === c.id);
            const expected = expectedSide === 'after' ? c.afterVersion : c.beforeVersion;
            const version = getDrawingVersion(step.key, c.id, tombs);
            const matches = exists === !!c[expectedSide] && version === expected;
            if (matches && version !== null) observeRevision(version);
            return matches;
        });
        if (changes.length) {
            commit(step.key, applyChanges(current, changes, step.side, step.order));
            // 不留節流窗：仍在同一把 Web Lock 內立即落地。
            writeDrawingsNow();
        } else {
            emit();
        }
        if (changes.length !== candidates.length) noteDrawingHistoryConflict();
        applied(new Map(changes.map((c) => [c.id, getDrawingVersion(step.key, c.id)])));
    }, () => applied(new Map()));
}

export function getDrawingSettings(): DrawingSettings {
    return settings;
}

export function setDrawingSettings(patch: Partial<DrawingSettings>) {
    settings = { ...settings, ...patch };
    for (const k of Object.keys(patch) as (keyof DrawingSettings)[]) pendingSettingKeys.add(k);
    persistSettings();
}

function subscribe(l: () => void) {
    listeners.add(l);
    return () => {
        listeners.delete(l);
    };
}

export function useDrawings(key: string): Drawing[] {
    return useSyncExternalStore(
        subscribe,
        () => store[key] ?? EMPTY,
        () => EMPTY,
    );
}

export function useDrawingSettings(): DrawingSettings {
    return useSyncExternalStore(
        subscribe,
        () => settings,
        () => DEFAULT_SETTINGS,
    );
}

export function useDrawingsSaveFailed(): boolean {
    return useSyncExternalStore(subscribe, drawingsSaveFailed, () => false);
}

function newId(): string {
    return `dw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}


// 已達上限回傳 null — 呼叫端的工具列會先把畫圖按鈕停用
export function addDrawing(
    key: string,
    tool: DrawingTool,
    anchors: DrawingAnchor[],
    style: DrawingStyle,
    extra?: Pick<Drawing, 'text' | 'fib' | 'name'>,
): Drawing | null {
    if ((store[key]?.length ?? 0) >= MAX_DRAWINGS_PER_SYMBOL) return null;
    const now = stamp();
    const drawing: Drawing = {
        id: newId(),
        tool,
        anchors,
        style: { ...style },
        locked: false,
        hidden: false,
        createdAt: now,
        updatedAt: now,
        revision: nextRevision(),
        ...(extra?.name ? { name: extra.name } : {}),
        ...(tool === 'text' ? { text: extra?.text ?? '' } : {}),
        ...(tool === 'fib' ? { fib: sanitizeFibOptions(extra?.fib ?? defaultFibOptions()) } : {}),
    };
    store = { ...store, [key]: [...(store[key] ?? []), drawing] };
    record(key, drawing.id, drawing);
    persist();
    return drawing;
}

// 把 key 的清單換成 next，並把有變動的物件記進待寫入（依 id）
function commit(key: string, nextIn: Drawing[]) {
    const before = store[key] ?? EMPTY;
    for (const d of before) {
        lastStamp = Math.max(lastStamp, d.updatedAt);
        observeRevision(drawingRevision(d));
    }
    const now = stamp();
    const ids = new Set(nextIn.map((d) => d.id));
    for (const d of before) if (!ids.has(d.id)) record(key, d.id, { revision: nextRevision(), updatedAt: now });
    const prev = new Map(before.map((d) => [d.id, d]));
    // 有變動的物件一律取得新 revision（含套用歷史快照）。
    const next = nextIn.map((d) => {
        if (prev.get(d.id) === d) return d;
        const stamped = { ...d, updatedAt: now, revision: nextRevision() };
        record(key, d.id, stamped);
        return stamped;
    });
    // 合併預設把新物件加在尾端；調整圖層或復原刪除插回中間時，
    // 需要另外保存順序，不能只比較共同物件的相對位置。
    const a = [
        ...before.filter((d) => ids.has(d.id)),
        ...next.filter((d) => !prev.has(d.id)),
    ].map((d) => d.id);
    const b = next.map((d) => d.id);
    if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
        const moves = [...(pendingOrder.get(key) ?? [])];
        // 只為這次有改動的物件存相對位置，鄰居的前驅改變不算移動。
        next.forEach((d, i) => {
            if (prev.get(d.id) === d) return;
            moves.push({ id: d.id, after: next[i - 1]?.id ?? null, revision: drawingRevision(d) });
        });
        pendingOrder.set(key, moves);
    }
    store = { ...store, [key]: next };
    persist();
}

// 整份換掉（復原／重做、多選操作）— 依物件記錄差異，跨視窗照樣合併
export function replaceDrawings(key: string, next: Drawing[]) {
    const before = store[key] ?? EMPTY;
    if (before === next) return;
    commit(key, next);
}

// 調整圖層：把 id 移到 toIndex（陣列尾端＝最上層）
export function moveDrawing(key: string, id: string, toIndex: number) {
    const list = store[key];
    const from = list?.findIndex((d) => d.id === id) ?? -1;
    if (!list || from < 0) return;
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (to === from) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, { ...item! }); // 只讓實際移動的物件取得新版本／進入歷史
    commit(key, next);
}

// 全部鎖定／解鎖（ids 省略＝整個商品）
export function setDrawingsLocked(key: string, locked: boolean, ids?: readonly string[]) {
    const list = store[key];
    if (!list) return;
    const pick = ids ? new Set(ids) : null;
    if (!list.some((d) => (!pick || pick.has(d.id)) && d.locked !== locked)) return;
    commit(
        key,
        list.map((d) => ((!pick || pick.has(d.id)) && d.locked !== locked ? { ...d, locked } : d)),
    );
}

// 一次刪多個（多選刪除）；鎖定的保留
export function removeDrawings(key: string, ids: readonly string[]) {
    const list = store[key];
    if (!list) return;
    const drop = new Set(ids);
    const next = list.filter((d) => !drop.has(d.id) || d.locked);
    if (next.length !== list.length) commit(key, next);
}

export function updateDrawing(key: string, id: string, patch: Partial<Omit<Drawing, 'id'>>) {
    const list = store[key];
    if (!list?.some((d) => d.id === id)) return;
    commit(
        key,
        list.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    );
}

export function removeDrawing(key: string, id: string) {
    const list = store[key];
    if (!list?.some((d) => d.id === id)) return;
    commit(
        key,
        list.filter((d) => d.id !== id),
    );
}

// 複製：偏移交給呼叫端決定。用畫面像素位移再換回時間／價格，水平線這種
// 「時間不影響外觀」的物件才不會複製出一條完全疊在原處、看不見的線。
export function duplicateDrawing(
    key: string,
    id: string,
    shift: (a: DrawingAnchor) => DrawingAnchor,
): Drawing | null {
    const source = (store[key] ?? []).find((d) => d.id === id);
    if (!source) return null;
    return addDrawing(key, source.tool, source.anchors.map(shift), source.style, {
        text: source.text,
        fib: source.fib,
        name: source.name,
    });
}

// 隱藏的物件點不到，取消選取後就只能從這裡找回來
export function showAllDrawings(key: string) {
    const list = store[key];
    if (!list?.some((d) => d.hidden)) return;
    commit(
        key,
        list.map((d) => (d.hidden ? { ...d, hidden: false } : d)),
    );
}

// 一鍵清除目前商品所有畫圖 — 鎖定的物件保留（鎖定的用意就是防誤刪）
export function clearDrawings(key: string) {
    const list = store[key];
    if (!list?.length) return;
    commit(
        key,
        list.filter((d) => d.locked),
    );
}

// 測試用 — 清乾淨 module state 與 localStorage
export function __resetDrawingsForTest() {
    if (writeTimer !== null) clearTimeout(writeTimer);
    if (settingsTimer !== null) clearTimeout(settingsTimer);
    writeTimer = null;
    settingsTimer = null;
    pending.clear();
    pendingOrder.clear();
    pendingSettingKeys.clear();
    notices = [];
    noticed.clear();
    observedVersions.clear();
    revisionCounter = 0;
    lastStamp = 0;
    lockOverride = null;
    saveError = false;
    saveErrorNoticePending = false;
    store = {};
    settings = DEFAULT_SETTINGS;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETTINGS_KEY);
        localStorage.removeItem(TOMB_KEY);
        for (const name of journalNames()) localStorage.removeItem(name);
    } catch {
        // ignore
    }
}

// ── 初始載入 ─────────────────────────────────────────────────────────
// 放在最後：loadView／loadSettingsView 會用到上面所有常數與函式
store = loadView();
rememberVersions(store, loadTombs());
settings = loadSettingsView();
