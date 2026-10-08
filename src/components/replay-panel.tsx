// src/components/replay-panel.tsx — 行情回放: replay today's ticks at
// adjustable speed on a self-contained line chart (great for練盤感 in sim).

import {
    ColorType,
    createChart,
    LineSeries,
    type IChartApi,
    type ISeriesApi,
    type UTCTimestamp,
} from 'lightweight-charts';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { fetchHistoryTicks } from '../lib/shioaji';
import { getChartColors, useThemeSettings, baseMode } from '../lib/theme-store';
import type { ContractInfo } from '../lib/types/contract';
import { fmtInt, fmtPrice } from '../lib/utils/format';
import { dateStrOffset, wallClockToUtc } from '../lib/utils/kbars';
import * as dock from './bottom-dock.css';
import * as styles from './replay-panel.css';
import { AsyncStatus } from './async-status';
import {
    closeReplayPosition,
    readReplayTrades,
    replayFetchDates,
    replayMultiplier,
    replayPointDiff,
    summarizeReplayTrades,
    writeReplayTrades,
    type ReplayPracticePosition,
    type ReplayPracticeTrade,
    type ReplayTradeSummary,
} from '../lib/replay-practice';

interface ReplayTick {
    time: number;
    price: number;
    volume: number;
}

const SPEEDS = [
    { label: '1x', tps: 10 },
    { label: '5x', tps: 50 },
    { label: '20x', tps: 200 },
    { label: '100x', tps: 1000 },
];

export function ReplayPanel({ contract }: { contract: ContractInfo }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const seriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const ticksRef = useRef<ReplayTick[]>([]);
    // precomputed at load so seeking is a slice, not an O(n) sort per move:
    // one point per unique second (last price wins) + tick index → point count
    const pointsRef = useRef<{ time: UTCTimestamp; value: number }[]>([]);
    const tickToPointRef = useRef<number[]>([]);
    const seekRaf = useRef(0);
    const idxRef = useRef(0);
    const [loaded, setLoaded] = useState(false);
    const [empty, setEmpty] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [speedIdx, setSpeedIdx] = useState(1);
    const [cursor, setCursor] = useState(0);
    const [selectedDate, setSelectedDate] = useState('');  // '' = 今天（期權含夜盤）
    const [loadRevision, setLoadRevision] = useState(0);
    const [quantity, setQuantity] = useState(1);
    const [position, setPosition] = useState<ReplayPracticePosition | null>(null);
    const [trades, setTrades] = useState<ReplayPracticeTrade[]>(() => readReplayTrades());
    const themeSettings = useThemeSettings();

    // chart lifecycle
    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const c = getChartColors(themeSettings);
        const chart = createChart(host, {
            layout: {
                background: { type: ColorType.Solid, color: 'transparent' },
                textColor: c.text,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: c.grid },
                horzLines: { color: c.grid },
            },
            rightPriceScale: { borderColor: c.border },
            timeScale: {
                borderColor: c.border,
                timeVisible: true,
                secondsVisible: true,
            },
            autoSize: true,
        });
        const series = chart.addSeries(LineSeries, {
            color: c.crosshair,
            lineWidth: 1,
        });
        chartRef.current = chart;
        seriesRef.current = series;
        return () => {
            chart.remove();
            chartRef.current = null;
            seriesRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
        // 只在深／淺底色改變時重建：重建會清掉已回放的線，自訂顏色微調不值得
    }, [baseMode(themeSettings)]);

    // load ticks
    useEffect(() => {
        let cancelled = false;
        setLoaded(false);
        setEmpty(false);
        setPlaying(false);
        idxRef.current = 0;
        setCursor(0);
        setPosition(null);
        ticksRef.current = [];
        const isFop =
            contract.security_type === 'FUT' ||
            contract.security_type === 'OPT';
        (async () => {
            const dates = replayFetchDates(selectedDate, isFop);
            for (const d of dates) {
                try {
                    const h = await fetchHistoryTicks(contract, d);
                    if (h.datetime.length > 0) {
                        const ticks: ReplayTick[] = [];
                        for (let i = 0; i < h.datetime.length; i++) {
                            const dt = h.datetime[i];
                            if (!dt) continue;
                            ticks.push({
                                time: wallClockToUtc(dt),
                                price: h.close[i] ?? 0,
                                volume: h.volume[i] ?? 0,
                            });
                        }
                        if (!cancelled) {
                            ticksRef.current = ticks;
                            // build the seek index
                            const points: {
                                time: UTCTimestamp;
                                value: number;
                            }[] = [];
                            const tickToPoint: number[] = new Array(
                                ticks.length,
                            );
                            for (let i = 0; i < ticks.length; i++) {
                                const t = ticks[i]!;
                                const last = points[points.length - 1];
                                if (last && last.time === t.time) {
                                    last.value = t.price;
                                } else if (!last || t.time > last.time) {
                                    points.push({
                                        time: t.time as UTCTimestamp,
                                        value: t.price,
                                    });
                                }
                                tickToPoint[i] = points.length;
                            }
                            pointsRef.current = points;
                            tickToPointRef.current = tickToPoint;
                            seriesRef.current?.setData([]);
                            setLoaded(true);
                        }
                        return;
                    }
                } catch {
                    // try next date
                }
            }
            if (!cancelled) setEmpty(true);
        })();
        return () => {
            cancelled = true;
        };
    }, [contract, selectedDate, loadRevision]);

    useEffect(() => {
        writeReplayTrades(trades);
    }, [trades]);

    // playback loop
    useEffect(() => {
        if (!playing) return;
        const tps = SPEEDS[speedIdx]?.tps ?? 50;
        const interval = setInterval(() => {
            const ticks = ticksRef.current;
            const series = seriesRef.current;
            if (!series) return;
            const batch = Math.max(1, Math.round(tps / 20));
            let lastTime = -1;
            for (let n = 0; n < batch; n++) {
                const t = ticks[idxRef.current];
                if (!t) {
                    setPlaying(false);
                    break;
                }
                // lightweight-charts requires strictly increasing times
                if (t.time > lastTime) {
                    series.update({
                        time: t.time as UTCTimestamp,
                        value: t.price,
                    });
                    lastTime = t.time;
                }
                idxRef.current += 1;
            }
            setCursor(idxRef.current);
        }, 50);
        return () => clearInterval(interval);
    }, [playing, speedIdx]);

    // slice the precomputed points; rAF-coalesced so dragging the slider
    // issues at most one setData per frame
    const seek = (idx: number) => {
        idxRef.current = idx;
        setCursor(idx);
        if (seekRaf.current) return;
        seekRaf.current = requestAnimationFrame(() => {
            seekRaf.current = 0;
            const series = seriesRef.current;
            if (!series) return;
            const i = idxRef.current;
            const count =
                i <= 0
                    ? 0
                    : (tickToPointRef.current[
                          Math.min(i, tickToPointRef.current.length) - 1
                      ] ?? 0);
            series.setData(pointsRef.current.slice(0, count));
        });
    };

    const ticks = ticksRef.current;
    const idx = cursor;
    const cur = ticks[Math.max(0, idx - 1)];
    const multiplier = replayMultiplier(contract);
    const today = dateStrOffset(0);

    const openPosition = (side: ReplayPracticePosition['side']) => {
        if (!cur || position) return;
        setPosition({ side, entry: cur.price, enteredAt: cur.time, quantity });
    };

    const closePosition = () => {
        if (!cur || !position) return;
        setTrades((old) => [...old, closeReplayPosition(position, contract.code, cur.price, cur.time, multiplier)]);
        setPosition(null);
    };

    return (
        <ReplayPanelView
            hostRef={hostRef}
            selectedDate={selectedDate}
            today={today}
            onDateChange={(v) => setSelectedDate(!v || v === today ? '' : v)}
            onReload={() => setLoadRevision((v) => v + 1)}
            loaded={loaded}
            empty={empty}
            playing={playing}
            onTogglePlay={() => {
                if (idx >= ticks.length) seek(0);
                setPlaying((p) => !p);
            }}
            speedIdx={speedIdx}
            onSpeed={setSpeedIdx}
            cursor={idx}
            tickCount={ticks.length}
            curPrice={cur?.price}
            onSeek={seek}
            code={contract.code}
            isStock={contract.security_type === 'STK'}
            multiplier={multiplier}
            quantity={quantity}
            onQuantity={setQuantity}
            position={position}
            summary={summarizeReplayTrades(trades, contract.code)}
            onOpen={openPosition}
            onClose={closePosition}
        />
    );
}

export interface ReplayPanelViewProps {
    hostRef: RefObject<HTMLDivElement | null>;
    // '' 代表預設「今天（期權含夜盤）」
    selectedDate: string;
    today: string;
    onDateChange: (date: string) => void;
    onReload: () => void;
    loaded: boolean;
    empty: boolean;
    playing: boolean;
    onTogglePlay: () => void;
    speedIdx: number;
    onSpeed: (idx: number) => void;
    cursor: number;
    tickCount: number;
    curPrice: number | undefined;
    onSeek: (idx: number) => void;
    code: string;
    isStock: boolean;
    multiplier: number;
    quantity: number;
    onQuantity: (qty: number) => void;
    position: ReplayPracticePosition | null;
    summary: ReplayTradeSummary;
    onOpen: (side: ReplayPracticePosition['side']) => void;
    onClose: () => void;
}

function signed(v: number, fmt: (n: number) => string): string {
    return `${v >= 0 ? '+' : ''}${fmt(v)}`;
}

// 純呈現：沒有資料時日期列與重新載入仍在，使用者可以直接換日期
export function ReplayPanelView(p: ReplayPanelViewProps) {
    const unit = p.isStock ? '張' : '口';
    const pointUnit = p.isStock ? '元' : '點';
    const dateLabel = p.selectedDate || '今天';
    const diff =
        p.position && p.curPrice !== undefined ? replayPointDiff(p.position, p.curPrice) : 0;
    const floatingPnl = p.position ? diff * p.position.quantity * p.multiplier : 0;
    const canTrade = p.loaded && p.curPrice !== undefined && p.cursor > 0;
    return (
        <div className={styles.wrap}>
            <div className={styles.controls}>
                <input
                    className={styles.dateInput}
                    type='date'
                    value={p.selectedDate || p.today}
                    max={p.today}
                    onChange={(e) => p.onDateChange(e.target.value)}
                    aria-label='回放日期'
                    title={p.selectedDate ? '回放日期' : '回放日期（今天，期權含夜盤）'}
                />
                <button
                    className={styles.speed.off}
                    onClick={p.onReload}
                    title='重新載入指定日期'
                    aria-label='重新載入指定日期'
                >
                    <RotateCcw size={11} />
                </button>
                <button
                    className={styles.playBtn}
                    disabled={!p.loaded}
                    onClick={p.onTogglePlay}
                >
                    {p.playing ? (
                        <>
                            <Pause size={11} style={{ verticalAlign: '-1px' }} /> 暫停
                        </>
                    ) : (
                        <>
                            <Play size={11} style={{ verticalAlign: '-1px' }} /> 播放
                        </>
                    )}
                </button>
                {SPEEDS.map((sp, i) => (
                    <button
                        key={sp.label}
                        className={styles.speed[i === p.speedIdx ? 'on' : 'off']}
                        onClick={() => p.onSpeed(i)}
                    >
                        {sp.label}
                    </button>
                ))}
                <input
                    type='range'
                    className={styles.seek}
                    min={0}
                    max={p.tickCount}
                    value={p.cursor}
                    disabled={!p.loaded}
                    onChange={(e) => p.onSeek(Number(e.target.value))}
                    aria-label='回放進度'
                />
                <span className={styles.status}>
                    {p.empty
                        ? '無資料'
                        : p.loaded
                          ? p.curPrice !== undefined && p.cursor > 0
                              ? `${fmtPrice(p.curPrice)} · ${fmtInt(p.cursor)}/${fmtInt(p.tickCount)}`
                              : `${fmtInt(p.tickCount)} ticks`
                          : (
                                <AsyncStatus phase='loading' size={10} text='載入重播資料…' />
                            )}
                </span>
            </div>
            <div className={styles.chartArea}>
                <div ref={p.hostRef} className={styles.chartHost} />
                {p.empty && (
                    <div className={`${dock.emptyState} ${styles.emptyOverlay}`} role='status'>
                        {dateLabel} 無可回放的歷史成交，請在上方換日期
                    </div>
                )}
            </div>
            <div className={styles.practice}>
                <div className={styles.practiceStatus}>
                    <strong>SIM 練習</strong>
                    <span>
                        {p.position
                            ? `${p.position.side === 'long' ? '多' : '空'} ${p.position.quantity} ${unit} @ ${fmtPrice(p.position.entry)}`
                            : '空手'}
                    </span>
                    <span>
                        浮動 {signed(diff, fmtPrice)} {pointUnit}
                        {p.position ? ` × ${p.position.quantity} ${unit} ≈ ${signed(floatingPnl, fmtInt)}` : ''}
                    </span>
                    <span>
                        {p.code} 累計估算 {signed(p.summary.estimatedPnl, fmtInt)}（{fmtInt(p.summary.count)} 筆）
                    </span>
                </div>
                <div className={styles.practiceActions}>
                    <label>
                        {unit}數{' '}
                        <input
                            type='number'
                            min={1}
                            max={100}
                            value={p.quantity}
                            onChange={(e) =>
                                p.onQuantity(Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))))
                            }
                        />
                    </label>
                    <button className={styles.practiceBuy} disabled={!canTrade || !!p.position} onClick={() => p.onOpen('long')}>
                        模擬買進
                    </button>
                    <button className={styles.practiceSell} disabled={!canTrade || !!p.position} onClick={() => p.onOpen('short')}>
                        模擬賣出
                    </button>
                    <button className={styles.practiceFlat} disabled={!canTrade || !p.position} onClick={p.onClose}>
                        模擬平倉
                    </button>
                </div>
                <div className={styles.practiceNote}>
                    僅本機歷史練習，不呼叫下單、撤單或任何券商交易 API。估算乘數{' '}
                    {p.isStock ? `每張 ${fmtInt(p.multiplier)} 股` : fmtInt(p.multiplier)}；累計依商品分開計算。
                </div>
            </div>
        </div>
    );
}
