// 整零價差：狀態機＋委託列對帳的固定種子隨機序列測試（repo 沒有 fast-check）。
//
// 模擬券商（委託以券商 id 回報、帶我們的唯一標記）：
// - 下單：送出前最後一刻檢查環境（不同就確定未送出）；成功／結果不明（一半其實
//   送到）／確定未送出；HTTP 回應延遲、亂序。
// - 成交：部分、全部；刪單請求送達後、生效前仍可能成交；刪單生效另一步。
// - 券商晚到的拒單（Failed、刪單量 0）。
// - 回讀落後：委託列看到的是某個時點的快照；刪單生效後回讀可能仍是 Submitted、
//   刪單量涵蓋全部（ADR 0004）。
// - App 重新整理：在途 HTTP 遺失（送出中的委託可能已到券商）、狀態機接回。
// - sidecar 重啟：所有委託換新 id、世代＋1，舊 id 可能被無關委託重用。
// - 環境切換：API base 或模擬／正式改變一段時間；期間回報保留、使用者操作拒絕、
//   送出前檢查擋下；切回後依序處理。
// - 使用者：取消、標記未送出（1/4 的序列會誤標已送出的委託）、補單接受／拒絕。
//
// 判定（oracle）獨立於執行器，只用券商端真實狀態與送出的指令計算：
//   (a) sequential 零股送出總量 ≤ 計畫。
//   (b) 靜止後，任一腳因補單造成的成交超過需要量一單位（1 張／1,000 股）以上 → 失敗
//       （誤標序列除外）。
//   (s) 靜止後，若某腳最多可能成交超過需要量，該腳每一筆仍在委託中的補單都必須已
//       被刪（或刪單失敗、已通知使用者）——只看「目前這一筆」，歷史刪單不能豁免。
//   (l) 靜止後，另一腳已確定、仍有未放棄的缺口 → 必須已送補單（缺口被在途量涵蓋）
//       或停在「未配對待處理」／「結果未確認」等使用者決定。
//   (c) 靜止後，券商端每一筆委託：狀態機都以目前的券商 id 追蹤、成交量一致；仍在
//       委託中的必為在途。
//   (d) 同一意圖（key）不會送兩次；券商端不會出現兩筆同標記的委託。

import { describe, expect, it } from 'vitest';
import {
    execReduce,
    initExec,
    isLive,
    restoreAfterReload,
    type ExecCommand,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type LegKind,
} from './odd-spread-exec';
import { reconcileEvents, slotTag, type TradeLike } from './odd-spread-reconcile';

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const ACC = { account_type: 'S', broker_id: 'BR', account_id: 'A' };
const TAG_BASE = 'abc';

interface BrokerOrder {
    key: string;
    id: string;
    tag: string;
    leg: LegKind;
    action: 'Buy' | 'Sell';
    price: number;
    qty: number;
    filled: number;
    cancelled: number;
    status: 'live' | 'filled' | 'cancelled' | 'failed';
    cancelReq: boolean;
    topUp: boolean;
    /** 委託列目前看到的快照 */
    seen: { status: string; filled: number; cancelled: number };
}

interface Env { base: string; simulation: boolean }

function simulate(seed: number) {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const chance = (p: number) => r() < p;

    const mode = chance(0.5) ? 'sequential' : 'simultaneous';
    const sloppy = seed % 4 === 0;
    const lots = 1 + Math.floor(r() * 2);
    const oddCap = lots * 1000;
    const oddOrders: { price: number; quantity: number }[] = [];
    for (let left = oddCap; left > 0;) {
        const q = Math.min(left, 999, 100 + Math.floor(r() * 900));
        oddOrders.push({ price: 100, quantity: q });
        left -= q;
    }
    const plan: ExecPlan = { direction: chance(0.5) ? 'buyRoundSellOdd' : 'buyOddSellRound', mode, lots, roundPrice: 100, oddOrders, netPerShare: 1 };

    const bound: Env = { base: 'b1', simulation: true };
    let env: Env = { ...bound };
    let envSteps = 0;
    const envOk = () => env.base === bound.base && env.simulation === bound.simulation;

    let s: ExecState = initExec(plan);
    let gen = 0;
    let idSeq = 0;
    const orders: BrokerOrder[] = [];
    const foreign: TradeLike[] = [];
    let http: ExecEvent[] = [];
    let outbox: ExecCommand[] = [];
    let held: ExecEvent[] = [];
    const sentKeys: string[] = [];
    const startKeys = new Set<string>();
    let oddPlaced = 0;
    let started = false;
    const log: string[] = [];

    const ctx: ExecContext = {
        quoteHedge: (_leg, _action, quantity) => (chance(0.7)
            ? { ok: true, orders: [{ price: 100, quantity }] }
            : { ok: false, reason: '超過滑價上限', orders: [{ price: 101, quantity }] }),
    };

    const newId = () => `g${gen}-${++idSeq}`;
    const tradeOf = (o: BrokerOrder): TradeLike => ({
        account: ACC,
        contract: { code: '2330' },
        order: { id: o.id, action: o.action, price: o.price, quantity: o.qty, order_lot: o.leg === 'odd' ? 'IntradayOdd' : 'Common', custom_field: o.tag },
        status: { status: o.seen.status, deal_quantity: o.seen.filled, cancel_quantity: o.seen.cancelled },
    });
    const truthStatus = (o: BrokerOrder) => (o.status === 'live' ? (o.filled > 0 ? 'PartFilled' : 'Submitted') : o.status === 'filled' ? 'Filled' : o.status === 'cancelled' ? 'Cancelled' : 'Failed');
    const see = (o: BrokerOrder, readBackQuirk = false) => {
        o.seen = { status: readBackQuirk && o.status === 'cancelled' ? 'Submitted' : truthStatus(o), filled: o.filled, cancelled: o.cancelled };
    };
    const reportOf = (o: BrokerOrder): ExecEvent => {
        const st = o.seen.status;
        return { type: 'report', key: o.key, filled: o.seen.filled, cancelled: o.seen.cancelled,
            status: st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working' };
    };

    const createAtBroker = (c: Extract<ExecCommand, { kind: 'place' }>): BrokerOrder => {
        const o: BrokerOrder = {
            key: c.key, id: newId(), tag: slotTag(TAG_BASE, c.key), leg: c.leg, action: c.action, price: c.price, qty: c.quantity,
            filled: 0, cancelled: 0, status: 'live', cancelReq: false, topUp: !startKeys.has(c.key), seen: { status: 'PendingSubmit', filled: 0, cancelled: 0 },
        };
        see(o);
        orders.push(o);
        return o;
    };

    // 失敗時才組訊息（每一步都檢查，字串要延後產生）
    const fail = (msg: string) => expect.fail(`${msg}\n${log.join('\n')}`);
    const check = () => {
        if (new Set(sentKeys).size !== sentKeys.length) fail('(d) duplicate place');
        if (new Set(orders.map(o => o.tag)).size !== orders.length) fail('(d) duplicate tag at broker');
        if (mode === 'sequential' && !sloppy && oddPlaced > oddCap) fail(`(a) odd sent ${oddPlaced}`);
    };

    const reduce = (e: ExecEvent) => {
        const res = execReduce(s, e, ctx);
        s = res.state;
        log.push(`${e.type}${'key' in e ? ` ${e.key}` : ''} → ${s.phase} ${res.commands.map(c => `${c.kind}:${c.key}`).join(',')}`);
        for (const c of res.commands) {
            if (c.kind === 'place') {
                sentKeys.push(c.key);
                if (!started) startKeys.add(c.key);
                if (c.leg === 'odd') oddPlaced += c.quantity;
            }
            outbox.push(c);
        }
        check();
    };
    // 服務層：環境不符時回報保留
    const feed = (e: ExecEvent) => {
        if (envOk()) reduce(e);
        else held.push(e);
    };
    const reconcile = () => {
        if (!envOk()) return;
        const trusted = new Set(s.slots.filter(x => x.orderId && x.idGen === gen).map(x => x.orderId!));
        const trades = [...orders.map(tradeOf), ...foreign];
        for (const e of reconcileEvents({ tagBase: TAG_BASE, code: '2330', account: ACC, state: s }, trades, trusted, gen)) reduce(e);
    };
    const execOne = (c: ExecCommand) => {
        if (c.kind === 'place') {
            // 送出前最後一刻確認環境
            if (!envOk()) { http.push({ type: 'placeFailed', key: c.key, error: 'env' }); return; }
            const roll = r();
            if (roll < 0.6) {
                const o = createAtBroker(c);
                http.push({ type: 'placed', key: c.key, orderId: o.id, gen }, reportOf(o));
            } else if (roll < 0.85) {
                if (chance(0.5)) createAtBroker(c);
                http.push({ type: 'placeUnknown', key: c.key, error: 'timeout' });
            } else {
                http.push({ type: 'placeFailed', key: c.key, error: 'refused' });
            }
        } else {
            const o = orders.find(x => x.key === c.key);
            if (!envOk() || !o || chance(0.2)) { http.push({ type: 'cancelResult', key: c.key, ok: false, error: 'busy' }); return; }
            if (o.status === 'live') o.cancelReq = true;
            http.push({ type: 'cancelResult', key: c.key, ok: true });
        }
    };
    // sidecar 重啟：在途請求以錯誤結束（下單結果不明、刪單失敗），已排隊的 HTTP 回應也失敗
    const failInFlight = () => {
        const next: ExecEvent[] = [];
        for (const c of outbox) {
            if (c.kind === 'place') {
                if (chance(0.5)) createAtBroker(c);
                next.push({ type: 'placeUnknown', key: c.key, error: 'sidecar restart' });
            } else next.push({ type: 'cancelResult', key: c.key, ok: false, error: 'sidecar restart' });
        }
        for (const e of http) {
            if (e.type === 'placed') next.push({ type: 'placeUnknown', key: e.key, error: 'sidecar restart' });
            else if (e.type === 'cancelResult') next.push({ ...e, ok: false, error: 'sidecar restart' });
            else if (e.type !== 'report') next.push(e);
        }
        outbox = [];
        http = next;
    };
    // App 重新整理：在途請求與回應都遺失（送出中的下單可能已到券商）
    const loseInFlight = () => {
        for (const c of outbox) if (c.kind === 'place' && envOk() && chance(0.5)) createAtBroker(c);
        outbox = [];
        http = [];
    };
    const replayHeld = () => {
        const evs = held;
        held = [];
        for (const e of evs) reduce(e);
        reconcile();
    };

    reduce({ type: 'start' });
    started = true;
    for (let step = 0; step < 140; step++) {
        if (envSteps > 0 && --envSteps === 0) {
            env = { ...bound };
            log.push('env back');
            replayHeld();
        }
        const roll = r();
        const live = orders.filter(o => o.status === 'live');
        if (roll < 0.14 && outbox.length) {
            execOne(outbox.splice(Math.floor(r() * outbox.length), 1)[0]!);
        } else if (roll < 0.3 && http.length) {
            feed(http.splice(Math.floor(r() * http.length), 1)[0]!);
        } else if (roll < 0.45 && live.length) {
            // 成交（刪單請求送達後、生效前也可能）
            const o = pick(live);
            o.filled += 1 + Math.floor(r() * (o.qty - o.filled));
            if (o.filled >= o.qty) o.status = 'filled';
        } else if (roll < 0.5) {
            const o = orders.find(x => x.cancelReq && x.status === 'live');
            if (o) { o.status = 'cancelled'; o.cancelled = o.qty - o.filled; }
        } else if (roll < 0.53 && live.length) {
            // 券商晚到的拒單
            pick(live).status = 'failed';
        } else if (roll < 0.66 && orders.length) {
            // 委託列更新（可能帶回讀型態）→ 對帳
            see(pick(orders), chance(0.3));
            reconcile();
        } else if (roll < 0.7 && envOk()) {
            feed({ type: 'cancel' });
        } else if (roll < 0.75 && envOk()) {
            const cand = s.slots.filter(x => x.status === 'unknown' && !x.markedUnsent && (sloppy || !orders.some(o => o.key === x.key)));
            if (cand.length) feed({ type: 'resolveUnknown', key: pick(cand).key });
        } else if (roll < 0.81 && envOk() && s.pendingHedge) {
            const p = s.pendingHedge;
            if (chance(0.65) && p.orders.reduce((a, o) => a + o.quantity, 0) === p.quantity) feed({ type: 'hedgeAccept', quantity: p.quantity, orders: p.orders });
            else feed({ type: 'hedgeDecline' });
        } else if (roll < 0.85) {
            // App 重新整理
            loseInFlight();
            s = restoreAfterReload(JSON.parse(JSON.stringify(s)) as ExecState);
            log.push('reload');
            if (envOk()) {
                reduce({ type: 'refresh' });
                reconcile();
            }
        } else if (roll < 0.88) {
            // sidecar 重啟：委託換 id、舊 id 可能被無關委託重用
            failInFlight();
            gen++;
            for (const o of orders) {
                const old = o.id;
                o.id = newId();
                if (chance(0.3)) {
                    foreign.push({ account: ACC, contract: { code: '2330' }, order: { id: old, action: o.action, price: o.price, quantity: o.qty, order_lot: o.leg === 'odd' ? 'IntradayOdd' : 'Common' }, status: { status: 'Filled', deal_quantity: o.qty, cancel_quantity: 0 } });
                }
            }
            log.push(`sidecar restart gen ${gen}`);
            reconcile();
        } else if (roll < 0.91 && envOk()) {
            // 環境切換：API base 或模擬／正式改變
            env = chance(0.5) ? { base: 'b2', simulation: true } : { base: 'b1', simulation: false };
            envSteps = 3 + Math.floor(r() * 6);
            log.push(`env switch ${env.base}/${env.simulation}`);
        }
    }

    // ---- 靜止：環境回來、不再成交；把指令、回應、刪單生效與委託列都跑完 ----
    if (!envOk()) {
        env = { ...bound };
        log.push('env back');
        replayHeld();
    }
    for (let guard = 0; guard < 300; guard++) {
        let did = false;
        while (outbox.length) { execOne(outbox.shift()!); did = true; }
        while (http.length) { feed(http.shift()!); did = true; }
        for (const o of orders) {
            if (o.cancelReq && o.status === 'live') { o.status = 'cancelled'; o.cancelled = o.qty - o.filled; did = true; }
        }
        for (const o of orders) see(o);
        const before = JSON.stringify(s);
        reconcile();
        reduce({ type: 'refresh' });
        if (JSON.stringify(s) !== before) did = true;
        if (!did && !outbox.length && !http.length) break;
    }
    const L = log.join('\n');

    // ---- oracle：只用券商真實狀態 ----
    const filledT = (leg: LegKind) => orders.filter(o => o.leg === leg).reduce((a, o) => a + o.filled, 0);
    const liveRemT = (leg: LegKind) => orders.filter(o => o.leg === leg && o.status === 'live').reduce((a, o) => a + o.qty - o.filled, 0);
    const roundNeed = (sh: number) => (sh >= oddCap ? lots : Math.min(lots, Math.floor(sh / 1000)));
    const oddNeed = (lt: number) => (lt >= lots ? oddCap : Math.min(oddCap, lt * 1000));
    const other = (leg: LegKind): LegKind => (leg === 'odd' ? 'round' : 'odd');
    const need = (leg: LegKind, x: number) => (leg === 'round' ? roundNeed(x) : oddNeed(x));
    const hedgeLegs: LegKind[] = mode === 'sequential' ? ['round'] : ['round', 'odd'];
    const unit = (leg: LegKind) => (leg === 'round' ? 1 : 1000);

    for (const leg of hedgeLegs) {
        const o = other(leg);
        const needMax = need(leg, filledT(o) + liveRemT(o));
        const needMin = need(leg, filledT(o));
        const pot = filledT(leg) + liveRemT(leg);
        const topUpFilled = orders.filter(x => x.leg === leg && x.topUp).reduce((a, x) => a + x.filled, 0);
        // (b)
        if (!sloppy) expect(Math.min(filledT(leg) - needMax, topUpFilled), `(b) ${leg} over-hedged\n${L}`).toBeLessThan(unit(leg));
        // (s) 超過需要量時，仍在委託中的每一筆補單都要已刪（或刪單失敗、已通知）
        if (pot > needMax) {
            for (const x of orders.filter(y => y.leg === leg && y.topUp && y.status === 'live')) {
                const slot = s.slots.find(y => y.key === x.key);
                expect(slot?.cancelState === 'failed', `(s) live surplus top-up ${x.key} not cancelled\n${L}`).toBe(true);
            }
        }
        // (l) 另一腳確定、缺口未放棄 → 已補或等使用者決定
        const determined = liveRemT(o) === 0;
        const gap = needMin - pot - s.waived[leg];
        if (determined && gap > 0 && !sloppy) {
            const waiting = s.pendingHedge?.leg === leg || s.phase === 'unknown';
            expect(waiting, `(l) ${leg} gap ${gap} neither hedged nor awaiting user\n${L}\n${JSON.stringify(s.slots)}`).toBe(true);
        }
    }
    // (c) 追蹤
    for (const o of orders) {
        const slot = s.slots.find(x => x.key === o.key);
        expect(slot, `(c) untracked ${o.key}\n${L}`).toBeDefined();
        expect(slot!.orderId, `(c) ${o.key} bound to stale id\n${L}`).toBe(o.id);
        expect(slot!.filled, `(c) ${o.key} filled\n${L}`).toBe(o.filled);
        if (o.status === 'live') expect(isLive(slot!), `(c) live ${o.key} not tracked as live\n${L}`).toBe(true);
    }
    return {
        mode,
        phase: s.phase,
        topUps: orders.filter(o => o.topUp).length,
        surplusCancels: s.slots.some(x => x.surplus),
        restarts: gen,
        envSwitch: log.some(l => l.startsWith('env switch')),
        lateFail: orders.some(o => o.status === 'failed'),
    };
}

describe('整零價差：隨機事件序列的不變式（獨立 oracle）', () => {
    it('3,000 組固定種子', { timeout: 60_000 }, () => {
        const seen = { topUps: 0, surplus: 0, restarts: 0, env: 0, lateFail: 0, modes: new Set<string>(), phases: new Set<string>() };
        for (let seed = 1; seed <= 3000; seed++) {
            const res = simulate(seed);
            seen.modes.add(res.mode);
            seen.phases.add(res.phase);
            if (res.topUps) seen.topUps++;
            if (res.surplusCancels) seen.surplus++;
            if (res.restarts) seen.restarts++;
            if (res.envSwitch) seen.env++;
            if (res.lateFail) seen.lateFail++;
        }
        // 確實涵蓋到各種情況
        expect(seen.modes.size).toBe(2);
        expect(seen.phases.size).toBeGreaterThan(4);
        expect(seen.topUps).toBeGreaterThan(500);
        // 多餘補單的刪單在獨立 oracle 下很少自然發生（需誤標後委託又出現），另有單元測試固定情境覆蓋
        expect(seen.restarts).toBeGreaterThan(500);
        expect(seen.env).toBeGreaterThan(500);
        expect(seen.lateFail).toBeGreaterThan(500);
    });
});

describe('對帳：唯一標記與 sidecar 世代', () => {
    const slot = { key: 'odd:0', leg: 'odd' as const, action: 'Sell' as const, price: 100, quantity: 300, status: 'working' as const, filled: 0, orderId: 'OLD', idGen: 0 };
    const state = { ...initExec({ direction: 'buyRoundSellOdd', mode: 'sequential', lots: 1, roundPrice: 100, oddOrders: [{ price: 100, quantity: 300 }] }), started: true, slots: [slot] };
    const rec = { tagBase: TAG_BASE, code: '2330', account: ACC, state };
    const tr = (id: string, tag: string | undefined, filled = 0): TradeLike => ({
        account: ACC, contract: { code: '2330' },
        order: { id, action: 'Sell', price: 100, quantity: 300, order_lot: 'IntradayOdd', ...(tag ? { custom_field: tag } : {}) },
        status: { status: 'Submitted', deal_quantity: filled, cancel_quantity: 0 },
    });
    const tag = slotTag(TAG_BASE, 'odd:0');
    it('同標記換了 id → rebind', () => {
        expect(reconcileEvents(rec, [tr('NEW', tag, 5)], new Set(), 1)).toEqual([
            { type: 'placed', key: 'odd:0', orderId: 'NEW', gen: 1, rebind: true },
            { type: 'report', key: 'odd:0', filled: 5, status: 'working', cancelled: 0 },
        ]);
    });
    it('世代變了：舊 id 被別的委託（沒標記或別的標記）重用 → 不採用', () => {
        expect(reconcileEvents(rec, [tr('OLD', undefined, 300)], new Set(), 1)).toEqual([]);
        expect(reconcileEvents(rec, [tr('OLD', 'oxyz00', 300)], new Set(), 1)).toEqual([]);
    });
    it('同一世代、標記被投影丟掉 → 仍以 id 採用；標記矛盾則不採用', () => {
        expect(reconcileEvents(rec, [tr('OLD', undefined, 7)], new Set(), 0)).toEqual([{ type: 'report', key: 'odd:0', filled: 7, status: 'working', cancelled: 0 }]);
        expect(reconcileEvents(rec, [tr('OLD', 'oxyz00', 7)], new Set(), 0)).toEqual([]);
    });
    it('同一標記對到多列 → 不接回', () => {
        expect(reconcileEvents(rec, [tr('A', tag), tr('B', tag)], new Set(), 1)).toEqual([]);
    });
});
