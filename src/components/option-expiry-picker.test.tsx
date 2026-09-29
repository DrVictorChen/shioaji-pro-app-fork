// src/components/option-expiry-picker.test.tsx — 到期契約下拉選擇器（issue #154）

import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExpiryKind, OptionExpiry } from '../lib/option-expiry';
import { OptionExpiryPicker } from './option-expiry-picker';

function exp(
    root: string,
    date: string,
    kind: ExpiryKind,
    daysLeft: number,
    shiftedFrom: number | null = null,
): OptionExpiry {
    return {
        key: `${root}:${date}`,
        root,
        date,
        month: date.slice(0, 7).replace('-', ''),
        deliveryMonth: date.slice(0, 7).replace('-', ''),
        kind,
        weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
        shiftedFrom,
        daysLeft,
        contracts: 20,
    };
}

// 2026-09-29（週二）為今日到期、且由週五順延
const EXPIRIES: OptionExpiry[] = [
    exp('TXY', '2026-09-29', 'fri', 0, 5),
    exp('TXU', '2026-10-02', 'fri', 3),
    exp('TX1', '2026-10-07', 'wed', 8),
    exp('TXO', '2026-10-21', 'monthly', 22),
    exp('TXO', '2027-03-17', 'monthly', 169),
];

const text = (n: ReactTestInstance): string =>
    n.children.map((c) => (typeof c === 'string' ? c : text(c))).join('');
const button = (r: ReactTestRenderer, label: string) =>
    r.root.find((n) => n.type === 'button' && n.props['aria-label'] === label);
const trigger = (r: ReactTestRenderer) =>
    r.root.find((n) => n.type === 'button' && n.props['aria-haspopup'] === 'listbox');
const listbox = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.role === 'listbox');
const options = (r: ReactTestRenderer) => r.root.findAll((n) => n.props.role === 'option');
const key = (k: string) => ({ key: k, defaultPrevented: false, preventDefault: vi.fn(), stopPropagation: vi.fn() });

let focus: ReturnType<typeof vi.fn>;

function render(value: string, onChange = vi.fn(), expiries = EXPIRIES) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(OptionExpiryPicker, { expiries, value, onChange }), {
            // 主按鈕可聚焦，其餘節點沒有 DOM（清單就地渲染）
            createNodeMock: (el) =>
                el.type === 'button' && (el.props as Record<string, unknown>)['aria-haspopup'] === 'listbox'
                    ? { focus }
                    : null,
        });
    });
    return r;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    focus = vi.fn();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

it('collapses to one row: date, weekday, kind badge and days left', () => {
    const r = render('TXU:2026-10-02');
    expect(text(trigger(r))).toBe('10/02週五週選剩 3 天▾');
    expect(trigger(r).props['aria-expanded']).toBe(false);
    expect(trigger(r).props.title).toBe('2026/10/02（五）到期 · 週五週選（TXU） · 剩 3 天');
    expect(listbox(r)).toHaveLength(0);

    const monthly = render('TXO:2026-10-21');
    expect(text(trigger(monthly))).toBe('10/21週三月選剩 22 天▾');
});

it('shows today-expiring in the danger style', () => {
    const r = render('TXY:2026-09-29');
    expect(text(trigger(r))).toBe('09/29週二週選今日到期▾');
    const days = trigger(r).find((n) => n.type === 'span' && n.props['data-today'] === true);
    expect(text(days)).toBe('今日到期');
});

it('steps to the previous/next expiry and disables the ends', () => {
    const onChange = vi.fn();
    let r = render('TXU:2026-10-02', onChange);
    expect(button(r, '上一個到期').props.disabled).toBe(false);
    expect(button(r, '下一個到期').props.disabled).toBe(false);
    act(() => button(r, '上一個到期').props.onClick());
    act(() => button(r, '下一個到期').props.onClick());
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['TXY:2026-09-29', 'TX1:2026-10-07']);

    r = render('TXY:2026-09-29', onChange);
    expect(button(r, '上一個到期').props.disabled).toBe(true);
    expect(button(r, '下一個到期').props.disabled).toBe(false);

    r = render('TXO:2027-03-17', onChange);
    expect(button(r, '上一個到期').props.disabled).toBe(false);
    expect(button(r, '下一個到期').props.disabled).toBe(true);
});

it('disables everything when there is no expiry', () => {
    const r = render('', vi.fn(), []);
    expect(trigger(r).props.disabled).toBe(true);
    expect(button(r, '上一個到期').props.disabled).toBe(true);
    expect(button(r, '下一個到期').props.disabled).toBe(true);
    expect(text(trigger(r))).toBe('無到期契約▾');
});

it('opens a month-grouped listbox with the selection marked', () => {
    const r = render('TX1:2026-10-07');
    act(() => trigger(r).props.onClick());
    expect(trigger(r).props['aria-expanded']).toBe(true);
    const [list] = listbox(r);
    expect(trigger(r).props['aria-controls']).toBe(list!.props.id);

    const groups = list!.findAll((n) => n.props.role === 'group');
    expect(groups.map((g) => g.props['aria-label'])).toEqual(['2026年9月', '2026年10月', '2027年3月']);
    // 第一組以外、不同年的分組加年份前綴
    expect(groups.map((g) => text(g.findAll((n) => n.props['aria-hidden'] === true)[0]!))).toEqual([
        '9月',
        '10月',
        '27年3月',
    ]);
    expect(groups.map((g) => g.findAll((n) => n.props.role === 'option').length)).toEqual([1, 3, 1]);

    const opts = options(r);
    expect(opts.map(text)).toEqual([
        '09/29週二週選順延今日到期',
        '10/02週五週選剩 3 天',
        '10/07週三週選剩 8 天',
        '10/21週三月選剩 22 天',
        '03/17週三月選剩 169 天',
    ]);
    expect(opts.filter((o) => o.props['aria-selected']).map((o) => o.props['data-expiry'])).toEqual([
        'TX1:2026-10-07',
    ]);
    // 目前的鍵盤位置從選取列開始
    expect(list!.props['aria-activedescendant']).toBe(opts[2]!.props.id);
});

it('flags holiday-shifted and today-expiring rows', () => {
    const r = render('TXU:2026-10-02');
    act(() => trigger(r).props.onClick());
    const [shifted, normal] = options(r);
    expect(shifted!.props.title).toBe(
        '2026/09/29（二）到期 · 週五週選（TXY） · 原定週五，遇假日調整為週二 · 今日到期',
    );
    expect(shifted!.findAll((n) => n.props['data-shifted-note'] === true).map(text)).toEqual(['順延']);
    expect(shifted!.findAll((n) => n.type === 'span' && n.props['data-shifted'] === true)).toHaveLength(1);
    expect(shifted!.findAll((n) => n.type === 'span' && n.props['data-today'] === true).map(text)).toEqual([
        '今日到期',
    ]);
    expect(normal!.findAll((n) => n.props['data-shifted-note'] === true)).toHaveLength(0);
    expect(normal!.findAll((n) => n.type === 'span' && n.props['data-today'] === true)).toHaveLength(0);
});

it('selects with a click, closes and returns focus', () => {
    const onChange = vi.fn();
    const r = render('TXU:2026-10-02', onChange);
    act(() => trigger(r).props.onClick());
    act(() => options(r)[3]!.props.onClick());
    expect(onChange).toHaveBeenCalledWith('TXO:2026-10-21');
    expect(listbox(r)).toHaveLength(0);
    expect(focus).toHaveBeenCalled();
});

it('moves with arrow keys and selects with Enter', () => {
    const onChange = vi.fn();
    const r = render('TXU:2026-10-02', onChange);
    const down = key('ArrowDown');
    act(() => trigger(r).props.onKeyDown(down));
    expect(down.preventDefault).toHaveBeenCalled();
    expect(listbox(r)).toHaveLength(1);

    const press = (k: string) => act(() => listbox(r)[0]!.props.onKeyDown(key(k)));
    press('ArrowDown');
    press('ArrowDown');
    press('ArrowUp');
    press('ArrowDown');
    const active = () =>
        options(r).find((o) => o.props.id === listbox(r)[0]!.props['aria-activedescendant'])!.props['data-expiry'];
    expect(active()).toBe('TXO:2026-10-21');
    press('End');
    press('ArrowDown'); // 停在最後一列
    expect(active()).toBe('TXO:2027-03-17');
    press('Home');
    press('ArrowUp'); // 停在第一列
    expect(active()).toBe('TXY:2026-09-29');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    expect(onChange).toHaveBeenCalledWith('TX1:2026-10-07');
    expect(listbox(r)).toHaveLength(0);
    expect(focus).toHaveBeenCalledTimes(1);
});

it('re-selecting the current expiry closes without a change', () => {
    const onChange = vi.fn();
    const r = render('TXU:2026-10-02', onChange);
    act(() => trigger(r).props.onClick());
    act(() => listbox(r)[0]!.props.onKeyDown(key('Enter')));
    expect(onChange).not.toHaveBeenCalled();
    expect(listbox(r)).toHaveLength(0);
});

it('Escape closes, returns focus and leaves the value untouched', () => {
    const onChange = vi.fn();
    const r = render('TXU:2026-10-02', onChange);
    act(() => trigger(r).props.onClick());
    act(() => listbox(r)[0]!.props.onKeyDown(key('ArrowDown')));
    const esc = key('Escape');
    act(() => listbox(r)[0]!.props.onKeyDown(esc));
    expect(esc.preventDefault).toHaveBeenCalled();
    expect(listbox(r)).toHaveLength(0);
    expect(trigger(r).props['aria-expanded']).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
});

it('claims Escape through the modal stack so it never arms cancel-all', () => {
    const listeners: ((e: KeyboardEvent) => void)[] = [];
    vi.stubGlobal('window', {
        addEventListener: (_t: string, fn: (e: KeyboardEvent) => void) => listeners.push(fn),
        removeEventListener: (_t: string, fn: (e: KeyboardEvent) => void) =>
            listeners.splice(listeners.indexOf(fn), 1),
    });
    const r = render('TXU:2026-10-02');
    act(() => trigger(r).props.onClick());
    expect(listeners).toHaveLength(1);
    const ev = { key: 'Escape', repeat: false, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    act(() => listeners[0]!(ev));
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(listbox(r)).toHaveLength(0);
    expect(focus).toHaveBeenCalledTimes(1);
    // 關閉後退出 modal stack
    expect(listeners).toHaveLength(0);
});

it('toggles closed when the button is pressed again', () => {
    const r = render('TXU:2026-10-02');
    act(() => trigger(r).props.onClick());
    expect(listbox(r)).toHaveLength(1);
    act(() => trigger(r).props.onClick());
    expect(listbox(r)).toHaveLength(0);
});

it('keeps the keyboard row on the same contract when the list updates while open', () => {
    const onChange = vi.fn();
    const r = render('TXU:2026-10-02', onChange);
    act(() => trigger(r).props.onKeyDown(key('ArrowDown')));
    // 今日到期的 TXY 下架：清單少一列，鍵盤位置仍停在 TXU
    act(() => r.update(createElement(OptionExpiryPicker, { expiries: EXPIRIES.slice(1), value: 'TXU:2026-10-02', onChange })));
    act(() => listbox(r)[0]!.props.onKeyDown(key('Enter')));
    expect(onChange).not.toHaveBeenCalled(); // 重選目前的到期只會關閉
    expect(listbox(r)).toHaveLength(0);
});

it('Tab closes, returns focus to the button and lets the browser move on', () => {
    const r = render('TXU:2026-10-02');
    act(() => trigger(r).props.onKeyDown(key('ArrowDown')));
    const tab = key('Tab');
    act(() => listbox(r)[0]!.props.onKeyDown(tab));
    expect(listbox(r)).toHaveLength(0);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(tab.preventDefault).not.toHaveBeenCalled();
});
