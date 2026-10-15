// src/hooks/use-flash-ladder.ts — what the flash ladder shows of conditional
// orders (#216): this panel's pending triggers and the stop / take of its
// brackets, from both executors (this window's engines and the background
// engine), and who runs new ones.

import { useMemo } from 'react';
import { backgroundSupported, useBackgroundPrograms, useBackgroundSetting } from '../lib/execution/background';
import { bracketViews } from '../lib/execution/bracket-contract';
import { ladderMarks, protectedQuantity, type LadderMark, type MarkScope, type ProtectionView } from '../lib/flash-trigger';
import { currentProtectionEnv } from '../lib/protection-env';
import { getAliasFor } from '../lib/stream';
import { useTriggers } from '../lib/trigger-engine';

export interface FlashLadderState {
    marks: Map<string, { buy: LadderMark[]; sell: LadderMark[] }>;
    protectedQty: number;
    /** new triggers / brackets run in the background engine (the setting is on) */
    background: boolean;
}

export function useFlashLadder(scope: Omit<MarkScope, 'env' | 'aliasOf'>, futures: boolean): FlashLadderState {
    const triggers = useTriggers();
    const programs = useBackgroundPrograms();
    const setting = useBackgroundSetting();
    const env = currentProtectionEnv();
    const { code, odd } = scope;
    const accountType = scope.account?.account_type;
    const brokerId = scope.account?.broker_id;
    const accountId = scope.account?.account_id;
    return useMemo(() => {
        const views: ProtectionView[] = bracketViews(programs).map(v => ({ id: `${v.programId}:${v.levelId}`, quoteCode: v.quoteCode, env: v.env,
            account: v.account, side: v.side, stop: v.stop, take: v.take, position: v.position, state: v.state }));
        const account = accountType && brokerId && accountId ? { account_type: accountType, broker_id: brokerId, account_id: accountId } : undefined;
        const s: MarkScope = { code, odd, account, env, aliasOf: getAliasFor };
        return {
            marks: ladderMarks(triggers, views, s, futures),
            protectedQty: protectedQuantity(triggers, views, s, futures),
            background: backgroundSupported() && setting === true,
        };
    }, [triggers, programs, setting, env, code, odd, accountType, brokerId, accountId, futures]);
}
