// screenshot-only fake market data (untracked, not committed)
import { displayBook } from '../lib/display-book';
const BASE: Record<string, { last: number; tick: number }> = { '2330': { last: 1085, tick: 5 }, '2317': { last: 211, tick: 0.5 } };
function bidask(code: string, odd: boolean) {
    const b = BASE[code]!;
    const lv = (s: number) => Array.from({ length: 5 }, (_, i) => String(b.last + s * (i + (s > 0 ? 1 : 0)) * b.tick));
    const vol = (seed: number) => Array.from({ length: 5 }, (_, i) => odd ? 120 + ((seed * 37 + i * 211) % 2400) : 8 + ((seed * 13 + i * 29) % 160));
    return { code, date: '2026/10/08', time: '10:31:05.000000', bid_price: lv(-1), bid_volume: vol(code.length + 1), ask_price: lv(1), ask_volume: vol(code.length + 7), ...(odd ? { intraday_odd: true } : {}) };
}
export function fakeQuote(code: string | null, odd = false) {
    if (!code || !BASE[code]) return undefined;
    const b = BASE[code]!;
    return {
        tick: { code, date: '2026/10/08', time: odd ? '10:31:05.000000' : '10:31:06.120000', close: String(odd ? b.last - b.tick : b.last), volume: odd ? 320 : 12, ...(odd ? { intraday_odd: true } : {}) },
        bidask: bidask(code, odd),
    };
}
export function fakeBook(code: string) {
    const q = fakeQuote(code);
    return q ? displayBook(code, undefined, q.bidask as never) : undefined;
}
