// src/lib/order-status-label.ts — 券商委託狀態的中文顯示。
// 畫面、通知與下單回饋一律用這裡的中文；英文原始狀態只留在診斷用的
// title／技術資訊，不直接給使用者看。

import type { OrderStatusName } from './types/order';

// Inactive：SDK 在券商尚未回覆前給的佔位狀態（非同步送單的 Trade
// 佔位），之後仍可能變成已委託或成交 — 不是「已結束」。
const LABELS: Readonly<Record<OrderStatusName, string>> = {
    PendingSubmit: '送出中',
    PreSubmitted: '預約中',
    Submitted: '已委託',
    PartFilled: '部分成交',
    Filled: '全部成交',
    Cancelled: '已取消',
    Failed: '失敗',
    Inactive: '未確認',
};

/** 中文委託狀態；未知的新狀態保留原字並標明「狀態」，不猜意思。 */
export function orderStatusLabel(status: string | null | undefined): string {
    if (!status) return '狀態未知';
    return Object.hasOwn(LABELS, status) ? LABELS[status as OrderStatusName] : `狀態 ${status}`;
}

/** 委託編號：優先委託序號，沒有時用 trade id 前 8 碼。 */
export function orderNumber(trade: { order: { seqno?: string | null; id: string } }): string {
    return trade.order.seqno || trade.order.id.slice(0, 8);
}

/** 「已委託 #003627」：送單回饋與通知用。 */
export function orderStatusWithNumber(trade: {
    status: { status: string };
    order: { seqno?: string | null; id: string };
}): string {
    return `${orderStatusLabel(trade.status.status)} #${orderNumber(trade)}`;
}
