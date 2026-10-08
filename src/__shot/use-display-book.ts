import { fakeBook, fakeQuote } from './fake';
export function useDisplayBook(code: string) {
    const q = fakeQuote(code);
    return { quote: q as never, snapshot: q ? { close: Number(q.tick.close) } as never : undefined, book: fakeBook(code) };
}
