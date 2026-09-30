// src/hooks/use-odd-spread-feed.ts — 整零價差面板的行情轉接層。
//
// 面板只吃 OddSpreadFeed（兩邊五檔＋最後成交），不直接碰行情 store，
// 方便測試與截圖時以固定資料餵入。
//
// TODO(#204 odd-lot store)：盤中零股行情（intraday_odd=true 訂閱、與整股
// 分開的 quote store）在 feat/204-odd-lot 完成後接上 odd／oddLast／oddTime；
// 在那之前零股簿為空、oddAvailable=false，面板顯示「零股行情尚未接上」且
// 兩個方向都停在「等待報價」，不會送出任何價差單。

import { useMemo } from 'react';
import type { SideBook } from '../lib/odd-spread';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { useDisplayBook } from './use-display-book';

export interface OddSpreadFeed {
    round: SideBook;
    odd: SideBook;
    roundLast: number | null;
    roundChange: number | null;
    oddLast: number | null;
    oddChange: number | null;
    /** 零股最近一次撮合時間（HH:MM:SS） */
    oddTime: string | null;
    /** 零股行情是否已接上 */
    oddAvailable: boolean;
}

export const EMPTY_BOOK: SideBook = { bids: [], asks: [] };

function num(v: string | number | undefined | null): number | null {
    const n = Number(v);
    return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? n : null;
}

export function useOddSpreadFeed(contract: ContractInfo, snapshot?: Snapshot): OddSpreadFeed {
    const { quote, snapshot: baseline, book } = useDisplayBook(contract.code, snapshot, contract);
    const tick = quote?.tick && !quote.tick.intraday_odd ? quote.tick : undefined;
    const roundLast = num(tick?.close) ?? (baseline?.close || null);
    const roundChange = num(tick?.price_chg)
        ?? (roundLast !== null && contract.reference ? roundLast - contract.reference : null);
    return useMemo(() => ({
        round: { bids: book?.bids ?? [], asks: book?.asks ?? [] },
        // TODO(#204 odd-lot store)：改接零股 quote store
        odd: EMPTY_BOOK,
        roundLast,
        roundChange,
        oddLast: null,
        oddChange: null,
        oddTime: null,
        oddAvailable: false,
    }), [book, roundLast, roundChange]);
}
