// src/lib/flash-conditional.ts — the flash panel's entry points into the
// conditional-order engines (#216). Loaded on first use so the panel does not
// pull the engines (and their stream / background wiring) in by itself; in
// the App they are already running, so the import resolves at once.

import type { PanelBracketRequest } from './conditional/panel-bracket';
import { protectionTargets, type ProtectionScope } from './flash-trigger';
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
export async function flashStopProtections(scope: ProtectionScope): Promise<{ stopped: number; blocked: string[]; failed: string[] }> {
    const [{ getBrackets, dismissBracket }, { isLive }, { getExits }, { getBackgroundPrograms, markBackgroundHandled }, { bracketViews }] = await Promise.all([
        import('./bracket'), import('./bracket-core'), import('./trigger-engine'), import('./execution/background'), import('./execution/bracket-contract')]);
    const t = protectionTargets(scope,
        getBrackets().map(p => ({ ...p, live: isLive(p) })),
        getExits(),
        bracketViews(getBackgroundPrograms()).map(v => ({ ...v, canEnd: v.actions.markHandled })));
    if (t.blocked.length) return { stopped: 0, blocked: t.blocked, failed: [] };
    let stopped = 0;
    const failed: string[] = [];
    for (const id of t.window) {
        try { await dismissBracket(id); stopped += 1; } catch (e) { failed.push(e instanceof Error ? e.message : String(e)); }
    }
    for (const b of t.background) {
        try { await markBackgroundHandled(b.programId, b.levelId); stopped += 1; } catch (e) { failed.push(`背景執行：${e instanceof Error ? e.message : String(e)}`); }
    }
    return { stopped, blocked: [], failed };
}
