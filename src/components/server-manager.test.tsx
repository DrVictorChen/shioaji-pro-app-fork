import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), start: vi.fn(), stop: vi.fn(), status: vi.fn(), env: vi.fn(), envCandidate: vi.fn(), ca: vi.fn(), notify: vi.fn(), info: vi.fn(), prepare: vi.fn() }));
vi.mock('../lib/tauri', () => ({
    isTauri: true, appVersion: async () => 'dev · test',
    loadDesktopSettings: mocks.load, saveDesktopSettings: mocks.save,
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
const updateState = { phase: 'idle' };
import { ServerManager } from './server-manager';
import { ServerSettingsDialog } from './server-settings-dialog';
const initial = { apiKey: 'test-key', secretKey: 'test-secret', production: false, caPath: '', caPasswd: '', autoStart: true, httpsEnabled: false, agentHarnessEnabled: true };

describe('server settings edit and apply workflow', () => {
    let view: ReactTestRenderer;
    beforeEach(() => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 0; });
        vi.clearAllMocks();
        mocks.prepare.mockResolvedValue(undefined);
        mocks.load.mockResolvedValue({ ...initial }); mocks.save.mockResolvedValue(undefined);
        mocks.status.mockResolvedValue({ running: true, healthy: true, simulation: false, scheme: 'http', port: 21322 });
        mocks.start.mockResolvedValue({ ok: true, output: '', port: 21322, attached: true });
        mocks.stop.mockResolvedValue({ ok: true, output: '' }); mocks.info.mockResolvedValue({ simulation: false });
    });
    afterEach(async () => { if (view) await act(async () => view.unmount()); vi.unstubAllGlobals(); });
    const text = () => JSON.stringify(view.toJSON());
    const button = (label: string) => view.root.findAllByType('button').find(node => node.children.filter(x => typeof x === 'string').join('').includes(label))!;
    const open = async () => { await act(async () => { view = create(createElement(ServerManager, { open: true, onToggle: vi.fn() })); }); await act(async () => button('完整設定').props.onClick()); };
    const changeKey = async (value: string) => { await act(async () => view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.onChange({ target: { value } })); };
    it('keeps edits and .env imports in draft; cancelling leaves saved credentials and server alone', async () => {
        await open(); await changeKey('changed-key');
        mocks.env.mockResolvedValue({ kind: 'imported', fileName: 's_multi.env', secretKey: 'imported-secret' });
        await act(async () => button('選擇 .env 檔案').props.onClick());
        expect(mocks.env).toHaveBeenCalledWith('file');
        expect(text()).toContain('已從 s_multi.env 匯入，尚未儲存。');
        expect(text()).toContain('尚未儲存');
        expect(mocks.save).not.toHaveBeenCalled();
        await act(async () => button('取消變更').props.onClick());
        expect(view.root.findAllByType(ServerSettingsDialog)).toHaveLength(0);
        await act(async () => button('完整設定').props.onClick());
        expect(view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.value).toBe('test-key');
        expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled();
    });
    it('shows a choice for multiple folder candidates and imports only the selected name', async () => {
        await open();
        const selection = { directory: 'C:\\Keys', candidates: ['.env', 'a.env', 'b.env'] };
        mocks.env.mockResolvedValue({ kind: 'choose', selection });
        mocks.envCandidate.mockResolvedValue({ kind: 'imported', fileName: 'b.env', apiKey: 'new-key' });
        await act(async () => button('選擇資料夾').props.onClick());
        expect(mocks.env).toHaveBeenCalledWith('directory');
        expect(text()).toContain('b.env');
        const select = view.root.findByType('select');
        await act(async () => select.props.onChange({ target: { value: 'b.env' } }));
        await act(async () => button('匯入所選檔案').props.onClick());
        expect(mocks.envCandidate).toHaveBeenCalledExactlyOnceWith(selection, 'b.env');
        expect(text()).toContain('已從 b.env 匯入，尚未儲存。');
        expect(mocks.save).not.toHaveBeenCalled();
    });
    it('reports a CA picker failure as a certificate error', async () => {
        await open();
        await act(async () => button('正式環境').props.onClick());
        mocks.ca.mockRejectedValue(new Error('fixture'));
        await act(async () => button('選擇憑證檔').props.onClick());
        expect(text()).toContain('無法讀取憑證檔。');
        expect(text()).not.toContain('無法匯入 .env 檔案。');
    });
    it('saves once without restarting and preserves other panels’ latest Harness/TLS settings', async () => {
        await open(); await changeKey('changed-key');
        mocks.load.mockResolvedValue({ ...initial, agentHarnessEnabled: false, httpsEnabled: true });
        await act(async () => button('僅儲存').props.onClick());
        expect(mocks.save).toHaveBeenCalledExactlyOnceWith({ ...initial, apiKey: 'changed-key', agentHarnessEnabled: false, httpsEnabled: true });
        expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
        expect(text()).toContain('下次啟動或重啟伺服器時套用');
    });
    it('does not save or stop a running server when apply validation fails', async () => {
        await open(); await changeKey('');
        await act(async () => button('儲存並重啟').props.onClick());
        expect(text()).toContain('缺少 API 金鑰');
        expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.start).not.toHaveBeenCalled();
    });
    it('keeps the draft and reports a storage failure without restarting', async () => {
        await open(); await changeKey('changed-key'); mocks.save.mockRejectedValue(new Error('磁碟無法寫入'));
        await act(async () => button('儲存並重啟').props.onClick());
        expect(text()).toContain('磁碟無法寫入');
        expect(view.root.findByType(ServerSettingsDialog).findAllByType('input')[0]!.props.value).toBe('changed-key');
        expect(mocks.stop).not.toHaveBeenCalled();
    });
    it('does not persist the new environment when stopping native Agents fails', async () => {
        mocks.load.mockResolvedValue({ ...initial, production: true });
        await open();
        await act(async () => button('模擬環境').props.onClick());
        mocks.prepare.mockRejectedValue(new Error('Agent 無法停止'));
        await act(async () => button('儲存並重啟').props.onClick());
        expect(text()).toContain('Agent 無法停止');
        expect(text()).toContain('有尚未儲存的變更');
        expect(mocks.save).not.toHaveBeenCalled();
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(mocks.start).not.toHaveBeenCalled();
    });
    it('switches to simulation through Agent shutdown, save, stop and start in order', async () => {
        mocks.load.mockResolvedValue({ ...initial, production: true });
        await open();
        await act(async () => button('模擬環境').props.onClick());
        await act(async () => {
            button('儲存並重啟').props.onClick();
            await vi.waitFor(() => expect(mocks.start).toHaveBeenCalled(), { timeout: 2500 });
        });
        expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.save.mock.invocationCallOrder[0]!);
        expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0]!);
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]!);
        expect(mocks.stop).toHaveBeenCalledWith({ stopAgents: true });
        expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({ production: false }));
    });
    it('does not start after stop fails, and makes partial apply failure visible', async () => {
        await open(); mocks.stop.mockResolvedValue({ ok: false, output: 'owned server busy' });
        await act(async () => button('儲存並重啟').props.onClick());
        expect(mocks.save).toHaveBeenCalledOnce(); expect(mocks.stop).toHaveBeenCalledOnce(); expect(mocks.start).not.toHaveBeenCalled();
        expect(text()).toContain('設定已儲存，但伺服器未能套用');
    });
    it('locks draft saves and duplicate logout while the server stop is pending', async () => {
        await open();
        let finishStop!: (result: { ok: boolean; output: string }) => void;
        mocks.stop.mockImplementation(() => new Promise(resolve => { finishStop = resolve; }));
        await act(async () => button('登出並清除金鑰').props.onClick());
        await act(async () => button('確認登出並清除金鑰').props.onClick());
        expect(view.root.findByType(ServerSettingsDialog).props.busy).toBe(true);
        expect(button('儲存並重啟').props.disabled).toBe(true);
        await expect(view.root.findByType(ServerSettingsDialog).props.onSave(initial, false)).rejects.toThrow('正在登出');
        await act(async () => button('登出並清除金鑰').props.onClick());
        expect(mocks.stop).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
        await act(async () => finishStop({ ok: false, output: 'stop failed' }));
        expect(mocks.save).not.toHaveBeenCalled();
        expect(view.root.findByType(ServerSettingsDialog).props.busy).toBe(false);
        expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ title: '登出未完成' }));
    });
    it('does not call an unknown server environment production during diagnostics', async () => {
        await open(); mocks.info.mockRejectedValue(new Error('offline'));
        await act(async () => button('檢查目前帳戶').props.onClick());
        expect(text()).toContain('環境：未知'); expect(text()).not.toContain('環境：⚠ 正式');
    });
});
