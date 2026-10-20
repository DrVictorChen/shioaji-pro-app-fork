// #285 — when may this App use a shioaji server it did not start?
import { beforeEach, expect, it, vi } from 'vitest';
import { foreignServerVerdict, hashPerson, knownPersonHash, recordOwnIdentity } from './server-adoption';

const store = new Map<string, string>();
beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
    });
});

const sim = { production: false, knownPersonHash: 'me' };

it('another environment is never used, whatever the account', () => {
    expect(foreignServerVerdict({ port: 21322, simulation: false, personHash: 'me' }, sim))
        .toEqual({ reason: 'mode', text: ':21322 上另一個程式啟動的正式伺服器與本 App 設定（模擬）不符，未連上' });
    expect(foreignServerVerdict({ port: 8080, simulation: true, personHash: 'me' }, { production: true, knownPersonHash: 'me' })?.reason).toBe('mode');
    expect(foreignServerVerdict({ port: 8080, simulation: undefined, personHash: 'me' }, sim)?.reason).toBe('mode');
});

it('the same environment is used only on the account this App\'s own server had', () => {
    expect(foreignServerVerdict({ port: 21322, simulation: true, personHash: 'me' }, sim)).toBeNull();
    expect(foreignServerVerdict({ port: 21322, simulation: true, personHash: 'someone' }, sim))
        .toEqual({ reason: 'account', text: ':21322 上另一個程式啟動的模擬伺服器登入的是另一個帳號，未連上' });
});

it('an account that cannot be confirmed is not used', () => {
    expect(foreignServerVerdict({ port: 21322, simulation: true, personHash: null }, sim)?.reason).toBe('unverified');
    expect(foreignServerVerdict({ port: 21322, simulation: true, personHash: 'me' }, { production: false, knownPersonHash: null })?.reason).toBe('unverified');
});

it('the own identity is kept per key set, hashed', async () => {
    const person = await hashPerson('A123456789');
    expect(person).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...store])).not.toContain('A123456789');
    recordOwnIdentity('keys-1', person);
    expect(knownPersonHash('keys-1')).toBe(person);
    expect(knownPersonHash('keys-2')).toBeNull(); // new keys: not known yet
    expect(knownPersonHash(null)).toBeNull();
    expect(JSON.stringify([...store])).not.toContain('A123456789');
});
