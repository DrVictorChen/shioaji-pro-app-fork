// src/lib/settle-date.test.ts — 交割日期在非台北時區也要與台北一致（#151）

import { afterEach, describe, expect, it } from 'vitest';
import { bizDateLabel, settleDateLabel } from './settle-date';

const ORIGINAL_TZ = process.env.TZ;
const ZONES = ['Asia/Taipei', 'UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati'];

function inZone<T>(tz: string, fn: () => T): T {
    process.env.TZ = tz;
    return fn();
}

afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
});

describe('bizDateLabel', () => {
    it('counts T+n business days from the Taipei date in every machine timezone', () => {
        // 台北 2026-09-25（五）01:30 ＝ UTC 09-24（四）17:30 ＝ 紐約 09-24 13:30
        const now = Date.parse('2026-09-24T17:30:00Z');
        const want = ['09/25 (五)', '09/28 (一)', '09/29 (二)'];
        for (const tz of ZONES) {
            const got = inZone(tz, () => [0, 1, 2].map((t) => bizDateLabel(t, now)));
            expect(got, tz).toEqual(want);
        }
        // 確認測試真的跑在非台北時區：紐約本地仍是週四
        expect(inZone('America/New_York', () => new Date(now).getDay())).toBe(4);
    });

    it('stays on the Taipei date right before Taipei midnight', () => {
        // 台北 2026-09-26（六）23:59 ＝ UTC 09-26 15:59；Kiritimati（UTC+14）已是 09-27
        const now = Date.parse('2026-09-26T15:59:00Z');
        for (const tz of ZONES) {
            const got = inZone(tz, () => [0, 1, 2].map((t) => bizDateLabel(t, now)));
            expect(got, tz).toEqual(['09/26 (六)', '09/28 (一)', '09/29 (二)']);
        }
    });

    it('defaults to the current time', () => {
        expect(bizDateLabel(0)).toBe(bizDateLabel(0, Date.now()));
    });
});

describe('settleDateLabel', () => {
    it('labels the server date with the same weekday in every timezone', () => {
        for (const tz of ZONES) {
            expect(inZone(tz, () => settleDateLabel('2026-09-29')), tz).toBe('09/29 (二)');
            expect(inZone(tz, () => settleDateLabel('2026-10-03T00:00:00')), tz).toBe(
                '10/03 (六)',
            );
        }
    });

    it('returns unparsable input unchanged', () => {
        expect(settleDateLabel('—')).toBe('—');
    });
});
