import { expect } from 'vitest';
import type { AppNotice } from '../lib/trade';

/** Assert exactly one notice for this operation, independent of other services.
 * Pass a call offset when the same operation is performed twice in one test. */
export function operationNotice(
    notify: { mock: { calls: AppNotice[][] } },
    title: string | RegExp,
    since = 0,
): AppNotice {
    const notices = notify.mock.calls.slice(since).map(([notice]) => notice!)
        .filter(notice => typeof title === 'string' ? notice.title === title : title.test(notice.title));
    expect(notices, `操作通知 ${title}`).toHaveLength(1);
    return notices[0]!;
}
