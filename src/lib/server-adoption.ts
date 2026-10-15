// src/lib/server-adoption.ts — may this App use a shioaji server it did not
// start itself? (#285)
//
// A server answering on 21322 / the last port / 8080 can belong to another
// Shioaji Pro (a production one, while this App is set to simulation), to a
// CLI daemon, or to another person's account. Before adopting one the App
// checks its environment (模擬／正式) against the settings and its account
// against the one this App's own server logged into before. Anything that
// does not match — or cannot be confirmed — is never adopted: the App says so
// and starts its own server on a free port instead (never stopping the other).

import { useSyncExternalStore } from 'react';

/** What the App knows about a server it did not start. */
export interface ForeignServerFacts {
    port: number;
    simulation: boolean | undefined;
    /** SHA-256 of the server's person id, null when unknown */
    personHash: string | null;
}

export type ForeignReason = 'mode' | 'account' | 'unverified';

export interface ForeignVerdict {
    reason: ForeignReason;
    /** the user-facing sentence */
    text: string;
}

const envName = (simulation: boolean | undefined) =>
    simulation === undefined ? '環境未知' : simulation ? '模擬' : '正式';

/**
 * The adoption rule for a server this App did not start: right environment
 * AND the same account as this App's own server had. `null` = adoptable.
 */
export function foreignServerVerdict(facts: ForeignServerFacts, want: {
    production: boolean;
    /** person hash this App's own server logged into with these keys */
    knownPersonHash: string | null;
}): ForeignVerdict | null {
    const where = `:${facts.port} 上另一個程式啟動的${envName(facts.simulation)}伺服器`;
    if (facts.simulation === undefined || facts.simulation === want.production) {
        return { reason: 'mode', text: `${where}與本 App 設定（${want.production ? '正式' : '模擬'}）不符，未連上` };
    }
    if (!want.knownPersonHash || !facts.personHash) {
        return { reason: 'unverified', text: `${where}無法確認是同一個帳號，未連上` };
    }
    if (facts.personHash !== want.knownPersonHash) {
        return { reason: 'account', text: `${where}登入的是另一個帳號，未連上` };
    }
    return null;
}

// ---- this App's own identity (learned from its own server) ----

const IDENTITY_KEY = 'sj-pro-own-identity';

/** The person this App's own server logged into with these keys (hashed). */
export function knownPersonHash(keyHash: string | null): string | null {
    if (!keyHash) return null;
    try {
        const raw = localStorage.getItem(IDENTITY_KEY);
        if (!raw) return null;
        const v = JSON.parse(raw) as { keyHash?: unknown; personHash?: unknown };
        return v.keyHash === keyHash && typeof v.personHash === 'string' ? v.personHash : null;
    } catch {
        return null;
    }
}

export function recordOwnIdentity(keyHash: string | null, personHash: string | null) {
    if (!keyHash || !personHash) return;
    try {
        localStorage.setItem(IDENTITY_KEY, JSON.stringify({ keyHash, personHash }));
    } catch {
        // storage unavailable: a foreign server simply stays unverified
    }
}

export function clearOwnIdentity() {
    try {
        localStorage.removeItem(IDENTITY_KEY);
    } catch {
        // storage unavailable
    }
}

/** SHA-256 hex of a person id (the id itself is never stored). */
export async function hashPerson(personId: string): Promise<string | null> {
    if (!personId) return null;
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sj-pro-person:${personId}`));
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch {
        return null;
    }
}

// ---- which server this window is on (header label / notice) ----

export type ServerAttachment =
    | { kind: 'unknown' }
    /** started by this App */
    | { kind: 'own'; port: number }
    /** started by another program, checked and adopted */
    | { kind: 'external'; port: number; simulation: boolean }
    /** another program's server that was NOT adopted */
    | { kind: 'refused'; port: number; simulation: boolean | undefined; reason: ForeignReason; text: string };

let attachment: ServerAttachment = { kind: 'unknown' };
const listeners = new Set<() => void>();

export function getServerAttachment(): ServerAttachment {
    return attachment;
}

export function setServerAttachment(next: ServerAttachment) {
    attachment = next;
    listeners.forEach(l => l());
}

export function subscribeServerAttachment(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useServerAttachment(): ServerAttachment {
    return useSyncExternalStore(subscribeServerAttachment, getServerAttachment, getServerAttachment);
}

/** Header wording for a server this App did not start. */
export function externalServerLabel(a: Extract<ServerAttachment, { kind: 'external' }>): string {
    return `已連上另一個程式啟動的${a.simulation ? '模擬' : '正式'}伺服器（:${a.port}）`;
}
