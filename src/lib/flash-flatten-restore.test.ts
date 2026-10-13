// 閃電平倉沒有成交時，對仍持有的部位恢復原本的停損停利：重查持倉、以可平倉量
// 與原保護量為上限、只做一次、不送單；已穿價的那一邊不恢復；查不到持倉或恢復
// 失敗就明確標示未受保護。
import { describe, expect, it, vi } from 'vitest';
import { restoreAfterUnfilledClose, restorePlan, restoreTriggers } from './flash-flatten-restore';

const snap = { exitAction: 'Sell' as const, stop: 95, take: 110, quantity: 2 };
const noSleep = async () => undefined;

describe('restorePlan', () => {
    it('caps by what is still held, largest protection first', () => {
        expect(restorePlan([snap, { ...snap, stop: 96, quantity: 1 }], 2, 100).legs).toEqual([{ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 }]);
        expect(restorePlan([snap], 5, 100).legs[0]!.quantity).toBe(2);
        expect(restorePlan([snap], 0, 100).legs).toEqual([]);
    });
    it('a leg already crossed is not put back (it would fire at once); both crossed: nothing', () => {
        const p = restorePlan([snap], 2, 94);
        expect(p.legs).toEqual([{ exitAction: 'Sell', stop: null, take: 110, quantity: 2 }]);
        expect(p.skipped[0]).toContain('停損 95 已穿價');
        expect(restorePlan([{ exitAction: 'Buy', stop: 105, take: 90, quantity: 1 }], 1, 89).legs[0]).toMatchObject({ stop: 105, take: null });
    });
});

describe('restoreTriggers', () => {
    it('protective stop / take as one OCO; futures close only; one leg alone', () => {
        const t = restoreTriggers({ exitAction: 'Buy', stop: 105, take: 90, quantity: 3 }, { code: 'TXFR1', futures: true, odd: false, group: 'g' });
        expect(t).toEqual([
            { code: 'TXFR1', action: 'Buy', quantity: 3, octype: 'Cover', condition: 'above', price: 105, kind: 'stop', group: 'g', ocoMode: 'trigger' },
            { code: 'TXFR1', action: 'Buy', quantity: 3, octype: 'Cover', condition: 'below', price: 90, kind: 'take', group: 'g', ocoMode: 'trigger' },
        ]);
        expect(restoreTriggers({ exitAction: 'Sell', stop: null, take: 110, quantity: 1 }, { code: '2330', futures: false, odd: false, group: 'g' }))
            .toEqual([{ code: '2330', action: 'Sell', quantity: 1, condition: 'above', price: 110, kind: 'take' }]);
    });
});

describe('restoreAfterUnfilledClose', () => {
    const run = (held: (number | null)[], restore = vi.fn(async () => true), last = 100) => {
        const notify = vi.fn();
        const reads = [...held];
        const readHeld = vi.fn(async () => reads.shift() ?? null);
        return { notify, restore, readHeld, done: restoreAfterUnfilledClose(2, [snap], 'TXFR1', '口', { readHeld, last: () => last, restore, notify, sleep: noSleep }) };
    };

    it('the close filled (flat at any read): nothing restored, nothing said', async () => {
        const r = run([2, 0]);
        expect(await r.done).toBe('closed');
        expect(r.restore).not.toHaveBeenCalled();
        expect(r.notify).not.toHaveBeenCalled();
    });

    it('not filled: the protection is put back once for what is held, with a clear warning', async () => {
        const r = run([2, 2, 2]);
        expect(await r.done).toBe('restored');
        expect(r.restore).toHaveBeenCalledTimes(1);
        expect(r.restore).toHaveBeenCalledWith({ exitAction: 'Sell', stop: 95, take: 110, quantity: 2 });
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉未成交，已恢復停損停利', body: expect.stringContaining('仍持有 2 口') }));
    });

    it('partly filled: only the rest; never more than before', async () => {
        const r = run([2, 1, 1]);
        expect(await r.done).toBe('restored');
        expect(r.restore).toHaveBeenCalledWith(expect.objectContaining({ quantity: 1 }));
    });

    it('the position turned the other way: not protected (never a position we did not hold)', async () => {
        expect(await run([-1]).done).toBe('closed');
    });

    it('the position cannot be read: nothing restored, flagged unprotected', async () => {
        const r = run([null, null, null]);
        expect(await r.done).toBe('unknown');
        expect(r.restore).not.toHaveBeenCalled();
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'err', body: expect.stringContaining('未受保護') }));
    });

    it('the restore is refused: flagged unprotected, not retried', async () => {
        const restore = vi.fn(async () => { throw new Error('主視窗沒有回應'); });
        const r = run([2, 2, 2], restore);
        expect(await r.done).toBe('failed');
        expect(restore).toHaveBeenCalledTimes(1);
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '⚡ 平倉未成交，停損停利未恢復（未受保護）' }));
    });

    it('a crossed stop: only the take comes back, and the warning says the rest is unprotected', async () => {
        const r = run([2, 2, 2], undefined, 94);
        expect(await r.done).toBe('partly');
        expect(r.notify).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('停損 95 已穿價') }));
    });
});
