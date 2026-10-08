// 連動群組：連動（跟自選）／群組 A／B／C（群組內共用一個代碼）／鎖定。
import { describe, expect, it } from 'vitest';
import { blockLinkMode, blockSourceCode, linkGroupSummary, withGroupCode, withLinkMode, type Workspace } from './workspace';

const ws = (): Workspace => ({
    blocks: [
        { id: 'f1', type: 'flash', pin: null },
        { id: 'f2', type: 'flash', pin: null },
        { id: 'f3', type: 'flash', pin: '2454' },
        { id: 'c1', type: 'chart', pin: null },
    ],
    layout: [],
});

describe('link groups', () => {
    it('joining an empty group seeds it with the panel\'s current code; joining a used group adopts its code', () => {
        let w = withLinkMode(ws(), 'f1', 'A', '2330');
        expect(w.linkGroups).toEqual({ A: '2330' });
        expect(blockLinkMode(w.blocks[0]!)).toBe('A');
        w = withLinkMode(w, 'f2', 'A', '2317');
        expect(w.linkGroups).toEqual({ A: '2330' });
        expect(blockSourceCode(w.blocks[1]!, w)).toBe('2330');
    });
    it('a pinned panel joining a group drops its pin; locking drops the group', () => {
        let w = withLinkMode(ws(), 'f3', 'B', '2454');
        expect(w.blocks[2]).toMatchObject({ pin: null, linkGroup: 'B' });
        expect(w.linkGroups).toEqual({ B: '2454' });
        w = withLinkMode(w, 'f3', 'pin', '2454');
        expect(w.blocks[2]!.pin).toBe('2454');
        expect(w.blocks[2]!.linkGroup).toBeUndefined();
        w = withLinkMode(w, 'f3', 'main', null);
        expect(blockLinkMode(w.blocks[2]!)).toBe('main');
        expect(blockSourceCode(w.blocks[2]!, w)).toBeNull();
    });
    it('changing a group\'s code moves every member and nobody else', () => {
        let w = withLinkMode(ws(), 'f1', 'A', '2330');
        w = withLinkMode(w, 'f2', 'B', '2603');
        w = withGroupCode(w, 'A', '2317');
        expect(blockSourceCode(w.blocks[0]!, w)).toBe('2317');
        expect(blockSourceCode(w.blocks[1]!, w)).toBe('2603');
        expect(blockSourceCode(w.blocks[2]!, w)).toBe('2454');
    });
    it('joining a group nobody uses any more starts from the panel\'s code, not the old hidden one', () => {
        let w = withLinkMode(ws(), 'f1', 'C', '2330');
        w = withLinkMode(w, 'f1', 'main', null);
        w = withLinkMode(w, 'f2', 'C', '2603');
        expect(blockSourceCode(w.blocks[1]!, w)).toBe('2603');
    });
    it('summarises each group for the menu', () => {
        let w = withLinkMode(ws(), 'f1', 'A', '2330');
        w = withLinkMode(w, 'f2', 'A', '2330');
        expect(linkGroupSummary(w)).toEqual([
            { id: 'A', code: '2330', count: 2 },
            { id: 'B', code: null, count: 0 },
            { id: 'C', code: null, count: 0 },
        ]);
    });
    it('only flash panels join groups; other panels keep following the selection', () => {
        const w = withLinkMode(ws(), 'c1', 'A', '2330');
        expect(w.blocks[3]!.linkGroup).toBeUndefined();
        const forced = { ...ws(), linkGroups: { A: '2330' }, blocks: ws().blocks.map(b => (b.id === 'c1' ? { ...b, linkGroup: 'A' as const } : b)) };
        expect(blockLinkMode(forced.blocks[3]!)).toBe('main');
        expect(blockSourceCode(forced.blocks[3]!, forced)).toBeNull();
    });
    it('ignores an unknown saved group', () => {
        const w = { ...ws(), blocks: [{ id: 'x', type: 'flash', pin: null, linkGroup: 'Z' }] } as unknown as Workspace;
        expect(blockLinkMode(w.blocks[0]!)).toBe('main');
    });
});
