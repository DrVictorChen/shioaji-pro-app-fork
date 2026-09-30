// src/components/chart-order-popover.tsx — K 線圖「下單設定」按鈕與彈出面板（#204）
// 按鈕只顯示數量＋單位（「500 股」＝盤中零股、「1 張」＝整股、「2 口」＝期貨），
// 滑過看完整摘要；面板只列這個商品適用的選項，底部一句話說明點下去會送什麼。

import { Settings2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
    chartOrderChipLabel,
    chartOrderRows,
    chartOrderSummary,
    chartOrderUnit,
    chartExitText,
    normalizeChartOrder,
    OCTYPES,
    ORDER_TYPES,
    QTY_PRESETS,
    type ChartOrderMarket,
    type ChartOrderSettings,
} from '../lib/chart-order-settings';
import { flashAccountKey } from '../lib/flash-account';
import { ODD_LOT_MAX_SHARES } from '../lib/odd-lot';
import type { Account } from '../lib/types/portfolio';
import * as styles from './chart-order-popover.css';

const FOLLOW = '__follow__';

export interface ChartOrderAccountView {
    eligible: Account[];
    /** the account a click would use now (undefined = none available) */
    active: Account | undefined;
    following: boolean;
    missing: boolean;
    short: (a: Account) => string;
    long: (a: Account) => string;
}

export function chartAccountLabel(view: ChartOrderAccountView): string {
    if (view.missing) return '（固定帳戶已不可用）';
    if (!view.active) return '（無可用帳戶）';
    return view.following ? `跟隨主畫面 ${view.short(view.active)}` : view.short(view.active);
}

export function ChartOrderButton({
    market,
    settings,
    onChange,
    onSaveDefault,
    account,
    contractLabel,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    account: ChartOrderAccountView;
    contractLabel: string;
}) {
    const [open, setOpen] = useState(false);
    const summary = chartOrderSummary(settings, market, chartAccountLabel(account));
    // Esc closes; nothing is listened to while closed (chart hotkeys untouched)
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [open]);
    return (
        <span className={styles.anchor}>
            <button
                type='button'
                className={styles.chip[open ? 'open' : 'closed']}
                title={`圖表下單設定\n${summary}`}
                aria-label={`圖表下單設定：${chartOrderChipLabel(settings, market)}`}
                aria-haspopup='dialog'
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
            >
                <Settings2 size={11} aria-hidden />
                <span className={styles.chipQty}>{chartOrderChipLabel(settings, market)}</span>
            </button>
            {open && (
                <>
                    <div className={styles.backdrop} onClick={() => setOpen(false)} />
                    <ChartOrderPanel
                        market={market}
                        settings={settings}
                        onChange={onChange}
                        onSaveDefault={onSaveDefault}
                        onClose={() => setOpen(false)}
                        account={account}
                        contractLabel={contractLabel}
                        summary={summary}
                    />
                </>
            )}
        </span>
    );
}

export function ChartOrderPanel({
    market,
    settings,
    onChange,
    onSaveDefault,
    onClose,
    account,
    contractLabel,
    summary,
}: {
    market: ChartOrderMarket;
    settings: ChartOrderSettings;
    onChange: (next: ChartOrderSettings) => void;
    onSaveDefault: () => void;
    onClose: () => void;
    account: ChartOrderAccountView;
    contractLabel: string;
    summary: string;
}) {
    const rows = chartOrderRows(market, settings.lot);
    const unit = chartOrderUnit(market, settings.lot);
    const odd = market === 'S' && settings.lot === 'IntradayOdd';
    const set = (patch: Partial<ChartOrderSettings>) => onChange(normalizeChartOrder({ ...settings, ...patch }, market));
    const [qtyText, setQtyText] = useState(String(settings.qty));
    useEffect(() => setQtyText(String(settings.qty)), [settings.qty]);
    const max = odd ? ODD_LOT_MAX_SHARES : 9999;
    return (
        <div className={styles.pop} role='dialog' aria-label='圖表下單設定'>
            <div className={styles.head}>
                <span>圖表下單設定</span>
                <span className={styles.headNote} title={contractLabel}>{contractLabel} · 只影響這張圖</span>
            </div>
            <div className={styles.row}>
                <span className={styles.label}>帳號</span>
                <select
                    className={styles.select}
                    aria-label='圖表下單帳號'
                    value={settings.accountKey ?? FOLLOW}
                    onChange={e => set({ accountKey: e.target.value === FOLLOW ? undefined : e.target.value })}
                >
                    <option value={FOLLOW}>
                        {account.following && account.active ? `跟隨主畫面 ${account.short(account.active)}` : '跟隨主畫面'}
                    </option>
                    {account.missing && settings.accountKey && <option value={settings.accountKey}>帳戶不可用</option>}
                    {account.eligible.map(a => (
                        <option key={flashAccountKey(a)} value={flashAccountKey(a)}>{account.long(a)}</option>
                    ))}
                </select>
            </div>
            {rows.unit && (
                <div className={styles.row}>
                    <span className={styles.label}>單位</span>
                    <div className={styles.seg} role='group' aria-label='單位'>
                        {([['Common', '整股（張）'], ['IntradayOdd', '盤中零股（股）']] as const).map(([lot, text]) => (
                            <button
                                key={lot}
                                type='button'
                                className={styles.segBtn[settings.lot === lot ? 'on' : 'off']}
                                aria-pressed={settings.lot === lot}
                                // 換單位時數量回 1：股數不能沿用成張數
                                onClick={() => { if (settings.lot !== lot) set({ lot, qty: 1 }); }}
                            >
                                {text}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <div className={styles.row}>
                <span className={styles.label}>數量</span>
                <div className={styles.qtyRow}>
                    <input
                        className={styles.qtyInput}
                        aria-label={`圖表下單數量（${unit}）`}
                        inputMode='numeric'
                        value={qtyText}
                        onChange={e => {
                            setQtyText(e.target.value);
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 1 && v <= max) set({ qty: v });
                        }}
                        onBlur={() => setQtyText(String(settings.qty))}
                    />
                    <span>{unit}</span>
                    {QTY_PRESETS[unit].map(n => (
                        <button key={n} type='button' className={styles.preset[settings.qty === n ? 'on' : 'off']} onClick={() => set({ qty: n })}>
                            {n}
                        </button>
                    ))}
                </div>
            </div>
            {rows.orderType && (
                <div className={styles.row}>
                    <span className={styles.label}>委託</span>
                    <div className={styles.seg} role='group' aria-label='委託條件'>
                        {ORDER_TYPES.map(t => (
                            <button key={t} type='button' className={styles.segBtn[settings.orderType === t ? 'on' : 'off']}
                                aria-pressed={settings.orderType === t} title='點價買賣的限價委託條件' onClick={() => set({ orderType: t })}>
                                {t}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {rows.octype && (
                <div className={styles.row}>
                    <span className={styles.label}>類別</span>
                    <div className={styles.seg} role='group' aria-label='開平倉'>
                        {OCTYPES.map(o => (
                            <button key={o.value} type='button' className={styles.segBtn[settings.octype === o.value ? 'on' : 'off']}
                                aria-pressed={settings.octype === o.value} onClick={() => set({ octype: o.value })}>
                                {o.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            <div className={styles.row}>
                <span className={styles.label}>停損停利</span>
                <span className={styles.info}>{chartExitText(settings, market)}</span>
            </div>
            <div className={styles.summary} data-testid='chart-order-summary'>{summary}</div>
            <div className={styles.foot}>
                <button type='button' className={styles.footBtn.normal} title={`新開的${market === 'F' ? '期貨' : '股票'}圖表使用這組設定（不含帳號）`} onClick={onSaveDefault}>
                    設為預設
                </button>
                <button type='button' className={styles.footBtn.primary} onClick={onClose}>完成</button>
            </div>
        </div>
    );
}
