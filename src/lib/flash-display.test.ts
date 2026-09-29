import { describe, expect, it } from 'vitest';
import { flashAccountLabels, flashSymbolLabel } from './flash-display';
import type { Account } from './types/portfolio';

const acct = (broker_id: string, account_id: string, username = ''): Account => ({
    account_type: 'F', person_id: 'P', broker_id, account_id, signed: true, username,
});

describe('flashSymbolLabel', () => {
    it('adds the delivery month to futures and the market to stocks', () => {
        expect(flashSymbolLabel({ code: 'TMFJ6', name: '微型臺指', exchange: 'TAIFEX', security_type: 'FUT', delivery_month: '202610' }))
            .toMatchObject({ name: '微型臺指 2026/10', meta: 'TMFJ6' });
        expect(flashSymbolLabel({ code: '6182', name: '合晶', exchange: 'OTC', security_type: 'STK', delivery_month: undefined }))
            .toMatchObject({ name: '合晶', meta: '上櫃・6182' });
    });
    it('reformats a month already in the name instead of repeating it', () => {
        expect(flashSymbolLabel({ code: 'TXFJ6', name: '臺股期貨 202610', exchange: 'TAIFEX', security_type: 'FUT', delivery_month: '202610' }).name)
            .toBe('臺股期貨 2026/10');
    });
    it('falls back to the code when the name is missing', () => {
        expect(flashSymbolLabel({ code: 'TXFJ6', name: '', exchange: 'TAIFEX', security_type: 'FUT', delivery_month: undefined }).name).toBe('TXFJ6');
    });
});

describe('flashAccountLabels', () => {
    it('drops a shared broker id and adds the account name only to the long label', () => {
        const a = acct('F002000', '2063902', '王小明');
        const labels = flashAccountLabels([a, acct('F002000', '2063903')], false);
        expect(labels.short(a)).toBe('2063902');
        expect(labels.long(a)).toBe('2063902 王小明');
    });
    it('keeps the broker id when accounts span brokers', () => {
        const a = acct('F002000', '2063902');
        expect(flashAccountLabels([a, acct('F001000', '1111111')], false).short(a)).toBe('F002000-2063902');
    });
    it('masks the account id and name in privacy mode', () => {
        const a = acct('F002000', '2063902', '王小明');
        const long = flashAccountLabels([a], true).long(a);
        expect(long).not.toContain('2063902');
        expect(long).not.toContain('王小明');
    });
});
