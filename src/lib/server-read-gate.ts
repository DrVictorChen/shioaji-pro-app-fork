// src/lib/server-read-gate.ts — dependency-free (api.ts and boot.ts import it)

// #285: on an App launch the main window's reads wait until boot knows the
// server on its port is this App's (or another program's server it checked)
// — the dashboard mounts in parallel and must not show a foreign server's
// data first. Released by every boot decision; expires on its own.
let readGate: Promise<void> | null = null;
let openReadGate: (() => void) | null = null;
const READ_GATE_MAX_MS = 20_000;

export function holdServerReads() {
    if (readGate) return;
    readGate = new Promise<void>((resolve) => {
        openReadGate = resolve;
        globalThis.setTimeout(resolve, READ_GATE_MAX_MS);
    });
}

export function releaseServerReads() {
    openReadGate?.();
    openReadGate = null;
    readGate = null;
}

export function serverReadsHeld(): Promise<void> | null {
    return readGate;
}
