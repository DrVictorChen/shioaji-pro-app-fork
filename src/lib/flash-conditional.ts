// src/lib/flash-conditional.ts — the flash panel's entry points into the
// conditional-order engines (#216). Loaded on first use so the panel does not
// pull the engines (and their stream / background wiring) in by itself; in
// the App they are already running, so the import resolves at once.

import type { PanelBracketRequest } from './conditional/panel-bracket';
import { protectionTargets, type ProtectionScope, type ProtectionSnapshot } from './flash-trigger';
import type { NewTrigger, TriggerOrder, TriggerPatch } from './trigger-engine';
import type { ContractBase } from './types/contract';
import type { Account } from './types/portfolio';

export async function flashAddTrigger(t: NewTrigger, contract: ContractBase, account: Account): Promise<TriggerOrder | null> {
    const { addTrigger } = await import('./trigger-engine');
    return addTrigger(t, contract, { account });
}

export async function flashModifyTrigger(id: string, patch: TriggerPatch): Promise<void> {
    const { modifyTrigger } = await import('./trigger-engine');
    return modifyTrigger(id, patch);
}

export async function flashRemoveTrigger(id: string): Promise<void> {
    // strict: a removal that is not confirmed throws (never announced as deleted)
    const { removeTriggerStrict } = await import('./trigger-engine');
    return removeTriggerStrict(id);
}

export async function flashPlaceBracket(r: PanelBracketRequest): ReturnType<typeof import('./conditional/panel-bracket').placePanelBracket> {
    const { placePanelBracket } = await import('./conditional/panel-bracket');
    return placePanelBracket(r);
}

/** #216 平倉／全刪: end this panel's protections (window and background
 * brackets of the account + product + unit). Nothing is ended while any
 * exit is out or unknown (`blocked`); `failed`: an end that was not confirmed. */
export async function flashStopProtections(scope: Omit<ProtectionScope, 'env'>): Promise<{ stopped: number; blocked: string[]; failed: string[]; restore: ProtectionSnapshot[] }> {
    const [{ getBrackets, dismissBracket, bracketSnapshotStale }, { isLive }, { getExits, getTriggers }, bg, { bracketViews }, { currentProtectionEnv }] = await Promise.all([
        import('./bracket'), import('./bracket-core'), import('./trigger-engine'), import('./execution/background'), import('./execution/bracket-contract'),
        import('./protection-env')]);
    const env = currentProtectionEnv();
    if (!env) return { stopped: 0, blocked: ['伺服器模式（模擬／正式）尚未確認，無法確認停損停利'], failed: [], restore: [] };
    // never "nothing to stop" from a list that may be out of date
    if (bracketSnapshotStale()) return { stopped: 0, blocked: ['主視窗的停損停利狀態未更新（主視窗可能已關閉或重新載入）'], failed: [], restore: [] };
    if (bg.backgroundSupported() && bg.getBackgroundHealth() === null) return { stopped: 0, blocked: ['背景執行的狀態尚未取得'], failed: [], restore: [] };
    const full: ProtectionScope = { ...scope, env };
    const read = () => protectionTargets(full,
        getBrackets().map(p => ({ ...p, live: isLive(p),
            legs: getTriggers().filter(t => t.bracketId === p.id).map(t => ({ kind: t.kind, price: t.price, quantity: t.quantity, action: t.action })) })),
        getExits(),
        bracketViews(bg.getBackgroundPrograms()).map(v => ({ ...v, canEnd: v.actions.markHandled,
            exitBusy: !!v.exit && (v.exit.status === 'pendingSubmit' || v.exit.status === 'working') })));
    const t = read();
    if (t.blocked.length) return { stopped: 0, blocked: t.blocked, failed: [], restore: [] };
    let stopped = 0;
    const failed: string[] = [];
    for (const id of t.window) {
        try { await dismissBracket(id); stopped += 1; } catch (e) { failed.push(e instanceof Error ? e.message : String(e)); }
    }
    for (const b of t.background) {
        const handledScope = { account: { accountType: scope.account.account_type, brokerId: scope.account.broker_id, accountId: scope.account.account_id },
            codes: [...scope.codes] };
        try { await bg.markBackgroundHandled(b.programId, b.levelId, handledScope); stopped += 1; } catch (e) { failed.push(`背景執行：${e instanceof Error ? e.message : String(e)}`); }
    }
    // read back: a protection may have fired while it was being ended — its
    // exit is then out (never close on top of it), or it is still tracked
    const ids = new Set(t.window);
    const exitAfter = getExits().some(e => !!e.bracketId && ids.has(e.bracketId)
        && (e.status === 'sending' || e.status === 'working' || (e.status === 'unknown' && !e.acknowledged)));
    const again = read();
    const blocked = [...again.blocked, ...(exitAfter ? ['取消期間停損停利已觸發，出場單正在送出或結果未知'] : [])];
    if (!failed.length && (again.window.length || again.background.length)) failed.push('停損停利仍在執行中，取消未確認');
    return { stopped, blocked, failed, restore: t.snapshots };
}

/** #216 put a protection back after an unfilled 平倉: an OCO of protective
 * stop / take (futures close only), or one leg. Sends nothing by itself. */
export async function flashRestoreProtection(legs: NewTrigger[], contract: ContractBase, account: Account): Promise<boolean> {
    const { addTrigger, addTriggerGroup } = await import('./trigger-engine');
    if (legs.length === 1) return !!(await addTrigger(legs[0]!, contract, { account }));
    return !!(await addTriggerGroup(legs, contract, { account }));
}

/** #216 the account's signed position in `codes` read from the broker now
 * (stocks in whole lots), for the restore after an unfilled 平倉. */
export async function flashReadHeld(account: Account, codes: readonly string[], stockLots: boolean): Promise<number> {
    const { fetchAccountPositions } = await import('./execution/rearm');
    const view = await fetchAccountPositions({ order: { code: codes[0] ?? '', action: 'Sell', quantity: 1, quantityUnit: 'contract' },
        account: { accountType: account.account_type === 'F' ? 'F' : 'S', brokerId: account.broker_id, accountId: account.account_id } } as never);
    let net = 0;
    for (const p of view.positions) if (codes.includes(p.code)) net += p.direction === 'Sell' ? -p.quantity : p.quantity;
    return stockLots ? Math.sign(net) * Math.floor(Math.abs(net) / 1000) : net;
}
