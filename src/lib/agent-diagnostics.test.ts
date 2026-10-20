import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentRuntimeDiagnostics, recordAgentRuntimeFailure, redactAgentRuntimeDetail } from './agent-diagnostics';

afterEach(() => vi.unstubAllGlobals());

describe('Agent runtime copied diagnostics', () => {
    it('masks complete paths without consuming the following cause in text and JSON', () => {
        for (const [path, cause] of [
            [String.raw`"\\server\share\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`'\\server\Client Share\Client Secret\account.json'`, 'failed: EACCES'],
            [String.raw`"\\?\unc\server\share\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`"C:\Client Secret\account.json"`, 'failed: EACCES'],
            [String.raw`\\server\share\Fixture User\p`, 'failed'],
            [String.raw`\\server\share`, 'access denied'],
            [String.raw`\\?\UnC\server\share`, 'access denied'],
            [String.raw`C:\\project\\config.json`, 'not found'],
        ]) {
            const detail = `open ${path} ${cause}`;
            const redacted = redactAgentRuntimeDetail(detail);
            expect(redacted).toBe(`open [REDACTED_PATH] ${cause}`);
            expect(JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail }))).message).toBe(redacted);
        }
    });

    it('masks case variants of UNC paths while retaining the following cause in text and JSON', () => {
        for (const path of [
            String.raw`\\server\share\FixtureUser\project`,
            ...['UNC', 'unc', 'UnC'].map(prefix => `\\\\?\\${prefix}\\server\\share\\FixtureUser\\project`),
        ]) {
            const detail = `open ${path} failed: EACCES`;
            const redacted = redactAgentRuntimeDetail(detail);
            expect(redacted).not.toContain('server');
            expect(redacted).not.toContain('FixtureUser');
            expect(redacted).toContain('failed: EACCES');
            const json = JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail })));
            expect(json.message).toBe(redacted);
        }
    });

    it('masks proxy accounts with or without passwords', () => {
        for (const proxy of ['http://fixture-user@proxy.test:80', 'socks5://fixture-user@proxy.test:1080', 'http://fixture-user:@proxy.test:80']) {
            expect(redactAgentRuntimeDetail(proxy)).not.toContain('fixture-user');
        }
    });

    it('preserves causes after escaped newlines while masking actual UNC paths', () => {
        for (const detail of [String.raw`failed\\nimportant cause /project/config.json`, String.raw`failed\\nimportant cause \"quoted\"`]) {
            expect(redactAgentRuntimeDetail(detail)).toBe(detail);
            expect(JSON.parse(redactAgentRuntimeDetail(JSON.stringify({ message: detail }))).message).toBe(detail);
        }
        expect(redactAgentRuntimeDetail(String.raw`failed\\nimportant cause C:\project\config.json`)).toBe(String.raw`failed\\nimportant cause [REDACTED_PATH]`);
        for (const path of [String.raw`\\server\share\Fixture User\project`, String.raw`"\\server\shared folder\Fixture User\project"`, String.raw`\\?\UNC\server\share\Fixture User\project`]) {
            expect(redactAgentRuntimeDetail(path)).not.toContain('Fixture User');
        }
    });
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
