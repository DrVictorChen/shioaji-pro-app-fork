// 委託條件（效期、價別、期貨倉別）的共用規則：下單面板與閃電下單用同一份
// 清單、同一個預設、同一個送出前檢查與同一種確認文字。
import { describe, expect, it } from 'vitest';
import * as oc from './order-conditions';

describe('lists shared by the order ticket and the flash ladder', () => {
    it('stocks price LMT/MKT; futures add MKP (範圍市價)', () => {
        expect(oc.priceTypesFor(false)).toEqual(['LMT', 'MKT']);
        expect(oc.priceTypesFor(true)).toEqual(['LMT', 'MKT', 'MKP']);
        expect(oc.ORDER_TYPES).toEqual(['ROD', 'IOC', 'FOK']);
        expect(oc.FUTURES_OCTYPES.map(o => o.value)).toEqual(['Auto', 'New', 'Cover', 'DayTrade']);
        expect(oc.FUTURES_OCTYPES.map(o => o.label)).toEqual(['自動', '新倉', '平倉', '當沖']);
    });
    it('a market price type defaults to IOC, a limit to ROD (as the ticket did)', () => {
        expect(oc.defaultOrderTypeFor('LMT')).toBe('ROD');
        expect(oc.defaultOrderTypeFor('MKT')).toBe('IOC');
        expect(oc.defaultOrderTypeFor('MKP')).toBe('IOC');
    });
    it('odd lots only allow LMT + ROD', () => {
        expect(oc.orderTypeDisabledReason('IOC', true)).toBeTruthy();
        expect(oc.orderTypeDisabledReason('ROD', true)).toBeNull();
        expect(oc.orderTypeDisabledReason('FOK', false)).toBeNull();
        expect(oc.priceTypeDisabledReason('MKT', true)).toBeTruthy();
        expect(oc.priceTypeDisabledReason('LMT', true)).toBeNull();
    });
});

describe('futuresOrderProblem (last check before a futures order goes out)', () => {
    it('accepts every combination the ticket offers', () => {
        for (const price_type of ['LMT', 'MKT', 'MKP'])
            for (const order_type of ['ROD', 'IOC', 'FOK'])
                for (const octype of ['Auto', 'New', 'Cover', 'DayTrade', undefined])
                    expect(oc.futuresOrderProblem({ price_type, order_type, octype })).toBeNull();
    });
    it('refuses unknown values with a plain explanation', () => {
        expect(oc.futuresOrderProblem({ price_type: 'MKP2', order_type: 'ROD' })).toBe(oc.ORDER_CONDITION_TEXT.priceType);
        expect(oc.futuresOrderProblem({ price_type: 'LMT', order_type: 'GTC' })).toBe(oc.ORDER_CONDITION_TEXT.orderType);
        expect(oc.futuresOrderProblem({ price_type: 'LMT', order_type: 'ROD', octype: 'Close' })).toBe(oc.ORDER_CONDITION_TEXT.octype);
    });
});

describe('quickOrderNote — the confirmation line names every non-default condition', () => {
    it('defaults say nothing', () => {
        expect(oc.quickOrderNote({ market: false })).toBeUndefined();
        expect(oc.quickOrderNote({ market: true })).toBeUndefined();
        expect(oc.quickOrderNote({ market: false, orderType: 'ROD', octype: 'Auto', futures: true })).toBeUndefined();
    });
    it('limit order type, 範圍市價, 倉別 and credit', () => {
        expect(oc.quickOrderNote({ market: false, orderType: 'IOC' })).toBe('限價 IOC');
        expect(oc.quickOrderNote({ market: false, orderType: 'FOK', futures: true, octype: 'New' })).toBe('限價 FOK・新倉');
        expect(oc.quickOrderNote({ market: false, futures: true, octype: 'DayTrade' })).toBe('限價 ROD・當沖');
        expect(oc.quickOrderNote({ market: true, futures: true, priceType: 'MKP' })).toBe('範圍市價 IOC');
        expect(oc.quickOrderNote({ market: true, futures: true, priceType: 'MKP', octype: 'Cover' })).toBe('範圍市價 IOC・平倉');
        expect(oc.quickOrderNote({ market: false, credit: '融券' })).toBe('限價 ROD・融券');
        expect(oc.quickOrderNote({ market: true, credit: '融資' })).toBe('市價 IOC・融資');
        expect(oc.quickOrderNote({ market: false, orderType: 'IOC', credit: '現股當沖' })).toBe('限價 IOC・現股當沖');
    });
    it('odd lots keep their own line', () => {
        expect(oc.quickOrderNote({ market: false, oddLotLabel: '盤中零股' })).toBe('盤中零股・限價 ROD');
    });
});
