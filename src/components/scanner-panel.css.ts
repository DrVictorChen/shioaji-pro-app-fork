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

// 窄面板：產業類別 chip 讓位，每列固定兩行、各欄上下對齊；預設寬度不受影響
//   第 1 行：名次｜代號｜價格｜漲跌幅
//   第 2 行：　　｜名稱｜量（跨價格＋漲跌幅，右緣對齊）
// 極窄時（代號欄放不下 6 字）漲跌幅改到第 2 行取代量，所有列一起換。
// 欄寬用 ch（列字型為 mono）：價格最長 6 字（≥500 不帶小數），漲跌幅 7 字。
const list = createContainer();
const NARROW = `${list} (max-width: 14rem)`;
// 1.2rem + 6ch + 6ch + 7ch + 3 gaps + padding ≈ 11rem
const COMPACT = `${list} (max-width: 11rem)`;

export const body = style({
    containerName: list,
    containerType: 'inline-size',
});

// two-line rows: code+name stacked tight on the left, price/pct and
// volume stacked on the right — no dead space between code and name
export const row = style({
    display: 'grid',
    gridTemplateColumns: '1.2rem minmax(0, 1fr) auto auto',
    alignItems: 'center',
    columnGap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    cursor: 'pointer',
    borderBottom: `1px solid rgba(34, 43, 55, 0.45)`,
    ':hover': { background: vars.color.muted },
    '@container': {
        [NARROW]: {
            gridTemplateColumns: '1.2rem minmax(6ch, 1fr) 6ch 7ch',
            gridTemplateRows: 'auto auto',
            borderBottomColor: vars.color.border,
        },
        [COMPACT]: { gridTemplateColumns: '1.2rem minmax(6ch, 1fr) 7ch' },
    },
});

export const idBlock = style({
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    // 窄面板：拆開讓代號、名稱直接排進列的 grid
    '@container': { [NARROW]: { display: 'contents' } },
});

export const scCode = style({
    fontWeight: 600,
    color: vars.color.foreground,
    '@container': { [NARROW]: { gridRow: 1, gridColumn: 2 } },
});

export const valueBlock = style({
    // 固定第 4 欄：chip 隱藏時不往左遞補
    gridColumn: 4,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    whiteSpace: 'nowrap',
    '@container': { [NARROW]: { display: 'contents' } },
});

export const rowPicked = style({
    background: vars.color.accentDim,
});

export const scSub = style({
    textAlign: 'right',
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    '@container': {
        [NARROW]: { gridRow: 2, gridColumn: '3 / 5' },
        [COMPACT]: { display: 'none' },
    },
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
    '@container': { [NARROW]: { gridRow: 1, gridColumn: 1 } },
});

export const scName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
    '@container': { [NARROW]: { gridRow: 2, gridColumn: 2 } },
});

export const scValue = style({
    textAlign: 'right',
    fontWeight: 600,
    '@container': { [NARROW]: { display: 'contents' } },
});

// 價格／漲跌幅：寬面板仍是同一行的兩段文字，窄面板各占一欄右對齊
export const scPrice = style({
    '@container': {
        [NARROW]: { gridRow: 1, gridColumn: 3, justifySelf: 'end' },
    },
});

export const scPct = style({
    '@container': {
        [NARROW]: { gridRow: 1, gridColumn: 4, justifySelf: 'end' },
        [COMPACT]: { gridRow: 2, gridColumn: 3 },
    },
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
