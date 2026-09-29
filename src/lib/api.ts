// src/lib/api.ts

import { getApiBase, isTauri } from './runtime';
import { isAgentHarnessEnabled } from './agent-harness-state';
import { getTradingMirrorFresh } from './trading-mirror-lease';

// resolved per request — the server port can move at runtime (e.g. the boot
// flow discovers the default port occupied and starts on a fallback), and a
// module-load-time capture kept every request on the dead old port
// (the stuck-at-載入交易終端 bug)
const base = () => getApiBase();

const AGENT_HARNESS_MUTATIONS = new Set([
    '/api/v1/order/place_order',
    '/api/v1/order/cancel_order',
    '/api/v1/order/update_price',
    '/api/v1/order/update_qty',
    '/api/v1/order/place_comboorder',
    '/api/v1/order/cancel_comboorder',
    '/api/v1/order/reserve_stock',
    '/api/v1/order/reserve_earmarking',
]);

export function shouldProxyAgentHarnessMutation(
    desktop: boolean,
    enabled: boolean,
    path: string,
): boolean {
    return desktop && enabled && AGENT_HARNESS_MUTATIONS.has(path);
}

export function shouldRejectUnsignedAgentMutation(
    desktop: boolean,
    enabled: boolean,
    path: string,
    agentInitiated: boolean,
): boolean {
    return (
        desktop &&
        agentInitiated &&
        !enabled &&
        AGENT_HARNESS_MUTATIONS.has(path)
    );
}

async function doFetch(url: string, init?: RequestInit): Promise<Response> {
    if (isTauri) {
        const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http');
        return tauriFetch(url, init);
    }
    return fetch(url, init);
}

async function runWithTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    mutation = false,
): Promise<T> {
    if (!timeoutMs) return operation(new AbortController().signal);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
        timer = globalThis.setTimeout(() => {
            reject(mutation
                ? Object.assign(new Error('連線忙碌，委託送出結果未確認；請求可能已送達，請先查詢委託，勿直接重送'), {
                    mutationOutcomeUnknown: true as const,
                    requestTimedOut: true as const,
                })
                : new DOMException('aborted', 'AbortError'));
            controller.abort();
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timedOut]);
    } finally {
        globalThis.clearTimeout(timer!);
    }
}

// shioaji errors come back as JSON: {"code":400,"message":"...","details":...}
// surface that message instead of a bare "400 Bad Request" — the message is
// what tells you it's CA / unsigned account / bad params (issue #1 support)
async function throwApiError(res: Response): Promise<never> {
    let detail = '';
    try {
        const data = (await res.json()) as {
            message?: string;
            details?: unknown;
        };
        detail =
            data.message ??
            (typeof data.details === 'string' ? data.details : '');
        if (data.details && typeof data.details !== 'string') {
            detail += ` ${JSON.stringify(data.details)}`;
        }
    } catch {
        // non-JSON body — fall back to status text
    }
    throw Object.assign(
        new Error(`${res.status} ${detail || res.statusText}`.trim()),
        { status: res.status },
    );
}

export async function apiGet<T>(path: string, opts?: { signal?: AbortSignal; headers?: HeadersInit }): Promise<T> {
    const res = await doFetch(base() + path, opts);
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}

export async function apiPost<T>(
    path: string,
    body: unknown,
    opts?: { timeoutMs?: number; agentInitiated?: boolean; agentCallId?: string; agentAuto?: boolean },
): Promise<T> {
    if (AGENT_HARNESS_MUTATIONS.has(path) && !getTradingMirrorFresh()) {
        throw Object.assign(new Error('主視窗交易狀態未同步，委託尚未送出；請重新開啟主視窗'), { mutationNotStarted: true as const });
    }
    const harnessEnabled = isAgentHarnessEnabled();
    if (
        shouldRejectUnsignedAgentMutation(
            isTauri,
            harnessEnabled,
            path,
            opts?.agentInitiated === true,
        )
    ) {
        throw Object.assign(
            new Error('Agent Harness 未啟用，拒絕 unsigned Agent mutation'),
            { mutationNotStarted: true },
        );
    }
    // Serialize once in the WebView, then let the native bridge sign and send
    // these exact bytes. The native bridge fails closed when Harness is absent
    // or disabled; it never falls back to an unsigned protected mutation.
    if (shouldProxyAgentHarnessMutation(isTauri, harnessEnabled, path)) {
        const bodyText = JSON.stringify(body);
        const { invoke } = await import('@tauri-apps/api/core');
        let proxied: { status: number; body: string };
        try {
            proxied = await invoke<{ status: number; body: string }>(
                'agent_harness_post',
                {
                    url: base() + path,
                    body: bodyText,
                    agentInitiated: opts?.agentInitiated === true,
                    ...(opts?.agentCallId ? { agentCallId: opts.agentCallId, agentAuto: opts.agentAuto === true } : {}),
                },
            );
        } catch (error) {
            const message = String(error);
            const marker = 'AGENT_MUTATION_NOT_STARTED:';
            if (message.startsWith(marker)) {
                throw Object.assign(
                    new Error(message.slice(marker.length).trim()),
                    { mutationNotStarted: true },
                );
            }
            throw error;
        }
        const res = new Response(proxied.body, {
            status: proxied.status,
            headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) await throwApiError(res);
        return res.json() as Promise<T>;
    }
    const timedMutation = path === '/api/v1/order/place_order' || path === '/api/v1/order/cancel_order';
    return runWithTimeout(async signal => {
        const res = await doFetch(base() + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        if (!res.ok) await throwApiError(res);
        return res.json() as Promise<T>;
    }, opts?.timeoutMs ?? (timedMutation ? 3000 : undefined), timedMutation);
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(base() + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}

export async function apiDelete<T>(path: string, body?: unknown): Promise<T> {
    const res = await doFetch(base() + path, {
        method: 'DELETE',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) await throwApiError(res);
    return res.json() as Promise<T>;
}
