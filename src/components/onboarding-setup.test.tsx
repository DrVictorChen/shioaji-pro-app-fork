import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ panel: vi.fn(() => null), defaults: vi.fn(), env: vi.fn(), envCandidate: vi.fn() }));
vi.mock('../lib/features', () => ({
    agentModule: { Panel: mocks.panel, ensureDefaultProvider: mocks.defaults },
    useFeature: () => ({ enabled: true }),
    FEATURES: [],
}));
vi.mock('../lib/tauri', () => ({
    isTauri: true, pickCaFile: vi.fn(), pickEnvFile: mocks.env, importEnvCandidate: mocks.envCandidate, reloadWhenHealthy: vi.fn(),
    saveDesktopSettings: vi.fn(), serverStart: vi.fn(),
}));

import { OnboardingSetup } from './onboarding-setup';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('first-run guide runtime scope', () => {
    it('explicitly opts only the embedded guide into onboarding', () => {
        const html = renderToStaticMarkup(createElement(OnboardingSetup));
        expect(html).toContain('引導申請 API Key');
        expect(mocks.panel).toHaveBeenCalledWith({
            onboarding: true,
            initialPrompt: '我是第一次使用，還沒有永豐 Shioaji API Key，可以引導我怎麼申請嗎？',
            visibleTabs: ['chat', 'settings'],
        }, undefined);
        expect(mocks.defaults).toHaveBeenCalledWith('codex');
    });
});

describe('first-run .env import', () => {
    it('uses the same file and folder choices and reports the chosen file', async () => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        vi.stubGlobal('window', new EventTarget());
        const selection = { directory: '/tmp/fixture', candidates: ['.env', 's_multi.env'] };
        mocks.env.mockResolvedValue({ kind: 'choose', selection });
        mocks.envCandidate.mockResolvedValue({ kind: 'imported', fileName: 's_multi.env', apiKey: 'fixture-api' });
        let view!: ReturnType<typeof create>;
        await act(async () => { view = create(createElement(OnboardingSetup)); });
        const button = (label: string) => view.root.findAllByType('button').find(node => node.children.filter(x => typeof x === 'string').join('').includes(label))!;
        expect(JSON.stringify(view.toJSON())).toContain('支援 name.env、.env、.env.local；隱藏檔請選資料夾。');
        await act(async () => button('選擇資料夾').props.onClick());
        expect(mocks.env).toHaveBeenCalledWith('directory');
        await act(async () => view.root.findByType('select').props.onChange({ target: { value: 's_multi.env' } }));
        await act(async () => button('匯入所選檔案').props.onClick());
        expect(mocks.envCandidate).toHaveBeenCalledExactlyOnceWith(selection, 's_multi.env');
        expect(JSON.stringify(view.toJSON())).toContain('已從 s_multi.env 匯入');
        await act(async () => view.unmount());
    });
});
