import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), profile: vi.fn(), select: vi.fn(), remove: vi.fn(), logout: vi.fn(), start: vi.fn(), stop: vi.fn(), status: vi.fn(), env: vi.fn(), envCandidate: vi.fn(), ca: vi.fn(), notify: vi.fn(), info: vi.fn(), prepare: vi.fn(), reload: vi.fn() }));
vi.mock('../lib/tauri', async () => ({
    ...await import('../lib/desktop-credentials'),
    isTauri: true, appVersion: async () => 'dev · test',
    loadDesktopSettings: mocks.load, saveDesktopSettings: mocks.save,
    saveCredentialProfile: mocks.profile, selectCredentialProfile: mocks.select,
    deleteCredentialProfile: mocks.remove, logoutCredentialProfile: mocks.logout,
    stopAgentsForServerChange: mocks.prepare,
    serverStart: mocks.start, serverStop: mocks.stop, serverStatus: mocks.status,
    pickEnvFile: mocks.env, importEnvCandidate: mocks.envCandidate, pickCaFile: mocks.ca,
    subscribeAgentHarnessEnabled: () => () => {}, subscribeAppUpdateState: () => () => {},
    getAppUpdateState: () => updateState, checkForUpdates: vi.fn(), ensureLocalTlsCert: vi.fn(),
    openLatestRelease: vi.fn(), reloadWhenHealthy: vi.fn(), restartAndInstallUpdate: vi.fn(),
}));
vi.mock('../hooks/use-stream', () => ({ useStreamStatus: () => 'live' }));
vi.mock('../lib/shioaji', () => ({ fetchHealth: async () => null, fetchInfo: mocks.info, fetchAccounts: async () => [], fetchCaExpire: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify: mocks.notify }));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { ServerManager } from './server-manager';
import { ServerSettingsDialog } from './server-settings-dialog';
import { CredentialProfiles } from './credential-profiles';
const updateState = { phase: 'idle' };
const one = { id: 'one', name: '主帳號', environment: 'simulation' as const, caPath: '', hasCA: false, apiKeyMasked: '••••1234', createdAt: '2026-10-20', secretState: 'stored' as const, credentialBackend: 'system' as const, revision: 'one-rev' };
const two = { ...one, id: 'two', name: '備用帳號', environment: 'production' as const, hasCA: true, caPath: '/fixture/ca.pfx', revision: 'two-rev' };
const initial: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, profiles: [one, two], activeProfileId: 'one', credentialRevision: 'one-rev', configured: true };
describe('credential profiles in server settings', () => {
    let view: ReactTestRenderer;
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload: mocks.reload } }));
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
        vi.clearAllMocks();
        mocks.load.mockResolvedValue(structuredClone(initial)); mocks.save.mockResolvedValue(initial); mocks.profile.mockResolvedValue(initial);
        mocks.select.mockResolvedValue({ ...initial, activeProfileId: 'two', production: true, credentialRevision: 'two-rev', caPath: two.caPath, hasCaPassword: true });
        mocks.remove.mockResolvedValue({ ...initial, profiles: [two], activeProfileId: null, configured: false });
        mocks.logout.mockResolvedValue({ ...initial, activeProfileId: null, configured: false });
        mocks.status.mockResolvedValue({ running: true, healthy: true, simulation: true, scheme: 'http', port: 12345 });
        mocks.start.mockResolvedValue({ ok: true, output: '', port: 12345, attached: true });
        mocks.stop.mockResolvedValue({ ok: true, output: '' }); mocks.info.mockResolvedValue({ simulation: true });
    });
    afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
    const text = () => JSON.stringify(view.toJSON());
    const button = (label: string) => view.root.findAllByType('button').find(node => (node.props['aria-label'] ?? node.children.filter(x => typeof x === 'string').join('')).includes(label))!;
    const click = async (label: string) => { await act(async () => button(label).props.onClick()); };
    const open = async () => { await act(async () => { view = create(createElement(ServerManager, { open: true, onToggle: vi.fn() })); }); await click('完整設定'); };
    const field = (index: number) => view.root.findByType(CredentialProfiles).findAllByType('input')[index]!;
    const change = async (index: number, value: string) => { await act(async () => field(index).props.onChange({ target: { value } })); };
    it('lists names, masked keys, environments and CA state without preloading secrets', async () => {
        await open(); expect(text()).toContain('主帳號'); expect(text()).toContain('備用帳號'); expect(text()).toContain('••••1234');
        expect(field(1).props.value).toBe(''); expect(field(2).props.value).toBe('');
        await change(1, 'draft-canary'); await click('關閉伺服器設定');
        expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
        await click('完整設定'); expect(text()).not.toContain('draft-canary');
    });
    it('requires a second confirmation to add and clears secrets before save finishes', async () => {
        await open(); await click('新增帳號'); await change(0, '新帳號'); await change(1, 'Abc123'); await change(2, 'Xyz789');
        let finish!: (value: DesktopSettings) => void;
        mocks.profile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await click('僅儲存'); expect(mocks.profile).not.toHaveBeenCalled();
        await click('確認新增帳號'); expect(mocks.profile).toHaveBeenCalledOnce();
        expect(field(1).props.value).toBe(''); expect(field(2).props.value).toBe('');
        await act(async () => finish({ ...initial, profiles: [...initial.profiles, { ...one, id: 'three', name: '新帳號' }] }));
        expect(mocks.stop).not.toHaveBeenCalled(); expect(text()).toContain('帳號已儲存');
    });
    it('saves a profile separately from preferences without restarting', async () => {
        await open(); await change(0, '更名'); await click('僅儲存');
        expect(mocks.profile).toHaveBeenCalledWith({ id: 'one', name: '更名', environment: 'simulation', caPath: '' });
        expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    });
    it('does not save or restart when native Agent shutdown fails', async () => {
        await open(); mocks.prepare.mockRejectedValueOnce(new Error('unavailable'));
        await click('儲存並重啟'); expect(mocks.profile).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled(); expect(text()).toContain('操作未完成');
    });
    it('switches only after confirmation and stopping the old server', async () => {
        await open(); await click('切換使用'); expect(mocks.select).not.toHaveBeenCalled();
        await click('確認切換並停止伺服器');
        expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true }); expect(mocks.select).toHaveBeenCalledWith('two');
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.select.mock.invocationCallOrder[0]!);
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('does not switch or delete when stopping fails', async () => {
        await open(); mocks.stop.mockResolvedValue({ ok: false, output: 'busy' });
        await click('切換使用'); await click('確認切換並停止伺服器');
        expect(mocks.select).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
    });
    it('requires confirmation and a stop before deleting the active profile', async () => {
        await open(); await click('刪除帳號'); expect(mocks.remove).not.toHaveBeenCalled();
        await click('確認刪除全部秘密'); expect(mocks.remove).toHaveBeenCalledWith('one');
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!);
        expect(mocks.reload).toHaveBeenCalledOnce();
    });
    it('imports only after confirmation and receives no plaintext form values', async () => {
        await open(); mocks.env.mockResolvedValue({ kind: 'imported', fileName: 'fixture.env', settings: initial, profileId: 'two' });
        await click('選擇 .env 檔案'); expect(mocks.env).not.toHaveBeenCalled();
        await click('確認匯入並新增帳號'); expect(mocks.env).toHaveBeenCalledWith('file', 'simulation');
        expect(field(1).props.value).toBe(''); expect(field(2).props.value).toBe(''); expect(text()).toContain('匯入並儲存帳號');
    });
    it('shows migration and Linux fallback warnings without secrets', async () => {
        mocks.load.mockResolvedValue({ ...initial, credentialBackend: 'plaintext-fallback', fallbackPath: '/fixture/credentials.json', migrationError: '遷移未完成；明文設定已保留' });
        await open(); expect(text()).toContain('0600'); expect(text()).toContain('/fixture/credentials.json'); expect(text()).toContain('遷移未完成');
    });
    it('logout stops then clears all active secrets through one native command and reloads', async () => {
        await open(); await click('登出並清除金鑰'); expect(mocks.logout).not.toHaveBeenCalled();
        await click('確認登出並清除金鑰');
        expect(mocks.logout).toHaveBeenCalledOnce(); expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.logout.mock.invocationCallOrder[0]!);
        expect(mocks.reload).toHaveBeenCalledOnce();
    });
    it('locks duplicate logout and profile operations while the stop is pending', async () => {
        await open(); let finish!: (value: { ok: boolean; output: string }) => void;
        mocks.stop.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await click('登出並清除金鑰'); await click('確認登出並清除金鑰');
        expect(view.root.findByType(ServerSettingsDialog).props.busy).toBe(true);
        await expect(view.root.findByType(ServerSettingsDialog).props.onSave({ name: 'test', environment: 'simulation', caPath: '' }, false)).rejects.toThrow('正在登出');
        await click('登出並清除金鑰'); expect(mocks.stop).toHaveBeenCalledTimes(1);
        await act(async () => finish({ ok: false, output: 'failed' })); expect(mocks.logout).not.toHaveBeenCalled();
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '登出未完成' }));
    });
    it('does not call an unknown server environment production during diagnostics', async () => {
        await open(); mocks.info.mockRejectedValue(new Error('offline')); await click('檢查目前帳戶');
        expect(text()).toContain('環境：未知'); expect(text()).not.toContain('環境：⚠ 正式');
    });
});
