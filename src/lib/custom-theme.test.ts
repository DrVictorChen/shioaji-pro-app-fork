import { describe, expect, it } from 'vitest';
import { CUSTOM_BASES, CUSTOM_PRESETS, customTokens, isCustomTheme, mix } from './custom-theme';

describe('custom theme', () => {
    it('mixes colors and validates saved themes', () => {
        expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
        expect(isCustomTheme(CUSTOM_BASES.light)).toBe(true);
        expect(CUSTOM_PRESETS.every(p => isCustomTheme(p.theme))).toBe(true);
        expect(isCustomTheme({ ...CUSTOM_BASES.dark, accent: 'blue' })).toBe(false);
        expect(isCustomTheme({ ...CUSTOM_BASES.dark, base: 'midnight' })).toBe(false);
    });

    it('derives every token and follows the price-color convention', () => {
        const t = CUSTOM_PRESETS[0]!.theme;
        const tw = customTokens(t, 'tw');
        expect(tw.up).toBe(t.red);
        expect(tw.down).toBe(t.green);
        expect(customTokens(t, 'intl').up).toBe(t.green);
        expect(tw.background).toBe(t.background);
        expect(tw.border).toMatch(/^#[0-9a-f]{6}$/);
        expect(tw.accentDim).toMatch(/^rgba\(/);
    });
});
