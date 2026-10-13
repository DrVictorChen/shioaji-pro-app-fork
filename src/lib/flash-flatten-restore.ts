// src/lib/flash-flatten-restore.ts — 閃電「平倉」 ends the product's
// 停損停利 first, then sends a market IOC close. When that close does not
// fill (or fills partly), the lots still held were left unprotected (QA
// 10/13: a night-session IOC close was cancelled with nothing filled). This
// re-reads the position and, once, puts the protection back for what is
// still held (capped by the position and by what was protected), as plain
// protective stop / take triggers at the prices they had. It never sends an
// order: a stop already crossed now is not put back (it would fire at once)
// and the user is told.

import type { ProtectionSnapshot } from './flash-trigger';
import type { NewTrigger } from './trigger-engine';

/** One protection to put back. */
export interface RestoreLeg {
    exitAction: 'Buy' | 'Sell';
    stop: number | null;
    take: number | null;
    quantity: number;
}

export interface RestorePlan {
    legs: RestoreLeg[];
    /** what was not put back and why */
    skipped: string[];
}

const crossedStop = (exit: 'Buy' | 'Sell', stop: number, last: number) => (exit === 'Sell' ? last <= stop : last >= stop);
const crossedTake = (exit: 'Buy' | 'Sell', take: number, last: number) => (exit === 'Sell' ? last >= take : last <= take);

/** What to put back for `remaining` held lots (same direction as before). */
export function restorePlan(snapshots: readonly ProtectionSnapshot[], remaining: number, last: number | null): RestorePlan {
    const out: RestorePlan = { legs: [], skipped: [] };
    let left = Math.max(0, Math.floor(remaining));
    for (const s of [...snapshots].sort((a, b) => b.quantity - a.quantity)) {
        if (left <= 0) break;
        const quantity = Math.min(left, s.quantity);
        let { stop, take } = s;
        if (last !== null && stop !== null && crossedStop(s.exitAction, stop, last)) {
            out.skipped.push(`停損 ${stop} 已穿價（現價 ${last}），沒有恢復，避免立刻觸發`);
            stop = null;
        }
        if (last !== null && take !== null && crossedTake(s.exitAction, take, last)) {
            out.skipped.push(`停利 ${take} 已穿價（現價 ${last}），沒有恢復，避免立刻觸發`);
            take = null;
        }
        if (stop === null && take === null) continue;
        out.legs.push({ exitAction: s.exitAction, stop, take, quantity });
        left -= quantity;
    }
    return out;
}

/** The triggers of one leg: protective (no entry role), futures close only. */
export function restoreTriggers(leg: RestoreLeg, c: { code: string; futures: boolean; odd: boolean; group: string }): NewTrigger[] {
    const base = {
        code: c.code, action: leg.exitAction, quantity: leg.quantity,
        ...(c.futures ? { octype: 'Cover' as const } : {}),
        ...(c.odd ? { orderLot: 'IntradayOdd' as const } : {}),
    };
    const sell = leg.exitAction === 'Sell';
    const out: NewTrigger[] = [];
    if (leg.stop !== null) out.push({ ...base, condition: sell ? 'below' : 'above', price: leg.stop, kind: 'stop' });
    if (leg.take !== null) out.push({ ...base, condition: sell ? 'above' : 'below', price: leg.take, kind: 'take' });
    return out.length > 1 ? out.map(t => ({ ...t, group: c.group, ocoMode: 'trigger' as const })) : out;
}

export const READBACK_DELAYS_MS = [1500, 2500, 4000];

export interface WatchDeps {
    /** signed held quantity in the order unit now (null: could not read) */
    readHeld: () => Promise<number | null>;
    /** the traded price now (crossed legs are not put back) */
    last: () => number | null;
    /** puts one leg back; false / throw: not confirmed */
    restore: (leg: RestoreLeg) => Promise<boolean>;
    notify: (n: { kind: 'ok' | 'err' | 'info'; title: string; body: string }) => void;
    sleep?: (ms: number) => Promise<void>;
    delays?: readonly number[];
}

export type WatchOutcome = 'closed' | 'restored' | 'partly' | 'failed' | 'unknown' | 'none';

/** After a 平倉 was sent: wait for the position, then put back (once) what
 * is still held. `before` is the signed position the close was sent for. */
export async function restoreAfterUnfilledClose(before: number, snapshots: readonly ProtectionSnapshot[], code: string, unit: string,
    deps: WatchDeps): Promise<WatchOutcome> {
    if (!snapshots.length || before === 0) return 'none';
    const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    let held: number | null = null;
    for (const d of deps.delays ?? READBACK_DELAYS_MS) {
        await sleep(d);
        try { held = await deps.readHeld(); } catch { held = null; }
        // flat, or the other way round (never protect a position we did not hold)
        if (held !== null && (held === 0 || Math.sign(held) !== Math.sign(before))) return 'closed';
    }
    if (held === null) {
        deps.notify({ kind: 'err', title: '⚡ 平倉結果無法確認，停損停利未恢復', body: `${code}：無法重新查詢持倉，平倉前取消的停損停利沒有恢復（未受保護）。請到持倉確認，必要時自行設定停損停利` });
        return 'unknown';
    }
    const remaining = Math.min(Math.abs(held), Math.abs(before));
    const plan = restorePlan(snapshots, remaining, deps.last());
    let restored = 0;
    const failed: string[] = [];
    for (const leg of plan.legs) {
        try {
            if (await deps.restore(leg)) restored += leg.quantity;
            else failed.push(`${leg.quantity} ${unit}`);
        } catch (e) {
            failed.push(`${leg.quantity} ${unit}（${e instanceof Error ? e.message : String(e)}）`);
        }
    }
    const what = plan.legs.map(l => `${l.stop !== null ? `停損 ${l.stop}` : ''}${l.stop !== null && l.take !== null ? '・' : ''}${l.take !== null ? `停利 ${l.take}` : ''}`).join('；');
    const notes = [...plan.skipped, ...(failed.length ? [`恢復未確認：${failed.join('、')}`] : [])];
    const unprotected = remaining - restored;
    if (restored > 0 && unprotected <= 0 && !notes.length) {
        deps.notify({ kind: 'err', title: '⚡ 平倉未成交，已恢復停損停利', body: `${code} 仍持有 ${remaining} ${unit}：已恢復 ${what}（固定價格，不含移動停損）。不會自動再平倉` });
        return 'restored';
    }
    if (restored > 0) {
        deps.notify({ kind: 'err', title: '⚡ 平倉未成交，停損停利只恢復一部分', body: `${code} 仍持有 ${remaining} ${unit}：已恢復 ${restored} ${unit}（${what}）${
            unprotected > 0 ? `；未受保護 ${unprotected} ${unit}` : ''}。${notes.join('；')}；請自行補上沒有恢復的部分` });
        return 'partly';
    }
    deps.notify({ kind: 'err', title: '⚡ 平倉未成交，停損停利未恢復（未受保護）', body: `${code} 仍持有 ${remaining} ${unit}，沒有停損停利。${notes.join('；') || '恢復未確認'}；請自行處理` });
    return 'failed';
}
