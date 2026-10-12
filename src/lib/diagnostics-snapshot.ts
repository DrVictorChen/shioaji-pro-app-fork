// src/lib/diagnostics-snapshot.ts — 複製診斷資訊時重新讀一次伺服器狀態與
// /health（#287）。面板的輪詢每 8 s／15 s 才更新：重啟後馬上複製，拿到的是
// 開機忙碌時那一筆（healthy=false、health: —），看起來像伺服器不健康。
// 重讀有上限時間；逾時或失敗就沿用輪詢值，不讓複製卡住。

export const DIAGNOSTICS_REFRESH_MS = 3000;

export async function freshDiagnostics<S, H>(
    readStatus: () => Promise<S>,
    readHealth: (signal: AbortSignal) => Promise<H>,
    polled: { status: S | undefined; health: H | undefined },
    timeoutMs = DIAGNOSTICS_REFRESH_MS,
): Promise<{ status: S | undefined; health: H | undefined }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve('timeout'); }, timeoutMs);
    });
    const within = async <T>(read: Promise<T>, fallback: T | undefined): Promise<T | undefined> => {
        try {
            const value = await Promise.race([read, expired]);
            return value === 'timeout' ? fallback : value as T;
        } catch {
            return fallback;
        }
    };
    try {
        const [status, health] = await Promise.all([
            within(readStatus(), polled.status),
            within(readHealth(controller.signal), polled.health),
        ]);
        return { status, health };
    } finally {
        clearTimeout(timer);
    }
}
