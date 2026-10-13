// scripts/flash-demo/cond.tsx — the 條件單管理面板 on its ?condDemo sample rows
// (wide and narrow), for design screenshots. Nothing can be sent.
import '../../src/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { ConditionalPanel } from '../../src/components/conditional-panel';
import { setPrivacyMode, setPrivacyMoney } from '../../src/lib/privacy';
import { initTheme, setThemeSettings } from '../../src/lib/theme-store';

const params = new URLSearchParams(location.search);
initTheme();
setThemeSettings({ mode: params.get('theme') === 'light' ? 'light' : 'dark' });
setPrivacyMode(true);
setPrivacyMoney(true);

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start' }}>
            <section style={{ width: 980, height: 620, border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, overflow: 'hidden' }}><ConditionalPanel /></section>
            <section style={{ width: 340, height: 620, border: '1px solid rgba(127,127,127,.35)', borderRadius: 6, overflow: 'hidden' }}><ConditionalPanel /></section>
        </div>
    </StrictMode>,
);
