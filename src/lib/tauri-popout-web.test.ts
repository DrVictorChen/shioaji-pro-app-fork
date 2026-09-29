// issue #139 — web build: flash popouts of the same code open as separate
// browser windows (named by their window id) and carry no account id
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./runtime', async importOriginal => ({ ...await importOriginal<object>(), isTauri: false }));
vi.mock('./trade', () => ({ notify: vi.fn() }));
import { openFlashTiles, openPopout } from './tauri';

const open = vi.fn();
const replace = vi.fn();
beforeEach(() => {
    open.mockReset();
    replace.mockReset();
    open.mockImplementation(() => ({ location: { href: 'about:blank', replace }, focus: vi.fn() }));
    vi.stubGlobal('window', { open, location: { pathname: '/' }, screen: { availWidth: 1200, availHeight: 800 } });
});
afterEach(() => vi.unstubAllGlobals());

it('names each flash popout window by its window id', async () => {
    await openPopout('flash', 'TMF', { win: 'w1' }, vi.fn());
    await openPopout('flash', 'TMF', { win: 'w2' }, vi.fn());
    const [first, second] = open.mock.calls;
    expect(first![1]).not.toBe(second![1]);
    expect(first![1]).toBe('sj-popout-flash-TMF-w1');
    expect(replace.mock.calls[0]![0]).toBe('/?popout=flash&code=TMF&win=w1');
});

it('keeps the existing single-window naming for other popouts', async () => {
    await openPopout('chart', 'TMF');
    expect(open.mock.calls[0]![1]).toBe('sj-popout-chart-TMF');
    expect(open.mock.calls[0]![0]).toBe('/?popout=chart&code=TMF');
});

it('seeds a reused flash id only when the old browser window has closed', async () => {
    const created = vi.fn();
    await openPopout('flash', 'TMF', { win: 'w1' }, created);
    expect(created).toHaveBeenCalledTimes(1);
    const focus = vi.fn();
    open.mockReturnValueOnce({ location: { href: 'http://localhost/?popout=flash&code=TMF&win=w1' }, focus });
    await openPopout('flash', 'TMF', { win: 'w1' }, created);
    expect(created).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledTimes(1);
});

it('updates a tile account only when a new tile window opens', async () => {
    const created = vi.fn();
    const params = vi.fn(() => ({ win: 'tile-w1' }));
    await openFlashTiles(['2330'], { cols: 1, rows: 1, region: 'full' }, params, created);
    expect(created).toHaveBeenCalledWith('2330', { win: 'tile-w1' });
    const focus = vi.fn();
    open.mockReturnValueOnce({ location: { href: 'http://localhost/?popout=flash&code=2330&win=tile-w1' }, focus });
    await openFlashTiles(['2330'], { cols: 1, rows: 1, region: 'full' }, params, created);
    expect(created).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledTimes(1);
});
