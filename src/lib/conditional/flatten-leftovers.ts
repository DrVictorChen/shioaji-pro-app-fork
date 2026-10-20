// src/lib/conditional/flatten-leftovers.ts — what 全平並取消 sent a close for
// but the account still holds when read back (#226; TXF/2330 QA 10/12: an
// IOC market sell of 8 張 filled 1, nothing told the user 7 remained).
// Listed under 需要你處理 until the user retries or checks them; this window
// only (not persisted: positions are read fresh on every retry).

import { useSyncExternalStore } from 'react';
import type { FlattenOrder, RemainingOrder } from './flatten';

export interface FlattenLeftover {
    id: string;
    at: number;
    env: string | null;
    order: RemainingOrder;
}

let items: readonly FlattenLeftover[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

const keyOf = (o: Pick<FlattenOrder, 'account' | 'code'>) => `${o.account.account_type}:${o.account.broker_id}:${o.account.account_id}:${o.code}`;

/** After a run: the products it sent for now hold exactly `remaining`
 * (older entries for those products are replaced or cleared). */
export function recordFlattenLeftovers(sentFor: readonly Pick<FlattenOrder, 'account' | 'code'>[],
    remaining: readonly FlattenLeftover['order'][], env: string | null, now = Date.now()): void {
    const touched = new Set([...sentFor, ...remaining].map(keyOf));
    items = [
        ...items.filter(i => !touched.has(keyOf(i.order))),
        ...remaining.map(order => ({ id: `${keyOf(order)}@${now}`, at: now, env, order })),
    ];
    emit();
}

export function dismissFlattenLeftover(id: string): void {
    items = items.filter(i => i.id !== id);
    emit();
}

export function getFlattenLeftovers(): readonly FlattenLeftover[] {
    return items;
}

export function subscribeFlattenLeftovers(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
}

export function useFlattenLeftovers(): readonly FlattenLeftover[] {
    return useSyncExternalStore(subscribeFlattenLeftovers, getFlattenLeftovers);
}

export function __resetFlattenLeftoversForTest(): void {
    items = [];
}
