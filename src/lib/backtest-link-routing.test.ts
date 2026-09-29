import { describe, expect, it } from 'vitest';
import { requestedBacktestPanelId, selectBacktestPanelId } from './backtest-link-routing';

describe('backtest deep link target', () => {
    const blocks = [
        { id: 'chart-1', type: 'chart' },
        { id: 'backtest-a', type: 'backtest' },
        { id: 'backtest-b', type: 'backtest' },
    ];

    it('uses the requesting backtest panel when multiple panels exist', () => {
        expect(selectBacktestPanelId(blocks, 'backtest-b')).toBe('backtest-b');
    });
    it('uses one existing panel for an external link', () => {
        expect(selectBacktestPanelId(blocks)).toBe('backtest-a');
        expect(selectBacktestPanelId(blocks, 'chart-1')).toBe('backtest-a');
    });
    it('requests a new panel when none exists', () => {
        expect(selectBacktestPanelId([{ id: 'chart-1', type: 'chart' }])).toBeUndefined();
    });
    it('retains the initial target when a child clears the URL before App effects', () => {
        expect(requestedBacktestPanelId(undefined, 'backtest-b', 'backtest-b'))
            .toBe('backtest-b');
        expect(requestedBacktestPanelId(undefined, null, 'backtest-b')).toBe('backtest-b');
        expect(selectBacktestPanelId(blocks,
            requestedBacktestPanelId(undefined, null, 'backtest-b'))).toBe('backtest-b');
        expect(requestedBacktestPanelId('backtest-a', 'backtest-b', 'backtest-b'))
            .toBe('backtest-a');
        // React StrictMode can run the mount effect again after the URL is cleared.
        expect(requestedBacktestPanelId(undefined, null, 'backtest-b')).toBe('backtest-b');
    });
});
