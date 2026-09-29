import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSharedStream } from './shared-stream';

class Channel {
    static all = new Set<Channel>();
    listeners = new Set<(event: MessageEvent) => void>();
    constructor(public name: string) { Channel.all.add(this); }
    postMessage(data: unknown) {
        for (const other of Channel.all) if (other !== this && other.name === this.name)
            queueMicrotask(() => other.listeners.forEach(listener => listener({ data } as MessageEvent)));
    }
    addEventListener(_name: string, listener: (event: MessageEvent) => void) { this.listeners.add(listener); }
    removeEventListener(_name: string, listener: (event: MessageEvent) => void) { this.listeners.delete(listener); }
    close() { Channel.all.delete(this); }
}

const held = new Set<string>();
const locks = {
    async request(name: string, _options: unknown, callback: (lock: object | null) => unknown) {
        if (held.has(name)) return callback(null);
        held.add(name);
        try { return await callback({}); }
        finally { held.delete(name); }
    },
};

beforeEach(() => {
    vi.useFakeTimers();
    Channel.all.clear(); held.clear();
    vi.stubGlobal('BroadcastChannel', Channel);
    vi.stubGlobal('navigator', { locks });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const make = (main: boolean) => {
    const own = vi.fn();
    const release = vi.fn();
    const wire = vi.fn();
    const stream = createSharedStream({ name: 'fixture', main, onOwn: own, onRelease: release, onWire: wire, onMissing: vi.fn(), snapshot: () => ({ kind: 'status', status: 'live', heartbeat: 1 }) });
    return { stream, own, release, wire };
};

it('keeps one owner across nine windows and transfers within seconds on close', async () => {
    const main = make(true);
    const children = Array.from({ length: 8 }, () => make(false));
    await vi.advanceTimersByTimeAsync(1000);
    expect(main.stream.isOwner()).toBe(true);
    expect(children.filter(child => child.stream.isOwner())).toHaveLength(0);
    main.stream.publish({ kind: 'event', name: 'tick_fop', raw: '{"code":"TXF"}' });
    await Promise.resolve();
    expect(children.every(child => child.wire.mock.calls.some(call => call[0].kind === 'event'))).toBe(true);
    main.stream.close();
    await vi.advanceTimersByTimeAsync(2500);
    expect(children.filter(child => child.stream.isOwner())).toHaveLength(1);
    children.forEach(child => child.stream.close());
});

it('hands a child-owned stream to a newly opened main window', async () => {
    const child = make(false);
    await vi.advanceTimersByTimeAsync(400);
    expect(child.stream.isOwner()).toBe(true);
    const main = make(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(main.stream.isOwner()).toBe(true);
    expect(child.stream.isOwner()).toBe(false);
    expect(child.release).toHaveBeenCalledTimes(1);
    main.stream.close(); child.stream.close();
});
