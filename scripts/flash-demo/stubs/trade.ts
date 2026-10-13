// demo stub of src/lib/trade.ts: notices go to the console, nothing is sent
export function notify(n: unknown) { console.info('[demo notice]', n); }
export function onNotice() { return () => undefined; }
export async function placeQuickOrder(): Promise<never> { throw new Error('示範畫面不會送單'); }
export async function placeStockExitByShares(): Promise<never> { throw new Error('示範畫面不會送單'); }
