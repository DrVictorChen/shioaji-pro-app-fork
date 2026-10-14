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

// 排行列：每列固定兩行，所有列共用同一組欄寬，各欄上下對齊。
//   寬面板：名次｜代號／名稱｜產業｜價格｜漲跌幅（量在第 2 行跨價格＋漲跌幅）
//   窄面板（放不下產業欄）：產業隱藏，其餘不變
//   極窄（代號欄放不下 6 字）：漲跌幅改到第 2 行取代量，量隱藏
// 數字欄用 ch（列字型為 mono）：價格最長 6 字（≥500 不帶小數），漲跌幅 7 字；
// 代號欄保底 6 字（6 碼 ETF）。產業欄寬 = 最長「電子零組件」5 字 + padding/border。
// 門檻依欄寬加總（2ch + 6ch + 產業 + 6ch + 7ch + gaps + padding）量測取整：
//   寬面板最少需約 14.4rem，極窄門檻約 10.6rem。
const list = createContainer();
const NARROW = `${list} (max-width: 14.4rem)`;
const COMPACT = `${list} (max-width: 10.75rem)`;
const TAG_FONT = '0.6rem';
const TAG_PAD_X = '4px';
const TAG_COL = `calc(5 * ${TAG_FONT} + 2 * ${TAG_PAD_X} + 2px)`;

export const body = style({
    containerName: list,
    containerType: 'inline-size',
});

export const row = style({
    display: 'grid',
    gridTemplateColumns: `2ch minmax(6ch, 1fr) ${TAG_COL} 6ch 7ch`,
    gridTemplateRows: 'auto auto',
    alignItems: 'center',
    columnGap: vars.space.xs,
    padding: `3px ${vars.space.sm}`,
    fontFamily: vars.font.mono,
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    borderBottom: `1px solid ${vars.color.border}`,
    ':hover': { background: vars.color.muted },
    '@container': {
        [NARROW]: { gridTemplateColumns: '2ch minmax(6ch, 1fr) 6ch 7ch' },
        [COMPACT]: { gridTemplateColumns: '2ch minmax(6ch, 1fr) 7ch' },
    },
});

// 代號／名稱、價格／量的外框不參與排版，子元素直接排進列的 grid
export const idBlock = style({ display: 'contents' });
export const valueBlock = style({ display: 'contents' });

export const scCode = style({
    gridRow: 1,
    gridColumn: 2,
    fontWeight: 600,
    color: vars.color.foreground,
});

export const rowPicked = style({
    background: vars.color.accentDim,
});

export const scSub = style({
    gridRow: 2,
    gridColumn: '4 / 6',
    textAlign: 'right',
    color: vars.color.mutedForeground,
    fontSize: '0.62rem',
    '@container': {
        [NARROW]: { gridColumn: '3 / 5' },
        [COMPACT]: { display: 'none' },
    },
});

// clickable 類別 chip that jumps the heatmap to this stock's sector —
// 固定寬度欄、欄內靠左，所有列左緣對齊；沒有產業的列留空
export const sectorTag = style({
    gridRow: '1 / 3',
    gridColumn: 3,
    justifySelf: 'start',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    fontSize: TAG_FONT,
    fontFamily: vars.font.body,
    color: vars.color.mutedForeground,
    background: vars.color.muted,
    border: `1px solid ${vars.color.border}`,
    borderRadius: vars.radius.sm,
    padding: `1px ${TAG_PAD_X}`,
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
    gridRow: 1,
    gridColumn: 1,
});

export const scName = style({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: vars.color.mutedForeground,
    fontFamily: vars.font.body,
    fontSize: '0.66rem',
});

// 排行列的名稱（第 2 行，截斷＋…）
export const rowName = style({ gridRow: 2, gridColumn: 2 });

export const scValue = style({
    display: 'contents',
    textAlign: 'right',
    fontWeight: 600,
});

// 價格／漲跌幅各占一個固定寬度欄、右對齊
export const scPrice = style({
    gridRow: 1,
    gridColumn: 4,
    justifySelf: 'end',
    '@container': { [NARROW]: { gridColumn: 3 } },
});

export const scPct = style({
    gridRow: 1,
    gridColumn: 5,
    justifySelf: 'end',
    '@container': {
        [NARROW]: { gridColumn: 4 },
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
