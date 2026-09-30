import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PriceInput } from './chart-drawing-tools';

// 瀏覽器裡 blur() 會同步觸發 onBlur — 替身照做，才重現得出「Esc 之後
// onBlur 看到舊 draft」的時序
let view!: ReactTestRenderer;
const input = () => view.root.findByType('input');
const blurNow = () => ({ blur: () => input().props.onBlur() });

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => {
    await act(async () => view.unmount());
    vi.unstubAllGlobals();
});

async function typeThenPress(key: string) {
    const onCommit = vi.fn();
    await act(async () => {
        view = create(createElement(PriceInput, { price: 25000, onCommit }));
    });
    await act(async () => input().props.onFocus());
    await act(async () => input().props.onChange({ target: { value: '25100' } }));
    await act(async () =>
        input().props.onKeyDown({ key, currentTarget: blurNow(), stopPropagation() {} }),
    );
    return onCommit;
}

describe('水平線價格輸入', () => {
    it('Esc 還原，不套用打到一半的價格', async () => {
        const onCommit = await typeThenPress('Escape');
        expect(onCommit).not.toHaveBeenCalled();
        expect(input().props.value).toBe('25000');
    });

    it('Enter 只套用一次', async () => {
        const onCommit = await typeThenPress('Enter');
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenCalledWith(25100);
    });

    it('點別處（失焦）照常套用', async () => {
        const onCommit = vi.fn();
        await act(async () => {
            view = create(createElement(PriceInput, { price: 25000, onCommit }));
        });
        await act(async () => input().props.onFocus());
        await act(async () => input().props.onChange({ target: { value: '25100' } }));
        await act(async () => input().props.onBlur());
        expect(onCommit).toHaveBeenCalledWith(25100);
    });
});
