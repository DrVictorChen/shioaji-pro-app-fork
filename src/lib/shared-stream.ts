// One SSE owner per origin/API base. BroadcastChannel carries the original
// event name and JSON bytes; every window keeps its own local quote store.
// Web Locks is the arbiter, including when a leader exits without unload.
export type StreamWire =
    | { kind: 'event'; name: string; raw: string }
    | { kind: 'status'; status: 'connecting' | 'live' | 'down' | 'stale'; heartbeat: number };

type Envelope = StreamWire | { kind: 'alive'; id: string; main: boolean } | { kind: 'yield'; id: string };

export function createSharedStream(options: {
    name: string;
    main: boolean;
    onOwn: () => void;
    onRelease: () => void;
    onWire: (wire: StreamWire) => void;
    onMissing: () => void;
    snapshot: () => Extract<StreamWire, { kind: 'status' }>;
}) {
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(options.name);
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    let owner = false;
    let closed = false;
    let claiming = false;
    let lastAlive = 0;
    let deferUntil = 0;
    let releaseLock: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let startup: ReturnType<typeof setTimeout> | null = null;

    const post = (message: Envelope) => { try { channel?.postMessage(message); } catch { /* closing */ } };
    const release = () => {
        if (!owner) return;
        owner = false;
        options.onRelease();
        releaseLock?.();
        releaseLock = null;
    };
    const receive = (event: MessageEvent<Envelope>) => {
        const data = event.data;
        if (!data || typeof data !== 'object') return;
        if (data.kind === 'yield') {
            if (data.id !== id && !options.main) {
                deferUntil = Date.now() + 2000;
                if (owner) release();
            }
        } else if (data.kind === 'alive') {
            if (data.id === id) return;
            if (options.main && !owner && !data.main) {
                post({ kind: 'yield', id });
                setTimeout(claim, 0);
            }
            if (!owner) lastAlive = Date.now();
        } else if (!owner && (data.kind === 'event' || data.kind === 'status')) {
            lastAlive = Date.now();
            options.onWire(data);
        }
    };

    const claim = () => {
        if (closed || claiming || owner || Date.now() < deferUntil) return;
        // A browser without both primitives cannot coordinate multiple tabs.
        // Fail closed instead of opening one EventSource per popout.
        if (typeof window !== 'undefined' && (!channel || !locks?.request)) {
            options.onMissing();
            return;
        }
        if (!channel || !locks?.request) {
            owner = true;
            options.onOwn();
            return;
        }
        claiming = true;
        void locks.request(options.name, { ifAvailable: true }, async lock => {
            claiming = false;
            if (!lock || closed) return;
            owner = true;
            options.onOwn();
            post({ kind: 'alive', id, main: options.main });
            post(options.snapshot());
            await new Promise<void>(resolve => { releaseLock = resolve; });
        }).catch(() => { claiming = false; });
    };

    channel?.addEventListener('message', receive);
    // The main window wins a simultaneous startup. A later main asks a child
    // owner to release its lock; the child waits before competing again.
    if (options.main) claim();
    else startup = setTimeout(claim, 350);
    timer = setInterval(() => {
        if (closed) return;
        if (owner) {
            post({ kind: 'alive', id, main: options.main });
            post(options.snapshot());
        }
        else if (options.main || Date.now() - lastAlive > 1700) {
            if (Date.now() - lastAlive > 1700) options.onMissing();
            claim();
        }
    }, 500);

    return {
        isOwner: () => owner,
        publish(wire: StreamWire) { if (owner) post(wire); },
        close() {
            closed = true;
            if (startup) clearTimeout(startup);
            if (timer) clearInterval(timer);
            release();
            channel?.removeEventListener('message', receive);
            channel?.close();
        },
    };
}
