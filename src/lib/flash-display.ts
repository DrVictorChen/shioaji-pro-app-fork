// src/lib/flash-display.ts — 閃電下單精簡顯示（#176）：面板上方的商品名稱列，
// 以及帳戶選單的短／長標籤。窄面板並排多個閃電下單時，帳號只留後段，
// 展開選單才顯示戶名。

import { maskAccountId, maskName } from './privacy';
import type { ContractInfo } from './types/contract';
import type { Account } from './types/portfolio';

const EXCHANGE_LABEL: Record<string, string> = { TSE: '上市', OTC: '上櫃', OES: '興櫃' };

/** 202610 → 2026/10；其他格式原樣回傳 */
function fmtMonth(month: string): string {
    return /^\d{6}$/.test(month) ? `${month.slice(0, 4)}/${month.slice(4)}` : month;
}

export function flashSymbolLabel(contract: Pick<ContractInfo, 'code' | 'name' | 'exchange' | 'security_type' | 'delivery_month'>): {
    name: string;
    meta: string;
    title: string;
} {
    const raw = contract.security_type === 'STK' ? '' : contract.delivery_month ?? '';
    const month = raw ? fmtMonth(raw) : '';
    const base = contract.name || contract.code;
    // 名稱常已帶 202610：改成 2026/10；沒帶月份才補上
    const name = !month ? base : base.includes(raw) ? base.replace(raw, month) : base.includes(month) ? base : `${base} ${month}`;
    const market = contract.exchange ? EXCHANGE_LABEL[contract.exchange] : undefined;
    const meta = market ? `${market}・${contract.code}` : contract.code;
    return { name, meta, title: `${name}（${meta}）` };
}

/**
 * 同市場的帳戶分公司代碼都相同時省略分公司，只顯示帳號；
 * long 另加戶名，給展開的選單與 tooltip 用。隱私模式遮帳號與戶名。
 */
export function flashAccountLabels(accounts: Account[], privacy: boolean): {
    short: (a: Account) => string;
    long: (a: Account) => string;
} {
    const brokers = new Set(accounts.map(a => a.broker_id));
    const short = (a: Account) => {
        const id = maskAccountId(a.account_id, privacy);
        return brokers.size <= 1 && (brokers.size === 0 || brokers.has(a.broker_id)) ? id : `${a.broker_id}-${id}`;
    };
    const long = (a: Account) => (a.username ? `${short(a)} ${maskName(a.username, privacy)}` : short(a));
    return { short, long };
}
