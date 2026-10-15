import { expect, it, vi } from 'vitest';
import { operationNotice } from './operation-notice';

const result = { kind: 'err' as const, title: '整零價差未送出', body: '確認期間伺服器或模擬／正式環境已切換' };
const unrelated = { kind: 'err' as const, title: '委託回報訂閱失敗', body: '資料可能過期' };

it.each(['before', 'after'] as const)('matches the operation with unrelated notices %s', position => {
    const notify = vi.fn();
    if (position === 'before') notify(unrelated);
    notify(result);
    if (position === 'after') notify(unrelated);
    expect(operationNotice(notify, /^整零價差/)).toEqual(result);
});

it('rejects missing and duplicate operation notices', () => {
    const notify = vi.fn();
    notify(unrelated);
    expect(() => operationNotice(notify, result.title)).toThrow();
    notify(result);
    notify(result);
    expect(() => operationNotice(notify, result.title)).toThrow();
});

it('checks a repeated operation only after its own starting offset', () => {
    const notify = vi.fn();
    notify({ ...result, body: '前一次操作' });
    const since = notify.mock.calls.length;
    notify(result);
    notify(unrelated);
    expect(operationNotice(notify, result.title, since)).toEqual(result);
});
