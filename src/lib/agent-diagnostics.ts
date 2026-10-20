// Shared with the optional desktop Agent overlay. Store only redacted errors,
// so server-manager's copied diagnostics also work after a WebView reload.
const KEY = 'sj-agent-runtime-failure';

export function redactAgentRuntimeDetail(text: string): string {
    return text
        .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[=:][^\r\n]*/gi, '[REDACTED]')
        .replace(/\b[\w-]*(?:token|key|secret|password|passwd|credential)[\w-]*["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '[REDACTED]')
        .replace(/\b(?:bearer|basic)\s+[^\s,"'}]+/gi, '[REDACTED]')
        .replace(/\b(?:sk-|sk_|rk_|pk_|ghp_|gho_|github_pat_|xox)[\w-]+|\bAKIA[A-Z0-9]{16}\b|\beyJ[\w-]{16,}(?:\.[\w-]+)*/g, '[REDACTED]')
        .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/g, '$1?[REDACTED]')
        .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
        .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .slice(0, 24_000);
}

export function recordAgentRuntimeFailure(message: string, detail?: string): string {
    const text = redactAgentRuntimeDetail([message, detail].filter(Boolean).join('\n'));
    try { localStorage.setItem(KEY, text); } catch { /* storage is optional */ }
    return text;
}

export function agentRuntimeDiagnostics(): string {
    try {
        const text = localStorage.getItem(KEY);
        return text ? `--- Agent runtime ---\n${redactAgentRuntimeDetail(text)}` : '';
    } catch { return ''; }
}
