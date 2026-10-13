// src/lib/conditional/pause-all.ts — the 條件單管理 header's 全部暫停／全部恢復 button (#226).

/** The header button: 全部暫停 while anything can be paused, 全部恢復 only
 * while something is paused and nothing runs, otherwise a disabled 全部暫停
 * (QA 10/12: with nothing left it showed a disabled 全部恢復). */
export function pauseAllButton(anyRunning: boolean, anyPaused: boolean): { mode: 'pause' | 'resume'; disabled: boolean } {
    if (anyRunning) return { mode: 'pause', disabled: false };
    if (anyPaused) return { mode: 'resume', disabled: false };
    return { mode: 'pause', disabled: true };
}
