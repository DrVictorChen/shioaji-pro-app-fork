// src/components/odd-spread.tsx — 整零價差面板（整股 vs 盤中零股）。
//
// 上方兩張卡各算一個方向（買整→賣零、買零→賣整）的毛價差、扣費後淨價差、
// 往下吃檔的加權淨價差與預估損益；中間是共用價格欄的兩市場五檔，點量＝
// 在該市場下限價（同閃電下單：要先啟用點價、依設定跳委託確認）；下方設定
// 張數／股數、送單方式、手續費折數與證交稅率，送出兩腳價差單。
//
// 試算：lib/odd-spread；兩腳送單狀態機：lib/odd-spread-exec；
// 行情轉接：hooks/use-odd-spread-feed（零股行情接上前見該檔 TODO）。

import { Link2, Link2Off } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccounts, ensureAccounts } from '../lib/account-store';
import { scopedFlashRows, accountMatches } from '../lib/flash-account';
import { useTradingLive } from '../hooks/use-stream';
import { useOddSpreadFeed, type OddSpreadFeed } from '../hooks/use-odd-spread-feed';
import { useOddSpreadExec, type SpreadExecution } from '../hooks/use-odd-spread-exec';
import { ODD_LOT_MAX_SHARES, SHARES_PER_LOT } from '../lib/odd-lot';
import {
    BLOCK_LABEL,
    buildSpreadLadder,
    DIRECTION_LABEL,
    DIRECTION_PATH_LABEL,
    loadOddSpreadPrefs,
    quoteBoth,
    saveOddSpreadPrefs,
    sliceOddOrders,
    type OddSpreadPrefs,
    type SpreadDirection,
    type SpreadQuote,
} from '../lib/odd-spread';
import { execSummary, isTerminalPhase, PHASE_LABEL, type ExecMode, type ExecPlan } from '../lib/odd-spread-exec';
import { requestOrderConfirm, accountConfirmLabel } from '../lib/order-confirm';
import { maskMoney, usePrivacyMoney } from '../lib/privacy';
import { getRiskSettings } from '../lib/risk';
import { notify, OrderConfirmCancelled, placeQuickOrder } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import type { Action, Trade } from '../lib/types/order';
import type { Account, AccountedPosition } from '../lib/types/portfolio';
import { stockTaxRate } from '../lib/utils/contract-cost';
import { fmtPrice } from '../lib/utils/format';
import { stepPrice } from '../lib/utils/ticksize';
import * as styles from './odd-spread.css';

const DIRECTIONS: SpreadDirection[] = ['buyRoundSellOdd', 'buyOddSellRound'];
const LADDER_ROWS = 15;

const int = (v: number) => Math.round(v).toLocaleString('en-US');
const signed = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const toneOf = (v: number | null) => (v === null || v === 0 ? 'flat' : v > 0 ? 'pos' : 'neg');
const chgTone = (v: number | null) => (v === null || v === 0 ? 'flat' : v > 0 ? 'up' : 'down');
const chgText = (v: number | null) => (v === null ? '' : `${v > 0 ? '▲' : v < 0 ? '▼' : ''}${fmtPrice(Math.abs(v), 0)}`);

/** 可賣現股庫存（股）：此帳戶、此商品、現股多單 */
export function cashInventoryShares(positions: AccountedPosition[], code: string): number {
    return positions
        .filter(p => p.code === code && p.direction === 'Buy' && (!('cond' in p) || !p.cond || p.cond === 'Cash'))
        .reduce((a, p) => a + p.quantity, 0);
}

export interface OddSpreadViewProps {
    contract: ContractInfo;
    feed: OddSpreadFeed;
    /** 可賣現股庫存（股）；null＝未知 */
    inventoryShares: number | null;
    live: boolean;
    account: Account | undefined;
    execution: SpreadExecution;
    onOrdersChanged?: () => void;
    /** 測試與截圖用：初始張數 */
    initialLots?: number;
}

export function OddSpread(props: {
    contract: ContractInfo;
    snapshot?: Snapshot;
    trades?: Trade[];
    positions?: AccountedPosition[];
    onOrdersChanged?: () => void;
}) {
    const { contract, snapshot, trades = [], positions = [], onOrdersChanged } = props;
    const feed = useOddSpreadFeed(contract, snapshot);
    const live = useTradingLive();
    const accountState = useAccounts();
    useEffect(ensureAccounts, []);
    const account = accountState.selectedStock ?? undefined;
    const scopedTrades = scopedFlashRows(trades, account);
    const scopedPositions = scopedFlashRows(positions, account);
    const inventoryShares = accountState.loaded && account ? cashInventoryShares(scopedPositions, contract.code) : null;
    const execution = useOddSpreadExec({ contract, account, trades: scopedTrades, onOrdersChanged });
    return (
        <OddSpreadView
            contract={contract}
            feed={feed}
            inventoryShares={inventoryShares}
            live={live}
            account={account}
            execution={execution}
            onOrdersChanged={onOrdersChanged}
        />
    );
}

export function OddSpreadView({ contract, feed, inventoryShares, live, account, execution, onOrdersChanged, initialLots = 1 }: OddSpreadViewProps) {
    const privMoney = usePrivacyMoney();
    const [lots, setLots] = useState(initialLots);
    const [oddShares, setOddShares] = useState(initialLots * SHARES_PER_LOT);
    const [paired, setPaired] = useState(true);
    const [mode, setMode] = useState<ExecMode>('sequential');
    const [prefs, setPrefs] = useState<OddSpreadPrefs>(loadOddSpreadPrefs);
    const [discountText, setDiscountText] = useState(() => String(Math.round(prefs.discount * 100) / 10));
    const [taxText, setTaxText] = useState<string | null>(null);
    const [armed, setArmed] = useState(false);
    const inflight = useRef(new Set<string>());

    const taxRate = prefs.taxRate ?? stockTaxRate(contract);
    const fees = useMemo(() => ({ discount: prefs.discount, taxRate }), [prefs.discount, taxRate]);
    const effOdd = paired ? lots * SHARES_PER_LOT : oddShares;

    useEffect(() => { setArmed(false); }, [contract.code, account?.account_id]);
    useEffect(() => { if (!live) setArmed(false); }, [live]);

    const updatePrefs = (p: OddSpreadPrefs) => {
        setPrefs(p);
        saveOddSpreadPrefs(p);
    };

    const quotes = useMemo(
        () => quoteBoth({ round: feed.round, odd: feed.odd, lots, oddShares: effOdd, fees, inventoryShares }),
        [feed.round, feed.odd, lots, effOdd, fees, inventoryShares],
    );

    const ladder = useMemo(
        () => buildSpreadLadder(feed.round, feed.odd, {
            roundLast: feed.roundLast,
            oddLast: feed.oddLast,
            step: (p, dir) => stepPrice(contract, p, dir),
            maxRows: LADDER_ROWS,
        }),
        [feed.round, feed.odd, feed.roundLast, feed.oddLast, contract],
    );

    const exec = execution.exec;
    const running = !!exec && exec.started && !isTerminalPhase(exec.phase);

    const blockText = (q: SpreadQuote): string | null => {
        if (!feed.oddAvailable && q.block === 'noQuote') return '零股行情尚未接上';
        if (!live) return '行情或交易狀態未連線';
        if (!account) return '沒有可用的證券帳戶';
        if (running) return '價差單執行中';
        if (q.block === 'inventory' && inventoryShares === null) return '庫存未知';
        return q.block ? BLOCK_LABEL[q.block] : null;
    };

    const execute = useCallback(async (q: SpreadQuote) => {
        if (!q.canExecute || !q.buyLeg || !q.sellLeg || !account || running) return;
        const oddLeg = q.direction === 'buyOddSellRound' ? q.buyLeg : q.sellLeg;
        const roundLeg = q.direction === 'buyOddSellRound' ? q.sellLeg : q.buyLeg;
        const roundPrice = roundLeg.orders[0]?.price;
        if (roundPrice === undefined) return;
        const plan: ExecPlan = { direction: q.direction, mode, lots: q.lots, roundPrice, oddOrders: oddLeg.orders };
        const levels = oddLeg.fills.map(f => `${fmtPrice(f.price)}×${int(f.shares)}`).join('、');
        if (getRiskSettings().confirmManualOrders) {
            try {
                const ok = await requestOrderConfirm({
                    code: contract.code,
                    name: contract.name,
                    action: q.direction === 'buyRoundSellOdd' ? 'Buy' : 'Sell',
                    price: roundPrice,
                    priceLabel: `整股 ${fmtPrice(roundPrice)}／零股 ${levels}`,
                    quantity: q.lots,
                    unit: '張',
                    accountLabel: accountConfirmLabel(account),
                    note: `整零價差 ${DIRECTION_LABEL[q.direction]}：整股 ${q.lots} 張 ↔ 零股 ${int(q.oddShares)} 股（${oddLeg.orders.length} 筆）；${mode === 'sequential' ? '零股全部成交後再送整股' : '兩腳同時送'}`,
                });
                if (!ok) return;
            } catch (e) {
                notify({ kind: 'err', title: '整零價差未送出', body: e instanceof Error ? e.message : String(e) });
                return;
            }
        }
        execution.start(plan);
    }, [account, running, mode, contract, execution]);

    // 點量下單：同閃電下單，要先啟用點價；依設定跳委託確認
    const placeAt = useCallback(async (market: 'round' | 'odd', action: Action, price: number) => {
        if (!armed || !account) return;
        const key = `${market}:${action}:${price}`;
        if (inflight.current.has(key)) return;
        inflight.current.add(key);
        const captured = account;
        const isAccountCurrent = () => accountMatches(account, captured);
        try {
            if (market === 'round') {
                await placeQuickOrder(contract, action, price, lots, { account: captured, isAccountCurrent });
            } else {
                const slices = sliceOddOrders([{ price, shares: effOdd }]);
                if (slices.length > 1 && getRiskSettings().confirmManualOrders) {
                    const ok = await requestOrderConfirm({
                        code: contract.code, name: contract.name, action, price, quantity: effOdd, unit: '股',
                        accountLabel: accountConfirmLabel(captured),
                        note: `盤中零股・限價 ROD；每筆上限 ${ODD_LOT_MAX_SHARES} 股，拆為 ${slices.length} 筆`,
                    });
                    if (!ok) throw new OrderConfirmCancelled();
                }
                for (const s of slices) {
                    await placeQuickOrder(contract, action, s.price, s.quantity, {
                        account: captured,
                        orderLot: 'IntradayOdd',
                        isAccountCurrent,
                        source: slices.length > 1 ? 'auto' : 'manual',
                    });
                }
            }
            notify({
                kind: 'ok',
                title: `${market === 'odd' ? '零股' : '整股'}${action === 'Buy' ? '買進' : '賣出'}已送出`,
                body: `${contract.code} ${market === 'odd' ? `${int(effOdd)} 股` : `${lots} 張`} @ ${fmtPrice(price)}`,
            });
            onOrdersChanged?.();
        } catch (e) {
            if (!(e instanceof OrderConfirmCancelled)) {
                notify({ kind: 'err', title: '整零價差點價下單失敗', body: e instanceof Error ? e.message : String(e) });
            }
        } finally {
            inflight.current.delete(key);
        }
    }, [armed, account, contract, lots, effOdd, onOrdersChanged]);

    const invLots = inventoryShares === null ? null : Math.floor(inventoryShares / SHARES_PER_LOT);
    const invOdd = inventoryShares === null ? null : inventoryShares % SHARES_PER_LOT;

    return (
        <div className={styles.wrap}>
            <div className={styles.symbolRow}>
                <span className={styles.symbolName}>{contract.name || contract.code}</span>
                <span className={styles.quoteMeta}>
                    <span className={styles.quoteItem}>
                        整股 <span className={styles.quoteVal}>{feed.roundLast !== null ? fmtPrice(feed.roundLast) : '—'}</span>
                        <span className={styles.chg[chgTone(feed.roundChange)]}>{chgText(feed.roundChange)}</span>
                    </span>
                    <span className={styles.quoteItem}>
                        零股 <span className={styles.quoteVal}>{feed.oddLast !== null ? fmtPrice(feed.oddLast) : '—'}</span>
                        <span className={styles.chg[chgTone(feed.oddChange)]}>{chgText(feed.oddChange)}</span>
                    </span>
                    <span className={styles.quoteItem} title='盤中零股約每 5 秒撮合一次'>
                        零股撮合 <span className={styles.quoteVal}>{feed.oddTime ?? '—'}</span>
                    </span>
                </span>
            </div>
            {!feed.oddAvailable && (
                <div className={styles.notice}>零股行情尚未接上：目前只顯示整股五檔，價差試算與送出暫停</div>
            )}
            <div className={styles.cards}>
                {DIRECTIONS.map(d => (
                    <SpreadCard
                        key={d}
                        q={quotes[d]}
                        blocked={blockText(quotes[d])}
                        privMoney={privMoney}
                        onExecute={() => void execute(quotes[d])}
                    />
                ))}
            </div>
            <div className={styles.ladderHead}>
                <span className={styles.groupCell}>整股（張）</span>
                <button
                    className={styles.armBtn[armed ? 'on' : 'off']}
                    disabled={!live || !account}
                    title={armed ? '點價下單中 — 點擊或 Esc 鎖定' : '啟用後點左側量＝整股限價、右側量＝零股限價'}
                    onClick={() => setArmed(a => !a)}
                >
                    {armed ? '點價中' : '啟用點價'}
                </button>
                <span className={styles.groupCell}>零股（股）</span>
                <span className={styles.headCell}>買量</span>
                <span className={styles.headCell}>賣量</span>
                <span className={styles.headCell}>價格</span>
                <span className={styles.headCell}>買量</span>
                <span className={styles.headCell}>賣量</span>
            </div>
            <ArmEscape armed={armed} onDisarm={() => setArmed(false)} />
            <div className={styles.ladderBody}>
                {ladder.length === 0 && <div className={styles.empty}>等待報價…</div>}
                {ladder.map(r => {
                    const cell = (market: 'round' | 'odd', side: 'bid' | 'ask', vol: number | undefined) => {
                        const action: Action = side === 'bid' ? 'Buy' : 'Sell';
                        const unit = market === 'odd' ? `${int(effOdd)} 股` : `${lots} 張`;
                        return (
                            <span
                                className={`${styles.volCell[side]} ${armed ? styles.volLive[side] : ''} ${market === 'odd' && side === 'bid' ? styles.oddSep : ''}`}
                                title={armed ? `${market === 'odd' ? '零股' : '整股'}限價${action === 'Buy' ? '買' : '賣'} ${unit} @ ${fmtPrice(r.price)}` : '先啟用點價'}
                                onClick={() => void placeAt(market, action, r.price)}
                            >
                                {vol ? int(vol) : ''}
                            </span>
                        );
                    };
                    return (
                        <div key={r.price} className={styles.ladderRow[r.cross ? 'cross' : 'normal']}>
                            {cell('round', 'bid', r.roundBid)}
                            {cell('round', 'ask', r.roundAsk)}
                            <span className={styles.priceCell[r.cross ? 'cross' : 'normal']}>
                                {fmtPrice(r.price)}
                                {r.oddLast && <span className={styles.mark.odd} title='零股最後成交價'>零</span>}
                                {r.roundLast && <span className={styles.mark.round} title='整股最後成交價'>整</span>}
                            </span>
                            {cell('odd', 'bid', r.oddBid)}
                            {cell('odd', 'ask', r.oddAsk)}
                        </div>
                    );
                })}
            </div>
            <div className={styles.footer}>
                <div className={styles.fRow}>
                    <span className={styles.fLabel}>整股</span>
                    <input
                        className={styles.input}
                        aria-label='整股張數'
                        inputMode='numeric'
                        value={lots}
                        onChange={e => {
                            const v = Number(e.target.value);
                            if (Number.isInteger(v) && v >= 0 && v <= 999) setLots(v);
                        }}
                    />
                    <span>張</span>
                    <button
                        className={styles.lockBtn[paired ? 'on' : 'off']}
                        aria-pressed={paired}
                        title={paired ? '配對中：1 張 = 1,000 股。點擊解除，分開設定零股股數' : '已解除配對。點擊恢復 1 張 = 1,000 股'}
                        onClick={() => {
                            if (!paired) setOddShares(lots * SHARES_PER_LOT);
                            setPaired(p => !p);
                        }}
                    >
                        {paired ? <Link2 size={12} /> : <Link2Off size={12} />}配對
                    </button>
                    <span className={styles.fLabel}>零股</span>
                    <input
                        className={styles.input}
                        aria-label='零股股數'
                        inputMode='numeric'
                        disabled={paired}
                        value={paired ? int(effOdd) : oddShares}
                        onChange={e => {
                            const v = Number(e.target.value.replace(/,/g, ''));
                            if (Number.isInteger(v) && v >= 0 && v <= 999_000) setOddShares(v);
                        }}
                    />
                    <span>股</span>
                    <span className={styles.inventory} title='可賣現股庫存（此帳戶）'>
                        庫存 {invLots === null ? '—' : `整 ${int(invLots)} 張／零 ${int(invOdd ?? 0)} 股`}
                    </span>
                </div>
                <div className={styles.fRow}>
                    <span className={styles.fLabel}>送單方式</span>
                    <select className={styles.select} aria-label='送單方式' value={mode} onChange={e => setMode(e.target.value as ExecMode)}>
                        <option value='sequential'>零股成交後再送整股</option>
                        <option value='simultaneous'>兩腳同時送</option>
                    </select>
                    <span className={styles.fLabel}>手續費</span>
                    <input
                        className={styles.inputNarrow}
                        aria-label='手續費折數'
                        title='券商手續費折數（6 折填 6、2.8 折填 2.8、無折扣填 10）'
                        value={discountText}
                        onChange={e => {
                            setDiscountText(e.target.value);
                            const z = Number(e.target.value);
                            if (Number.isFinite(z) && z > 0 && z <= 10) updatePrefs({ ...prefs, discount: Math.round(z * 1000) / 10_000 });
                        }}
                    />
                    <span>折</span>
                    <span className={styles.fLabel}>證交稅</span>
                    <input
                        className={styles.inputNarrow}
                        aria-label='證交稅率（%）'
                        title='賣出證交稅率（%）：一般股票 0.3、當沖 0.15、ETF 0.1'
                        value={taxText ?? String(Math.round(taxRate * 100_000) / 1000)}
                        onChange={e => {
                            setTaxText(e.target.value);
                            const t = Number(e.target.value);
                            if (e.target.value !== '' && Number.isFinite(t) && t >= 0 && t <= 1) updatePrefs({ ...prefs, taxRate: Math.round(t * 10_000) / 1_000_000 });
                        }}
                        onBlur={() => setTaxText(null)}
                    />
                    <span>%</span>
                </div>
                {exec && exec.started && <ExecStatus execution={execution} />}
                <div className={styles.btns}>
                    {DIRECTIONS.map(d => {
                        const q = quotes[d];
                        const blocked = blockText(q);
                        const on = q.canExecute && !blocked;
                        const text = d === 'buyRoundSellOdd'
                            ? `買整賣零　${lots} 張 ↔ ${int(effOdd)} 股`
                            : `買零賣整　${int(effOdd)} 股 ↔ ${lots} 張`;
                        return (
                            <button
                                key={d}
                                className={styles.bigBtn[on ? 'on' : 'off']}
                                disabled={!on}
                                title={blocked ?? `${DIRECTION_LABEL[d]}：加權淨價差 ${signed(q.weightedNetPerShare ?? 0)} 元/股`}
                                onClick={() => void execute(q)}
                            >
                                {text}
                            </button>
                        );
                    })}
                </div>
            </div>
            <div className={styles.note}>
                點左側量＝整股限價、點右側量＝零股限價（同閃電下單）· 黃底為可套利價位：零股買價高於整股賣價，或零股賣價低於整股買價
            </div>
        </div>
    );
}

function ArmEscape({ armed, onDisarm }: { armed: boolean; onDisarm: () => void }) {
    useEffect(() => {
        if (!armed) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDisarm(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [armed, onDisarm]);
    return null;
}

function SpreadCard({ q, blocked, privMoney, onExecute }: { q: SpreadQuote; blocked: string | null; privMoney: boolean; onExecute: () => void }) {
    const on = q.canExecute && !blocked;
    const oddLeg = q.direction === 'buyOddSellRound' ? q.buyLeg : q.sellLeg;
    // 量不足或價差未達成本時不列可做量／損益（與設計稿一致）
    const showPlan = q.block === null || q.block === 'inventory';
    const levels = oddLeg?.fills.map(f => `${fmtPrice(f.price)}×${int(f.shares)}`).join('、');
    return (
        <div className={styles.card[on ? 'good' : 'idle']}>
            <div className={styles.cardTitle}>
                {DIRECTION_LABEL[q.direction]}
                <span className={styles.cardHint}>{DIRECTION_PATH_LABEL[q.direction]}</span>
            </div>
            <div className={styles.cardPath}>
                {q.buyPrice !== null ? fmtPrice(q.buyPrice) : '—'} → {q.sellPrice !== null ? fmtPrice(q.sellPrice) : '—'}
            </div>
            <div className={`${styles.big} ${styles.tone[toneOf(q.grossPerShare)]}`}>
                {q.grossPerShare !== null ? signed(q.grossPerShare) : '—'}
                {q.grossBps !== null && (
                    <span className={styles.bigUnit}>元/股 · {q.grossBps > 0 ? '' : q.grossBps < 0 ? '−' : ''}{int(Math.abs(q.grossBps))} bps</span>
                )}
            </div>
            <div className={styles.kv}>
                <span className={styles.kvKey}>扣手續費、稅</span>
                <span className={`${styles.kvVal} ${styles.tone[toneOf(q.netPerShare)]}`}>
                    {q.netPerShare !== null ? `${signed(q.netPerShare)} 元/股` : '—'}
                </span>
                <span className={styles.kvKey}>可做量</span>
                <span className={styles.kvVal}>
                    {showPlan && levels ? (
                        <>
                            {q.lots} 張 <span className={styles.kvSub}>（零股 {levels}）</span>
                            {q.maxLots > q.lots && <span className={styles.kvSub}> · 最多 {q.maxLots} 張</span>}
                        </>
                    ) : '—'}
                </span>
                {showPlan && q.weightedNetPerShare !== null && (
                    <>
                        <span className={styles.kvKey}>加權淨價差</span>
                        <span className={`${styles.kvVal} ${styles.tone[toneOf(q.weightedNetPerShare)]}`}>{signed(q.weightedNetPerShare)} 元/股</span>
                    </>
                )}
                <span className={styles.kvKey}>預估損益</span>
                <span className={`${styles.kvVal} ${showPlan && q.pnl !== null ? styles.tone[toneOf(q.pnl)] : ''}`}>
                    {showPlan && q.pnl !== null ? maskMoney(`${signed(q.pnl, 0)} 元`, privMoney) : '—'}
                </span>
            </div>
            <button className={styles.goBtn[on ? 'on' : 'off']} disabled={!on} onClick={onExecute}>
                {on ? `以 ${q.lots} 張執行` : blocked ?? '無法執行'}
            </button>
        </div>
    );
}

function ExecStatus({ execution }: { execution: SpreadExecution }) {
    const exec = execution.exec;
    if (!exec) return null;
    const sum = execSummary(exec);
    const done = isTerminalPhase(exec.phase);
    return (
        <div className={styles.execBar} role='status'>
            <span className={styles.execPhase}>{DIRECTION_LABEL[exec.plan.direction]} · {PHASE_LABEL[exec.phase]}</span>
            <span className={styles.execNums}>
                零股 {int(sum.oddFilledShares)}/{int(sum.oddPlannedShares)} 股 · 整股 {sum.roundFilledLots}/{exec.plan.lots} 張
            </span>
            {done && sum.unhedgedShares !== 0 && (
                <span title='零股成交股數與整股成交股數的差額，需自行處理'>
                    未配對 {sum.unhedgedShares > 0 ? '零股多' : '整股多'} {int(Math.abs(sum.unhedgedShares))} 股
                </span>
            )}
            {done ? (
                <button className={styles.smallBtn} onClick={execution.dismiss}>關閉</button>
            ) : (
                <button
                    className={styles.smallBtn}
                    title='刪除未成交的委託；已成交的零股會以整張配對送出整股，不足一張列為未配對'
                    onClick={execution.cancel}
                >
                    取消剩餘
                </button>
            )}
        </div>
    );
}
