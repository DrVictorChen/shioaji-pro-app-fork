// src/components/flash-link-host.css.ts — 對應商品暫停時的說明

import { style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const empty = style({
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: vars.space.md,
    textAlign: 'center',
    color: vars.color.mutedForeground,
});

export const emptyTitle = style({
    fontFamily: vars.font.body,
    fontSize: '0.74rem',
    fontWeight: 600,
    color: vars.color.foreground,
});

export const emptyNote = style({
    fontFamily: vars.font.body,
    fontSize: '0.64rem',
    lineHeight: 1.5,
});

export const emptyBtn = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
    padding: '3px 10px',
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 600,
    color: vars.color.accent,
    background: vars.color.accentDim,
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    cursor: 'pointer',
});

export const monthSelect = style({ width: 'auto', flex: '1 1 0', minWidth: 0, border: 'none', borderRadius: 0 });

export const emptyActions = style({ display: 'inline-flex', gap: 6 });
