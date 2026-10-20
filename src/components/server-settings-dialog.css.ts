import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '../theme.css';

export const backdrop = style({ position: 'fixed', inset: 0, zIndex: 209, background: 'rgba(0,0,0,.45)' });
export const dialog = style({
    position: 'fixed', inset: '5vh auto auto 50%', transform: 'translateX(-50%)', zIndex: 210,
    width: 'min(44rem, calc(100vw - 24px))', maxHeight: '90dvh', display: 'flex', flexDirection: 'column',
    color: vars.color.foreground, background: vars.color.panelRaised, border: `1px solid ${vars.color.borderBright}`,
    borderRadius: vars.radius.md, boxShadow: '0 18px 48px rgba(0,0,0,.4)', fontSize: '1rem',
});
export const header = style({ flexShrink: 0, padding: '18px 20px 14px', borderBottom: `1px solid ${vars.color.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 });
export const title = style({ margin: '0 0 6px', fontSize: '1.25rem', fontWeight: 700 });
export const hint = style({ margin: 0, color: vars.color.mutedForeground, lineHeight: 1.6, overflowWrap: 'anywhere' });
export const body = style({ padding: '18px 20px', overflowY: 'auto', minHeight: 0 });
export const fields = style({ minWidth: 0, border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 20 });
export const section = style({ display: 'flex', flexDirection: 'column', gap: 10 });
export const heading = style({ margin: 0, fontSize: '1.05rem', fontWeight: 650 });
export const field = style({ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 });
export const label = style({ fontWeight: 600 });
export const input = style({ width: '100%', boxSizing: 'border-box', minWidth: 0, padding: '9px 10px', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panel, color: vars.color.foreground, fontSize: '1rem' });
export const row = style({ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' });
export const button = style({ border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, padding: '8px 12px', background: vars.color.panel, color: vars.color.foreground, cursor: 'pointer', fontSize: '1rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, selectors: { '&:disabled': { opacity: .5, cursor: 'default' }, '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: 2 } } });
export const primary = style([button, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent, fontWeight: 600 }]);
export const selected = style([button, { background: vars.color.accentDim, borderColor: vars.color.accent, color: vars.color.accent }]);
export const warning = style({ margin: 0, lineHeight: 1.6, color: vars.color.danger });
export const notice = style({ padding: '10px 12px', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, background: vars.color.panel, lineHeight: 1.6, overflowWrap: 'anywhere' });
export const footer = style({ flexShrink: 0, padding: '14px 20px', borderTop: `1px solid ${vars.color.border}`, display: 'flex', flexDirection: 'column', gap: 10, background: vars.color.panelRaised, borderRadius: `0 0 ${vars.radius.md} ${vars.radius.md}` });
export const actions = style([row, { justifyContent: 'flex-end' }]);
export const details = style({ borderTop: `1px solid ${vars.color.border}`, paddingTop: 14 });
globalStyle(`${details} > summary`, { cursor: 'pointer', fontWeight: 600, marginBottom: 12 });

// 帳號設定列表與編輯（#193）— 模擬／正式徽章沿用頁首配色（模擬琥珀框、正式紅底）
export const profileList = style({ display: 'flex', flexDirection: 'column', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, overflow: 'hidden' });
export const profileItem = style({
    display: 'grid', gridTemplateColumns: '20px minmax(0, 1fr) auto', alignItems: 'center', gap: 12,
    padding: '12px 14px', background: vars.color.panel,
    selectors: { '& + &': { borderTop: `1px solid ${vars.color.border}` } },
});
export const profileActive = style({ background: vars.color.accentDim });
export const profileMark = style({ display: 'inline-flex', color: vars.color.accent });
export const profileIdle = style({ width: 12, height: 12, borderRadius: '50%', border: `1.5px solid ${vars.color.borderBright}`, boxSizing: 'border-box', justifySelf: 'center' });
export const profileMain = style({ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 });
export const profileName = style({ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, fontWeight: 650 });
export const profileNameText = style({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const profileMeta = style({ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', color: vars.color.mutedForeground, fontSize: '0.9rem' });
export const mono = style({ fontFamily: vars.font.mono, letterSpacing: '0.02em' });
export const metaDanger = style({ color: vars.color.danger, display: 'inline-flex', alignItems: 'center', gap: 4 });
const badgeBase = { fontSize: '0.75rem', fontWeight: 650, letterSpacing: '0.04em', borderRadius: vars.radius.sm, padding: '1px 8px', whiteSpace: 'nowrap', flexShrink: 0 } as const;
export const simBadge = style({ ...badgeBase, color: vars.color.amber, border: '1px solid rgba(224, 164, 60, 0.45)', background: 'rgba(224, 164, 60, 0.08)' });
export const prodBadge = style({ ...badgeBase, color: '#fff', background: vars.color.up, border: `1px solid ${vars.color.up}` });
export const profileActions = style({ display: 'flex', alignItems: 'center', gap: 6 });
export const iconButton = style([button, { padding: 7 }]);
export const dangerButton = style([button, { color: vars.color.danger, borderColor: vars.color.danger }]);
export const editorHead = style({ display: 'flex', alignItems: 'center', gap: 10 });
export const card = style({ display: 'flex', flexDirection: 'column', gap: 12, padding: '14px 16px', border: `1px solid ${vars.color.border}`, borderRadius: vars.radius.sm, background: vars.color.panel });
export const cardTitle = style({ margin: 0, fontSize: '0.95rem', fontWeight: 650, color: vars.color.mutedForeground, display: 'flex', alignItems: 'center', gap: 6 });
export const segmented = style({ display: 'inline-flex', border: `1px solid ${vars.color.borderBright}`, borderRadius: vars.radius.sm, overflow: 'hidden', alignSelf: 'flex-start' });
export const segment = style({ border: 0, padding: '8px 16px', background: 'transparent', color: vars.color.mutedForeground, cursor: 'pointer', fontSize: '1rem', selectors: { '& + &': { borderLeft: `1px solid ${vars.color.borderBright}` }, '&:focus-visible': { outline: `2px solid ${vars.color.accent}`, outlineOffset: -2 } } });
export const segmentSim = style([segment, { color: vars.color.amber, background: 'rgba(224, 164, 60, 0.10)', fontWeight: 650 }]);
export const segmentProd = style([segment, { color: '#fff', background: vars.color.up, fontWeight: 650 }]);
export const fileRow = style({ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 });
export const fileName = style({ flex: 1, minWidth: 0, padding: '8px 10px', border: `1px dashed ${vars.color.borderBright}`, borderRadius: vars.radius.sm, color: vars.color.mutedForeground, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const linkButton = style({ border: 0, padding: 0, background: 'transparent', color: vars.color.accent, cursor: 'pointer', fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: 4, selectors: { '&:disabled': { opacity: .5, cursor: 'default' } } });
export const editorActions = style([row, { justifyContent: 'flex-end', paddingTop: 4 }]);
