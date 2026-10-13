import { describe, expect, it } from 'vitest';
import { bracketEntryWaiting, bracketFinished, bracketViews, lapsedLevel } from './bracket-contract';
import { bracketRequestFor, backgroundBracketEligible, newBracketId } from './background-bracket';
import type { Level, OrderProgram, OrderSlot } from './model';

const slot = (o: Partial<OrderSlot>): OrderSlot => ({ key: 'k', role: 'entry', leg: 'entry', cycle: 0, qty: 2, status: 'working',
    orderId: 'bg:k', filled: 0, fills: {}, fillTs: {}, detail: null, acknowledged: false, cancel: null, ...o });

function program(lv: Partial<Level>, over: Partial<OrderProgram> = {}): OrderProgram {
    const level: Level = { id: 'L1', side: 'Buy', qty: 2, entry: { type: 'external', orderId: 'bg:k' },
        exit: { type: 'oco', stop: { price: 95, condition: 'below' }, take: { price: 110, condition: 'above' },
            order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } },
        phase: 'working', check: null, recross: [], pending: null, orders: [slot({})], position: 0, entryFilled: 0,
        unprotected: 0, cycles: 0, detail: null, ...lv };
    return { id: 'bkt-1', kind: 'bracket', version: 1, status: 'running', pauseReason: null, hold: null, ocoLevels: false,
        binding: { env: 'simulation', serverId: 'srv', account: { accountType: 'F', brokerId: 'B', accountId: 'A' },
            contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
        levels: [level], generator: null, cycle: { rearmAfterExit: false, maxCycles: null, partialFill: 'immediate' },
        bounds: { upper: null, lower: null, onBreakUpper: 'none', onBreakLower: 'none' },
        session: { resumeRule: 'confirm', longDisconnectMs: 60000, silentStallMs: 90000 }, risk: { maxWorkingEntries: null },
        hooks: [], intentSeq: 0, issues: [], createdAt: 1, updatedAt: 1, ...over } as OrderProgram;
}

const one = (p: OrderProgram) => bracketViews([p])[0]!;

describe('bracket views', () => {
    it('follows the bracket through waiting, protected and exiting', () => {
        expect(one(program({})).state).toBe('waitingEntry');
        const held = one(program({ phase: 'holding', position: 1, entryFilled: 1 }));
        expect([held.state, held.position, held.attention]).toEqual(['protected', 1, false]);
        expect(held.actions).toMatchObject({ markHandled: true, rearm: false, pause: true, remove: false });
        expect(one(program({ phase: 'exiting', position: 1 })).state).toBe('exiting');
    });

    it('a lapsed protection offers the rearm and asks for attention', () => {
        const lv = { phase: 'disabled' as const, detail: 'sessionEnded', position: 2, orders: [slot({ status: 'ended' })] };
        expect(lapsedLevel(program(lv).levels[0]!)).toBe(true);
        const v = one(program(lv));
        expect([v.state, v.attention, v.actions.rearm, v.actions.markHandled]).toEqual(['lapsed', true, true, true]);
    });

    it('a late fill after protection ended is unprotected', () => {
        const v = one(program({ phase: 'done', unprotected: 1, orders: [slot({ status: 'ended', filled: 1 })] }));
        expect([v.state, v.unprotected, v.attention, v.actions.remove]).toEqual(['unprotected', 1, true, false]);
    });

    it('an unknown send is decided on 委託待確認 and 我已自行處理 waits while a request leaves', () => {
        const v = one(program({ phase: 'unknown', position: 1, orders: [slot({ status: 'unknown', role: 'exit', leg: 'stop' })] }));
        expect(v.state).toBe('unknown');
        expect(v.actions.markHandled).toBe(true);
        const leaving = one(program({ phase: 'holding', position: 1,
            orders: [slot({}), slot({ key: 'x', role: 'exit', leg: 'stop', status: 'pendingSubmit' })] }));
        expect(leaving.actions.markHandled).toBe(false);
    });

    it('paused keeps the stop watching; handled and finished can be removed', () => {
        const paused = one(program({ phase: 'holding', position: 1 }, { status: 'paused' }));
        expect([paused.paused, paused.state, paused.actions.resume]).toEqual([true, 'protected', true]);
        const handled = program({ phase: 'done', detail: 'handledByUser', orders: [slot({ status: 'ended' })] }, { status: 'stopped' });
        expect(bracketFinished(handled)).toBe(true);
        expect(one(handled)).toMatchObject({ state: 'handled', actions: { remove: true, markHandled: false } });
        expect(one(program({ phase: 'done', detail: 'rearmed', orders: [slot({ status: 'ended' })] })).state).toBe('rearmed');
        // lots it knew unprotected stay shown after a rearm
        expect(one(program({ phase: 'done', detail: 'rearmed', unprotected: 1, orders: [slot({ status: 'ended' })] })).state)
            .toBe('unprotected');
    });

    it('only brackets are listed', () => {
        expect(bracketViews([program({}, { kind: 'trigger' })])).toEqual([]);
    });
});

describe('background bracket request', () => {
    const spec = { env: 'http://127.0.0.1:1|simulation', account: { account_type: 'F' as const, broker_id: 'B', account_id: 'A' },
        quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' as const, action: 'Sell' as const, quantity: 3,
        stopPrice: 105, takePrice: 90, tradeId: 'T1', seqno: 'S1', ordno: '', sentAt: 7 };

    it('names the environment, account, contract and the accepted entry', () => {
        const r = bracketRequestFor(spec, 'bkt-x')!;
        expect(r).toEqual({ id: 'bkt-x', side: 'Sell', qty: 3, stop: 105, take: 90,
            binding: { env: 'simulation', serverId: 'http://127.0.0.1:1', account: { accountType: 'F', brokerId: 'B', accountId: 'A' },
                contract: { market: 'futures', quoteCode: 'TXFR1', orderCode: 'TXFJ6', securityType: 'FUT' } },
            entry: { tradeId: 'T1', seqno: 'S1', ordno: null, sentAt: 7 } });
    });

    it('refuses what it cannot describe', () => {
        expect(bracketRequestFor({ ...spec, tradeId: '' })).toBeNull();
        expect(bracketRequestFor({ ...spec, quantity: 1.5 })).toBeNull();
        expect(bracketRequestFor({ ...spec, env: 'nope' })).toBeNull();
    });

    it('futures and options only; ids are fresh', () => {
        expect(backgroundBracketEligible(true, 'OPT')).toBe(true);
        expect(backgroundBracketEligible(false, 'STK')).toBe(false);
        expect(newBracketId()).not.toBe(newBracketId());
        expect(newBracketId()).toMatch(/^bkt-[a-z0-9-]+$/);
    });
});

describe('v2: bracket settings', () => {
    it('reads exactly three booleans and defaults all off', async () => {
        const { parseBracketPolicy, DEFAULT_BRACKET_POLICY, BRACKET_POLICY_TEXT } = await import('./bracket-contract');
        expect(DEFAULT_BRACKET_POLICY).toEqual({ autoRearm: false, autoProtectLateFill: false, pauseStopsExits: false });
        expect(parseBracketPolicy({ autoRearm: true, autoProtectLateFill: false, pauseStopsExits: true }))
            .toEqual({ autoRearm: true, autoProtectLateFill: false, pauseStopsExits: true });
        expect(() => parseBracketPolicy({ autoRearm: 'yes' })).toThrow();
        expect(() => parseBracketPolicy(null)).toThrow();
        for (const t of Object.values(BRACKET_POLICY_TEXT)) expect(`${t.label}${t.help}`).not.toMatch(/原生/);
    });

    it('names where a protection came from', () => {
        expect(one(program({}, { id: 'late:bkt-1:abc:1' })).origin).toBe('lateFill');
        expect(one(program({}, { id: 'rearm:bkt-1:abc:1' })).origin).toBe('rearm');
        expect(one(program({})).origin).toBe('entry');
    });
});

describe('#226 panel bracket tiers', () => {
    const tier = (id: string, index: number, over: Partial<Level> = {}): Level => ({ id, side: 'Buy', qty: 1,
        entry: { type: 'tier', of: 'L1', offset: index, index }, exit: { type: 'oco', stop: null, take: null,
            order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } },
        phase: 'idle', check: null, recross: [], pending: null, orders: [], position: 0, entryFilled: 0, unprotected: 0, cycles: 0,
        detail: null, rules: { stopTicks: 4, takeTicks: index === 0 ? 5 : null, ...(index === 1 ? { trail: { activateTicks: 5, distanceTicks: 3, stepTicks: 1 } } : {}) },
        ...over });
    function tiered(entry: Partial<Level>, tiers: Level[]): OrderProgram {
        const p = program({ ...entry, exit: null, qty: 2 });
        return { ...p, levels: [p.levels[0]!, ...tiers] };
    }

    it('one view per tier (the entry level protects nothing itself), with its tier and rules', () => {
        const views = bracketViews([tiered({}, [tier('T1', 0, { phase: 'holding', position: 1, base: 100,
            exit: { type: 'oco', stop: { price: 96, condition: 'below' }, take: { price: 105, condition: 'above' },
                order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' } } }), tier('T2', 1)])]);
        expect(views.map(v => [v.levelId, v.state, v.priced, v.tier])).toEqual([
            ['T1', 'protected', true, { index: 0, count: 2 }], ['T2', 'waitingEntry', false, { index: 1, count: 2 }]]);
        expect(views[1]!.rules).toEqual({ stopTicks: 4, takeTicks: null, trail: true });
    });

    it('a 觸價 entry not fired yet is not a bracket yet (a trigger row shows it)', () => {
        const p = tiered({ entry: { type: 'touch', condition: 'above', price: 100, order: { priceType: 'MKT', timeInForce: 'IOC' } },
            phase: 'idle', orders: [] }, [tier('T1', 0), tier('T2', 1)]);
        expect(bracketEntryWaiting(p)?.id).toBe('L1');
        expect(bracketViews([p])).toEqual([]);
    });
});
