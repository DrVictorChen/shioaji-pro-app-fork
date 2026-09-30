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

export const DEFAULT_FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

export interface DrawingAnchor {
    time: number; // UTC 秒（與 lightweight-charts 的 UTCTimestamp 同一刻度）
    price: number;
}

export interface DrawingStyle {
    color: string; // 線色（#rrggbb）
    width: number; // 線寬 1–4
    dash: 'solid' | 'dashed';
    fillOpacity: number; // 方框／通道／斐波那契的填色透明度 0–1
}

export interface Drawing {
    id: string;
    tool: DrawingTool;
    anchors: DrawingAnchor[];
    style: DrawingStyle;
    locked: boolean; // 鎖定：不可拖曳、改價、刪除（仍可選取與改樣式）
    hidden: boolean; // 隱藏：不繪製，但仍保存
    createdAt: number;
    name?: string; // 物件列表裡的名稱（沒設就用工具名稱）
    text?: string; // 文字註記的內容
    levels?: number[]; // 斐波那契的比例（沒設就用 DEFAULT_FIB_LEVELS）
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

// 新物件除了顏色以外的預設（線寬、線型、方框填色）
export type DrawingBaseStyle = Omit<DrawingStyle, 'color'>;

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
    return { ...s.defaultStyle, color: s.toolColors[tool] ?? TOOL_DEFAULT_COLORS[mode][tool] };
}

const STORAGE_KEY = 'sj-pro-chart-drawings';
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

export function sanitizeStyle(v: unknown, fallbackColor: string): DrawingStyle {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        color: isDrawingColor(o.color) ? o.color : fallbackColor,
        ...sanitizeBaseStyle(o, DEFAULT_SETTINGS.defaultStyle),
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
        ...(typeof d.name === 'string' && d.name.trim()
            ? { name: d.name.trim().slice(0, MAX_NAME_LENGTH) }
            : {}),
        ...(tool === 'text'
            ? { text: typeof d.text === 'string' ? d.text.slice(0, MAX_TEXT_LENGTH) : '' }
            : {}),
        ...(tool === 'fib' ? sanitizeLevels(d.levels) : {}),
    };
}

// 斐波那契比例：有限數值、-5～5、去重排序、最多 16 個；壞掉就不帶（用預設）
export function sanitizeLevels(v: unknown): { levels?: number[] } {
    if (!Array.isArray(v)) return {};
    const out = [...new Set(v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x) && x >= -5 && x <= 5))]
        .sort((a, b) => a - b)
        .slice(0, 16);
    return out.length ? { levels: out } : {};
}

export function fibLevelsOf(d: Pick<Drawing, 'levels'>): number[] {
    return d.levels?.length ? d.levels : DEFAULT_FIB_LEVELS;
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
    };
}

// ── 儲存 ─────────────────────────────────────────────────────────────

type Store = Record<string, Drawing[]>;

function loadStore(): Store {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: Store = {};
        for (const [key, list] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(list)) continue;
            const clean: Drawing[] = [];
            for (const item of list) {
                const d = sanitizeDrawing(item);
                if (d) clean.push(d);
            }
            if (clean.length) out[key] = clean;
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

let store: Store = loadStore();
let settings: DrawingSettings = loadSettings();
const listeners = new Set<() => void>();

function emit() {
    for (const l of listeners) l();
}

// ── 待寫入的改動（依物件 id）──────────────────────────────────────────
//
// popout 是另一個 window，module state 不共用，靠同一個 localStorage 項目
// 與 storage 事件同步。本視窗的改動先記成「每個物件 id 的最新版本」，
// 刪除記成墓碑（null）。寫出時一律「讀最新的 localStorage → 疊上本視窗
// 的改動 → 寫回」，收到別的視窗寫入時也是「對方版本 → 疊上本視窗還沒
// 寫出去的改動」。兩個視窗在節流窗內各改同一商品的不同物件，兩邊的
// 改動都會留下；只有同一個物件兩邊都改時，較晚寫出的那一方勝出。
const pending = new Map<string, Map<string, Drawing | null>>();
// 本視窗調整過圖層順序的商品：記下想要的 id 順序，疊上對方版本時照排
const pendingOrder = new Map<string, string[]>();

function record(key: string, id: string, d: Drawing | null) {
    let ops = pending.get(key);
    if (!ops) {
        ops = new Map();
        pending.set(key, ops);
    }
    ops.set(id, d);
}

function applyPending(base: Store): Store {
    if (!pending.size && !pendingOrder.size) return base;
    const out: Store = { ...base };
    for (const [key, ops] of pending) {
        const list = [...(out[key] ?? [])];
        for (const [id, d] of ops) {
            const i = list.findIndex((x) => x.id === id);
            if (d === null) {
                if (i >= 0) list.splice(i, 1);
            } else if (i >= 0) {
                list[i] = d;
            } else {
                list.push(d);
            }
        }
        if (list.length) out[key] = list;
        else delete out[key];
    }
    for (const [key, order] of pendingOrder) {
        const list = out[key];
        if (!list) continue;
        const rank = new Map(order.map((id, i) => [id, i]));
        // 本視窗排過的依本視窗順序；對方新加的（不在排序裡）保持在原位之後
        const known = list.filter((d) => rank.has(d.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
        const unknown = list.filter((d) => !rank.has(d.id));
        out[key] = [...known, ...unknown];
    }
    return out;
}

// 儲存失敗（多半是配額滿）— 畫面上的物件還在，但關掉就沒了，要讓
// 使用者知道。saveError 給 UI 顯示；notice 每一段連續失敗只發一次。
let saveError = false;
let saveErrorNoticePending = false;

// cross-window sync — 沒有這段，在主視窗畫的線不會出現在已開啟的彈出視窗
if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY) {
            reloadDrawingsFromStorage();
        } else if (e.key === SETTINGS_KEY) {
            // 本視窗還有沒寫出去的設定就保留自己的，稍後的寫入會覆蓋
            if (settingsTimer !== null) return;
            reloadDrawingSettingsFromStorage();
        }
    });
}

// 落地節流：拖曳、拉透明度滑桿時每個 mousemove 都會改 store。畫面照常
// 即時更新（emit），localStorage 最多每 WRITE_THROTTLE_MS 寫一次 — 每寫
// 一次其他視窗就要重新解析整份 JSON。
const WRITE_THROTTLE_MS = 300;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let settingsTimer: ReturnType<typeof setTimeout> | null = null;

export function flushDrawingWrites() {
    if (writeTimer !== null) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    if (!pending.size && !pendingOrder.size) return;
    // 讀最新版本再疊上本視窗的改動 — 別的視窗剛寫入、storage 事件還沒
    // 送到這裡時，也不會把對方的物件蓋掉
    const next = applyPending(loadStore());
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
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
    pending.clear();
    pendingOrder.clear();
    if (saveError) {
        saveError = false;
        emit();
    }
}

export function flushDrawingSettings() {
    if (settingsTimer === null) return;
    clearTimeout(settingsTimer);
    settingsTimer = null;
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // 設定寫不進去只影響下次開啟的預設樣式，不另外提示
    }
}

if (typeof window !== 'undefined') {
    // 還在節流窗內就關視窗 — 最後一筆不能丟
    window.addEventListener('pagehide', () => {
        flushDrawingWrites();
        flushDrawingSettings();
    });
}

function persist() {
    writeTimer ??= setTimeout(flushDrawingWrites, WRITE_THROTTLE_MS);
    emit();
}

// 別的視窗寫入了 — 以它的版本為準，再疊上本視窗還沒寫出去的改動
export function reloadDrawingsFromStorage() {
    store = applyPending(loadStore());
    emit();
}

export function reloadDrawingSettingsFromStorage() {
    settings = loadSettings();
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

export function getDrawingSettings(): DrawingSettings {
    return settings;
}

export function setDrawingSettings(patch: Partial<DrawingSettings>) {
    settings = { ...settings, ...patch };
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

// 每個商品鍵的上限。整份 store 是一個 localStorage 項目，無上限地長下去
// 每次寫入與跨視窗解析都會變慢，也會吃掉其他設定的配額。
export const MAX_DRAWINGS_PER_SYMBOL = 200;

// 已達上限回傳 null — 呼叫端的工具列會先把畫圖按鈕停用
export function addDrawing(
    key: string,
    tool: DrawingTool,
    anchors: DrawingAnchor[],
    style: DrawingStyle,
    extra?: Pick<Drawing, 'text' | 'levels' | 'name'>,
): Drawing | null {
    if ((store[key]?.length ?? 0) >= MAX_DRAWINGS_PER_SYMBOL) return null;
    const drawing: Drawing = {
        id: newId(),
        tool,
        anchors,
        style: { ...style },
        locked: false,
        hidden: false,
        createdAt: Date.now(),
        ...(extra?.name ? { name: extra.name } : {}),
        ...(tool === 'text' ? { text: extra?.text ?? '' } : {}),
        ...(tool === 'fib' && extra?.levels ? { levels: [...extra.levels] } : {}),
    };
    store = { ...store, [key]: [...(store[key] ?? []), drawing] };
    record(key, drawing.id, drawing);
    persist();
    return drawing;
}

// 把 key 的清單換成 next，並把有變動的物件記進待寫入（依 id）
function commit(key: string, next: Drawing[]) {
    const before = store[key] ?? EMPTY;
    const ids = new Set(next.map((d) => d.id));
    for (const d of before) if (!ids.has(d.id)) record(key, d.id, null);
    const prev = new Map(before.map((d) => [d.id, d]));
    for (const d of next) if (prev.get(d.id) !== d) record(key, d.id, d);
    // 共同物件的相對順序變了（調整圖層）— 記下想要的順序
    const common = (list: Drawing[], other: Map<string, unknown> | Set<string>) =>
        list.filter((d) => other.has(d.id)).map((d) => d.id);
    const a = common(before, ids);
    const b = common(next, prev);
    if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
        pendingOrder.set(key, next.map((d) => d.id));
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
    next.splice(to, 0, item!);
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
        levels: source.levels,
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
    saveError = false;
    saveErrorNoticePending = false;
    store = {};
    settings = DEFAULT_SETTINGS;
    try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SETTINGS_KEY);
    } catch {
        // ignore
    }
}
