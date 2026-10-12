// src/lib/order-outcome.ts — 下單錯誤的三種結果（#249）。
//
// 下單閘道主備切換後，「單已寫出但沒收到確認」會回 HTTP 409
// `OrderOutcomeUnknown`：委託可能已經成立，不能當失敗、也不能重送。
// 「還沒送出」回 503 `NotConnected`：確定沒送出。
//
// Shioaji 1.7.7 sidecar 會把 409 轉成 400（訊息帶 `OrderOutcomeUnknown: ...`），
// 503／504 轉成 500；1.7.8 起原樣回 409／503／504，並在 `details.error_code`
// 帶閘道錯誤碼。兩種都要認：
//   - 結果不確定：409、`OrderOutcomeUnknown`（error_code 或訊息）、502／504／其他 5xx、
//     送單逾時（api.ts runWithTimeout 標的 mutationOutcomeUnknown）
//   - 未送出：送出前就擋下（mutationNotStarted）、503、`NotConnected`
//   - 其他（券商拒單、4xx 參數錯誤）：下單失敗
//
// 任何結果都不會自動重送；結果不確定時只自動「更新委託」一次做對帳。

import type { AppNotice } from './trade';

export type OrderErrorKind = 'unknown' | 'not-sent' | 'rejected';

export const OUTCOME_UNKNOWN_CODE = 'OrderOutcomeUnknown';
export const NOT_CONNECTED_CODE = 'NotConnected';

/** 下單類 HTTP 回應錯誤要標記哪一種；非下單錯誤回 null（照原樣處理）。 */
export function classifyHttpOrderError(
    status: number,
    errorCode: string | undefined,
    message: string,
): 'unknown' | 'not-sent' | null {
    if (errorCode === OUTCOME_UNKNOWN_CODE || message.includes(OUTCOME_UNKNOWN_CODE)) return 'unknown';
    if (errorCode === NOT_CONNECTED_CODE || message.includes(NOT_CONNECTED_CODE)) return 'not-sent';
    if (status === 409) return 'unknown';
    if (status === 503) return 'not-sent';
    if (status >= 500) return 'unknown';
    return null;
}

const flag = (e: unknown, key: string) =>
    typeof e === 'object' && e !== null && (e as Record<string, unknown>)[key] === true;

/** 一個下單錯誤屬於哪一種。送出前確定沒送出的（mutationNotStarted）優先。 */
export function classifyOrderError(e: unknown): OrderErrorKind {
    if (flag(e, 'mutationNotStarted')) return 'not-sent';
    if (flag(e, 'mutationOutcomeUnknown') || flag(e, 'orderOutcomeUnknown')) return 'unknown';
    const message = e instanceof Error ? e.message : String(e ?? '');
    if (message.includes(OUTCOME_UNKNOWN_CODE)) return 'unknown';
    if (message.includes(NOT_CONNECTED_CODE)) return 'not-sent';
    return 'rejected';
}

export const OUTCOME_UNKNOWN_GUIDANCE =
    '委託可能已經成立。請等待委託回報，或到「委託」分頁確認；確認前請勿重新下單。系統會自動更新委託一次。';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 下單錯誤的通知內容。`label` 是入口名稱（例：「⚡ 閃電下單」「圖表下單」），
 * 結果不確定的標題一律是「{label}結果不確定」，不會出現「失敗」。
 */
export function orderErrorNotice(label: string, e: unknown): AppNotice & { outcome: OrderErrorKind } {
    const outcome = classifyOrderError(e);
    const detail = errorText(e);
    if (outcome === 'unknown') {
        return { kind: 'err', outcome, title: `${label}結果不確定`, body: `${OUTCOME_UNKNOWN_GUIDANCE}（${detail}）` };
    }
    if (outcome === 'not-sent') {
        return { kind: 'err', outcome, title: `${label}未送出`, body: detail };
    }
    return { kind: 'err', outcome, title: `${label}失敗`, body: detail };
}

let reconcileQueued = false;

/**
 * 結果不確定後自動更新委託一次（update_status 對帳）。同一時間多個入口
 * 一起回報時只排一次；不重送任何委託。
 */
export function reconcileAfterUnknownOutcome(): void {
    if (reconcileQueued) return;
    reconcileQueued = true;
    void import('./trading-state')
        .then(({ reconcileOrdersOnce }) => reconcileOrdersOnce())
        .catch(() => { /* 對帳失敗由委託分頁的待對帳狀態呈現 */ })
        .finally(() => { reconcileQueued = false; });
}

/** 通知＋（結果不確定時）自動對帳一次。回傳分類，讓呼叫端決定是否停止後續批次。 */
export function reportOrderError(
    label: string,
    e: unknown,
    notify: (n: AppNotice) => void,
): OrderErrorKind {
    const { outcome, ...notice } = orderErrorNotice(label, e);
    notify(notice);
    if (outcome === 'unknown') reconcileAfterUnknownOutcome();
    return outcome;
}
