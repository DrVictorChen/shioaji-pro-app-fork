// src/components/custom-theme-editor.tsx — 外觀設定「自訂」主題的編輯區：
// 起始底色、預設組合、六個顏色與即時預覽。

import {
    CUSTOM_BASES,
    CUSTOM_COLOR_FIELDS,
    CUSTOM_PRESETS,
    type CustomBase,
    type CustomTheme,
} from '../lib/custom-theme';
import { setThemeSettings, useThemeSettings } from '../lib/theme-store';
import * as hud from './hud-header.css';
import * as panel from './panel.css';
import * as styles from './custom-theme-editor.css';

const BASE_OPTIONS: { key: CustomBase; label: string }[] = [
    { key: 'dark', label: '從深色開始' },
    { key: 'light', label: '從淺色開始' },
];

const same = (a: CustomTheme, b: CustomTheme) =>
    CUSTOM_COLOR_FIELDS.every(({ key }) => a[key].toLowerCase() === b[key].toLowerCase()) && a.base === b.base;

export function CustomThemeEditor() {
    const settings = useThemeSettings();
    const custom = settings.custom ?? CUSTOM_BASES.dark;
    const apply = (next: CustomTheme) => setThemeSettings({ mode: 'custom', custom: next });
    return (
        <div className={styles.editor}>
            <span className={hud.settingLabel}>起始底色</span>
            <div className={hud.settingGroup}>
                {BASE_OPTIONS.map((b) => (
                    <button
                        key={b.key}
                        className={hud.opt[custom.base === b.key ? 'on' : 'off']}
                        title='以此為起點，六個顏色會換成它的預設值'
                        onClick={() => custom.base !== b.key && apply(CUSTOM_BASES[b.key])}
                    >
                        {b.label}
                    </button>
                ))}
            </div>
            <span className={hud.settingLabel}>預設組合</span>
            <div className={styles.presets}>
                {CUSTOM_PRESETS.map((p) => (
                    <button
                        key={p.name}
                        className={styles.preset[same(p.theme, custom) ? 'on' : 'off']}
                        onClick={() => apply(p.theme)}
                    >
                        <span className={styles.presetChip} aria-hidden>
                            <span style={{ background: p.theme.background }} />
                            <span style={{ background: p.theme.panel }} />
                            <span style={{ background: p.theme.accent }} />
                        </span>
                        {p.name}
                    </button>
                ))}
            </div>
            <span className={hud.settingLabel}>顏色（點色塊開啟選色器）</span>
            <div className={styles.swatches}>
                {CUSTOM_COLOR_FIELDS.map(({ key, label }) => (
                    <label key={key} className={styles.swatch}>
                        <input
                            type='color'
                            className={styles.colorInput}
                            value={custom[key]}
                            aria-label={`${label}顏色`}
                            onChange={(e) => apply({ ...custom, [key]: e.target.value })}
                        />
                        <span>{label}</span>
                        <span className={styles.hex}>{custom[key].toUpperCase()}</span>
                    </label>
                ))}
            </div>
            <div className={styles.preview}>
                <span>預覽</span>
                <span className={panel.dirText.up}>▲ +1.25 上漲</span>
                <span className={panel.dirText.down}>▼ -1.25 下跌</span>
                <span className={styles.previewAccent}>連動</span>
            </div>
            <button
                className={styles.reset}
                disabled={same(custom, CUSTOM_BASES[custom.base])}
                onClick={() => apply(CUSTOM_BASES[custom.base])}
            >
                重設為起始底色
            </button>
        </div>
    );
}
