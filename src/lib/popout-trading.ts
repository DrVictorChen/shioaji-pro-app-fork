// src/lib/popout-trading.ts — whether this window can send orders. With the
// Agent Harness on (desktop), every order and cancel is signed by the main
// window only (since v0.1.45): a popped-out window cannot send them. The
// flash panel shows that before anything is clicked (#216 QA 2026-10-13).

import { isAgentHarnessEnabled } from './agent-harness-state';
import { isMainWindow } from './main-window-commands';
import * as runtime from './runtime';

export const POPOUT_VIEW_ONLY = '彈出視窗目前不能下單或刪單，請在主視窗的閃電下單操作';

/** The reason this window cannot send orders, or null. */
export function popoutTradingBlocked(): string | null {
    let desktop = false;
    try { desktop = runtime.isTauri; } catch { /* a test double without it: not desktop */ }
    return desktop && !isMainWindow() && isAgentHarnessEnabled() ? POPOUT_VIEW_ONLY : null;
}
