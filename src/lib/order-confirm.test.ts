// 可視化委託確認服務：resolve 流程、單一 pending、環境快取容錯

import { afterEach, describe, expect, it, vi } from 'vitest';

// like the real fetchInfo, a response updates the server-info store
vi.mock('./shioaji', () => ({
    fetchInfo: vi.fn(async () => {
        const store = await import('./server-info-store');
        const info = { simulation: true };
        store.observeServerInfo(store.beginServerInfoRequest(), info as never);
        return info;
    }),
}));

import {
    getPendingOrderConfirm,
    primeOrderConfirmSimulation,
    requestOrderConfirm,
    resetOrderConfirmForTest,
    resolveOrderConfirm,
    setSimulationCacheForTest,
    ORDER_CONFIRM_SERVER_CHANGED,
} from './order-confirm';
import { fetchInfo } from './shioaji';

const req = {
    code: 'CCFI6',
    name: '聯電期貨',
    action: 'Buy' as const,
    price: 130.5,
    quantity: 1,
    unit: '口',
};

afterEach(() => {
    resetOrderConfirmForTest();
    vi.clearAllMocks();
});

describe('requestOrderConfirm', () => {
    it('preloads the server mode for a tile before its first confirmation', async () => {
        await primeOrderConfirmSimulation();
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        expect(getPendingOrderConfirm()?.simulation).toBe(true);
        // the dialog also refreshes /info when it opens (the badge must not be stale)
        expect(fetchInfo).toHaveBeenCalled();
        resolveOrderConfirm(false);
        await promise;
    });
    it('確認 → resolve true，pending 清空', async () => {
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.code).toBe('CCFI6');
        resolveOrderConfirm(true);
        await expect(promise).resolves.toBe(true);
        expect(getPendingOrderConfirm()).toBeNull();
    });

    it('取消 → resolve false', async () => {
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        resolveOrderConfirm(false);
        await expect(promise).resolves.toBe(false);
    });

    it('已有 pending 時第二筆直接 reject（不排隊）', async () => {
        const first = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        await expect(
            requestOrderConfirm({ ...req, code: '2330' }),
        ).rejects.toThrow('已有待確認的委託');
        resolveOrderConfirm(false);
        await first;
    });

    it('cold cache 下同一 tick 的第二筆也會直接 reject', async () => {
        setSimulationCacheForTest(null);
        const first = requestOrderConfirm(req);
        await expect(
            requestOrderConfirm({ ...req, code: '2330' }),
        ).rejects.toThrow('已有待確認的委託');
        resolveOrderConfirm(false);
        await expect(first).resolves.toBe(false);
    });

    it('環境快取已知時帶入 simulation flag', async () => {
        setSimulationCacheForTest(false);
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.simulation).toBe(false);
        resolveOrderConfirm(false);
        await promise;
    });

    it('保留整批限價區間供確認視窗顯示', async () => {
        const promise = requestOrderConfirm({
            ...req,
            price: null,
            priceLabel: '128.5 ～ 132.5 限價',
        });
        await vi.waitFor(() =>
            expect(getPendingOrderConfirm()).not.toBeNull(),
        );
        expect(getPendingOrderConfirm()?.priceLabel).toBe(
            '128.5 ～ 132.5 限價',
        );
        resolveOrderConfirm(false);
        await promise;
    });
});

describe('server mode changes while the confirmation is open', () => {
    it('an approval after the server mode changed (e.g. simulation sidecar restarted as production) never counts', async () => {
        const store = await import('./server-info-store');
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
        resolveOrderConfirm(true);
        await expect(promise).rejects.toMatchObject({ mutationNotStarted: true, message: ORDER_CONFIRM_SERVER_CHANGED });
    });
    it('an approval under the same server mode still counts', async () => {
        const store = await import('./server-info-store');
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        resolveOrderConfirm(true);
        await expect(promise).resolves.toBe(true);
    });
});

describe('server mode unknown when the confirmation opens', () => {
    it('the dialog is not exposed (and cannot be approved) until it has refreshed the mode', async () => {
        const store = await import('./server-info-store');
        store.forgetServerInfo('');
        let release!: () => void;
        vi.mocked(fetchInfo).mockImplementationOnce(() => new Promise(res => { release = () => {
            store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
            res({ simulation: false } as never);
        }; }));
        const promise = requestOrderConfirm(req);
        expect(getPendingOrderConfirm()).toBeNull();
        resolveOrderConfirm(true); // premature approval is ignored
        release();
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        expect(getPendingOrderConfirm()?.simulation).toBe(false);
        resolveOrderConfirm(true);
        await expect(promise).resolves.toBe(true);
    });
    it('a slow first /info that arrives after the dialog opened updates the badge and the gate (cold production start)', async () => {
        vi.useFakeTimers();
        try {
            const store = await import('./server-info-store');
            store.forgetServerInfo('');
            vi.mocked(fetchInfo).mockImplementationOnce(() => new Promise(() => undefined));
            const promise = requestOrderConfirm(req);
            await vi.advanceTimersByTimeAsync(900);
            expect(getPendingOrderConfirm()?.simulation).toBeNull();
            store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
            expect(getPendingOrderConfirm()?.simulation).toBe(false);
            resolveOrderConfirm(true);
            await expect(promise).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
    it('an approval while the server info was cleared (restart in progress) refuses', async () => {
        const store = await import('./server-info-store');
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
        const promise = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        store.observeServerInfo(store.beginServerInfoRequest(), undefined);
        resolveOrderConfirm(true);
        await expect(promise).rejects.toMatchObject({ mutationNotStarted: true });
    });
});

describe('the dialog badge and the gate read the same current mode', () => {
    it('a new dialog after simulation → production shows 正式 (not a stale cached 模擬) and approving it sends', async () => {
        const store = await import('./server-info-store');
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: true } as never);
        const first = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        expect(getPendingOrderConfirm()?.simulation).toBe(true);
        resolveOrderConfirm(false);
        await first;
        store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
        vi.mocked(fetchInfo).mockImplementationOnce(async () => {
            store.observeServerInfo(store.beginServerInfoRequest(), { simulation: false } as never);
            return { simulation: false } as never;
        });
        const second = requestOrderConfirm(req);
        await vi.waitFor(() => expect(getPendingOrderConfirm()).not.toBeNull());
        expect(getPendingOrderConfirm()?.simulation).toBe(false);
        resolveOrderConfirm(true);
        await expect(second).resolves.toBe(true);
    });
});
