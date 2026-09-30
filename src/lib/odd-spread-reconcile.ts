// src/lib/odd-spread-reconcile.ts — 整零價差：委託列 → 狀態機事件（純函式）。
//
// 每筆委託帶唯一標記（custom_field，6 字元：o＋執行代碼 3 碼＋序號 2 碼）。
// 對帳規則：
// - 委託列中「完全相同標記」且商品／帳戶／方向／價量／單位都相同的唯一一筆，就是
//   這筆委託；id 與已知不同（sidecar 重啟後 trade_id 換了）→ 以新 id 重新接回。
// - 沒找到標記時，只有在「同一個 sidecar 世代」取得的 id 才可信：依 id 找到、且
//   標記相符（或該列沒有標記）才採用回報；世代變了的舊 id 不信任（可能被別的
//   委託重用），等標記出現或使用者在面板指定。
// - 同一標記對到多列（不應發生）→ 不接回，避免猜錯。
//
// 回報帶累計成交、券商狀態與刪單量（刪單量讓「回讀仍 Submitted、刪單量已涵蓋全部」
// 也能判定為終態，見 ADR 0004）。

import { accountMatches } from './flash-account';
import { isOddLot } from './odd-lot';
import type { ExecEvent, ExecState, OrderSlot, ReportStatus } from './odd-spread-exec';

type AccountIdentity = { account_type: string; broker_id: string; account_id: string };

export interface TradeLike {
    account?: AccountIdentity;
    contract: { code: string };
    order: {
        id: string;
        action: string;
        price: number;
        quantity: number;
        order_lot?: string;
        custom_field?: string;
        account?: AccountIdentity;
    };
    status: {
        status: string;
        deal_quantity?: number;
        cancel_quantity?: number;
        deals?: { quantity: number }[];
    };
}

export interface ReconcileTarget {
    tagBase: string;
    code: string;
    account: AccountIdentity;
    state: ExecState;
}

/** 此執行某筆委託的 custom_field：o＋執行代碼 3 碼＋序號 2 碼（共 6 字元） */
export function slotTag(tagBase: string, key: string): string {
    const n = Number(key.split(':')[1] ?? 0);
    return `o${tagBase}${n.toString(36).padStart(2, '0')}`;
}

export function tradeReport(t: TradeLike): { filled: number; status: ReportStatus; cancelled?: number } {
    const deals = (t.status.deals ?? []).reduce((a, d) => a + (d.quantity || 0), 0);
    const filled = Math.max(t.status.deal_quantity || 0, deals);
    const st = t.status.status;
    const status: ReportStatus = st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working';
    const cancelled = Number(t.status.cancel_quantity);
    return { filled, status, ...(t.status.cancel_quantity !== undefined && Number.isFinite(cancelled) ? { cancelled } : {}) };
}

export function sameOrder(rec: Pick<ReconcileTarget, 'code' | 'account'>, slot: OrderSlot, x: TradeLike): boolean {
    return accountMatches(x.account ?? x.order.account, rec.account)
        && x.contract.code === rec.code
        && x.order.action === slot.action
        && Math.round(x.order.price * 100) === Math.round(slot.price * 100)
        && x.order.quantity === slot.quantity
        && isOddLot(x.order.order_lot) === (slot.leg === 'odd');
}

/**
 * 依委託列產生一筆執行的對帳事件。claimed：其他委託已使用的 id（會就地更新）；
 * gen：目前的 sidecar 世代。
 */
export function reconcileEvents(rec: ReconcileTarget, trades: TradeLike[], claimed: Set<string>, gen: number): ExecEvent[] {
    const events: ExecEvent[] = [];
    for (const slot of rec.state.slots) {
        if (slot.status === 'unsent' || slot.local) continue;
        const tag = slotTag(rec.tagBase, slot.key);
        const tagged = trades.filter(x => x.order.custom_field === tag && sameOrder(rec, slot, x));
        if (tagged.length === 1) {
            const t = tagged[0]!;
            if (t.order.id !== slot.orderId || slot.idGen !== gen) {
                if (claimed.has(t.order.id) && t.order.id !== slot.orderId) continue;
                events.push({ type: 'placed', key: slot.key, orderId: t.order.id, gen, rebind: !!slot.orderId });
                claimed.add(t.order.id);
            }
            events.push({ type: 'report', key: slot.key, ...tradeReport(t) });
            continue;
        }
        if (tagged.length > 1) continue;
        // 沒有標記可對：只信任同一 sidecar 世代取得的 id，且標記不可矛盾
        if (slot.orderId && slot.idGen === gen) {
            const t = trades.find(x => x.order.id === slot.orderId);
            if (t && (!t.order.custom_field || t.order.custom_field === tag) && sameOrder(rec, slot, t)) {
                events.push({ type: 'report', key: slot.key, ...tradeReport(t) });
            }
        }
    }
    return events;
}

/** 使用者指定用的候選：同帳戶／商品／方向／價量／單位、未被認領、沒有或相同標記 */
export function candidateTrades(rec: ReconcileTarget, slot: OrderSlot, trades: TradeLike[], claimed: Set<string>, gen: number): TradeLike[] {
    if (slot.orderId && slot.idGen === gen) return [];
    const tag = slotTag(rec.tagBase, slot.key);
    return trades.filter(x => !claimed.has(x.order.id) && (!x.order.custom_field || x.order.custom_field === tag) && sameOrder(rec, slot, x));
}
