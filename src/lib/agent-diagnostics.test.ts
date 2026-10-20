import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRuntimeDiagnostics, recordAgentRuntimeFailure, redactAgentRuntimeDetail } from './agent-diagnostics';

afterEach(() => vi.unstubAllGlobals());

describe('Agent runtime copied diagnostics', () => {
    it('redacts structured credentials, account data and private paths without hiding token limits', () => {
        const detail = [
            JSON.stringify({ nested: [{ Cookie: 'session=fixture-login-cookie', SJ_PERSON_ID: 'fixture-person', email: 'fixture@example.com', custom_key: 'fixture-private-key', max_tokens: 4096 }] }),
            'proxy=http://fixture-user:fixture-pass@proxy.test:80',
            'C:\\Users\\Fixture User\\project',
            JSON.stringify({ message: 'C:\\Users\\Fixture User\\project' }),
            '\\\\host\\Users\\Fixture User\\project',
            '\\\\host\\share\\Fixture User\\project',
            'email=fixture@example.com SJ_PERSON_ID=fixture-person',
        ].join('\n');
        const result = redactAgentRuntimeDetail(detail);
        for (const secret of ['fixture-login-cookie', 'fixture-person', 'fixture@example.com', 'fixture-user', 'fixture-pass', 'Fixture User', 'fixture-private-key']) expect(result).not.toContain(secret);
        expect(result).toContain('"max_tokens":4096');
    });
    it('retains the cause across reloads and redacts credentials before storage', async () => {
        const stored = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (key: string) => stored.get(key) ?? null,
            setItem: (key: string, value: string) => stored.set(key, value),
        });
        const cause = 'exit code: 3\nInvalid settings\nAuthorization: Bearer private-token\nAPI_KEY="secret with spaces"\ntoken=hidden\nsk-ant-private12345';
        recordAgentRuntimeFailure('Claude 連線失敗', cause);
        vi.resetModules();
        const reloaded = await import('./agent-diagnostics');
        const copied = reloaded.agentRuntimeDiagnostics();
        expect(copied).toContain('exit code: 3\nInvalid settings');
        for (const secret of ['private-token', 'secret with spaces', 'hidden', 'sk-ant-private12345']) {
            expect(copied).not.toContain(secret);
            expect([...stored.values()].join('')).not.toContain(secret);
        }
    });

    it('works when storage is unavailable', () => {
        vi.stubGlobal('localStorage', undefined);
        expect(recordAgentRuntimeFailure('failed', 'exit code: 3')).toContain('exit code: 3');
        expect(agentRuntimeDiagnostics()).toBe('');
    });
});
