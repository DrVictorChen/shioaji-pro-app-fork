// src/lib/popout-order.ts — orders from a flash popout window while the Agent
// Harness signs them. The main window's native signer is main-window only; a
// flash popout (popout-flash-* / popout-flashtile-*) uses its own, narrower
// native command `flash_popout_order_post` (private repo): the native side
// checks the window label, the endpoint (place / cancel / update only), a
// one-time request id and the server mode approved here. The popout's own
// order confirmation already happened before this is called.
//
// Never resent: one fresh id per call. Refused before sending → not sent;
// any failure after the request may have left → outcome unknown (#249).

import { getApiBase } from './runtime';
import { knownServerInfo } from './server-info-store';

export interface PopoutReply { status: number; body: string; headers?: Record<string, string> }

export const NOT_STARTED_MARKER = 'ORDER_NOT_STARTED:';
export const DUPLICATE_MARKER = 'ORDER_DUPLICATE:';
export const POPOUT_UNKNOWN = '委託結果不確定（彈出視窗送出後沒有結果）；請到委託查詢核對，不要直接重送';
export const POPOUT_UNSUPPORTED = '這個版本的 App 還不能從彈出視窗下單，這筆沒有送出；請在主視窗操作或更新 App';

type Invoke = <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;

const notStarted = (message: string) => Object.assign(new Error(message), { mutationNotStarted: true as const });
const unknownOutcome = (message: string) => Object.assign(new Error(message),
    { mutationOutcomeUnknown: true as const, orderOutcomeUnknown: true as const });

const newId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The server mode as known now (no I/O); null: unknown. */
function simulationNow(): boolean | null {
    const s = knownServerInfo()?.simulation;
    return typeof s === 'boolean' ? s : null;
}

/** Sends one approved request through the popout's native command. */
export async function popoutOrderPost(path: string, body: string, beforeSend?: () => void,
    deps: { invoke?: Invoke; base?: () => string; simulation?: () => boolean | null; newId?: () => string } = {}): Promise<PopoutReply> {
    const simulation = (deps.simulation ?? simulationNow)();
    if (simulation === null) throw notStarted('伺服器模式（模擬／正式）尚未確認，這筆沒有送出');
    const invoke = deps.invoke ?? (await import('@tauri-apps/api/core')).invoke as Invoke;
    // the caller's last checks (account, product, server) right before it leaves
    try { beforeSend?.(); } catch (e) { throw notStarted(e instanceof Error ? e.message : String(e)); }
    const url = (deps.base ?? getApiBase)() + path;
    try {
        return await invoke<PopoutReply>('flash_popout_order_post', { requestId: (deps.newId ?? newId)(), url, body, simulation });
    } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        if (message.startsWith(NOT_STARTED_MARKER)) throw notStarted(message.slice(NOT_STARTED_MARKER.length).trim());
        // the same id again (never sent by this code): it may already be out
        if (message.startsWith(DUPLICATE_MARKER)) throw unknownOutcome(`${message.slice(DUPLICATE_MARKER.length).trim()}；委託結果不確定，請到委託查詢核對，不要直接重送`);
        // an App build without the command: the IPC refused it, nothing left
        if (/command flash_popout_order_post not found/i.test(message)) throw notStarted(POPOUT_UNSUPPORTED);
        throw unknownOutcome(`${POPOUT_UNKNOWN}（${message}）`);
    }
}
