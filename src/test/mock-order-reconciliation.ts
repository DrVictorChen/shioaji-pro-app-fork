import { afterEach, vi } from 'vitest';

// Component tests replace accounts, orders and streams. Keep unknown-outcome
// reconciliation at the same boundary: the real service would dynamically load
// boot and try to subscribe with those incomplete mocks, possibly in a later test.
// Service/subscription behaviour stays covered by the lib integration tests.
const mocks = vi.hoisted(() => ({ reconcileOrdersOnce: vi.fn(async () => {}) }));
vi.mock('../lib/trading-state', () => ({ reconcileOrdersOnce: mocks.reconcileOrdersOnce }));
export const reconcileOrdersOnce = mocks.reconcileOrdersOnce;

afterEach(async () => {
    // Drain order-outcome's dynamic import before another test clears its mocks.
    await vi.dynamicImportSettled();
    reconcileOrdersOnce.mockClear();
});
