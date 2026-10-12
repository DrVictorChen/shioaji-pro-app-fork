// scripts/flash-demo/main.tsx — three flash panels on sample data (#216):
// 自動停損停利 on with protection on the ladder, 觸價模式, and the settings.
import '../../src/lib/polyfills';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import { FlashOrder } from '../../src/components/flash-order';
import type { FlashOrderOpts } from '../../src/lib/flash-account';
import { setPrivacyMode, setPrivacyMoney } from '../../src/lib/privacy';
import { initTheme, setThemeSettings } from '../../src/lib/theme-store';
import type { ContractInfo } from '../../src/lib/types/contract';

const params = new URLSearchParams(location.search);
initTheme();
setThemeSettings({ mode: params.get('theme') === 'light' ? 'light' : 'dark' });
// screenshots are taken with privacy mode on (account and money masked)
setPrivacyMode(params.get('privacy') !== 'off');
setPrivacyMoney(params.get('privacy') !== 'off');

const txf = { code: 'TXFR1', target_code: 'TXFJ6', name: '臺股期貨 10月', symbol: 'TXFR1', security_type: 'FUT', exchange: 'TAIFEX',
    category: 'TXF', currency: 'TWD', limit_up: 53033, limit_down: 43391, reference: 48212, tick: 1, multiplier: 200,
    delivery_month: '202610', delivery_date: '2026/10/21', update_date: '2026/10/12', day_trade: 'Yes' } as unknown as ContractInfo;
const account = { account_type: 'F' as const, broker_id: 'F002000', account_id: '9804567', person_id: '', signed: true, username: '示範帳戶' };
const long2 = [{ account, id: 1, code: 'TXFR1', direction: 'Buy' as const, quantity: 2, price: 48205, last_price: 48212, pnl: 2800 }];
const protectOn: FlashOrderOpts = { orderType: 'ROD', octype: 'Auto', futuresPriceType: 'MKT',
    protect: { on: true, stopTicks: 4, takeTicks: 12, trail: { activateTicks: 8, distanceTicks: 4, stepTicks: 1 } } };

function Panel({ title, order, width = 300 }: { title: string; order: FlashOrderOpts; width?: number }) {
    return (
        <section style={{ width, height: 820, display: 'flex', flexDirection: 'column', border: '1px solid var(--demo-border, rgba(127,127,127,.35))', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ fontSize: 11, padding: '4px 8px', opacity: 0.7 }}>{title}</div>
            <div style={{ flex: 1, minHeight: 0 }}>
                <FlashOrder contract={txf} positions={long2} trades={[]} orderOpts={order} onOrderOptsChange={() => undefined} />
            </div>
        </section>
    );
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'flex-start', background: 'var(--sj-bg, transparent)' }} data-demo-root>
            <Panel title='A 觸價欄（推薦）：觸買｜買單｜買量｜價格｜賣量｜賣單｜觸賣' order={protectOn} />
            <Panel title='A 觸價欄・齒輪設定' order={protectOn} />
            <Panel title='B Alt＋點（不加欄，窄面板）' order={{ ...protectOn, triggerLayout: 'modifier' }} width={260} />
        </div>
    </StrictMode>,
);
