import '../lib/polyfills';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../index.css';
import { initTheme } from '../lib/theme-store';
import { FlashOrder } from '../components/flash-order';
import { PanelChrome } from '../components/panel-chrome';
import * as panel from '../components/panel.css';
import type { ContractInfo } from '../lib/types/contract';
import type { FlashLot } from '../lib/flash-account';

initTheme();
const mk = (code: string, name: string, ref: number): ContractInfo => ({
    code, name, symbol: `TSE${code}`, exchange: 'TSE', security_type: 'STK', category: '24', unit: 1000,
    reference: ref, limit_up: Math.round(ref * 1.1), limit_down: Math.round(ref * 0.9), currency: 'TWD',
    update_date: '2026/10/08', day_trade: 'Yes', margin_trading_balance: 0, short_selling_balance: 0, target_code: '',
} as unknown as ContractInfo);
const CONTRACTS: Record<string, ContractInfo> = { '2330': mk('2330', '台積電', 1080), '2317': mk('2317', '鴻海', 210) };
// simulated workspace blocks: each panel's flashLot lives on its block
const KEY = 'shot-blocks';
type Blk = { id: string; flashLot?: FlashLot };
const load = (): Blk[] => { try { return JSON.parse(localStorage.getItem(KEY) ?? '') as Blk[]; } catch { return [{ id: 'flash-a' }, { id: 'flash-b' }]; } };

function Shot() {
    const [code, setCode] = useState(() => new URLSearchParams(location.search).get('code') ?? '2330');
    const [blocks, setBlocks] = useState(load);
    useEffect(() => { (window as unknown as { __select: (c: string) => void }).__select = setCode; }, []);
    const contract = CONTRACTS[code]!;
    return (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, padding: 6, height: '100vh', boxSizing: 'border-box', background: 'var(--bg, #0b0e13)' }}>
            {blocks.map(b => (
                <section key={b.id} className={panel.panel}>
                    <PanelChrome title='閃電下單' symbolCode={contract.code} pinnable pin={null} currentCode={code} onPinChange={() => undefined} />
                    <FlashOrder contract={contract} trades={[]} positions={[]} lot={b.flashLot}
                        onLotChange={lot => setBlocks(prev => { const next = prev.map(x => x.id === b.id ? { ...x, flashLot: lot } : x); localStorage.setItem(KEY, JSON.stringify(next)); return next; })} />
                </section>
            ))}
        </div>
    );
}
createRoot(document.getElementById('root')!).render(<StrictMode><Shot /></StrictMode>);
