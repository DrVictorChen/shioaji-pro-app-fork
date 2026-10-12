import { expect, it } from 'vitest';
import { orderStatusLabel, orderStatusWithNumber } from './order-status-label';

it('every broker status has a Chinese label', () => {
    const labels = (['Cancelled', 'Filled', 'PartFilled', 'Inactive', 'Failed', 'PendingSubmit', 'PreSubmitted', 'Submitted'] as const).map(orderStatusLabel);
    expect(labels).toEqual(['已取消', '全部成交', '部分成交', '未確認', '失敗', '送出中', '預約中', '已委託']);
    for (const l of labels) expect(l).not.toMatch(/[A-Za-z]/);
});

it('order feedback reads 「送出中 #003627」, not the raw broker status', () => {
    const text = orderStatusWithNumber({ status: { status: 'PendingSubmit' }, order: { seqno: '003627', id: 'abcdef123456' } });
    expect(text).toBe('送出中 #003627');
    expect(orderStatusWithNumber({ status: { status: 'Submitted' }, order: { seqno: '', id: 'abcdef123456' } })).toBe('已委託 #abcdef12');
});

it('an unknown status is shown as such, never guessed', () => {
    expect(orderStatusLabel('SomethingNew')).toBe('狀態 SomethingNew');
    expect(orderStatusLabel(undefined)).toBe('狀態未知');
    expect(orderStatusLabel('constructor')).toBe('狀態 constructor');
});
