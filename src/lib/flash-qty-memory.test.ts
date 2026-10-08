import { expect, it } from 'vitest';
import { flashQtyMemoryText, flashQtySlot, rememberedFlashQty, sanitizeFlashQtySetting, withRememberedFlashQty } from './flash-qty-memory';

it('one slot per unit: 張, 股 and 口', () => {
    expect(flashQtySlot('S', 'Common')).toBe('Common');
    expect(flashQtySlot('S', 'IntradayOdd')).toBe('IntradayOdd');
    expect(flashQtySlot('F', 'Common')).toBe('F');
    expect(flashQtySlot('F', 'IntradayOdd')).toBe('F');
});

it('restores only quantities that pass the unit limits; anything else is reported invalid', () => {
    const mem = { Common: 3, IntradayOdd: 500, F: 2 };
    expect(rememberedFlashQty(mem, 'Common')).toEqual({ qty: 3, invalid: false });
    expect(rememberedFlashQty(mem, 'IntradayOdd')).toEqual({ qty: 500, invalid: false });
    expect(rememberedFlashQty(mem, 'F')).toEqual({ qty: 2, invalid: false });
    expect(rememberedFlashQty({}, 'F')).toEqual({ qty: undefined, invalid: false });
    expect(rememberedFlashQty(undefined, 'F')).toEqual({ qty: undefined, invalid: false });
    for (const bad of [0, -1, 1.5, 1000, Number.NaN, '5', null]) {
        expect(rememberedFlashQty({ IntradayOdd: bad as number }, 'IntradayOdd')).toEqual({ qty: undefined, invalid: true });
    }
    expect(rememberedFlashQty({ Common: 10_000 }, 'Common').invalid).toBe(true);
    expect(rememberedFlashQty({ Common: 9999 }, 'Common').qty).toBe(9999);
});

it('writes a quantity only when it is valid for that unit', () => {
    expect(withRememberedFlashQty({ Common: 3 }, 'IntradayOdd', 500)).toEqual({ Common: 3, IntradayOdd: 500 });
    expect(withRememberedFlashQty({ Common: 3 }, 'IntradayOdd', 1000)).toEqual({ Common: 3 });
    expect(withRememberedFlashQty({ Common: 3 }, 'Common', 0)).toEqual({ Common: 3 });
});

it('is on by default: only an explicit false is off; missing or malformed means on with nothing remembered', () => {
    expect(sanitizeFlashQtySetting(false)).toBe(false);
    expect(sanitizeFlashQtySetting(undefined)).toEqual({});
    expect(sanitizeFlashQtySetting(null)).toEqual({});
    expect(sanitizeFlashQtySetting([1])).toEqual({});
    expect(sanitizeFlashQtySetting('x')).toEqual({});
    expect(sanitizeFlashQtySetting({})).toEqual({});
    // raw values are kept so an invalid one can be reported on restore
    expect(sanitizeFlashQtySetting({ Common: 3, IntradayOdd: 5000, X: 1 })).toEqual({ Common: 3, IntradayOdd: 5000 });
});

it('describes what is remembered with explicit units', () => {
    expect(flashQtyMemoryText({ Common: 3, IntradayOdd: 500, F: 2 })).toBe('整股 3 張｜零股 500 股｜期貨 2 口');
    expect(flashQtyMemoryText({ IntradayOdd: 500 })).toBe('零股 500 股');
    expect(flashQtyMemoryText({})).toBe('尚未記住');
});
