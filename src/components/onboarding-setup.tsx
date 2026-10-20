import { Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { registerOnboardingAppStateHost } from '../lib/agent-app-command';
import { agentModule } from '../lib/features';
import { validateDesktopSettings } from '../lib/server-diagnostics';
import { isTauri, loadDesktopSettings, saveCredentialProfile, selectCredentialProfile, deleteCredentialProfile, serverStart, reloadWhenHealthy, EMPTY_DESKTOP_SETTINGS, type CredentialDraft, type DesktopSettings } from '../lib/tauri';
import { FeatureGate } from './feature-gate';
import { CredentialProfiles } from './credential-profiles';
import { timedOnboarding } from '../lib/server-actions';
import * as styles from './onboarding-setup.css';

const AGENT_STARTER_PROMPT = '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？';
export function OnboardingSetup() {
    const [settings, setSettings] = useState<DesktopSettings>(EMPTY_DESKTOP_SETTINGS);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
        let active = true;
        loadDesktopSettings().then(value => { if (active) { setSettings(value); setLoaded(true); } }).catch(() => { if (active) setError('無法讀取本機設定，請重新開啟 App 後重試。'); });
        const off = isTauri ? registerOnboardingAppStateHost(window) : undefined;
        return () => { active = false; off?.(); };
    }, []);
    const save = async (draft: CredentialDraft, apply: boolean) => {
        setBusy(true); setError('');
        let next: DesktopSettings;
        try {
            next = await saveCredentialProfile(draft);
            const id = draft.id ?? next.profiles.at(-1)?.id;
            setSettings(next);
            if (apply && id && id !== next.activeProfileId) { next = await selectCredentialProfile(id); setSettings(next); }
        } finally { setBusy(false); }
        if (apply) {
            const invalid = validateDesktopSettings(next);
            if (invalid) { setError(invalid.body); return next; }
            setBusy(true);
            try {
                const result = await timedOnboarding({ save: async () => {}, start: () => serverStart(next), reloadWhenHealthy });
                if (!result.ok) { setError('伺服器啟動失敗，請確認帳號設定、網路與憑證後重試。'); setBusy(false); }
            } catch { setError('伺服器啟動失敗，請重試。'); setBusy(false); }
        }
        return next;
    };
    const action = async (kind: 'select' | 'delete', id: string) => {
        const next = kind === 'select' ? await selectCredentialProfile(id) : await deleteCredentialProfile(id);
        setSettings(next); return next;
    };
    const AgentPanel = agentModule?.Panel;
    agentModule?.ensureDefaultProvider('codex');
    return (<div className={styles.shell}><div className={styles.layout}>
        <div className={styles.card}>
            <div><div className={styles.logo}>Shioaji Pro</div><div className={styles.subtitle}>設定或選擇帳號以啟動交易伺服器</div></div>
            {error && <p className={styles.errorText} role="alert">{error}</p>}
            {loaded && <CredentialProfiles settings={settings} busy={busy} running={false} onSave={save} onAction={action} onImported={setSettings} />}
            {busy && <p className={styles.hint}>啟動中 — 登入與載入合約約需 10–30 秒…</p>}
            <p className={styles.hint}>秘密儲存在系統憑證庫。還沒有 API Key？可使用右側 AI 助理引導申請。</p>
        </div>
                {AgentPanel && (
                    <div className={styles.agentCard}>
                        <div className={styles.agentHeader}>
                            <Bot size={14} />
                            AI 助理 — 引導申請 API Key
                        </div>
                        <div className={styles.agentBody}>
                            <FeatureGate feature='agent'>
                                <AgentPanel
                                    onboarding
                                    initialPrompt={AGENT_STARTER_PROMPT}
                                    visibleTabs={['chat', 'settings']}
                                />
                            </FeatureGate>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
