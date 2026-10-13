// demo stub of src/hooks/use-stream.ts: always LIVE, no odd-lot quotes
export function useStreamStatus() { return 'live' as const; }
export function useTradingLive() { return true; }
export function useQuote(_code: string | null, _o?: unknown) { return undefined; }
