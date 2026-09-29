// src/lib/activity.test.ts — 操作紀錄的時間以台北時間顯示（#151）

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLog, clearActivity, trackActivity } from './activity';

const ORIGINAL_TZ = process.env.TZ;

describe('activityLog', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        clearActivity();
    });
    afterEach(() => {
        clearActivity();
        vi.useRealTimers();
        if (ORIGINAL_TZ === undefined) delete process.env.TZ;
        else process.env.TZ = ORIGINAL_TZ;
    });

    it('prints Taipei wall-clock time regardless of the machine timezone', () => {
        // 台北 09-25 08:45 ＝ UTC 09-25 00:45 ＝ 紐約 09-24 20:45
        vi.setSystemTime(new Date('2026-09-25T00:45:00Z'));
        trackActivity('選商品', '2330');
        // 台北 09-26 00:05 ＝ UTC 09-25 16:05（跨台北午夜）
        vi.setSystemTime(new Date('2026-09-25T16:05:00Z'));
        trackActivity('下單', 'TXF');
        const want = ['08:45 選商品 2330', '00:05 下單 TXF'];
        for (const tz of ['Asia/Taipei', 'UTC', 'America/New_York', 'Europe/London']) {
            process.env.TZ = tz;
            expect(activityLog(), tz).toEqual(want);
        }
        process.env.TZ = 'America/New_York';
        expect(new Date('2026-09-25T00:45:00Z').getHours()).toBe(20);
    });
});
