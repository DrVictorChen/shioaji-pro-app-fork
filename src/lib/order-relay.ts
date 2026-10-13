// src/lib/order-relay.ts — orders from a popped-out window, sent by the
// main window. With the Agent Harness on (desktop), every order and cancel is
// signed by the main window only. A popout (閃電下單彈出視窗) still asks its
// own order confirmation; once approved, it hands the exact request it would
// have sent to the main window, which checks it and sends it through its
// normal signed path, then answers with the result.
//
// Never resent: one one-time id per request (the main window refuses an id
// it saw before); the transport's own retransmit carries the SAME envelope id
// and gets the cached answer. No answer in time → the outcome is unknown
// (#249: 結果不確定), never "not sent". The main window not answering a
// ping first → nothing was sent.

import { createCommandBus, isExecutor, isMainWindow, type CommandBus } from './main-window-commands';
import { getApiBase } from './runtime';
import { knownServerInfo } from './server-info-store';

export interface RelayRequest {
    v: 1;
    /** one-time id: the main window sends a request id once, ever */
    id: string;
    path: string;
    /** the exact JSON the popout would have sent */
    body: string;
    /** `${apiBase}|simulation|production` when the user approved it */
    env: string;
    /** ms epoch the request left the popout (after its confirmation) */
    issuedAt: number;
}

export interface RelayReply { status: number; body: string; headers?: Record<string, string> }

export type RelayAnswer =
    | { ok: RelayReply }
    /** refused before anything was sent */
    | { notStarted: string }
    /** the main window tried to send it: the outcome is unknown */
    | { unknown: string };

type Cmd = { op: 'ping' } | { op: 'post'; req: RelayRequest };

export const RELAY_PATHS = new Set([
    '/api/v1/order/place_order',
    '/api/v1/order/cancel_order',
    '/api/v1/order/update_price',
    '/api/v1/order/update_qty',
    '/api/v1/order/place_comboorder',
    '/api/v1/order/cancel_comboorder',
    '/api/v1/order/reserve_stock',
    '/api/v1/order/reserve_earmarking',
]);
/** older than this when the main window gets it: not sent */
export const RELAY_MAX_AGE_MS = 15_000;
export const RELAY_PING_MS = 2_000;
/** the main window's own send may take a while (order timeout + margin) */
export const RELAY_TIMEOUT_MS = 30_000;

/** The protection-style environment key (no I/O). */
export function relayEnv(): string | null {
    const info = knownServerInfo();
    if (!info || typeof info.simulation !== 'boolean') return null;
    return `${getApiBase()}|${info.simulation ? 'simulation' : 'production'}`;
}

type AccountRef = { account_type: string; broker_id: string; account_id: string };

/** The account in an order body (place orders carry it; cancel / update by trade id do not). */
function bodyAccount(body: unknown): AccountRef | null {
    const o = body && typeof body === 'object' ? body as Record<string, unknown> : null;
    const nested = (k: string) => (o?.[k] as Record<string, unknown> | undefined)?.account;
    const a = (o?.account ?? nested('stock_order') ?? nested('futures_order') ?? nested('order')) as Partial<AccountRef> | undefined;
    return a && typeof a.broker_id === 'string' && typeof a.account_id === 'string'
        ? { account_type: String(a.account_type ?? ''), broker_id: a.broker_id, account_id: a.account_id } : null;
}

export interface RelayContext {
    env: string | null;
    now: number;
    seen: (id: string) => boolean;
    /** tradable accounts of the main window */
    accounts: readonly AccountRef[];
}

/** Why the main window must not send this (null: it may). */
export function relayProblem(req: RelayRequest, ctx: RelayContext): string | null {
    if (!req || req.v !== 1 || typeof req.id !== 'string' || !req.id) return '代送請求格式不正確';
    if (!RELAY_PATHS.has(req.path)) return '這個操作不能由主視窗代送';
    if (ctx.seen(req.id)) return '這筆請求已處理過，不會再送一次';
    if (!ctx.env || ctx.env !== req.env) return '主視窗的伺服器或模擬／正式模式與彈出視窗確認時不同';
    if (!Number.isFinite(req.issuedAt) || ctx.now - req.issuedAt > RELAY_MAX_AGE_MS || req.issuedAt - ctx.now > 5_000) {
        return '請求已逾時（確認後過久才到主視窗）';
    }
    let body: unknown;
    try { body = JSON.parse(req.body); } catch { return '代送請求格式不正確'; }
    const a = bodyAccount(body);
    if (a && !ctx.accounts.some(x => (!a.account_type || x.account_type === a.account_type) && x.broker_id === a.broker_id && x.account_id === a.account_id)) {
        return '這個帳戶在主視窗已不可用';
    }
    return null;
}

export interface RelayHostDeps {
    env: () => string | null;
    now: () => number;
    accounts: () => Promise<readonly AccountRef[]>;
    /** the main window's signed send to exactly `env`'s server; it must
     * re-check the environment right before sending and throw a
     * `mutationNotStarted` error when nothing left */
    post: (path: string, body: string, env: string) => Promise<RelayReply>;
}

/** The main window's side: check, remember the id, send once. A request id
 * seen before gets the SAME answer (pending or settled) — never a second send,
 * and never a "not sent" for an order that may be out. */
export function createRelayHost(deps: RelayHostDeps) {
    const answers = new Map<string, { at: number; answer: Promise<RelayAnswer> }>();
    const forget = (now: number) => { for (const [id, a] of answers) if (now - a.at > 10 * 60_000) answers.delete(id); };
    const decide = async (req: RelayRequest, received: number): Promise<RelayAnswer> => {
        // every check against one moment: the environment is re-read after
        // the async account read and the age is measured from the receipt
        const problem = relayProblem(req, { env: deps.env(), now: received, seen: () => false, accounts: await deps.accounts() })
            ?? (deps.env() !== req.env ? '主視窗的伺服器或模擬／正式模式與彈出視窗確認時不同' : null)
            ?? (deps.now() - received > 5_000 ? '主視窗忙碌，請求已逾時' : null);
        if (problem) return { notStarted: problem };
        try {
            return { ok: await deps.post(req.path, req.body, req.env) };
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            return (e as { mutationNotStarted?: boolean } | null)?.mutationNotStarted ? { notStarted: message } : { unknown: message };
        }
    };
    return async (cmd: Cmd): Promise<RelayAnswer | 'pong'> => {
        if (cmd.op === 'ping') return 'pong';
        const now = deps.now();
        forget(now);
        const req = cmd.req;
        if (!req || typeof req.id !== 'string' || !req.id) return { notStarted: '代送請求格式不正確' };
        const seen = answers.get(req.id);
        if (seen) return seen.answer;
        const answer = decide(req, now);
        answers.set(req.id, { at: now, answer });
        return answer;
    };
}

const notStarted = (message: string) => Object.assign(new Error(message), { mutationNotStarted: true as const });
const unknownOutcome = (message: string) => Object.assign(new Error(message),
    { mutationOutcomeUnknown: true as const, orderOutcomeUnknown: true as const });

export const RELAY_NO_MAIN = '主視窗沒有回應（可能已關閉），這筆沒有送出；請確認主視窗開著再操作';
export const RELAY_NO_ANSWER = '主視窗沒有回覆送單結果，委託結果不確定；請到委託查詢核對，不要直接重送';

const newId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** The popout's side: ping first (no main → not sent), then one request. */
export async function relayThroughMain(bus: Pick<CommandBus<Cmd>, 'send'>, path: string, body: string,
    opts: { env?: string | null; now?: () => number; beforeSend?: () => void } = {}): Promise<RelayReply> {
    const envNow = () => (opts.env === undefined ? relayEnv() : opts.env);
    const env = envNow();
    if (!env) throw notStarted('伺服器模式（模擬／正式）尚未確認，這筆沒有送出');
    try {
        if (await bus.send({ op: 'ping' }, RELAY_PING_MS) !== 'pong') throw new Error('no pong');
    } catch {
        throw notStarted(RELAY_NO_MAIN);
    }
    // the caller's last checks (account, product, server) right before it leaves
    if (envNow() !== env) throw notStarted('伺服器或模擬／正式模式已切換，這筆沒有送出');
    try { opts.beforeSend?.(); } catch (e) { throw notStarted(e instanceof Error ? e.message : String(e)); }
    const req: RelayRequest = { v: 1, id: newId(), path, body, env, issuedAt: (opts.now ?? Date.now)() };
    let answer: RelayAnswer;
    try {
        answer = await bus.send({ op: 'post', req }, RELAY_TIMEOUT_MS) as RelayAnswer;
    } catch {
        throw unknownOutcome(RELAY_NO_ANSWER);
    }
    if (answer && 'ok' in answer) return answer.ok;
    if (answer && 'notStarted' in answer) throw notStarted(`主視窗沒有送出：${answer.notStarted}`);
    throw unknownOutcome(`委託結果不確定（主視窗代送）：${answer && 'unknown' in answer ? answer.unknown : '沒有結果'}；請到委託查詢核對，不要直接重送`);
}

// ---- wiring ----

let bus: CommandBus<Cmd> | null = null;

/** One relay bus per window; the main window answers. */
export function startOrderRelay(): CommandBus<Cmd> {
    if (bus) return bus;
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('sj-pro-order-relay') : null;
    const host = createRelayHost({
        env: relayEnv,
        now: Date.now,
        accounts: async () => {
            const [{ getAccountState }, { canTrade }] = await Promise.all([import('./account-store'), import('./account-tradable')]);
            return getAccountState().accounts.filter(canTrade);
        },
        post: async (path, body, env) => {
            const { invoke } = await import('@tauri-apps/api/core');
            // exactly the server the popout approved it for
            if (relayEnv() !== env) throw notStarted('主視窗的伺服器或模擬／正式模式已切換');
            const apiBase = env.slice(0, env.lastIndexOf('|'));
            try {
                return await invoke<RelayReply>('agent_harness_post', { url: apiBase + path, body, agentInitiated: false });
            } catch (error) {
                const message = String(error);
                const marker = 'AGENT_MUTATION_NOT_STARTED:';
                if (message.startsWith(marker)) throw notStarted(message.slice(marker.length).trim());
                throw error;
            }
        },
    });
    // only the executing main window answers (one sender even with two main tabs)
    bus = createCommandBus<Cmd, null>({ channel, main: () => isMainWindow() && isExecutor(), handle: host, snapshot: () => null, timeoutMs: RELAY_TIMEOUT_MS });
    return bus;
}

/** A popout's request, sent by the main window. */
export function relayOrder(path: string, body: string, beforeSend?: () => void): Promise<RelayReply> {
    return relayThroughMain(startOrderRelay(), path, body, { beforeSend });
}
