import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLevels, placeFloatingToolbar, placeStylePopover, Popover, PriceInput } from './chart-drawing-tools';
import { escStackDepth } from '../hooks/use-esc-close';

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

describe('樣式面板的位置：不被 K 線面板裁切，每個控制項都點得到', () => {
    const vp = { width: 1600, height: 1000 };

    it('放得下時貼在樣式鈕右側、與它頂端對齊', () => {
        expect(placeStylePopover({ top: 200, right: 300 }, 380, vp, 240)).toMatchObject({
            position: 'fixed',
            top: 200,
            left: 306,
        });
    });

    it('樣式鈕靠近視窗下緣（預設版面、426px 矮面板）時往上推，整個面板留在視窗內', () => {
        const pos = placeStylePopover({ top: 900, right: 300 }, 380, vp, 240);
        expect(pos.top).toBe(1000 - 8 - 380);
        expect((pos.top as number) + 380).toBeLessThanOrEqual(1000 - 8);
    });

    it('視窗比面板還矮時限高（面板內捲動），頂端不跑出視窗', () => {
        const pos = placeStylePopover({ top: 300, right: 300 }, 900, { width: 1600, height: 426 }, 240);
        expect(pos.top).toBe(8);
        expect(pos.maxHeight).toBe(426 - 16);
    });

    it('右側放不下時往左收，不超出視窗', () => {
        const pos = placeStylePopover({ top: 100, right: 1500 }, 300, vp, 240);
        expect((pos.left as number) + 240).toBeLessThanOrEqual(1600 - 8);
    });
});

describe('彈出層（工具組、色盤、線寬）：Esc 與點外面關閉', () => {
    const keyListeners = new Set<(e: KeyboardEvent) => void>();
    const downListeners = new Set<(e: Event) => void>();
    let active: unknown = null;
    const popChild = { tagName: 'BUTTON' };
    const priceInput = { tagName: 'INPUT' };

    const anchorEl = { tagName: 'BUTTON' };
    const anchor = {
        contains: (n: unknown) => n === anchorEl,
        getBoundingClientRect: () => ({ top: 0, right: 0 }),
        ownerDocument: {
            get activeElement() {
                return active;
            },
            addEventListener: (t: string, l: (e: Event) => void) => {
                if (t === 'pointerdown') downListeners.add(l);
            },
            removeEventListener: (t: string, l: (e: Event) => void) => void downListeners.delete(l),
        },
    } as unknown as HTMLElement;

    beforeEach(() => {
        keyListeners.clear();
        downListeners.clear();
        active = null;
        vi.stubGlobal('window', {
            addEventListener: (t: string, l: (e: KeyboardEvent) => void) => {
                if (t === 'keydown') keyListeners.add(l);
            },
            removeEventListener: (t: string, l: (e: KeyboardEvent) => void) =>
                void keyListeners.delete(l),
        });
    });

    function esc() {
        const e = { key: 'Escape', repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const l of [...keyListeners]) l(e as unknown as KeyboardEvent);
        return e;
    }

    async function openPop() {
        const onClose = vi.fn();
        await act(async () => {
            view = create(
                createElement(Popover, { anchor, onClose, label: '測試', children: null }),
                // popRef 需要一個 contains()：面板內的元素只有 popChild 與 priceInput
                { createNodeMock: () => ({ contains: (n: unknown) => n === popChild || n === priceInput, ownerDocument: anchor.ownerDocument, scrollHeight: 300, offsetWidth: 240 }) },
            );
        });
        return onClose;
    }

    it('開著時入 modal stack；Esc 關閉並吃掉這一下（不算進 Esc×2 全部刪單）', async () => {
        const onClose = await openPop();
        expect(escStackDepth()).toBe(1);
        let e!: ReturnType<typeof esc>;
        await act(async () => {
            e = esc();
        });
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(e.defaultPrevented).toBe(true);
    });

    it('價格輸入框裡的 Esc 只還原輸入，不關面板', async () => {
        const onClose = await openPop();
        active = priceInput;
        await act(async () => {
            esc();
        });
        expect(onClose).not.toHaveBeenCalled();
    });

    it('點面板或樣式鈕不關，點外面任何地方都關', async () => {
        const onClose = await openPop();
        const down = (target: unknown) => {
            for (const l of [...downListeners]) l({ target } as unknown as Event);
        };
        await act(async () => down(popChild));
        await act(async () => down(anchorEl));
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => down({ tagName: 'DIV' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});

describe('浮動物件工具列的位置：留在圖表內，放不下就翻面', () => {
    const host = { width: 800, height: 400 };
    const bar = { width: 220, height: 30 };

    it('預設在物件上方置中', () => {
        expect(placeFloatingToolbar({ left: 300, top: 200, right: 500, bottom: 260 }, bar, host)).toEqual({
            left: 290,
            top: 162,
            flipped: false,
        });
    });

    it('物件貼近上緣時翻到下方', () => {
        const p = placeFloatingToolbar({ left: 300, top: 10, right: 500, bottom: 60 }, bar, host);
        expect(p.flipped).toBe(true);
        expect(p.top).toBe(68);
    });

    it('上下都放不下（物件佔滿整個高度）時壓在圖表內', () => {
        const p = placeFloatingToolbar({ left: 300, top: 0, right: 500, bottom: 400 }, bar, host);
        expect(p.top).toBeGreaterThanOrEqual(4);
        expect(p.top + bar.height).toBeLessThanOrEqual(host.height - 4);
    });

    it('左右夾在圖表內（水平線橫跨整個畫面、物件跑出畫面）', () => {
        expect(placeFloatingToolbar({ left: -500, top: 200, right: 20, bottom: 200 }, bar, host).left).toBe(4);
        expect(placeFloatingToolbar({ left: 780, top: 200, right: 2000, bottom: 200 }, bar, host).left).toBe(800 - 220 - 4);
    });
});

describe('斐波那契比例輸入', () => {
    it('逗號、空白、全形逗號都能分隔，忽略看不懂的字', () => {
        expect(parseLevels('0, 0.236，0.382 0.5、abc, 1')).toEqual([0, 0.236, 0.382, 0.5, 1]);
        expect(parseLevels('')).toEqual([]);
    });
});
