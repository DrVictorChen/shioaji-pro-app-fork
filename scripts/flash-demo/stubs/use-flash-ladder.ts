// demo stub of src/hooks/use-flash-ladder.ts: sample triggers and protection
// for a long 2 TXF (bracket stop 48,201 / take 48,217, background engine) plus
// a pending buy-stop entry with protection and a sell stop of the position.
import type { LadderMark } from '../../../src/lib/flash-trigger';

const mk = (m: Partial<LadderMark> & Pick<LadderMark, 'id' | 'side' | 'price' | 'quantity' | 'kind'>): LadderMark =>
    ({ protects: false, paused: false, pending: false, editable: m.kind === 'trigger', background: true, title: '', ...m });
const marks = new Map<string, { buy: LadderMark[]; sell: LadderMark[] }>();
const put = (m: LadderMark) => {
    const key = m.price.toFixed(2);
    const cur = marks.get(key) ?? { buy: [], sell: [] };
    cur[m.side].push(m);
    marks.set(key, cur);
};
put(mk({ id: 'bg:1:stop', side: 'sell', price: 48201, quantity: 2, kind: 'stop', title: '停損 賣 2 口 @ 48201（括號單保護・背景執行；請到條件單面板修改）' }));
put(mk({ id: 'bg:1:take', side: 'sell', price: 48217, quantity: 2, kind: 'take', title: '停利 賣 2 口 @ 48217（括號單保護・背景執行；請到條件單面板修改）' }));
put(mk({ id: 'bg:2:e', side: 'buy', price: 48219, quantity: 1, kind: 'trigger', protects: true, condition: 'above',
    title: '觸價單 成交價 ≥ 48219 → 買 1 口・成交後附停損停利\n點一下刪除・拖曳改觸發價' }));
put(mk({ id: 'bg:3:e', side: 'sell', price: 48203, quantity: 1, kind: 'trigger', condition: 'below',
    title: '停損觸價 成交價 ≤ 48203 → 賣 1 口\n點一下刪除・拖曳改觸發價' }));

export function useFlashLadder() {
    return { marks, protectedQty: 2, background: true };
}
