import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ panel: vi.fn(() => null), defaults: vi.fn(), load: vi.fn(), save: vi.fn(), select: vi.fn(), start: vi.fn(), reload: vi.fn() }));
vi.mock('../lib/features', () => ({ agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults }, useFeature: () => ({ enabled: true }), FEATURES: [] }));
vi.mock('../lib/tauri', async () => ({
    ...await import('../lib/desktop-credentials'), isTauri: true,
    loadDesktopSettings: mocks.load, saveCredentialProfile: mocks.save, selectCredentialProfile: mocks.select,
    pickCaFile: vi.fn(), pickEnvFile: vi.fn(), importEnvCandidate: vi.fn(), reloadWhenHealthy: mocks.reload, serverStart: mocks.start,
}));
import { EMPTY_DESKTOP_SETTINGS, type DesktopSettings } from '../lib/desktop-credentials';
import { OnboardingSetup } from './onboarding-setup';
import { CredentialProfiles } from './credential-profiles';
let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('window', new EventTarget());
    mocks.load.mockResolvedValue(EMPTY_DESKTOP_SETTINGS);
});
afterEach(async () => { if (view) { await act(async () => view!.unmount()); view = undefined; } vi.unstubAllGlobals(); });
describe('first-run credential profiles', () => {
    it('opts only the embedded guide into onboarding', () => {
        expect(renderToStaticMarkup(createElement(OnboardingSetup))).toContain('引導申請 API Key');
        expect(mocks.panel).toHaveBeenCalledWith({ onboarding: true, initialPrompt: '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？', visibleTabs: ['chat', 'settings'] }, undefined);
    });
    it('starts with the native non-secret read model after saving a new account', async () => {
        const settings: DesktopSettings = { ...EMPTY_DESKTOP_SETTINGS, configured: true, activeProfileId: 'new', credentialRevision: 'native', profiles: [{ id: 'new', name: '新帳號', environment: 'simulation', hasCA: false, caPath: '', createdAt: '', apiKeyMasked: '••••1234', secretState: 'stored', credentialBackend: 'system', revision: 'native' }] };
        mocks.save.mockResolvedValue(settings); mocks.start.mockResolvedValue({ ok: true });
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await act(async () => view!.root.findByType(CredentialProfiles).props.onSave({ name: '新帳號', environment: 'simulation', caPath: '', apiKey: 'test', secretKey: 'test' }, true));
        expect(mocks.start).toHaveBeenCalledWith(settings);
        expect(mocks.start.mock.calls[0]![0]).not.toHaveProperty('apiKey'); expect(mocks.start.mock.calls[0]![0]).not.toHaveProperty('caPassword');
        expect(mocks.reload).toHaveBeenCalledOnce();
    });
    it('does not start when secret storage fails', async () => {
        mocks.save.mockRejectedValue(new Error('storage unavailable'));
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        await expect(view!.root.findByType(CredentialProfiles).props.onSave({ name: 'test', environment: 'simulation', caPath: '' }, true)).rejects.toThrow();
        expect(mocks.start).not.toHaveBeenCalled();
    });
});
