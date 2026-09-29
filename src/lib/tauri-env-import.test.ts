import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(), readDir: vi.fn(), readTextFile: vi.fn() }));
vi.mock('./runtime', async importOriginal => ({
    ...(await importOriginal<typeof import('./runtime')>()), isTauri: true,
}));
vi.mock('./trade', () => ({ notify: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readDir: mocks.readDir, readTextFile: mocks.readTextFile }));

import { envCandidates, importEnvCandidate, pickEnvFile } from './tauri';

const files = (...names: string[]) => names.map(name => ({ name, isFile: true }));
const fixture = 'SJ_API_KEY=fixture-api\nSJ_SEC_KEY=fixture-secret';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.readTextFile.mockResolvedValue(fixture);
});

describe('.env import', () => {
    it('filters and sorts the supported names, with exact .env first', () => {
        expect(envCandidates(['z.env', '.env.local', '.env', 'a.env', '.envfoo', 'other.txt', 'x.env.bak']))
            .toEqual(['.env', '.env.local', 'a.env', 'z.env']);
    });

    it('opens a file picker and reports the imported Windows file name', async () => {
        mocks.open.mockResolvedValue('C:\\Keys\\s_multi.env');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'imported', fileName: 's_multi.env', apiKey: 'fixture-api', secretKey: 'fixture-secret',
        });
        expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: false, multiple: false }));
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('C:\\Keys\\s_multi.env');
    });

    it('finds a single hidden .env through the directory picker on Windows', async () => {
        mocks.open.mockResolvedValue('C:\\Keys\\');
        mocks.readDir.mockResolvedValue([...files('.env'), { name: 'nested.env', isFile: false }]);
        expect(await pickEnvFile('directory')).toEqual({
            kind: 'imported', fileName: '.env', apiKey: 'fixture-api', secretKey: 'fixture-secret',
        });
        expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('C:\\Keys\\.env');
    });

    it('joins a Windows drive root without dropping its separator', async () => {
        mocks.open.mockResolvedValue('C:\\');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('C:\\s_multi.env');
    });

    it('keeps a backslash inside a POSIX directory name', async () => {
        mocks.open.mockResolvedValue('/tmp/keys\\backup');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('/tmp/keys\\backup/s_multi.env');
    });

    it('treats a trailing POSIX backslash as part of the directory name', async () => {
        mocks.open.mockResolvedValue('/tmp/keys\\');
        mocks.readDir.mockResolvedValue(files('s_multi.env'));
        await pickEnvFile('directory');
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('/tmp/keys\\/s_multi.env');

        mocks.readTextFile.mockClear();
        mocks.readDir.mockResolvedValue(files('.env', 's_multi.env'));
        const result = await pickEnvFile('directory');
        if (result?.kind !== 'choose') throw new Error('expected selection');
        await importEnvCandidate(result.selection, 's_multi.env');
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('/tmp/keys\\/s_multi.env');
    });

    it('reports the full POSIX file name when it contains a backslash', async () => {
        mocks.open.mockResolvedValue('/tmp/a\\b.env');
        expect(await pickEnvFile('file')).toMatchObject({ kind: 'imported', fileName: 'a\\b.env' });
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('/tmp/a\\b.env');
    });

    it('lists multiple candidates without reading until the user selects one', async () => {
        mocks.open.mockResolvedValue('C:\\Keys');
        mocks.readDir.mockResolvedValue(files('b.env', '.env', 'a.env'));
        const result = await pickEnvFile('directory');
        expect(result).toEqual({ kind: 'choose', selection: {
            directory: 'C:\\Keys', candidates: ['.env', 'a.env', 'b.env'],
        } });
        expect(mocks.readTextFile).not.toHaveBeenCalled();
        if (result?.kind !== 'choose') throw new Error('expected selection');
        expect(await importEnvCandidate(result.selection, 'b.env')).toMatchObject({ kind: 'imported', fileName: 'b.env' });
        expect(mocks.readTextFile).toHaveBeenCalledExactlyOnceWith('C:\\Keys\\b.env');
    });

    it('identifies each checked file when no supported file or key is found', async () => {
        mocks.open.mockResolvedValue('/tmp/project');
        mocks.readDir.mockResolvedValue(files('readme.txt', 'notes.conf'));
        expect(await pickEnvFile('directory')).toEqual({
            kind: 'error', error: '資料夾裡沒有 .env 檔案。已檢查檔案：notes.conf、readme.txt',
        });
        mocks.open.mockResolvedValue('/tmp/project/s_multi.env');
        mocks.readTextFile.mockResolvedValue('OTHER=value');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: 's_multi.env 沒有 SJ_API_KEY / SJ_SEC_KEY。已檢查檔案：s_multi.env',
        });
        mocks.open.mockResolvedValue('/tmp/project/readme.txt');
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: 'readme.txt 不是 .env 檔案。已檢查檔案：readme.txt',
        });
    });

    it('reports the selected name on read failure without revealing file content', async () => {
        mocks.open.mockResolvedValue('/tmp/project/s_multi.env');
        mocks.readTextFile.mockRejectedValue(new Error('fixture-secret'));
        expect(await pickEnvFile('file')).toEqual({
            kind: 'error', error: '無法讀取 s_multi.env。已檢查檔案：s_multi.env',
        });
    });
});
