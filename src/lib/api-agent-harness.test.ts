import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    invoke: vi.fn(),
    harnessEnabled: true,
    identityVerified: true,
}));

vi.mock('./runtime', () => ({
    getApiBase: () => 'http://127.0.0.1:21322',
    isTauri: true,
}));
vi.mock('./agent-harness-state', () => ({
    isAgentHarnessEnabled: () => mocks.harnessEnabled,
}));
vi.mock('./server-identity', () => ({ serverIdentityVerified: () => mocks.identityVerified }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));

import { apiPost } from './api';
import { canTrade } from './account-tradable';
import { beginServerInfoRequest, observeServerInfo } from './server-info-store';
import type { Account } from './types/portfolio';
import type { ServerInfo } from './shioaji';

describe('agent harness native POST proxy', () => {
    beforeEach(() => {
        mocks.invoke.mockReset();
        mocks.harnessEnabled = true;
        mocks.identityVerified = true;
    });

    it('rejects a desktop mutation before native or direct HTTP while identity is unverified', async () => {
        mocks.identityVerified = false;
        const browserFetch = vi.spyOn(globalThis, 'fetch');
        const error = await apiPost('/api/v1/order/place_order', { code: '2330' }).catch((caught: unknown) => caught);
        expect(error).toMatchObject({ mutationNotStarted: true });
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });

    it('sends the exact serialized mutation through the native bridge', async () => {
        const browserFetch = vi.spyOn(globalThis, 'fetch');
        mocks.invoke.mockResolvedValue({
            status: 200,
            body: '{"trade_id":"t-1"}',
        });

        await expect(
            apiPost<{ trade_id: string }>('/api/v1/order/place_order', {
                code: '2330',
                quantity: 1,
            }),
        ).resolves.toEqual({ trade_id: 't-1' });
        expect(mocks.invoke).toHaveBeenCalledWith('agent_harness_post', {
            url: 'http://127.0.0.1:21322/api/v1/order/place_order',
            body: '{"code":"2330","quantity":1}',
            agentInitiated: false,
        });
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });

    it('rechecks the trading account after serialization and native transport loading', async () => {
        const account = { signed: false } as Account;
        observeServerInfo(beginServerInfoRequest(), { simulation: true } as ServerInfo);
        const body = { toJSON: () => {
            observeServerInfo(beginServerInfoRequest(), { simulation: false } as ServerInfo);
            return { code: 'fixture' };
        } };
        await expect(apiPost('/api/v1/order/place_order', body, {
            beforeDispatch: () => {
                if (!canTrade(account)) throw Object.assign(new Error('帳戶不可交易'), { mutationNotStarted: true });
            },
        })).rejects.toMatchObject({ mutationNotStarted: true });
        expect(mocks.invoke).not.toHaveBeenCalled();
    });

    it.each([200, 403])('preserves native response headers before parsing a %s response', async status => {
        mocks.invoke.mockResolvedValue({
            status,
            body: status === 200 ? '{"trade_id":"t-1"}' : '{"message":"denied"}',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'x-shioaji-instance': 'instance-A',
                'x-request-id': 'request-A',
            },
        });
        const onResponse = vi.fn();
        const pending = apiPost('/api/v1/order/place_order', {}, { onResponse });
        if (status === 200) await expect(pending).resolves.toEqual({ trade_id: 't-1' });
        else await expect(pending).rejects.toThrow('403 denied');
        expect(onResponse).toHaveBeenCalledOnce();
        const response = onResponse.mock.calls[0]![0] as Response;
        expect(response.headers.get('X-Shioaji-Instance')).toBe('instance-A');
        expect(response.headers.get('X-Request-Id')).toBe('request-A');
        expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    });

    it('keeps the JSON content type for native responses without headers', async () => {
        mocks.invoke.mockResolvedValue({ status: 200, body: '{}' });
        const onResponse = vi.fn();
        await apiPost('/api/v1/order/place_order', {}, { onResponse });
        expect(onResponse.mock.calls[0]![0].headers.get('Content-Type')).toBe('application/json');
    });

    it('marks an Agent mutation for native production approval', async () => {
        mocks.invoke.mockResolvedValue({ status: 200, body: '{}' });

        await apiPost('/api/v1/order/place_order', { code: '2330' }, {
            agentInitiated: true,
        });

        expect(mocks.invoke).toHaveBeenCalledWith('agent_harness_post', {
            url: 'http://127.0.0.1:21322/api/v1/order/place_order',
            body: '{"code":"2330"}',
            agentInitiated: true,
        });
    });

    it('surfaces a rejected native mutation without direct HTTP fallback', async () => {
        const browserFetch = vi.spyOn(globalThis, 'fetch');
        mocks.invoke.mockResolvedValue({
            status: 403,
            body: '{"message":"capability denied"}',
        });

        await expect(
            apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }),
        ).rejects.toThrow('403 capability denied');
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });

    it('passes native call identity and Auto request without changing body bytes', async () => {
        mocks.invoke.mockResolvedValue({ status: 200, body: '{}' });
        await apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }, {
            agentInitiated: true, agentCallId: 'call-1', agentAuto: true,
        });
        expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('agent_harness_post', {
            url: 'http://127.0.0.1:21322/api/v1/order/cancel_order',
            body: '{"trade_id":"t-1"}',
            agentInitiated: true, agentCallId: 'call-1', agentAuto: true,
        });
    });

    it('preserves ambiguous native failures without retry or not-started classification', async () => {
        mocks.invoke.mockRejectedValue('UI trading proxy request failed: timeout');
        const error = await apiPost('/api/v1/order/place_order', { code: '2330' }, {
            agentInitiated: true, agentCallId: 'call-2', agentAuto: true,
        }).catch((caught: unknown) => caught);
        expect(error).toBe('UI trading proxy request failed: timeout');
        expect(mocks.invoke).toHaveBeenCalledTimes(1);
    });

    it('marks native approval denial as a mutation that never started', async () => {
        mocks.invoke.mockRejectedValue(
            'AGENT_MUTATION_NOT_STARTED: 使用者未核准這筆 Agent 交易',
        );

        const error = await apiPost(
            '/api/v1/order/place_order',
            { code: '2330' },
            { agentInitiated: true },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ mutationNotStarted: true });
        expect((error as Error).message).toContain('使用者未核准');
    });

    it('marks the native main-window-only refusal as not started and says why (#244)', async () => {
        // agent_harness_post rejects every non-main window before any HTTP
        // (desktop ensure_agent_command_window); popouts / flash tiles hit it.
        mocks.invoke.mockRejectedValue('此視窗無權呼叫 Agent 原生命令');
        const error = await apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ mutationNotStarted: true });
        expect((error as Error).message).toContain('主視窗');
        expect((error as Error).message).toContain('此視窗無權呼叫 Agent 原生命令');
    });

    it.each(['錯誤：此視窗無權呼叫 Agent 原生命令', '此視窗無權呼叫 Agent 原生命令。'])('does not mark a near-match native error %s as not started', async text => {
        mocks.invoke.mockRejectedValue(text);
        const error = await apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }).catch((caught: unknown) => caught);
        expect(error).toBe(text);
    });

    it('does not mark an HTTP response with the same text as not started', async () => {
        mocks.invoke.mockResolvedValue({ status: 403, body: '{"code":403,"message":"此視窗無權呼叫 Agent 原生命令"}' });
        const error = await apiPost('/api/v1/order/cancel_order', { trade_id: 't-1' }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toMatchObject({ mutationNotStarted: true });
    });

    it('never falls back to unsigned HTTP for an Agent mutation', async () => {
        mocks.harnessEnabled = false;
        const browserFetch = vi.spyOn(globalThis, 'fetch');

        const error = await apiPost(
            '/api/v1/order/place_order',
            { code: '2330' },
            { agentInitiated: true },
        ).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(Error);
        expect(error).toMatchObject({ mutationNotStarted: true });
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(browserFetch).not.toHaveBeenCalled();
        browserFetch.mockRestore();
    });
});
