import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRuntimeDiagnostics, recordAgentRuntimeFailure } from './agent-diagnostics';

afterEach(() => vi.unstubAllGlobals());

describe('Agent runtime copied diagnostics', () => {
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
