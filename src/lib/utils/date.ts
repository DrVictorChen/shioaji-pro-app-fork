// src/lib/utils/date.ts

import { dateStrOffset } from './kbars';

// 台灣（交易所）時間 UTC+8、無日光節約 — 與 kbars.ts 的 TW_OFFSET_SEC 同值
const TW_OFFSET_MS = 8 * 3600_000;

// 今天的台灣（交易所）日期 — 與本機時區無關，和 dateStrOffset 同一套
// UTC+8 換算；海外使用者查當日成交/損益/掃描才不會落到本地前一天
export function todayStr(): string {
    return dateStrOffset(0);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

// epoch ms → 台灣牆鐘。回傳的 Date 只能讀 getUTC*（UTC 欄位即台北時間）
function twWallClock(ms: number): Date {
    return new Date(ms + TW_OFFSET_MS);
}

// epoch ms 在台灣的時間 HH:MM
export function twTimeHM(ms: number): string {
    const d = twWallClock(ms);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export interface TwCalendarDate {
    year: number;
    month: number; // 1–12
    day: number;
    weekday: number; // 0=日 … 6=六
}

// 從台灣今天起算第 offset 個營業日（只跳過週末；國定假日無法本地判斷）
export function twBusinessDay(offset: number, nowMs = Date.now()): TwCalendarDate {
    const d = twWallClock(nowMs);
    let left = offset;
    while (left > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        const wd = d.getUTCDay();
        if (wd !== 0 && wd !== 6) left--;
    }
    return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        weekday: d.getUTCDay(),
    };
}

// YYYY-MM-DD 的星期（0=日）；純日曆計算，與本機時區無關。不可解析回 null
export function weekdayOfDateStr(raw: string): number | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
}
