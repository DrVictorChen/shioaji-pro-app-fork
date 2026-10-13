// demo stub of src/hooks/use-display-book.ts: a fixed TXF book around 48,212
const LAST = 48212;
const lv = (from: number, dir: 1 | -1, vols: number[]) => vols.map((vol, i) => ({ price: from + dir * i, vol }));
export function useDisplayBook(_code: string) {
    return {
        quote: { tick: { close: String(LAST), volume: 4, time: '10:24:31' } },
        snapshot: { close: LAST },
        book: { bids: lv(LAST - 1, -1, [12, 31, 18, 44, 27]), asks: lv(LAST, 1, [9, 22, 35, 16, 40]), source: 'stream' as const },
    };
}
