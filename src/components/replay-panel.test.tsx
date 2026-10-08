import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/shioaji', () => ({ fetchHistoryTicks: vi.fn() }));
// SSR 不支援 useSyncExternalStore 無 server snapshot；面板只需要底色模式
vi.mock('../lib/theme-store', () => ({
    useThemeSettings: () => ({}),
    baseMode: () => 'dark',
    getChartColors: () => ({}),
}));
import type { ContractInfo } from '../lib/types/contract';
import { ReplayPanel, ReplayPanelView, type ReplayPanelViewProps } from './replay-panel';

function view(over: Partial<ReplayPanelViewProps> = {}) {
    const props: ReplayPanelViewProps = {
        hostRef: createRef<HTMLDivElement>(),
        selectedDate: '',
        today: '2026-10-08',
        onDateChange: () => {},
        onReload: () => {},
        loaded: true,
        empty: false,
        playing: false,
        onTogglePlay: () => {},
        speedIdx: 1,
        onSpeed: () => {},
        cursor: 10,
        tickCount: 100,
        curPrice: 23010,
        curTime: 100,
        onSeek: () => {},
        code: 'TXFJ6',
        isStock: false,
        multiplier: 200,
        quantity: 2,
        onQuantity: () => {},
        position: null,
        summary: { count: 0, estimatedPnl: 0 },
        onOpen: () => {},
        onClose: () => {},
        ...over,
    };
    return renderToStaticMarkup(createElement(ReplayPanelView, props));
}

afterEach(() => {
    vi.useRealTimers();
});

describe('回放面板', () => {
    it('選到沒有資料的日期時，日期列與重新載入仍在，可以換日期', () => {
        const html = view({ selectedDate: '2026-10-04', empty: true, loaded: false, cursor: 0, tickCount: 0, curPrice: undefined });
        expect(html).toContain('aria-label="回放日期"');
        expect(html).toContain('value="2026-10-04"');
        expect(html).toContain('aria-label="重新載入指定日期"');
        expect(html).toContain('2026-10-04 無可回放的歷史成交');
        // 圖表容器仍掛著，換日期後不必重建圖表
        expect(html).toMatch(/<div class="[^"]*chartHost[^"]*"><\/div>/);
    });

    it('預設日期顯示今天（不是昨天）', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
        const contract = {
            code: 'TXFJ6', exchange: 'TAIFEX', security_type: 'FUT', target_code: null, category: 'TXF',
        } as unknown as ContractInfo;
        const html = renderToStaticMarkup(createElement(ReplayPanel, { contract }));
        expect(html).toContain('value="2026-10-08"');
        expect(html).toContain('今天，期權含夜盤');
        expect(html).not.toContain('value="2026-10-07"');
    });

    it('浮動損益標示已乘口數：每口點數 × 口數 ≈ 金額', () => {
        const html = view({ position: { side: 'long', entry: 23000, enteredAt: 1, quantity: 2 }, curPrice: 23010 });
        expect(html).toContain('浮動 +10.00 點 × 2 口 ≈ +4,000');
        expect(html).toContain('多 2 口 @ ');
    });

    it('股票以張與元標示，乘數每張 1,000 股', () => {
        const html = view({ code: '2330', isStock: true, multiplier: 1000, position: { side: 'short', entry: 1000, enteredAt: 1, quantity: 1 }, curPrice: 995 });
        expect(html).toContain('浮動 +5.00 元 × 1 張 ≈ +5,000');
        expect(html).toContain('每張 1,000 股');
    });

    it('累計損益只顯示目前商品並標示筆數', () => {
        const html = view({ summary: { count: 3, estimatedPnl: -1200 } });
        expect(html).toContain('TXFJ6 累計估算 -1,200（3 筆）');
    });

    it('倒帶到進場之前時平倉按鈕停用', () => {
        const pos = { side: 'long' as const, entry: 23000, enteredAt: 200, quantity: 1 };
        expect(view({ position: pos, curTime: 100 })).toMatch(/disabled=""[^>]*title="回放位置在進場之前，無法平倉"/);
        expect(view({ position: pos, curTime: 200 })).not.toContain('回放位置在進場之前');
    });
});
