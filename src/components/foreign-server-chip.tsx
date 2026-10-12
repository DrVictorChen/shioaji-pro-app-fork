// src/components/foreign-server-chip.tsx — #285: another program's shioaji
// server that this App did not use (wrong environment, another account, or
// not confirmable). Says so in the header and offers to start this App's
// own server on a free port; the other server is never stopped.

import { Unplug } from 'lucide-react';
import { useState } from 'react';
import { useServerAttachment } from '../lib/server-adoption';
import { validateDesktopSettings } from '../lib/server-diagnostics';
import { timedStart, type ServerActionDeps } from '../lib/server-actions';
import { loadDesktopSettings, reloadWhenHealthy, serverStart, serverStop } from '../lib/tauri';
import { notify } from '../lib/trade';
import * as styles from './hud-header.css';

const deps: ServerActionDeps = {
    serverStart,
    serverStop,
    reloadWhenHealthy: () => reloadWhenHealthy(),
    reloadAfterFailedStop: () => setTimeout(() => globalThis.window?.location?.reload?.(), 0),
    scheduleReload: (ms) => setTimeout(() => globalThis.window?.location?.reload?.(), ms),
};

export async function startOwnServerInstead(): Promise<boolean> {
    const settings = await loadDesktopSettings();
    const invalid = validateDesktopSettings(settings);
    if (invalid) {
        notify({ kind: 'err', ...invalid });
        return false;
    }
    try {
        // serverStart never adopts or stops the other server: it starts this
        // App's own on a free port and the page reloads onto it once healthy
        const res = await timedStart(settings, 'start', deps);
        notify(res.ok
            ? { kind: 'ok', title: '🟢 已啟動本 App 的伺服器', body: `port ${res.port} · 模式：${settings.production ? '⚠ 正式環境' : '模擬環境'}；就緒後畫面自動重新載入` }
            : { kind: 'err', title: '伺服器啟動失敗', body: res.output.slice(-160) });
        return res.ok;
    } catch (e) {
        notify({ kind: 'err', title: '伺服器啟動失敗', body: e instanceof Error ? e.message : String(e) });
        return false;
    }
}

export function ForeignServerChip() {
    const a = useServerAttachment();
    const [busy, setBusy] = useState(false);
    if (a.kind !== 'refused') return null;
    const env = a.simulation === undefined ? '' : a.simulation ? '模擬' : '正式';
    return (
        <span className={styles.foreignChip} title={a.text} role='status'>
            <Unplug size={13} aria-hidden />
            未連上 :{a.port}（另一個程式的{env}伺服器）
            <button
                className={styles.foreignChipAction}
                disabled={busy}
                onClick={() => {
                    setBusy(true);
                    void startOwnServerInstead().finally(() => setBusy(false));
                }}
            >
                {busy ? '啟動中…' : '啟動本 App 的伺服器'}
            </button>
        </span>
    );
}
