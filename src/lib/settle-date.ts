// src/lib/settle-date.ts — 帳務面板交割行事曆的日期標籤。
// 一律以台灣日期計算，電腦時區不是台北時也不會差一天（#151）。

import { twBusinessDay, weekdayOfDateStr } from './utils/date';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n: number) => String(n).padStart(2, '0');

// T+n 的預估交割日（台灣日期起算、跳過週末；國定假日無法本地判斷，
// 僅供 server 沒回該列時的全 0 佔位列）
export function bizDateLabel(offset: number, nowMs = Date.now()): string {
    const d = twBusinessDay(offset, nowMs);
    return `${pad2(d.month)}/${pad2(d.day)} (${WEEKDAYS[d.weekday]})`;
}

// server 回的 date（YYYY-MM-DD）→ MM/DD (週X)；不可解析就原樣顯示
export function settleDateLabel(raw: string): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    const wd = weekdayOfDateStr(raw);
    if (!m || wd === null) return raw;
    return `${m[2]}/${m[3]} (${WEEKDAYS[wd]})`;
}
