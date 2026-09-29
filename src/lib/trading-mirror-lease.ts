// Popout accounting is projected by the main window. A quote feed can remain
// LIVE after main closes, but that does not make its trading snapshot current.
const isMirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
let fresh = !isMirror;
let expiry: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function getTradingMirrorFresh() { return fresh; }
export function subscribeTradingMirror(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
function setFresh(value: boolean) {
    if (fresh === value) return;
    fresh = value;
    listeners.forEach(listener => listener());
}
export function markTradingMirrorSnapshot() {
    if (!isMirror) return;
    if (expiry) clearTimeout(expiry);
    setFresh(true);
    expiry = setTimeout(() => setFresh(false), 2500);
}
export function invalidateTradingMirror() {
    if (expiry) clearTimeout(expiry);
    expiry = null;
    if (isMirror) setFresh(false);
}
