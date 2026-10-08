// 標題列的連動下拉：連動（跟自選）／群組 A／B／C／鎖定。群組的代碼框輸入代碼
// 全組一起換；頂端色條與群組色點標出同一組。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, expect, it, vi } from 'vitest';
import { PanelChrome } from './panel-chrome';

const text = (n: ReactTestInstance): string => n.children.map(c => (typeof c === 'string' ? c : text(c))).join('');
const groups = [
    { id: 'A' as const, code: '2330', count: 3 },
    { id: 'B' as const, code: '2317', count: 1 },
    { id: 'C' as const, code: null, count: 0 },
];
function render(mode: 'main' | 'pin' | 'A' | 'B' | 'C', extra: Record<string, unknown> = {}) {
    const onMode = vi.fn();
    const onGroupCode = vi.fn();
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(PanelChrome, {
            title: '閃電下單', symbolCode: '2330', pinnable: true, pin: mode === 'pin' ? '2454' : null, currentCode: '2330',
            onPinChange: vi.fn(), link: { mode, groups, onMode, onGroupCode }, ...extra,
        }));
    });
    return { r, onMode, onGroupCode };
}
const modeBtn = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props['aria-haspopup'] === 'menu')[0]!;
const items = (r: ReactTestRenderer) => r.root.findAll(n => n.type === 'button' && n.props.role === 'menuitemradio');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

it('the link button opens a menu of 連動, the three groups (code and member count) and 鎖定', () => {
    const { r, onMode } = render('main');
    expect(text(modeBtn(r))).toContain('連動');
    act(() => { modeBtn(r).props.onClick(); });
    expect(items(r).map(text)).toEqual(['連動自選清單', '群組 A2330 · 3 個', '群組 B2317 · 1 個', '群組 C未使用', '鎖定目前商品']);
    expect(items(r)[0]!.props['aria-checked']).toBe(true);
    act(() => { items(r)[1]!.props.onClick(); });
    expect(onMode).toHaveBeenCalledWith('A');
    expect(r.root.findAll(n => n.props.role === 'menu')).toHaveLength(0);
});

it('a group member shows the group code box; Enter changes the whole group', () => {
    const { r, onGroupCode } = render('A');
    expect(text(modeBtn(r))).toContain('A');
    const input = r.root.findAllByType('input')[0]!;
    expect(input.props.value).toBe('2330');
    act(() => { input.props.onChange({ target: { value: '2317' } }); });
    act(() => { r.root.findAllByType('input')[0]!.props.onKeyDown({ key: 'Enter' }); });
    expect(onGroupCode).toHaveBeenCalledWith('A', '2317');
    // the group colour marks the panel (top bar) and the title
    expect(r.root.findAll(n => n.props['data-link-group'] === 'A').length).toBeGreaterThan(0);
});

it('鎖定 from the menu locks the current code; a locked panel can go back to 連動', () => {
    const { r, onMode } = render('pin');
    expect(text(modeBtn(r))).toContain('鎖定');
    act(() => { modeBtn(r).props.onClick(); });
    act(() => { items(r)[0]!.props.onClick(); });
    expect(onMode).toHaveBeenCalledWith('main');
    act(() => { modeBtn(r).props.onClick(); });
    act(() => { items(r)[4]!.props.onClick(); });
    expect(onMode).toHaveBeenLastCalledWith('pin');
});
