// src/components/scanner-panel.css.ts

import { createContainer, style, styleVariants } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const switcher = style({
    display: 'flex',
    gap: '2px',
    padding: `4px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

const swBase = style({
    flex: 1,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    fontWeight: 500,
    padding: '3px 0',
    cursor: 'pointer',
    background: 'transparent',
    border: '1px solid transparent',
    borderRadius: vars.radius.sm,
    color: vars.color.mutedForeground,
});

export const sw = styleVariants({
    off: [swBase, { ':hover': { color: vars.color.foreground } }],
    on: [
        swBase,
        {
            color: vars.color.foreground,
            background: vars.color.muted,
            fontWeight: 600,
        },
    ],
});

// 窄面板：類股 chip 讓位，避免代號被蓋住、價格溢出右緣
const list = createContainer();
const NARROW = `${list} (max-width: 14rem)`;

export const body = style({
    containerName: list,
    containerType: 'inline-size',
});

// two-line rows: code+name stacked tight on the left, price/pct and
// volume stacked on the right — no dead space between code and name
export const row = style({
    display: 'grid',
    // 4em：代號欄保底寬度（6 碼代號），不再被壓成 0
    gridTemplateColumns: '1.2rem minmax(4em, 1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    borderBottom: `1px solid rgba(34, 43, 55, 0.45)`,
    ':hover': { background: vars.color.muted },
});

export const idBlock = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
});

export const scCode = style({
    fontWeight: 600,
    color: vars.color.foreground,
});

export const valueBlock = style({
    // 固定第 4 欄：chip 隱藏時不往左遞補
    gridColumn: 4,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    whiteSpace: 'nowrap',
    // 極窄時價格／漲幅折成兩行，而不是溢出右緣
    '@container': { [NARROW]: { whiteSpace: 'normal' } },
});

export const rowPicked = style({
    background: vars.color.accentDim,
});

export const scSub = style({
    textAlign: 'right',
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
});

// clickable 類別 chip that jumps the heatmap to this stock's sector
export const sectorTag = style({
    fontSize: '0.6rem',
    fontFamily: vars.font.body,
    color: vars.color.mutedForeground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 5px',
    whiteSpace: 'nowrap',
    // 空間不足時 chip 先以省略號縮短，讓出代號與價格
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    cursor: 'pointer',
    ':hover': {
        color: vars.color.accent,
        borderColor: vars.color.accent,
    },
    '@container': { [NARROW]: { display: 'none' } },
});

export const errorBox = style({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: vars.space.xs,
    padding: '1rem',
});

export const retryBtn = style({
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    color: vars.color.accent,
    background: 'transparent',
    border: `1px solid ${vars.color.accent}`,
    borderRadius: vars.radius.sm,
    padding: '2px 12px',
    cursor: 'pointer',
});

export const rank = style({
    color: vars.color.mutedForeground,
    fontSize: '0.64rem',
    fontWeight: 600,
});

export const scName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
});

export const scValue = style({
    textAlign: 'right',
    fontWeight: 600,
});

// 複選 threshold inputs
export const filterRow = style({
    display: 'flex',
    gap: vars.space.sm,
    padding: `3px ${vars.space.sm}`,
    borderBottom: `1px solid ${vars.color.border}`,
    flexShrink: 0,
});

export const filterItem = style({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: '0.62rem',
    color: vars.color.mutedForeground,
    flex: 1,
});

export const filterInput = style({
    width: '100%',
    minWidth: 0,
    fontFamily: vars.font.mono,
    fontSize: '0.68rem',
    textAlign: 'right',
    color: vars.color.foreground,
    background: vars.color.inset,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: '1px 4px',
    outline: 'none',
    ':focus': { borderColor: vars.color.accent },
});
