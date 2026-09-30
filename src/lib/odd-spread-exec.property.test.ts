// 整零價差狀態機：固定種子的隨機事件序列（repo 沒有 fast-check）。
//
// 模擬券商：下單結果（成功／結果不明（可能已送出）／確定未送出）、委託回報、
// 成交（早到、晚到、部分）、刪單（成功／失敗）、回報亂序與延遲、重新整理
// （丟失在途的 HTTP 回應、送出中→結果不明、刪單等待→刪單結果不明、以委託列重新
// 對帳）、環境切換（一段時間內回報全部延後），以及使用者的取消、標記未送出、
// 補單決定。每一步之後檢查：
//   (a) 送出量不超過計畫：potential(腳) ≤ 上限（整股 ≤ 計畫張數、零股 ≤ 計畫股數），
//       否則該腳必有多出補單的刪單已發出；sequential 零股總送出量 ≤ 計畫。
//   (b) 任一腳因補單而成交超過目標上限一單位（1 張／1,000 股）以上時，該腳必有
//       為多出而刪的補單。
//   (c) 靜止後，券商端仍在委託中的每一筆，狀態機都在追蹤（在途），成交量一致。
//   (d) 同一個意圖（key）不會送兩次。
//   (b') 任何時候：超過目標上限的量，只要還有能刪的補單就一定已發刪單（含使用者
//       誤把已送出的委託標成「未送出」的序列）。

import { describe, expect, it } from 'vitest';
import {
    execReduce,
    filledOf,
    initExec,
    isLive,
    legTargets,
    unaccounted,
    potentialOf,
    restoreAfterReload,
    type ExecCommand,
    type ExecContext,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
    type LegKind,
} from './odd-spread-exec';

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

interface BrokerOrder {
    key: string;
    id: string;
    leg: LegKind;
    qty: number;
    filled: number;
    /** 最近一次成交前的成交量（委託狀態回報可能落後成交回報） */
    prevFilled: number;
    cancelled: number;
    status: 'live' | 'filled' | 'cancelled';
}

type Queued = ExecEvent & { http?: boolean };

function simulate(seed: number) {
    const r = rng(seed);
    const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
    const chance = (p: number) => r() < p;

    const mode = chance(0.5) ? 'sequential' : 'simultaneous';
    // 1/4 的序列使用者會誤標：把其實已送出的委託標成「未送出」（之後委託出現→撤銷標記）
    const sloppy = seed % 4 === 0;
    const lots = 1 + Math.floor(r() * 2);
    const shares = lots * 1000;
    const oddOrders: { price: number; quantity: number }[] = [];
    for (let left = shares; left > 0;) {
        const q = Math.min(left, 999, 100 + Math.floor(r() * 900));
        oddOrders.push({ price: 100, quantity: q });
        left -= q;
    }
    const plan: ExecPlan = { direction: chance(0.5) ? 'buyRoundSellOdd' : 'buyOddSellRound', mode, lots, roundPrice: 100, oddOrders, netPerShare: 1 };
    const oddCap = shares;

    const broker = new Map<string, BrokerOrder>();
    let queue: Queued[] = [];
    let s: ExecState = initExec(plan);
    const sentKeys: string[] = [];
    const placedQty: Record<LegKind, number> = { odd: 0, round: 0 };
    let idSeq = 0;
    let holdSteps = 0;
    const log: string[] = [];

    const ctx: ExecContext = {
        quoteHedge: (_leg, _action, quantity) => (chance(0.7)
            ? { ok: true, orders: [{ price: 100, quantity }] }
            : { ok: false, reason: '超過滑價上限', orders: [{ price: 101, quantity }] }),
    };

    const report = (o: BrokerOrder): Queued => ({
        type: 'report', key: o.key, filled: o.filled,
        status: o.status === 'live' ? 'working' : o.status,
        ...(o.status === 'cancelled' ? { cancelled: o.cancelled } : {}),
    });

    const handle = (cmds: ExecCommand[]) => {
        for (const c of cmds) {
            if (c.kind === 'place') {
                sentKeys.push(c.key);
                placedQty[c.leg] += c.quantity;
                const roll = r();
                if (roll < 0.6) {
                    const o: BrokerOrder = { key: c.key, id: `O${++idSeq}`, leg: c.leg, qty: c.quantity, filled: 0, prevFilled: 0, cancelled: 0, status: 'live' };
                    broker.set(c.key, o);
                    queue.push({ type: 'placed', key: c.key, orderId: o.id, http: true }, { ...report(o), http: true });
                } else if (roll < 0.85) {
                    // 結果不明：一半其實有送到
                    if (chance(0.5)) {
                        const o: BrokerOrder = { key: c.key, id: `O${++idSeq}`, leg: c.leg, qty: c.quantity, filled: 0, prevFilled: 0, cancelled: 0, status: 'live' };
                        broker.set(c.key, o);
                        // 委託列（以標記）對上
                        queue.push({ type: 'placed', key: c.key, orderId: o.id }, report(o));
                    }
                    queue.push({ type: 'placeUnknown', key: c.key, error: 'timeout', http: true });
                } else {
                    queue.push({ type: 'placeFailed', key: c.key, error: 'refused', http: true });
                }
            } else {
                const o = broker.get(c.key);
                if (o && chance(0.8)) {
                    if (o.status === 'live') {
                        o.status = 'cancelled';
                        o.cancelled = o.qty - o.filled;
                    }
                    // 刪單回報的成交量可能落後（成交回報晚到）→ 刪單量＋成交量對不上
                    const lagging = chance(0.5) ? { ...report(o), filled: o.prevFilled } : report(o);
                    queue.push({ type: 'cancelResult', key: c.key, ok: true, http: true }, lagging);
                } else {
                    queue.push({ type: 'cancelResult', key: c.key, ok: false, error: 'busy', http: true });
                }
            }
        }
    };

    const reduce = (e: ExecEvent) => {
        const res = execReduce(s, e, ctx);
        s = res.state;
        log.push(`${e.type}${'key' in e ? ` ${e.key}` : ''} → ${s.phase} ${res.commands.map(c => `${c.kind}:${c.key}`).join(',')}`);
        handle(res.commands);
        check();
    };

    const unit = (leg: LegKind) => (leg === 'round' ? 1 : 1000);
    const cap = (leg: LegKind) => (leg === 'round' ? lots : oddCap);
    // 該腳的補單已有刪單發出（為多出而刪，或使用者取消時已一併刪）
    const surplusIssued = (leg: LegKind) => s.slots.some(x => x.leg === leg && x.hedge
        && (x.surplus || x.cancelWanted || x.cancelState === 'pending' || x.cancelState === 'sent' || x.cancelState === 'failed' || x.cancelState === 'unknown'));
    const check = () => {
        const t = legTargets(s);
        for (const leg of ['odd', 'round'] as LegKind[]) {
            // (b') 任何時候：超過上限的量，只要還有能刪的補單就一定已發刪單
            const tt0 = t[leg];
            if (tt0) {
                const effective = s.slots.filter(x => x.leg === leg).reduce((acc, x) => acc + x.filled + unaccounted(x)
                    + (x.cancelWanted || x.cancelState === 'pending' || x.cancelState === 'sent' || x.cancelState === 'failed' || !isLive(x) ? 0 : Math.max(0, x.quantity - x.filled)), 0);
                const cancellable = s.slots.some(x => x.leg === leg && x.hedge && isLive(x) && !x.cancelWanted && x.cancelState !== 'pending' && x.cancelState !== 'sent' && x.cancelState !== 'failed');
                if (effective > tt0.max) expect(cancellable, `(b') ${leg} effective ${effective} > max ${tt0.max} with uncancelled top-up\n${log.join('\n')}\n${JSON.stringify(s.slots.filter(x => x.leg === leg))}`).toBe(false);
            }
            // 誤標的序列：已送出的委託被當成沒送出，超送無法完全避免，只檢查 (b')(c)(d)
            if (sloppy) continue;
            // (a)
            if (potentialOf(s, leg) > cap(leg)) expect(surplusIssued(leg), `(a) ${leg} potential ${potentialOf(s, leg)} > ${cap(leg)}\n${log.join('\n')}`).toBe(true);
            // (b)
            const tt = t[leg];
            // 超額只算補單造成的部分（同時送的原始兩腳是計畫內的委託）
            const hedgeFilled = s.slots.filter(x => x.leg === leg && x.hedge).reduce((acc, x) => acc + x.filled, 0);
            const over = tt ? Math.min(filledOf(s, leg) - tt.max, hedgeFilled) : 0;
            if (over >= unit(leg)) expect(surplusIssued(leg), `(b) ${leg} filled ${filledOf(s, leg)} max ${tt!.max}\n${log.join('\n')}`).toBe(true);
        }
        if (mode === 'sequential' && !sloppy) expect(placedQty.odd, `(a) odd sent\n${log.join('\n')}`).toBeLessThanOrEqual(oddCap);
        // (d)
        expect(new Set(sentKeys).size, `(d) duplicate place\n${log.join('\n')}`).toBe(sentKeys.length);
    };

    reduce({ type: 'start' });
    for (let step = 0; step < 120; step++) {
        const roll = r();
        if (holdSteps > 0) holdSteps--;
        if (roll < 0.45 && queue.length > 0 && holdSteps === 0) {
            // 亂序送達
            const i = Math.floor(r() * queue.length);
            const [e] = queue.splice(i, 1);
            const { http: _h, ...ev } = e!;
            reduce(ev as ExecEvent);
        } else if (roll < 0.7) {
            // 券商成交（部分或全部）
            const live = [...broker.values()].filter(o => o.status === 'live');
            if (live.length) {
                const o = pick(live);
                const add = 1 + Math.floor(r() * (o.qty - o.filled));
                o.prevFilled = o.filled;
                o.filled += add;
                if (o.filled >= o.qty) o.status = 'filled';
                queue.push({ type: 'placed', key: o.key, orderId: o.id }, report(o));
            }
        } else if (roll < 0.76) {
            reduce({ type: 'cancel' });
        } else if (roll < 0.82) {
            // 使用者核對後標記未送出（只標記券商端確實沒有的）
            const cand = s.slots.filter(x => x.status === 'unknown' && !x.markedUnsent && (sloppy || !broker.has(x.key)));
            if (cand.length) reduce({ type: 'resolveUnknown', key: pick(cand).key });
        } else if (roll < 0.88) {
            if (s.pendingHedge) reduce(chance(0.6) ? { type: 'hedgeAccept' } : { type: 'hedgeDecline' });
        } else if (roll < 0.93) {
            // 重新整理：在途的 HTTP 回應遺失；以委託列重新對帳
            s = restoreAfterReload(JSON.parse(JSON.stringify(s)) as ExecState);
            queue = queue.filter(e => !e.http);
            for (const o of broker.values()) queue.push({ type: 'placed', key: o.key, orderId: o.id }, report(o));
            log.push('reload');
            reduce({ type: 'refresh' });
        } else {
            // 環境切換：一段時間內不送達任何回報
            holdSteps = 3 + Math.floor(r() * 5);
            log.push('env switch');
        }
    }
    // 靜止：不再成交，把所有回報送完（期間的刪單照常處理）
    for (let guard = 0; queue.length > 0 && guard < 500; guard++) {
        const [e] = queue.splice(0, 1);
        const { http: _h, ...ev } = e!;
        reduce(ev as ExecEvent);
    }
    // (c) 券商端仍在委託中的，狀態機都在追蹤，且成交量一致
    for (const o of broker.values()) {
        const slot = s.slots.find(x => x.key === o.key);
        expect(slot, `(c) untracked ${o.key}\n${log.join('\n')}`).toBeDefined();
        expect(slot!.filled, `(c) filled ${o.key}\n${log.join('\n')}`).toBe(o.filled);
        if (o.status === 'live') expect(isLive(slot!), `(c) live ${o.key} not tracked as live\n${log.join('\n')}`).toBe(true);
    }
    return {
        mode, phase: s.phase, sent: sentKeys.length,
        surplus: s.slots.some(x => x.surplus),
        hedges: s.slots.filter(x => x.hedge).length,
        revived: log.some(l => l.startsWith('resolveUnknown')) && s.slots.some(x => x.status === 'unknown' && x.markedUnsent) === false,
        unknown: log.some(l => l.startsWith('placeUnknown')),
        reloads: log.filter(l => l === 'reload').length,
    };
}

describe('整零價差狀態機：隨機事件序列的不變式', () => {
    it('2,000 組固定種子：送出量、超額補單、在途追蹤與不重送', () => {
        const phases = new Map<string, number>();
        const seen = { surplus: 0, hedges: 0, unknown: 0, reloads: 0 };
        for (let seed = 1; seed <= 2000; seed++) {
            const res = simulate(seed);
            phases.set(`${res.mode}:${res.phase}`, (phases.get(`${res.mode}:${res.phase}`) ?? 0) + 1);
            if (res.surplus) seen.surplus++;
            if (res.hedges > 0) seen.hedges++;
            if (res.unknown) seen.unknown++;
            if (res.reloads > 0) seen.reloads++;
        }
        // 確實跑到了補單、多出補單的刪單、結果不明與重新整理
        expect(seen.hedges).toBeGreaterThan(100);
        expect(seen.surplus).toBeGreaterThan(5);
        expect(seen.hedges).toBeGreaterThan(500);
        expect(seen.unknown).toBeGreaterThan(100);
        expect(seen.reloads).toBeGreaterThan(100);
        // 兩種模式都有跑到，且有各種結局
        expect([...phases.keys()].some(k => k.startsWith('sequential'))).toBe(true);
        expect([...phases.keys()].some(k => k.startsWith('simultaneous'))).toBe(true);
        expect(phases.size).toBeGreaterThan(4);
    });
});
