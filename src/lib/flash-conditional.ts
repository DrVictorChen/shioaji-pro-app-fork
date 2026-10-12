// src/lib/flash-conditional.ts — the flash panel's entry points into the
// conditional-order engines (#216). Loaded on first use so the panel does not
// pull the engines (and their stream / background wiring) in by itself; in
// the App they are already running, so the import resolves at once.

import type { PanelBracketRequest } from './conditional/panel-bracket';
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
    const { removeTrigger } = await import('./trigger-engine');
    return removeTrigger(id);
}

export async function flashPlaceBracket(r: PanelBracketRequest): ReturnType<typeof import('./conditional/panel-bracket').placePanelBracket> {
    const { placePanelBracket } = await import('./conditional/panel-bracket');
    return placePanelBracket(r);
}
