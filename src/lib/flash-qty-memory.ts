// 閃電下單「記住數量」（每個面板的開關，預設開；新面板與升級前的面板都開）：開啟時依單位分開記 —
// 整股（張）、盤中零股（股）、期貨／選擇權（口）各一個數量，跟面板設定一起存
// （workspace block／彈出視窗依視窗 id）。還原前一律重新檢查單位上限，
// 不合法的數量不會被帶出來。
import { ODD_LOT_MAX_SHARES } from './odd-lot';

export type FlashQtySlot = 'Common' | 'IntradayOdd' | 'F';
export type FlashQtyMemory = Partial<Record<FlashQtySlot, number>>;
/** Stored panel setting: false = 使用者關閉記住數量；undefined（沒存過）＝預設開啟 */
export type FlashQtySetting = FlashQtyMemory | false;

const SLOTS: readonly FlashQtySlot[] = ['Common', 'IntradayOdd', 'F'];
// 與設定面板數量欄相同的上限（normalizeChartOrder）
const MAX: Record<FlashQtySlot, number> = { Common: 9999, IntradayOdd: ODD_LOT_MAX_SHARES, F: 9999 };
const TEXT: Record<FlashQtySlot, [string, string]> = { Common: ['整股', '張'], IntradayOdd: ['零股', '股'], F: ['期貨', '口'] };

export function flashQtySlot(market: 'S' | 'F', lot: 'Common' | 'IntradayOdd'): FlashQtySlot {
    return market === 'F' ? 'F' : lot;
}

export function validFlashQty(slot: FlashQtySlot, v: unknown): v is number {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= MAX[slot];
}

/** The remembered quantity of one unit; `invalid` = something was stored but fails the unit's limits. */
export function rememberedFlashQty(mem: FlashQtyMemory | undefined, slot: FlashQtySlot): { qty: number | undefined; invalid: boolean } {
    if (!mem || !Object.prototype.hasOwnProperty.call(mem, slot)) return { qty: undefined, invalid: false };
    const v = mem[slot];
    return validFlashQty(slot, v) ? { qty: v, invalid: false } : { qty: undefined, invalid: true };
}

export function withRememberedFlashQty(mem: FlashQtyMemory, slot: FlashQtySlot, qty: number): FlashQtyMemory {
    return validFlashQty(slot, qty) ? { ...mem, [slot]: qty } : mem;
}

/**
 * Stored (untrusted) value → setting. Only an explicit `false` is "off"; a
 * missing (never saved, e.g. an upgraded panel) or malformed value is "on"
 * with nothing remembered yet.
 */
export function sanitizeFlashQtySetting(raw: unknown): FlashQtySetting {
    if (raw === false) return false;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: FlashQtyMemory = {};
    for (const slot of SLOTS) {
        if (Object.prototype.hasOwnProperty.call(raw, slot)) out[slot] = (raw as Record<string, number>)[slot];
    }
    return out;
}

export function flashQtyMemoryText(mem: FlashQtyMemory): string {
    const parts = SLOTS.filter(s => validFlashQty(s, mem[s])).map(s => `${TEXT[s][0]} ${mem[s]!.toLocaleString('en-US')} ${TEXT[s][1]}`);
    return parts.length ? parts.join('｜') : '尚未記住';
}
