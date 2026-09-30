// src/hooks/use-odd-spread-exec.ts — 把 odd-spread-exec 狀態機接到實際下單。
//
// 狀態機產生的 place／cancel 指令在這裡送出；下單回應與委託列（trades）
// 的累計成交量再當成事件餵回狀態機。每次執行有自己的 runId，舊執行的
// 非同步回應不會污染新的執行。

import { useCallback, useEffect, useRef, useState } from 'react';
import { accountMatches } from '../lib/flash-account';
import {
    execReduce,
    initExec,
    isTerminalPhase,
    type ExecCommand,
    type ExecEvent,
    type ExecPlan,
    type ExecState,
} from '../lib/odd-spread-exec';
import { cancelOrders } from '../lib/shioaji';
import { notify, placeQuickOrder } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Trade } from '../lib/types/order';
import type { Account } from '../lib/types/portfolio';

export function tradeReport(t: Trade): { filled: number; status: 'working' | 'filled' | 'cancelled' | 'failed' } {
    const deals = (t.status.deals ?? []).reduce((a, d) => a + (d.quantity || 0), 0);
    const filled = Math.max(t.status.deal_quantity || 0, deals);
    const st = t.status.status;
    const status = st === 'Filled' ? 'filled' : st === 'Cancelled' ? 'cancelled' : st === 'Failed' ? 'failed' : 'working';
    return { filled, status };
}

export interface SpreadExecution {
    exec: ExecState | null;
    start: (plan: ExecPlan) => void;
    cancel: () => void;
    dismiss: () => void;
}

export function useOddSpreadExec({
    contract,
    account,
    trades,
    onOrdersChanged,
}: {
    contract: ContractInfo;
    account: Account | undefined;
    trades: Trade[];
    onOrdersChanged?: () => void;
}): SpreadExecution {
    const stateRef = useRef<ExecState | null>(null);
    const runRef = useRef(0);
    const [, setVersion] = useState(0);
    const ctx = useRef({ contract, account, onOrdersChanged });
    ctx.current = { contract, account, onOrdersChanged };
    // 執行中固定用開始時的商品與帳戶
    const pinned = useRef<{ contract: ContractInfo; account: Account } | null>(null);

    const dispatchRef = useRef<(run: number, e: ExecEvent) => void>(() => undefined);

    const runCommand = useCallback((run: number, c: ExecCommand) => {
        const target = pinned.current;
        if (!target) return;
        if (c.kind === 'place') {
            void placeQuickOrder(target.contract, c.action, c.price, c.quantity, {
                account: target.account,
                // 整筆價差已在開始時確認過一次
                source: 'auto',
                ...(c.leg === 'odd' ? { orderLot: 'IntradayOdd' as const } : {}),
                isAccountCurrent: () => accountMatches(ctx.current.account, target.account),
            }).then(
                (trade) => {
                    dispatchRef.current(run, { type: 'placed', key: c.key, orderId: trade.order.id });
                    dispatchRef.current(run, { type: 'report', key: c.key, ...tradeReport(trade) });
                    ctx.current.onOrdersChanged?.();
                },
                (error: unknown) => {
                    const notStarted = !!(error && typeof error === 'object' && 'mutationNotStarted' in error);
                    const msg = error instanceof Error ? error.message : String(error);
                    notify({
                        kind: 'err',
                        title: `整零價差：${c.leg === 'odd' ? '零股' : '整股'}委託${notStarted ? '未送出' : '結果未確認'}`,
                        body: notStarted ? msg : `${msg}。可能已送出，請核對委託，勿直接重送`,
                    });
                    dispatchRef.current(run, { type: 'placeFailed', key: c.key, error: msg });
                },
            );
        } else {
            void cancelOrders([c.orderId]).then(() => ctx.current.onOrdersChanged?.());
        }
    }, []);

    const dispatch = useCallback((run: number, e: ExecEvent) => {
        if (run !== runRef.current) return;
        const s = stateRef.current;
        if (!s) return;
        const r = execReduce(s, e);
        if (r.state === s && r.commands.length === 0) return;
        stateRef.current = r.state;
        setVersion(v => v + 1);
        for (const c of r.commands) runCommand(run, c);
        if (isTerminalPhase(r.state.phase) && !isTerminalPhase(s.phase)) {
            notify({
                kind: r.state.phase === 'done' ? 'ok' : 'err',
                title: r.state.phase === 'done' ? '整零價差完成' : r.state.phase === 'cancelled' ? '整零價差已取消' : '整零價差未完成',
                body: `${ctx.current.contract.code}：請以委託與成交回報確認兩腳數量`,
            });
        }
    }, [runCommand]);
    dispatchRef.current = dispatch;

    // 委託列更新 → 累計成交回報
    useEffect(() => {
        const s = stateRef.current;
        if (!s || !s.started) return;
        const run = runRef.current;
        for (const slot of s.slots) {
            if (!slot.orderId) continue;
            const t = trades.find(x => x.order.id === slot.orderId);
            if (t) dispatch(run, { type: 'report', key: slot.key, ...tradeReport(t) });
        }
    }, [trades, dispatch]);

    const start = useCallback((plan: ExecPlan) => {
        const cur = stateRef.current;
        if (cur && cur.started && !isTerminalPhase(cur.phase)) return; // 一次只跑一筆
        const acc = ctx.current.account;
        if (!acc) return;
        pinned.current = { contract: ctx.current.contract, account: acc };
        runRef.current += 1;
        stateRef.current = initExec(plan);
        dispatch(runRef.current, { type: 'start' });
    }, [dispatch]);

    const cancel = useCallback(() => dispatch(runRef.current, { type: 'cancel' }), [dispatch]);

    const dismiss = useCallback(() => {
        const cur = stateRef.current;
        if (cur && cur.started && !isTerminalPhase(cur.phase)) return;
        stateRef.current = null;
        setVersion(v => v + 1);
    }, []);

    return { exec: stateRef.current, start, cancel, dismiss };
}
