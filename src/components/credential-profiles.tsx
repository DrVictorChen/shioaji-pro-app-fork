import { Check, FileUp, KeyRound, Pencil, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { importEnvCandidate, loadDesktopSettings, pickCaFile, pickEnvFile, type CredentialDraft, type CredentialProfile, type DesktopSettings, type EnvImportResult, type EnvSelection } from '../lib/tauri';
import * as s from './server-settings-dialog.css';

const emptyDraft = (): CredentialDraft => ({ name: '', environment: 'simulation', caPath: '', apiKey: '', secretKey: '', caPassword: '' });
const editDraft = (profile?: CredentialProfile): CredentialDraft => profile ? {
    id: profile.id, name: profile.name, environment: profile.environment, caPath: profile.caPath,
    apiKey: '', secretKey: '', caPassword: '',
} : emptyDraft();

export function CredentialProfiles({ settings, busy, running, onSave, onAction, onImported, onBusyChange }: {
    settings: DesktopSettings; busy: boolean; running: boolean;
    onSave: (draft: CredentialDraft, apply: boolean) => Promise<DesktopSettings>;
    onAction: (action: 'select' | 'delete', id: string) => Promise<DesktopSettings>;
    onImported: (settings: DesktopSettings) => void;
    onBusyChange?: (busy: boolean) => void;
}) {
    const [draft, setDraft] = useState(() => editDraft(settings.profiles.find(p => p.id === settings.activeProfileId)));
    const [pending, setPending] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [selection, setSelection] = useState<EnvSelection | null>(null);
    const inFlight = useRef(false);
    const locked = busy || pending;
    const patch = (values: Partial<CredentialDraft>) => { setDraft(current => ({ ...current, ...values })); setConfirmation(''); setMessage(''); setError(''); };
    const confirm = (key: string) => {
        if (confirmation === key) { setConfirmation(''); return true; }
        setConfirmation(key); setError(''); setMessage(''); return false;
    };
    const operation = async (action: () => Promise<void>) => {
        if (inFlight.current || busy) return;
        inFlight.current = true; setPending(true); onBusyChange?.(true); setError(''); setMessage('');
        try { await action(); }
        catch (e) { setError(e instanceof Error ? e.message : typeof e === 'string' ? e : '操作未完成，請重試。'); }
        finally {
            // Clear even on partial success (e.g. saved, but restart failed).
            // No submitted secret remains in React state or a hidden input.
            inFlight.current = false; setPending(false); onBusyChange?.(false);
        }
    };
    const save = (apply: boolean) => {
        if (!draft.name.trim()) { setError('請填入帳號名稱。'); return; }
        if (!draft.id && (!draft.apiKey || !draft.secretKey)) { setError('請填入 API Key 與 Secret Key。'); return; }
        if (!draft.id && !confirm(`save:${apply}`)) return;
        const profileId = draft.id;
        const input: CredentialDraft = { id: draft.id, name: draft.name, environment: draft.environment, caPath: draft.caPath,
            ...(draft.apiKey ? { apiKey: draft.apiKey } : {}), ...(draft.secretKey ? { secretKey: draft.secretKey } : {}),
            ...(draft.caPassword ? { caPassword: draft.caPassword } : {}),
        };
        // Clear the old object too: async event closures can outlive a render.
        // Only the write-only native payload holds values during the IPC.
        draft.apiKey = ''; draft.secretKey = ''; draft.caPassword = '';
        setDraft({ ...draft });
        void operation(async () => {
            // Blank fields preserve existing secrets; never preload secrets.
            let next: DesktopSettings;
            try { next = await onSave(input, apply); }
            finally { delete input.apiKey; delete input.secretKey; delete input.caPassword; }
            const profile = next.profiles.find(p => p.id === profileId) ?? next.profiles.at(-1);
            setDraft(editDraft(profile));
            setMessage(apply ? '帳號已儲存，正在等待伺服器連線。' : '帳號已儲存，下次啟動或重啟伺服器時套用。');
        });
    };
    const profileAction = (action: 'select' | 'delete', profile: CredentialProfile) => {
        if (!confirm(`${action}:${profile.id}`)) return;
        void operation(async () => {
            const next = await onAction(action, profile.id);
            setDraft(editDraft(next.profiles.find(p => p.id === next.activeProfileId)));
            setMessage(action === 'select' ? '已切換使用中的帳號；請按啟動套用。' : '帳號與所有秘密已刪除。');
        });
    };
    const handleImport = (found: EnvImportResult | null) => {
        if (!found) return;
        if (found.kind === 'choose') setSelection(found.selection);
        else if (found.kind === 'error') setError(found.error);
        else {
            onImported(found.settings);
            setDraft(editDraft(found.settings.profiles.find(p => p.id === found.profileId)));
            setSelection(null);
            setMessage(`已從 ${found.fileName} 匯入並儲存帳號。`);
        }
    };
    const importFile = (mode: 'file' | 'directory', candidate?: string) => {
        if (!candidate && !confirm(`import:${mode}`)) return;
        void operation(async () => handleImport(candidate && selection
            ? await importEnvCandidate(selection, candidate, draft.environment)
            : await pickEnvFile(mode, draft.environment)));
    };
    const selectedProfile = settings.profiles.find(p => p.id === draft.id);
    return <div className={s.fields}>
        {settings.migrationError && <p className={s.warning} role="alert">{settings.migrationError}<button className={s.button} disabled={locked} onClick={() => void operation(async () => onImported(await loadDesktopSettings()))}>重試遷移</button></p>}
        {settings.credentialBackend === 'plaintext-fallback' && <p className={s.warning} role="alert"><ShieldAlert size={16} />此系統沒有可用的 Secret Service，金鑰與 CA 密碼以明文保存在 {settings.fallbackPath}（檔案權限 0600）。同機以相同使用者權限執行的程式（含 Agent）仍可能讀到此檔案。</p>}
        <section className={s.section} aria-label="帳號設定列表">
            <div className={s.row}><h3 className={s.heading}>帳號設定</h3><button className={s.button} disabled={locked} onClick={() => { setDraft(emptyDraft()); setConfirmation(''); setError(''); setMessage(''); }}><Plus size={14} />新增帳號</button></div>
            {settings.profiles.map(profile => <div className={s.notice} key={profile.id}>
                <div className={s.row}><strong>{profile.name}</strong>{profile.id === settings.activeProfileId && <span><Check size={14} />使用中</span>}</div>
                <p className={s.hint}>{profile.apiKeyMasked} · {profile.environment === 'production' ? '正式' : '模擬'} · CA {profile.hasCA ? '已設定' : '未設定'} · {profile.secretState === 'stored' ? '憑證已保存' : profile.secretState === 'pendingDelete' ? '刪除未完成，請重試' : profile.secretState === 'unavailable' ? '憑證庫無法存取' : profile.secretState === 'missing' ? '秘密遺失，請重新設定' : '寫入未完成，請重試'}</p>
                <div className={s.row}>
                    <button className={s.button} disabled={locked || profile.secretState !== 'stored'} onClick={() => { setDraft(editDraft(profile)); setConfirmation(''); setMessage(''); }}><Pencil size={14} />編輯 {profile.name}</button>
                    {profile.id !== settings.activeProfileId && <button className={s.button} disabled={locked || profile.secretState !== 'stored'} onClick={() => profileAction('select', profile)}>{confirmation === `select:${profile.id}` ? '確認切換並停止伺服器' : '切換使用'}</button>}
                    <button className={s.button} disabled={locked} onClick={() => profileAction('delete', profile)}><Trash2 size={14} />{confirmation === `delete:${profile.id}` ? '確認刪除全部秘密' : '刪除帳號'}</button>
                </div>
            </div>)}
            {!settings.profiles.length && <p className={s.hint}>尚未新增帳號設定。</p>}
        </section>
        <fieldset className={s.fields} disabled={locked || !!settings.migrationError}>
            <section className={s.section} aria-label="編輯帳號">
                <h3 className={s.heading}>{draft.id ? '編輯帳號' : '新增帳號'}</h3>
                <label className={s.field}><span className={s.label}>帳號名稱</span><input className={s.input} maxLength={60} value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
                <label className={s.field}><span className={s.label}>API Key</span><input className={s.input} type="password" autoComplete="off" placeholder={selectedProfile ? `${selectedProfile.apiKeyMasked}（留空保留）` : 'SJ_API_KEY'} value={draft.apiKey ?? ''} onChange={e => patch({ apiKey: e.target.value })} /></label>
                <label className={s.field}><span className={s.label}>Secret Key</span><input className={s.input} type="password" autoComplete="off" placeholder={draft.id ? '留空保留已存秘密' : 'SJ_SEC_KEY'} value={draft.secretKey ?? ''} onChange={e => patch({ secretKey: e.target.value })} /></label>
                <div className={s.row}><button className={s.button} onClick={() => importFile('file')}><FileUp size={14} />{confirmation === 'import:file' ? '確認匯入並新增帳號' : '選擇 .env 檔案'}</button><button className={s.button} onClick={() => importFile('directory')}>{confirmation === 'import:directory' ? '確認選資料夾並新增帳號' : '選擇資料夾'}</button></div>
                <p className={s.hint}>支援 name.env、.env、.env.local；隱藏檔請選資料夾。匯入後會立即儲存為新帳號，秘密不會傳回畫面。</p>
                {selection && <div className={s.row}>{selection.candidates.map(name => <button key={name} className={s.button} onClick={() => importFile('directory', name)}>{name}</button>)}</div>}
            </section>
            <section className={s.section}>
                <h3 className={s.heading}>此帳號的環境</h3>
                <div className={s.row}><button className={draft.environment === 'simulation' ? s.selected : s.button} aria-pressed={draft.environment === 'simulation'} onClick={() => patch({ environment: 'simulation' })}>模擬環境</button><button className={draft.environment === 'production' ? s.selected : s.button} aria-pressed={draft.environment === 'production'} onClick={() => patch({ environment: 'production' })}>正式環境</button></div>
                {draft.environment === 'production' && <p className={s.warning}>正式環境的委託會動用真實資金，請核對金鑰與憑證。</p>}
                <div className={s.row}><button className={s.button} onClick={() => void operation(async () => { const path = await pickCaFile(); if (path) patch({ caPath: path }); })}>{draft.caPath ? draft.caPath.split(/[/\\]/).pop() : '選擇憑證檔…'}</button>{draft.caPath && <button className={s.button} onClick={() => patch({ caPath: '', caPassword: '' })}>清除憑證設定</button>}</div>
                {draft.caPath && <label className={s.field}><span className={s.label}>憑證密碼</span><input className={s.input} type="password" autoComplete="off" placeholder={draft.id ? '留空保留；清除憑證設定會刪除密碼' : '下載憑證時設定的密碼'} value={draft.caPassword ?? ''} onChange={e => patch({ caPassword: e.target.value })} /></label>}
                <p className={s.hint}>金鑰與 CA 密碼存入系統憑證庫；CA 檔案留在原本的位置。儲存後會清空輸入欄位。</p>
            </section>
            <div className={s.actions}><button className={s.button} onClick={() => save(false)}>{confirmation === 'save:false' ? '確認新增帳號' : '僅儲存'}</button><button className={s.primary} onClick={() => save(true)}><KeyRound size={14} />{confirmation === 'save:true' ? '確認新增並啟動' : running ? '儲存並重啟' : '儲存並啟動'}</button></div>
        </fieldset>
        {confirmation && <p className={s.warning}>請再次確認操作。切換或刪除使用中的帳號會停止本 App 的 Agent 與伺服器。<button className={s.button} disabled={locked} onClick={() => setConfirmation('')}>取消確認</button></p>}
        {error && <p className={s.warning} role="alert">{error}</p>}
        <p className={s.hint} role="status">{pending ? '處理中…' : message}</p>
    </div>;
}
