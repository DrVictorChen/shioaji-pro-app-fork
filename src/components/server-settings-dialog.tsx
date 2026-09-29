import { Eye, EyeOff, FileUp, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { importEnvCandidate, pickCaFile, pickEnvFile, type DesktopSettings, type EnvImportResult, type EnvSelection, type ServerStatus } from '../lib/tauri';
import * as s from './server-settings-dialog.css';
import { AsyncStatus } from './async-status';

export type ServerConnectionSettings = Pick<DesktopSettings, 'apiKey' | 'secretKey' | 'production' | 'caPath' | 'caPasswd'>;
export const connectionSettings = (settings: DesktopSettings): ServerConnectionSettings => ({
    apiKey: settings.apiKey, secretKey: settings.secretKey, production: settings.production,
    caPath: settings.caPath, caPasswd: settings.caPasswd,
});

export function ServerSettingsDialog({ settings, status, busy, pendingApply = false, onSave, onClose, children }: {
    settings: DesktopSettings; status: ServerStatus | null | undefined; busy: boolean; pendingApply?: boolean;
    onSave: (draft: ServerConnectionSettings, apply: boolean) => Promise<void>;
    onClose: () => void; children?: ReactNode;
}) {
    const [draft, setDraft] = useState(() => connectionSettings(settings));
    const [showPassword, setShowPassword] = useState(false);
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const [envSelection, setEnvSelection] = useState<EnvSelection | null>(null);
    const active = useRef(false);
    const dialog = useRef<HTMLDivElement>(null);
    const close = useRef(onClose); close.current = onClose;
    const locked = busy || pending;
    const lockedRef = useRef(locked); lockedRef.current = locked;
    const dirty = JSON.stringify(draft) !== JSON.stringify(connectionSettings(settings));
    const change = (values: Partial<ServerConnectionSettings>) => {
        setDraft(current => ({ ...current, ...values })); setMessage(''); setError('');
    };
    useEffect(() => {
        const node = dialog.current;
        if (!node) return;
        const previous = document.activeElement as HTMLElement | null;
        node.focus();
        const keydown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault(); event.stopPropagation();
                if (!lockedRef.current) close.current();
            }
            if (event.key !== 'Tab') return;
            const nodes = Array.from(node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], summary, [tabindex="0"]')).filter(el => el.getClientRects().length);
            const first = nodes[0], last = nodes.at(-1);
            if (!first || !last) { event.preventDefault(); node.focus(); return; }
            if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) { event.preventDefault(); first.focus(); }
        };
        node.addEventListener('keydown', keydown);
        return () => { node.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
    }, []);
    const submit = async (apply: boolean) => {
        if (active.current || busy) return;
        active.current = true; setPending(true); setError(''); setMessage('');
        try {
            await onSave(draft, apply);
            setMessage(apply ? '設定已儲存，正在等待伺服器連線。' : '設定已儲存，下次啟動或重啟伺服器時套用。');
        } catch (e) { setError(e instanceof Error ? e.message : '儲存失敗，請重試。'); }
        finally { active.current = false; setPending(false); }
    };
    // 對話框取消（null）時畫面保持原狀；有結果才清掉上一次的訊息與候選清單
    const handleEnvResult = (found: EnvImportResult | null, newPick: boolean) => {
        if (!found) return;
        setError(''); setMessage('');
        if (newPick) setEnvSelection(null);
        if (found.kind === 'choose') {
            setEnvSelection(found.selection);
        } else if (found.kind === 'error') setError(found.error);
        else {
            change({ ...(found.apiKey !== undefined ? { apiKey: found.apiKey } : {}), ...(found.secretKey !== undefined ? { secretKey: found.secretKey } : {}) });
            setEnvSelection(null);
            setMessage(`已從 ${found.fileName} 匯入，尚未儲存。`);
        }
    };
    // candidate: a file name from the folder's candidate list (envSelection)
    const chooseFile = async (kind: 'env-file' | 'env-directory' | 'ca', candidate?: string) => {
        if (active.current) return;
        active.current = true; setPending(true);
        if (kind === 'ca') { setError(''); setMessage(''); }
        try {
            if (kind === 'ca') { const path = await pickCaFile(); if (path) change({ caPath: path }); }
            else {
                handleEnvResult(candidate && envSelection
                    ? await importEnvCandidate(envSelection, candidate)
                    : await pickEnvFile(kind === 'env-file' ? 'file' : 'directory'), !candidate);
            }
        } catch { setError(kind === 'ca' ? '無法讀取憑證檔。' : '無法匯入 .env 檔案。'); }
        finally { active.current = false; setPending(false); }
    };
    const currentMode = status?.simulation === true ? '模擬' : status?.simulation === false ? '正式' : '環境待確認';
    return <>
        <div className={s.backdrop} />
        <div ref={dialog} className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="server-settings-title" aria-describedby="server-settings-description" tabIndex={-1}>
            <header className={s.header}>
                <div><h2 id="server-settings-title" className={s.title}>伺服器設定</h2>
                    <p className={s.hint}>目前{status?.running
                        ? `運行：${currentMode} · ${(status.scheme ?? 'http').toUpperCase()}`
                        : status ? '未啟動' : <AsyncStatus phase='loading' text='狀態讀取中' size={10} />}</p>
                </div>
                <button className={s.button} aria-label="關閉伺服器設定" disabled={locked} onClick={onClose}><X size={16} /></button>
            </header>
            <div className={s.body}><fieldset className={s.fields} disabled={locked}>
                <p id="server-settings-description" className={s.hint}>編輯不會立即影響連線。儲存後，下次啟動時套用；也可儲存並立即重啟。</p>
                <section className={s.section} aria-labelledby="server-keys-title">
                    <h3 id="server-keys-title" className={s.heading}>API 金鑰</h3>
                    <label className={s.field}><span className={s.label}>API Key</span><input className={s.input} type="password" autoComplete="off" value={draft.apiKey} disabled={locked} onChange={e => change({ apiKey: e.target.value })} /></label>
                    <label className={s.field}><span className={s.label}>Secret Key</span><input className={s.input} type="password" autoComplete="off" value={draft.secretKey} disabled={locked} onChange={e => change({ secretKey: e.target.value })} /></label>
                    <div className={s.row}><button className={s.button} disabled={locked} onClick={() => void chooseFile('env-file')}><FileUp size={14} />選擇 .env 檔案</button><button className={s.button} disabled={locked} onClick={() => void chooseFile('env-directory')}>選擇資料夾</button></div>
                    <p className={s.hint}>支援 name.env、.env、.env.local；隱藏檔請選資料夾。</p>
                    {envSelection && <div className={s.field}>
                        <span className={s.hint}>{`資料夾裡有 ${envSelection.candidates.length} 個 .env 檔案，選一個匯入：`}</span>
                        <div className={s.row}>{envSelection.candidates.map(name => <button key={name} className={s.button} disabled={locked} onClick={() => void chooseFile('env-directory', name)}>{name}</button>)}</div>
                    </div>}
                    <p className={s.hint}>金鑰儲存在本機 App 資料夾。</p>
                </section>
                <section className={s.section} aria-labelledby="server-environment-title">
                    <h3 id="server-environment-title" className={s.heading}>下次啟動環境</h3>
                    <div className={s.row} role="group" aria-label="下次啟動環境">
                        <button className={draft.production ? s.button : s.selected} aria-pressed={!draft.production} disabled={locked} onClick={() => change({ production: false })}>模擬環境</button>
                        <button className={draft.production ? s.selected : s.button} aria-pressed={draft.production} disabled={locked} onClick={() => change({ production: true })}>正式環境</button>
                    </div>
                    <p className={draft.production ? s.warning : s.hint}>{draft.production ? '正式環境的委託會動用真實資金，請核對金鑰與憑證。' : '模擬環境不需要 CA 憑證。既有憑證設定會保留。'}</p>
                    {draft.production && <>
                        <span className={s.label}>CA 憑證（Sinopac.pfx）</span>
                        <div className={s.row}><button className={s.button} disabled={locked} onClick={() => void chooseFile('ca')}>{draft.caPath ? draft.caPath.split(/[/\\]/).pop() : '選擇憑證檔…'}</button>
                            {draft.caPath && <button className={s.button} disabled={locked} onClick={() => change({ caPath: '', caPasswd: '' })}>清除憑證設定</button>}</div>
                        <div className={s.field}><label className={s.label} htmlFor="server-ca-password">憑證密碼</label><span className={s.row}><input id="server-ca-password" className={s.input} style={{ flex: 1 }} type={showPassword ? 'text' : 'password'} autoComplete="off" value={draft.caPasswd} disabled={locked} onChange={e => change({ caPasswd: e.target.value })} /><button className={s.button} aria-label={showPassword ? '隱藏憑證密碼' : '顯示憑證密碼'} disabled={locked} onClick={() => setShowPassword(v => !v)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></div>
                    </>}
                </section>
                {children}
            </fieldset></div>
            <footer className={s.footer}>
                {error && <div className={s.warning} role="alert">{error}</div>}
                <p className={s.hint} role="status">{message || (dirty ? '有尚未儲存的變更' : pendingApply ? '設定已儲存，尚未套用到目前伺服器。' : '目前沒有未儲存的變更')}</p>
                <div className={s.actions}>
                    <button className={s.button} disabled={locked} onClick={onClose}>{dirty ? '取消變更' : '關閉'}</button>
                    <button className={s.button} disabled={locked || !dirty} onClick={() => void submit(false)}>僅儲存</button>
                    <button className={s.primary} disabled={locked || !status} onClick={() => void submit(true)}>{pending ? '處理中…' : status?.running ? '儲存並重啟' : '儲存並啟動'}</button>
                </div>
                <p className={s.hint}>重啟會停止本 App 的 Agent、撤銷本次 Auto 授權，並暫時中斷行情；既有委託不會因此撤銷。</p>
            </footer>
        </div>
    </>;
}
