import { AlertTriangle, ArrowLeft, Check, FileKey, FileUp, KeyRound, Pencil, Plus, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { importEnvCandidate, loadDesktopSettings, pickCaFile, pickEnvFile, type CredentialDraft, type CredentialProfile, type DesktopSettings, type EnvImportResult, type EnvSelection } from '../lib/tauri';
import * as s from './server-settings-dialog.css';

const emptyDraft = (): CredentialDraft => ({ name: '', environment: 'simulation', caPath: '', apiKey: '', secretKey: '', caPassword: '' });
const editDraft = (profile?: CredentialProfile): CredentialDraft => profile ? {
    id: profile.id, name: profile.name, environment: profile.environment, caPath: profile.caPath,
    apiKey: '', secretKey: '', caPassword: '',
} : emptyDraft();

export function CredentialProfiles({ settings, busy, running, onSave, onAction, onImported, onBusyChange, onEditingChange }: {
    settings: DesktopSettings; busy: boolean; running: boolean;
    onSave: (draft: CredentialDraft, apply: boolean) => Promise<DesktopSettings>;
    onAction: (action: 'select' | 'delete', id: string) => Promise<DesktopSettings>;
    onImported: (settings: DesktopSettings) => void;
    onBusyChange?: (busy: boolean) => void;
    // 編輯中時讓外層收起其他設定區塊，畫面只留表單
    onEditingChange?: (editing: boolean) => void;
}) {
    const [draft, setDraft] = useState(() => editDraft(settings.profiles.find(p => p.id === settings.activeProfileId)));
    // 列表為主，新增或編輯時才展開表單；完全沒有帳號（首次設定）直接進新增
    const [editing, setEditingState] = useState(() => settings.profiles.length === 0);
    const setEditing = (next: boolean) => { setEditingState(next); onEditingChange?.(next); };
    const [pending, setPending] = useState(false);
    const [confirmation, setConfirmation] = useState('');
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [selection, setSelection] = useState<EnvSelection | null>(null);
    const inFlight = useRef(false);
    const editingChange = useRef(onEditingChange); editingChange.current = onEditingChange;
    useEffect(() => { editingChange.current?.(editing); return () => editingChange.current?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
            setEditing(false);
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
            setEditing(false);
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
    const open = (next: CredentialDraft) => { setDraft(next); setEditing(true); setConfirmation(''); setError(''); setMessage(''); setSelection(null); };
    const back = () => { setDraft(editDraft(settings.profiles.find(p => p.id === settings.activeProfileId))); setEditing(false); setConfirmation(''); setError(''); setSelection(null); };
    const stateText = (profile: CredentialProfile) => profile.secretState === 'pendingDelete' ? '刪除未完成，請重試' : profile.secretState === 'unavailable' ? '憑證庫無法存取' : profile.secretState === 'missing' ? '秘密遺失，請重新設定' : profile.secretState === 'stored' ? '' : '寫入未完成，請重試';
    const envBadge = (environment: CredentialDraft['environment']) => environment === 'production' ? <span className={s.prodBadge}>正式</span> : <span className={s.simBadge}>模擬</span>;
    const list = <section className={s.section} aria-label="帳號設定列表">
        <div className={s.row}><h3 className={s.heading}>帳號設定</h3><span style={{ flex: 1 }} /><button className={s.button} disabled={locked || !!settings.migrationError} onClick={() => open(emptyDraft())}><Plus size={14} />新增帳號</button></div>
        {settings.profiles.length ? <div className={s.profileList}>
            {settings.profiles.map(profile => {
                const active = profile.id === settings.activeProfileId;
                const problem = stateText(profile);
                const deleting = confirmation === `delete:${profile.id}`;
                const switching = confirmation === `select:${profile.id}`;
                return <div className={active ? `${s.profileItem} ${s.profileActive}` : s.profileItem} key={profile.id}>
                    {active ? <span className={s.profileMark} title="使用中"><Check size={18} /></span> : <span className={s.profileIdle} />}
                    <div className={s.profileMain}>
                        <div className={s.profileName}><span className={s.profileNameText}>{profile.name}</span>{envBadge(profile.environment)}{active && <span className={s.hint}>使用中</span>}</div>
                        <div className={s.profileMeta}>
                            <span className={s.mono}>{profile.apiKeyMasked}</span><span>·</span>
                            {profile.hasCA ? <span><ShieldCheck size={13} /> 已設定憑證</span> : <span>未設定憑證</span>}
                            {problem && <span className={s.metaDanger}><AlertTriangle size={13} />{problem}</span>}
                        </div>
                    </div>
                    <div className={s.profileActions}>
                        {deleting ? <>
                            <button className={s.dangerButton} disabled={locked} onClick={() => profileAction('delete', profile)}><Trash2 size={14} />確認刪除全部秘密</button>
                            <button className={s.iconButton} aria-label="取消刪除" disabled={locked} onClick={() => setConfirmation('')}><X size={14} /></button>
                        </> : switching ? <>
                            <button className={s.primary} disabled={locked} onClick={() => profileAction('select', profile)}>確認切換並停止伺服器</button>
                            <button className={s.iconButton} aria-label="取消切換" disabled={locked} onClick={() => setConfirmation('')}><X size={14} /></button>
                        </> : <>
                            {!active && <button className={s.button} disabled={locked || profile.secretState !== 'stored'} onClick={() => profileAction('select', profile)}>切換使用</button>}
                            <button className={s.iconButton} aria-label={`編輯 ${profile.name}`} title="編輯" disabled={locked || profile.secretState !== 'stored' || !!settings.migrationError} onClick={() => open(editDraft(profile))}><Pencil size={14} /></button>
                            <button className={s.iconButton} aria-label={`刪除 ${profile.name}`} title="刪除" disabled={locked} onClick={() => profileAction('delete', profile)}><Trash2 size={14} /></button>
                        </>}
                    </div>
                </div>;
            })}
        </div> : <p className={s.hint}>尚未新增帳號設定。</p>}
        {(confirmation.startsWith('select:') || confirmation.startsWith('delete:')) && <p className={s.warning}>{confirmation.startsWith('delete:') ? '刪除後這組金鑰與 CA 密碼會從系統憑證庫移除，無法復原。' : ''}切換或刪除使用中的帳號會停止本 App 的 Agent 與伺服器。</p>}
    </section>;
    const editor = <fieldset className={s.fields} disabled={locked || !!settings.migrationError}>
        <div className={s.editorHead}>
            {settings.profiles.length > 0 && <button className={s.iconButton} aria-label="返回帳號列表" title="返回帳號列表" onClick={back}><ArrowLeft size={16} /></button>}
            <h3 className={s.heading}>{draft.id ? `編輯「${selectedProfile?.name ?? draft.name}」` : '新增帳號'}</h3>
        </div>
        <section className={s.card} aria-label="帳號">
            <label className={s.field}><span className={s.label}>帳號名稱</span><input className={s.input} maxLength={60} placeholder="例如：主帳號、模擬測試" value={draft.name} onChange={e => patch({ name: e.target.value })} /></label>
            <div className={s.field}><span className={s.label}>環境</span>
                <div className={s.segmented} role="group" aria-label="此帳號的環境">
                    <button className={draft.environment === 'simulation' ? s.segmentSim : s.segment} aria-pressed={draft.environment === 'simulation'} onClick={() => patch({ environment: 'simulation' })}>模擬環境</button>
                    <button className={draft.environment === 'production' ? s.segmentProd : s.segment} aria-pressed={draft.environment === 'production'} onClick={() => patch({ environment: 'production' })}>正式環境</button>
                </div>
                {draft.environment === 'production' && <p className={s.warning}>正式環境的委託會動用真實資金，請核對金鑰與憑證。</p>}
            </div>
        </section>
        <section className={s.card} aria-label="API 金鑰">
            <div className={s.row}><h4 className={s.cardTitle}><KeyRound size={14} />API 金鑰</h4><span style={{ flex: 1 }} />
                {!draft.id && <button className={s.linkButton} onClick={() => importFile('file')}><FileUp size={14} />{confirmation === 'import:file' ? '確認匯入並新增帳號' : '從 .env 匯入'}</button>}
                {!draft.id && <button className={s.linkButton} onClick={() => importFile('directory')}>{confirmation === 'import:directory' ? '確認選資料夾並新增帳號' : '或選資料夾'}</button>}
            </div>
            <label className={s.field}><span className={s.label}>API Key</span><input className={s.input} type="password" autoComplete="off" placeholder={selectedProfile ? `${selectedProfile.apiKeyMasked}（留空保留）` : 'SJ_API_KEY'} value={draft.apiKey ?? ''} onChange={e => patch({ apiKey: e.target.value })} /></label>
            <label className={s.field}><span className={s.label}>Secret Key</span><input className={s.input} type="password" autoComplete="off" placeholder={draft.id ? '留空保留已存秘密' : 'SJ_SEC_KEY'} value={draft.secretKey ?? ''} onChange={e => patch({ secretKey: e.target.value })} /></label>
            {selection && <div className={s.row}>{selection.candidates.map(name => <button key={name} className={s.button} onClick={() => importFile('directory', name)}>{name}</button>)}</div>}
            <p className={s.hint}>{draft.id ? '欄位留空會保留已存的金鑰。' : '支援 name.env、.env、.env.local；隱藏檔請選資料夾。匯入會立即儲存為新帳號。'}金鑰存入系統憑證庫，儲存後不會再顯示。</p>
        </section>
        <section className={s.card} aria-label="憑證">
            <h4 className={s.cardTitle}><FileKey size={14} />憑證（正式環境下單需要）</h4>
            <div className={s.fileRow}>
                <span className={s.fileName} title={draft.caPath}>{draft.caPath ? draft.caPath.split(/[/\\]/).pop() : '尚未選擇 Sinopac.pfx'}</span>
                <button className={s.button} onClick={() => void operation(async () => { const path = await pickCaFile(); if (path) patch({ caPath: path }); })}>{draft.caPath ? '更換' : '選擇憑證檔…'}</button>
                {draft.caPath && <button className={s.iconButton} aria-label="清除憑證設定" title="清除憑證設定" onClick={() => patch({ caPath: '', caPassword: '' })}><X size={14} /></button>}
            </div>
            {draft.caPath && <label className={s.field}><span className={s.label}>憑證密碼</span><input className={s.input} type="password" autoComplete="off" placeholder={draft.id ? '留空保留；清除憑證設定會刪除密碼' : '下載憑證時設定的密碼'} value={draft.caPassword ?? ''} onChange={e => patch({ caPassword: e.target.value })} /></label>}
            <p className={s.hint}>CA 檔案留在原本的位置，只保存路徑；密碼存入系統憑證庫。</p>
        </section>
        <div className={s.editorActions}>
            {settings.profiles.length > 0 && <button className={s.button} onClick={back}>取消</button>}
            <button className={s.button} onClick={() => save(false)}>{confirmation === 'save:false' ? '確認新增帳號' : '僅儲存'}</button>
            <button className={s.primary} onClick={() => save(true)}><KeyRound size={14} />{confirmation === 'save:true' ? '確認新增並啟動' : running ? '儲存並重啟' : '儲存並啟動'}</button>
        </div>
        {confirmation.startsWith('save:') || confirmation.startsWith('import:') ? <p className={s.warning}>請再次確認：新增帳號會把金鑰寫入系統憑證庫。<button className={s.linkButton} disabled={locked} onClick={() => setConfirmation('')}>取消確認</button></p> : null}
    </fieldset>;
    return <div className={s.fields}>
        {settings.migrationError && <p className={s.warning} role="alert">{settings.migrationError}<button className={s.button} disabled={locked} onClick={() => void operation(async () => onImported(await loadDesktopSettings()))}>重試遷移</button></p>}
        {settings.credentialBackend === 'plaintext-fallback' && <p className={s.warning} role="alert"><ShieldAlert size={16} />此系統沒有可用的 Secret Service，金鑰與 CA 密碼以明文保存在 {settings.fallbackPath}（檔案權限 0600）。同機以相同使用者權限執行的程式（含 Agent）仍可能讀到此檔案。</p>}
        {editing ? editor : list}
        {error && <p className={s.warning} role="alert">{error}</p>}
        <p className={s.hint} role="status">{pending ? '處理中…' : message}</p>
    </div>;
}
