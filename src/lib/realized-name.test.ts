import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ resolveContract: vi.fn(), fetchFuturesRoots: vi.fn(), cached: new Map<string, { code: string; name: string }>() }));
vi.mock('./shioaji', () => ({ resolveContract: api.resolveContract, fetchFuturesRoots: api.fetchFuturesRoots }));
vi.mock('./contracts-cache', () => ({ getCachedContract: (code: string) => api.cached.get(code) }));

import { canonicalBrokerCode, realizedCodeCandidates, resetRealizedNameCache, resolveRealizedName } from './realized-name';

// 合約表：模擬環境 paper endpoint 回的就是這些代號
const CONTRACTS: Record<string, string> = { TMFJ6: '微型臺指期貨10', MXFJ6: '小型臺指期貨10', TXFJ6: '臺股期貨10', '2330': '台積電' };

beforeEach(() => {
    resetRealizedNameCache();
    api.cached.clear();
    api.resolveContract.mockReset().mockImplementation(async (code: string) => {
        const name = CONTRACTS[code];
        if (!name) throw new Error(`404 ${code}`);
        return { code, name };
    });
    api.fetchFuturesRoots.mockReset().mockResolvedValue([
        { root: 'TMF', name: '微型臺指期貨' }, { root: 'MXF', name: '小型臺指期貨' }, { root: 'NSF', name: '美國那斯達克100期貨' }, { root: 'TXF', name: '臺股期貨' },
    ]);
});

describe('canonicalBrokerCode (#286)', () => {
    it('removes padding, control and zero-width characters, folds full-width and case', () => {
        expect(canonicalBrokerCode(' TMFJ6\u0000\u0000')).toBe('TMFJ6');
        expect(canonicalBrokerCode('TMF​J6')).toBe('TMFJ6');
        expect(canonicalBrokerCode('ＴＭＦＪ６')).toBe('TMFJ6');
        expect(canonicalBrokerCode('tmfj6\t')).toBe('TMFJ6');
    });
});

describe('realizedCodeCandidates (#286)', () => {
    it('adds the contract code for the root+YYYYMM long form on futures rows only', () => {
        expect(realizedCodeCandidates('TMF202610', 'F')).toEqual(['TMF202610', 'TMFJ6']);
        expect(realizedCodeCandidates('MXF 202612', 'F')).toEqual(['MXF202612', 'MXFL6']);
        expect(realizedCodeCandidates('TMFJ6', 'F')).toEqual(['TMFJ6']);
        expect(realizedCodeCandidates('2330', 'S')).toEqual(['2330']);
        expect(realizedCodeCandidates('TMF202613', 'F')).toEqual(['TMF202613']);
        expect(realizedCodeCandidates('  ', 'F')).toEqual([]);
    });
});

describe('resolveRealizedName (#286)', () => {
    it('simulation shape: canonical contract code resolves directly', async () => {
        await expect(resolveRealizedName('TMFJ6', 'F')).resolves.toBe('微型臺指期貨10');
        await expect(resolveRealizedName('2330', 'S')).resolves.toBe('台積電');
    });

    it('production shape: padded / invisible characters still resolve', async () => {
        await expect(resolveRealizedName('MXFJ6\u0000 ', 'F')).resolves.toBe('小型臺指期貨10');
        expect(api.resolveContract).toHaveBeenCalledWith('MXFJ6');
    });

    it('production shape: root+YYYYMM long form resolves through the converted contract code', async () => {
        await expect(resolveRealizedName('TMF202610', 'F')).resolves.toBe('微型臺指期貨10');
        expect(api.resolveContract.mock.calls.map(c => c[0])).toEqual(['TMF202610', 'TMFJ6']);
    });

    it('uses the shared contract cache (what the positions tab resolved) before querying', async () => {
        api.cached.set('NSFJ6', { code: 'NSFJ6', name: '美國那斯達克100期貨10' });
        await expect(resolveRealizedName('NSFJ6', 'F')).resolves.toBe('美國那斯達克100期貨10');
        expect(api.resolveContract).not.toHaveBeenCalled();
    });

    it('falls back to the root name plus month for expired contracts not in the list', async () => {
        // 已到期下市（例如 QEFG6、RVFG6）查不到合約：商品名稱＋兩位數月份
        await expect(resolveRealizedName('NSFJ6', 'F')).resolves.toBe('美國那斯達克100期貨10');
        await expect(resolveRealizedName('TXFG6', 'F')).resolves.toBe('臺股期貨07');
    });

    it('falls back to the bare root name when the tail is not month+year', async () => {
        await expect(resolveRealizedName('TXF', 'F')).resolves.toBeNull();
        await expect(resolveRealizedName('TXFX', 'F')).resolves.toBe('臺股期貨');
    });

    it('returns null for unknown stock rows, and retries roots after a failure', async () => {
        await expect(resolveRealizedName('9999', 'S')).resolves.toBeNull();
        api.fetchFuturesRoots.mockRejectedValueOnce(new Error('offline'));
        await expect(resolveRealizedName('NSFJ6', 'F')).resolves.toBeNull();
        await expect(resolveRealizedName('NSFJ6', 'F')).resolves.toBe('美國那斯達克100期貨10');
    });
});
