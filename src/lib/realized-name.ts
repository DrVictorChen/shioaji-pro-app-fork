// src/lib/realized-name.ts — 已實現損益列的代號 → 商品名稱（#240 #286）。
//
// 損益列的 code 來自券商帳務，正式環境（portfolio endpoint）與模擬環境
// （paper endpoint）是兩個不同的後端：模擬回的就是合約代號（TMFJ6），
// 正式環境的期貨代號格式不保證與合約代號一字不差——可能夾帶看不到的
// 控制字元／全形字，或是「商品代號＋年月」長格式（TMF202610）。
// 原本只拿 code.trim() 查一次合約，查不到名稱就永遠空白。
//
// 這裡依序嘗試：
//   1. 正規化後的代號（去掉所有空白、控制字元、零寬字元，全形轉半形、轉大寫）
//   2. 期貨長格式「商品＋YYYYMM」轉成合約代號（TMF202610 → TMFJ6）
//   （先看全域合約快取——持倉分頁解析過的合約就在裡面，不必再查）
//   3. 期貨商品代號（root）的名稱——至少顯示「微型臺指期貨」而不是空白

import { getCachedContract } from './contracts-cache';
import { fetchFuturesRoots, resolveContract } from './shioaji';

const MONTH_CODES = 'ABCDEFGHIJKL';

/** 去掉所有看不到的字元、全形轉半形、轉大寫。 */
export function canonicalBrokerCode(code: string): string {
    return code
        .normalize('NFKC')
        .replace(/[\s\u0000-\u001f\u007f​-‍⁠﻿]/g, '')
        .toUpperCase();
}

/** 這個代號可能對應的合約代號，依可信度排序、不重複。 */
export function realizedCodeCandidates(
    code: string,
    market: 'S' | 'F',
): string[] {
    const canonical = canonicalBrokerCode(code);
    if (!canonical) return [];
    const out = [canonical];
    if (market === 'F') {
        // 商品＋YYYYMM（TMF202610）→ 商品＋月份字母＋年尾數（TMFJ6）
        const long = /^([A-Z0-9]{2,4}?)(\d{4})(\d{2})$/.exec(canonical);
        if (long) {
            const month = Number(long[3]);
            if (month >= 1 && month <= 12) {
                out.push(
                    `${long[1]}${MONTH_CODES[month - 1]}${Number(long[2]) % 10}`,
                );
            }
        }
    }
    return [...new Set(out)];
}

let rootsTask: Promise<Map<string, string>> | null = null;

function loadFuturesRootNames(): Promise<Map<string, string>> {
    rootsTask ??= fetchFuturesRoots()
        .then(
            (roots) =>
                new Map(
                    roots
                        .filter((r) => r.root && r.name)
                        .map((r) => [canonicalBrokerCode(r.root), r.name]),
                ),
        )
        .catch((err) => {
            rootsTask = null; // 下次再試
            throw err;
        });
    return rootsTask;
}

/** 測試用：清掉 root 名稱快取。 */
export function resetRealizedNameCache() {
    rootsTask = null;
}

/** 以最長的 root 前綴找期貨商品名稱（TMFJ6 → TMF → 微型臺指期貨）。 */
async function futuresRootName(canonical: string): Promise<string | null> {
    const roots = await loadFuturesRootNames().catch(() => null);
    if (!roots) return null;
    let best: string | null = null;
    let bestLen = 0;
    for (const [root, name] of roots) {
        if (
            root.length > bestLen &&
            canonical.startsWith(root) &&
            canonical.length > root.length
        ) {
            best = name;
            bestLen = root.length;
        }
    }
    return best;
}

/**
 * 解析一筆已實現損益列的商品名稱；全部方法都失敗才回 null（呼叫端下次更新會再試）。
 */
export async function resolveRealizedName(
    code: string,
    market: 'S' | 'F',
): Promise<string | null> {
    const candidates = realizedCodeCandidates(code, market);
    for (const candidate of candidates) {
        const cached = getCachedContract(candidate);
        if (cached?.name) return cached.name;
    }
    for (const candidate of candidates) {
        try {
            const contract = await resolveContract(candidate);
            if (contract.name) return contract.name;
        } catch {
            // 試下一個候選
        }
    }
    const canonical = candidates[0];
    if (market === 'F' && canonical) {
        return futuresRootName(canonical);
    }
    return null;
}
