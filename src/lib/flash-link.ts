// src/lib/flash-link.ts — 閃電下單的「對應商品」與連動群組（純規則）
//
// 每個閃電面板選一種對應商品：照選取（原商品）／現股／個股期。面板收到的
// 「來源商品」（自選選取、群組代碼或鎖定代碼）依這個設定換成實際下單的合約。
// 個股期另有規格（標準／小型）與月份（近月／次月／指定月）；近月、次月是
// 相對設定，最後交易日收盤後自動換到下一個月份。

import type { ContractInfo } from './types/contract';

export type LinkGroupId = 'A' | 'B' | 'C';
export const LINK_GROUPS: readonly LinkGroupId[] = ['A', 'B', 'C'];
export function isLinkGroup(v: unknown): v is LinkGroupId {
    return v === 'A' || v === 'B' || v === 'C';
}

export type FlashLinkKind = 'select' | 'stock' | 'future';
export interface FlashLink {
    kind: FlashLinkKind;
    /** 個股期規格：標準／小型 */
    spec: 'std' | 'mini';
    /** 個股期月份：近月／次月／指定月份（YYYYMM） */
    month: string;
    /** 價差對照列 */
    ref: boolean;
}
export const DEFAULT_FLASH_LINK: FlashLink = { kind: 'select', spec: 'std', month: 'near', ref: true };

export function normalizeFlashLink(v: unknown): FlashLink {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        kind: o.kind === 'stock' || o.kind === 'future' ? o.kind : 'select',
        spec: o.spec === 'mini' ? 'mini' : 'std',
        month: o.month === 'next' || (typeof o.month === 'string' && /^\d{6}$/.test(o.month)) ? o.month as string : 'near',
        ref: o.ref !== false,
    };
}

/** 個股期。ETF 期貨不算：spec_kind 有值就必須是 stock_fut；缺省時標的不可是 ETF（00 開頭） */
export function isStockFuture(c: Pick<ContractInfo, 'security_type' | 'underlying_kind' | 'underlying_code' | 'spec_kind'>): boolean {
    if (c.security_type !== 'FUT' || c.underlying_kind !== 'S' || !c.underlying_code) return false;
    return c.spec_kind ? c.spec_kind === 'stock_fut' : !/^00/.test(c.underlying_code);
}

/** 現股／個股期面板的標的股票；不是股票也不是個股期 → null（暫停） */
export function linkedStockCode(c: ContractInfo): string | null {
    if (c.security_type === 'STK') return c.code;
    return isStockFuture(c) ? c.underlying_code! : null;
}

function taipei(now: number): { day: string } {
    return { day: new Date(now + 8 * 3600_000).toISOString().slice(0, 10) };
}
/** 個股期最後交易日 13:30（台北）收盤的時刻；之後視為已到期。沒有日期 → null。
 * 只適用個股期 — 其他期貨（例如有夜盤的 UDF）不由這裡判斷 */
export function expiryTime(c: Pick<ContractInfo, 'last_trading_date' | 'delivery_date'>): number | null {
    const ltd = c.last_trading_date || c.delivery_date;
    if (!ltd || !/^\d{4}-\d{2}-\d{2}$/.test(ltd)) return null;
    return Date.parse(`${ltd}T13:30:00+08:00`);
}
function expired(c: ContractInfo, now: number): boolean {
    const t = expiryTime(c);
    return t !== null && now >= t;
}

export type StockFuturePick =
    | { status: 'ok'; contract: ContractInfo; hasMini: boolean; expiresToday: boolean; expiresAt: number | null; months: string[] }
    | { status: 'unlisted'; month: string }
    | { status: 'none' }
    | { status: 'noMini' }
    | { status: 'noStd' }
    | { status: 'noExpiry' }
    | { status: 'expired'; month: string };

/** 依面板的規格與月份，從某檔股票的個股期合約中選出要下單的真實月份合約 */
export function pickStockFuture(rows: ContractInfo[], link: Pick<FlashLink, 'spec' | 'month'>, now = Date.now()): StockFuturePick {
    // 近月／次月別名（…R1／…R2）不用：下單一律用真實月份
    // ETF 期貨不是個股期（spec_kind 缺省時不排除）
    const real = rows.filter(r => isStockFuture(r) && !r.target_code && /^\d{6}$/.test(r.delivery_month ?? ''));
    if (real.length === 0) return { status: 'none' };
    // 規格依實際每口股數：標準（≥1,000 股，一般 2,000）、小型（< 1,000，一般 100）；對不到就不替換
    const isMini = (r: ContractInfo) => (r.multiplier ?? 0) > 0 && r.multiplier! < 1000;
    const isStd = (r: ContractInfo) => (r.multiplier ?? 0) >= 1000;
    const hasMini = real.some(isMini) && real.some(isStd);
    const ofSpec = real.filter(link.spec === 'mini' ? isMini : isStd);
    if (ofSpec.length === 0) return { status: link.spec === 'mini' ? 'noMini' : 'noStd' };
    // 同規格有多個 root 時取每口股數最大（標準）或最小（小型）的那一個
    const pickRoot = ofSpec.reduce((a, b) => (link.spec === 'mini' ? (b.multiplier! < a.multiplier! ? b : a) : (b.multiplier! > a.multiplier! ? b : a))).root ?? '';
    const series = ofSpec.filter(r => (r.root ?? '') === pickRoot).sort((a, b) => a.delivery_month!.localeCompare(b.delivery_month!));
    // 任一月份沒有最後交易日：無法判斷到期與近月／次月，不送
    if (series.some(r => expiryTime(r) === null)) return { status: 'noExpiry' };
    const live = series.filter(r => !expired(r, now));
    const contract = link.month === 'near' ? live[0] : link.month === 'next' ? live[1] : live.find(r => r.delivery_month === link.month);
    if (!contract) {
        if (link.month === 'next' && live.length > 0) return { status: 'unlisted', month: 'next' };
        if (link.month === 'near' || link.month === 'next') return { status: 'none' };
        const listed = series.some(r => r.delivery_month === link.month);
        return listed || link.month < taipei(now).day.replace('-', '').slice(0, 6)
            ? { status: 'expired', month: link.month }
            : { status: 'unlisted', month: link.month };
    }
    const ltd = contract.last_trading_date || contract.delivery_date;
    // 這個選擇失效的時刻：近月／次月在近月到期時就會換，指定月份到自己到期
    const expiresAt = expiryTime(link.month === 'near' || link.month === 'next' ? live[0]! : contract);
    return { status: 'ok', contract, hasMini, expiresToday: !!ltd && ltd === taipei(now).day, expiresAt, months: live.map(r => r.delivery_month!) };
}

/** 價差：a − b 與相對 b 的百分比；任一方沒有價格 → null */
export function spreadOf(a: number | null | undefined, b: number | null | undefined): { diff: number; pct: number } | null {
    if (!a || !b) return null;
    const diff = a - b;
    return { diff, pct: (diff / b) * 100 };
}

/** 個股期 1 口對應的現股：2,000 股 → 1口=2張；小型 100 股 → 1口=100股 */
export function lotsPerContract(multiplier: number | undefined): string {
    if (!multiplier) return '';
    return multiplier % 1000 === 0 ? `1口=${multiplier / 1000}張` : `1口=${multiplier}股`;
}

/** 202610 → 10月（同年）或 2027/3 */
export function monthLabel(month: string, now = Date.now()): string {
    const y = month.slice(0, 4);
    const m = String(Number(month.slice(4)));
    return y === taipei(now).day.slice(0, 4) ? `${m}月` : `${y}/${m}`;
}
