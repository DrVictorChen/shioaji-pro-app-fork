// src/lib/order-conditions.ts — 委託條件（效期、價別、期貨倉別）的共用規則
//
// 下單面板（order-ticket）與閃電下單用同一份清單、同一個預設、同一個送出前
// 檢查與同一種確認文字，不各自複製一份：
// - 價別：股票 LMT／MKT；期貨另有 MKP（範圍市價）。選非限價時效期預設 IOC。
// - 效期：ROD／IOC／FOK；零股只能限價 ROD（見 odd-lot.ts）。
// - 期貨倉別：自動／新倉／平倉／當沖。
// placeFuturesOrder 送出前一律再檢查一次（futuresOrderProblem）。

import { ODD_LOT_TEXT } from './odd-lot';
import type { FuturesOCType, FuturesPriceType, OrderType } from './types/order';

export const ORDER_TYPES: readonly OrderType[] = ['ROD', 'IOC', 'FOK'];
const STOCK_PRICE_TYPES: readonly FuturesPriceType[] = ['LMT', 'MKT'];
const FUTURES_PRICE_TYPES: readonly FuturesPriceType[] = ['LMT', 'MKT', 'MKP'];
export const FUTURES_OCTYPES: readonly { value: FuturesOCType; label: string }[] = [
    { value: 'Auto', label: '自動' },
    { value: 'New', label: '新倉' },
    { value: 'Cover', label: '平倉' },
    { value: 'DayTrade', label: '當沖' },
];
export const PRICE_TYPE_LABEL: Record<FuturesPriceType, string> = { LMT: '限價', MKT: '市價', MKP: '範圍市價' };

export function octypeLabel(octype: FuturesOCType | string | undefined): string {
    return FUTURES_OCTYPES.find(o => o.value === octype)?.label ?? '自動';
}

export function priceTypesFor(isFutures: boolean): readonly FuturesPriceType[] {
    return isFutures ? FUTURES_PRICE_TYPES : STOCK_PRICE_TYPES;
}

/** 換價別時的效期預設：限價 ROD、市價／範圍市價 IOC */
export function defaultOrderTypeFor(priceType: string): OrderType {
    return priceType === 'LMT' ? 'ROD' : 'IOC';
}

/** 不能選的效期 → 原因（零股只能 ROD）；可以選回 null */
export function orderTypeDisabledReason(orderType: OrderType, odd: boolean): string | null {
    return odd && orderType !== 'ROD' ? ODD_LOT_TEXT.orderType : null;
}

/** 不能選的價別 → 原因（零股只能限價）；可以選回 null */
export function priceTypeDisabledReason(priceType: string, odd: boolean): string | null {
    return odd && priceType !== 'LMT' ? ODD_LOT_TEXT.priceType : null;
}

export const ORDER_CONDITION_TEXT = {
    priceType: '期貨價別只能是限價、市價或範圍市價',
    orderType: '委託效期只能是 ROD、IOC 或 FOK',
    octype: '期貨倉別只能是自動、新倉、平倉或當沖',
} as const;

/** 期貨委託的條件不在下單面板提供的範圍 → 白話原因；正常回 null */
export function futuresOrderProblem(o: { price_type?: string; order_type?: string; octype?: string }): string | null {
    if (o.price_type !== undefined && !FUTURES_PRICE_TYPES.includes(o.price_type as FuturesPriceType)) return ORDER_CONDITION_TEXT.priceType;
    if (o.order_type !== undefined && !ORDER_TYPES.includes(o.order_type as OrderType)) return ORDER_CONDITION_TEXT.orderType;
    if (o.octype !== undefined && !FUTURES_OCTYPES.some(x => x.value === o.octype)) return ORDER_CONDITION_TEXT.octype;
    return null;
}

/**
 * 確認視窗的條件列：只寫非預設的條件（預設 = 限價 ROD／市價 IOC、自動、現股），
 * 有任何一項就把價別＋效期寫在最前面，例如「限價 IOC・新倉」「範圍市價 IOC」
 * 「限價 ROD・融券」。零股維持「盤中零股・限價 ROD」。
 */
export function quickOrderNote(o: {
    market: boolean;
    futures?: boolean;
    priceType?: FuturesPriceType;
    orderType?: OrderType;
    octype?: FuturesOCType;
    credit?: string;
    oddLotLabel?: string;
}): string | undefined {
    if (o.oddLotLabel) return `${o.oddLotLabel}・限價 ROD`;
    const pt: FuturesPriceType = o.market ? (o.futures && o.priceType === 'MKP' ? 'MKP' : 'MKT') : 'LMT';
    const ot: OrderType = o.market ? 'IOC' : (o.orderType ?? 'ROD');
    const extras = [
        ...(o.credit ? [o.credit] : []),
        ...(o.futures && o.octype && o.octype !== 'Auto' ? [octypeLabel(o.octype)] : []),
    ];
    if (!extras.length && pt !== 'MKP' && ot === defaultOrderTypeFor(pt)) return undefined;
    return [`${PRICE_TYPE_LABEL[pt]} ${ot}`, ...extras].join('・');
}
