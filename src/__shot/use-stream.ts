import { fakeQuote } from './fake';
export const useStreamStatus = () => 'live' as const;
export const useTradingLive = () => true;
export function useQuote(code: string | null, options?: { oddLot?: boolean }) { return fakeQuote(code, options?.oddLot === true) as never; }
