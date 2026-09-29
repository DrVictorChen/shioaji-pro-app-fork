// src/components/custom-theme-editor.css.ts

import { globalStyle, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const editor = style({
    display: 'flex',
    flexDirection: 'column',
    gap: vars.space.sm,
    padding: vars.space.sm,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.md,
    background: vars.color.inset,
});

export const presets = style({ display: 'flex', flexWrap: 'wrap', gap: vars.space.xs });

const presetBase = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '3px 10px 3px 4px',
    borderRadius: 999,
    border: `1px solid ${vars.color.border}`,
    background: vars.color.panel,
    color: vars.color.foreground,
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    cursor: 'pointer',
});

export const preset = styleVariants({
    off: [presetBase, { ':hover': { borderColor: vars.color.borderBright } }],
    on: [presetBase, { borderColor: vars.color.accent, color: vars.color.accent }],
});

export const presetChip = style({
    display: 'inline-flex',
    borderRadius: 999,
    overflow: 'hidden',
    border: `1px solid ${vars.color.borderBright}`,
});
globalStyle(`${presetChip} > span`, { width: 8, height: 14 });

export const swatches = style({
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(min(10rem, 100%), 1fr))',
    gap: vars.space.xs,
});

export const swatch = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.sm,
    padding: '4px 8px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panel,
    fontFamily: vars.font.body,
    fontSize: '0.7rem',
    color: vars.color.foreground,
    cursor: 'pointer',
    selectors: { '&:focus-within': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 1 } },
});

export const colorInput = style({
    width: 20,
    height: 20,
    padding: 0,
    border: `1px solid ${vars.color.borderBright}`,
    borderRadius: 4,
    background: 'none',
    cursor: 'pointer',
    flex: 'none',
    selectors: {
        '&::-webkit-color-swatch-wrapper': { padding: 0 },
        '&::-webkit-color-swatch': { border: 'none', borderRadius: 3 },
    },
});

export const hex = style({
    marginLeft: 'auto',
    fontFamily: vars.font.mono,
    fontSize: '0.64rem',
    color: vars.color.mutedForeground,
});

export const preview = style({
    display: 'flex',
    alignItems: 'center',
    gap: vars.space.md,
    padding: '6px 10px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panel,
    color: vars.color.foreground,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
});

export const previewAccent = style({ marginLeft: 'auto', color: vars.color.accent });

export const reset = style({
    alignSelf: 'flex-end',
    padding: '3px 10px',
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    background: vars.color.panel,
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    cursor: 'pointer',
    selectors: { '&:disabled': { opacity: 0.5, cursor: 'default' } },
});
