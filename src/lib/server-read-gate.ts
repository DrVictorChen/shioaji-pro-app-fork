// src/lib/server-read-gate.ts — dependency-free (api.ts, stream.ts and runtime.ts import it)

// #285: on an App launch the main window's reads wait until boot knows the
// server on its port is this App's (or another program's server it checked)
// — the dashboard mounts in parallel and must not show a foreign server's
// data first. Released by every boot decision; expires on its own.
let readGate: Promise<void> | null = null;
let openReadGate: (() => void) | null = null;
const READ_GATE_MAX_MS = 20_000;

export function holdServerReads() {
    if (readGate) return;
    readGate = new Promise<void>((resolve) => {
        openReadGate = resolve;
        globalThis.setTimeout(resolve, READ_GATE_MAX_MS);
    });
}

export function releaseServerReads() {
    openReadGate?.();
    openReadGate = null;
    readGate = null;
}

export function serverReadsHeld(): Promise<void> | null {
    return readGate;
}

// #285: another program's server answering on the App's port that this App
// did not adopt (wrong environment / another account / unverified). Until the
// App moves to its own server, nothing in any of its windows reads it: every
// request to that port fails at once in code (serverUrlBlocked). The API
// base itself is never rewritten — it keys caches, broadcast channels and
// environment checks all over the App (a rewritten base, e.g. port 0, broke
// every read on the QA build: watchlist names, positions, rankings).
// Persisted so popouts / the tray panel follow the main window's decision;
// the main window re-decides it on every boot before any read is released.
const BLOCKED_PORT_KEY = 'sj-pro-foreign-port';

export function blockForeignServerPort(port: number | null) {
    const changed = foreignServerPortBlocked() !== port;
    try {
        if (port === null) localStorage.removeItem(BLOCKED_PORT_KEY);
        else localStorage.setItem(BLOCKED_PORT_KEY, String(port));
    } catch {
        // storage unavailable
    }
    if (changed && typeof window !== 'undefined') window.dispatchEvent(new Event('sj-pro-api-base-changed'));
}

export function foreignServerPortBlocked(): number | null {
    try {
        const p = Number(localStorage.getItem(BLOCKED_PORT_KEY));
        if (Number.isInteger(p) && p > 0 && p < 65536) return p;
    } catch {
        // storage unavailable
    }
    return null;
}

const portOf = (url: string): number | null => {
    try {
        const u = new URL(url);
        if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') return null;
        return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    } catch {
        return null; // relative (same-origin web build): never blocked
    }
};

/** The blocked port this URL targets, or null when it may be requested. */
export function serverUrlBlocked(url: string): number | null {
    const blocked = foreignServerPortBlocked();
    if (blocked === null || !url) return null;
    return portOf(url) === blocked ? blocked : null;
}

/** Fails a request to another program's server that was not adopted —
 * immediately, before anything is sent. */
export function foreignServerBlockedError(port: number): Error {
    return Object.assign(
        new Error(`:${port} 上是另一個程式啟動的伺服器，本 App 未使用它，這筆請求沒有送出`),
        { foreignServerBlocked: true as const, mutationNotStarted: true as const },
    );
}
