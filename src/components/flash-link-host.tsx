// src/components/flash-link-host.tsx — 閃電下單的「對應商品」
// 把面板收到的來源商品（自選選取、群組代碼、鎖定代碼）依面板設定換成要下單的
// 合約：照選取／現股／個股期（規格、月份）。換不到就暫停並說明，絕不保留上一檔。
// linkKey 涵蓋群組、對應設定與來源代碼 — 任何一項變了，閃電同一次 render 解除
// 點價下單，確認中的那筆也不送。

import { CirclePause, ArrowLeftRight, Ban, ChevronDown, RotateCw } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type MutableRefObject, type ReactNode } from 'react';
import { ensureContract, getCachedContract, primeContract, useContract } from '../lib/contracts-cache';
import { linkedStockCode, monthLabel, pickStockFuture, type FlashLink } from '../lib/flash-link';
import { fetchFutures } from '../lib/shioaji';
import type { ContractInfo } from '../lib/types/contract';
import { SettingsSegRow } from './chart-order-popover';
import * as styles from './flash-order.css';
import * as hostStyles from './flash-link-host.css';

// ---- 個股期合約（依標的股票快取）----
type FuturesEntry = { status: 'loading' } | { status: 'ok'; rows: ContractInfo[] } | { status: 'error' };
const futures = new Map<string, FuturesEntry>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

function loadStockFutures(code: string) {
    futures.set(code, { status: 'loading' });
    emit();
    fetchFutures({ underlyingCode: code }).then(rows => {
        for (const row of rows) if (!getCachedContract(row.code)) primeContract(row);
        futures.set(code, { status: 'ok', rows });
    }, () => futures.set(code, { status: 'error' })).finally(emit);
}

export function resetStockFuturesCache() {
    futures.clear();
}

function useStockFutures(code: string | null): FuturesEntry | undefined {
    const entry = useSyncExternalStore(
        l => { listeners.add(l); return () => listeners.delete(l); },
        () => (code ? futures.get(code) : undefined),
    );
    useEffect(() => {
        if (code && !futures.has(code)) loadStockFutures(code);
    }, [code]);
    return entry;
}

// 近月到期換月：每次 render 都用當下時間判斷，並在到期那一刻重新 render
function useRerenderAt(at: number | null) {
    const [, bump] = useState(0);
    useEffect(() => {
        if (at === null) return;
        const t = setTimeout(() => bump(n => n + 1), Math.max(0, at - Date.now()) + 50);
        return () => clearTimeout(t);
    }, [at]);
}

export interface FlashLinkProps {
    linkKey: string;
    symbolExtra?: ReactNode;
    settingsRows: ReactNode;
    showRef: boolean;
    expiresAt?: number | null;
}

const KIND_OPTIONS = [['select', '照選取'], ['stock', '現股'], ['future', '個股期']] as const;

export function FlashLinkHost({ source, link, group, onLinkChange, render, targetRef }: {
    source: ContractInfo;
    link: FlashLink;
    /** 連動方式（main／pin／A／B／C） */
    group: string;
    onLinkChange: (next: FlashLink) => void;
    render: (contract: ContractInfo, props: FlashLinkProps) => ReactNode;
    /** 目前實際下單的合約代碼（彈出視窗用）；暫停時 null */
    targetRef?: MutableRefObject<string | null>;
}) {
    if (targetRef) targetRef.current = null;
    const show = (contract: ContractInfo, props: FlashLinkProps) => {
        if (targetRef) targetRef.current = contract.code;
        return render(contract, props);
    };
    const stockCode = link.kind === 'select' ? null : linkedStockCode(source);
    // 現股：來源是個股期時找回標的股票
    const needStock = link.kind === 'stock' && stockCode !== null && stockCode !== source.code ? stockCode : null;
    const stock = useContract(needStock);
    const [stockLoad, setStockLoad] = useState<{ code: string; ok: boolean } | null>(null);
    const stockFailed = stockLoad && !stockLoad.ok ? stockLoad.code : null;
    useEffect(() => {
        if (!needStock || stock) return;
        let active = true;
        ensureContract(needStock).then(
            () => { if (active) setStockLoad({ code: needStock, ok: true }); },
            () => { if (active) setStockLoad({ code: needStock, ok: false }); },
        );
        return () => { active = false; };
    }, [needStock, stock]);
    const fut = useStockFutures(link.kind === 'future' ? stockCode : null);
    const pick = link.kind === 'future' && fut?.status === 'ok' ? pickStockFuture(fut.rows, link, Date.now()) : null;
    useRerenderAt(pick?.status === 'ok' ? pick.expiresAt : null);
    const picked = useContract(pick?.status === 'ok' ? pick.contract.code : null) ?? (pick?.status === 'ok' ? pick.contract : undefined);

    const set = (patch: Partial<FlashLink>) => onLinkChange({ ...link, ...patch });
    const months = pick?.status === 'ok' ? pick.months : [];
    const settingsRows = (
        <>
            <SettingsSegRow label='對應商品' value={link.kind} options={KIND_OPTIONS} onPick={kind => set({ kind })} />
            {link.kind === 'future' && (pick?.status === 'ok' && pick.hasMini || link.spec === 'mini') && (
                <SettingsSegRow label='規格' value={link.spec}
                    options={[['std', '標準'], ['mini', '小型']]} onPick={spec => set({ spec })} />
            )}
            {link.kind === 'future' && (
                <SettingsSegRow label='月份' value={link.month}
                    options={[['near', '近月', months[0] && monthLabel(months[0])], ['next', '次月', months[1] && monthLabel(months[1])],
                        ...months.slice(2).map(m => [m, monthLabel(m)] as const)]}
                    onPick={month => set({ month })} />
            )}
            <SettingsSegRow label='價差對照' value={link.ref ? 'on' : 'off'}
                options={[['on', '顯示'], ['off', '隱藏']]} onPick={v => set({ ref: v === 'on' })} />
        </>
    );
    const linkKey = `${group}|${link.kind}|${link.spec}|${link.month}|${source.code}`;
    const name = `${source.code === source.name || !source.name ? source.code : source.security_type === 'STK' ? `${source.code} ${source.name}` : source.name}`;

    const empty = (icon: ReactNode, title: string, note?: string, action?: ReactNode) => (
        <div className={hostStyles.empty}>
            {icon}
            <div className={hostStyles.emptyTitle}>{title}</div>
            {note && <div className={hostStyles.emptyNote}>{note}</div>}
            {action}
        </div>
    );
    const button = (label: ReactNode, onClick: () => void) => (
        <button type='button' className={hostStyles.emptyBtn} onClick={onClick}>{label}</button>
    );

    if (link.kind === 'select') return show(source, { linkKey, settingsRows, showRef: link.ref });
    if (stockCode === null) {
        return empty(<CirclePause size={18} aria-hidden />, `${name} 不是個股`, '選一檔股票或個股期即恢復',
            button('改為照選取', () => set({ kind: 'select' })));
    }
    if (link.kind === 'stock') {
        const target = needStock ? stock : source;
        if (target) return show(target, { linkKey, settingsRows, showRef: link.ref });
        if (stockFailed === needStock) return empty(<Ban size={18} aria-hidden />, `找不到 ${needStock}`);
        return <div className={styles.waiting}>載入商品…</div>;
    }
    if (!fut || fut.status === 'loading') return <div className={styles.waiting}>載入個股期…</div>;
    if (fut.status === 'error') {
        return empty(<Ban size={18} aria-hidden />, '個股期合約載入失敗', undefined,
            button(<><RotateCw size={11} aria-hidden /> 重試</>, () => loadStockFutures(stockCode)));
    }
    if (pick?.status === 'none') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode}${source.security_type === 'STK' && source.name ? ` ${source.name}` : ''} 沒有個股期貨`, '群組換到有個股期的股票時自動恢復',
            button(<><ArrowLeftRight size={11} aria-hidden /> 改為現股</>, () => set({ kind: 'stock' })));
    }
    if (pick?.status === 'noMini') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 沒有小型個股期`, undefined,
            button('改為標準', () => set({ spec: 'std' })));
    }
    if (pick?.status === 'expired') {
        return empty(<Ban size={18} aria-hidden />, `${monthLabel(pick.month)} 合約已到期`, undefined,
            button('改為近月', () => set({ month: 'near' })));
    }
    if (pick?.status === 'unlisted') {
        return empty(<Ban size={18} aria-hidden />, `${stockCode} 沒有 ${monthLabel(pick.month)} 合約`, undefined,
            button('改為近月', () => set({ month: 'near' })));
    }
    if (pick?.status !== 'ok' || !picked) return <div className={styles.waiting}>載入個股期…</div>;
    const monthText = link.month === 'near' ? '近月' : link.month === 'next' ? '次月' : monthLabel(link.month);
    const symbolExtra = (
        <>
            <label className={styles.monthPick} title='個股期月份'>
                {monthText}
                <ChevronDown size={9} aria-hidden />
                <select className={styles.monthSelect} aria-label='個股期月份' value={link.month} onChange={e => set({ month: e.target.value })}>
                    <option value='near'>近月</option>
                    <option value='next'>次月</option>
                    {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
            </label>
            {pick.expiresToday && <span className={styles.expiryTag}>今日到期</span>}
        </>
    );
    return show(picked, { linkKey, symbolExtra, settingsRows, showRef: link.ref, expiresAt: pick.expiresAt });
}
