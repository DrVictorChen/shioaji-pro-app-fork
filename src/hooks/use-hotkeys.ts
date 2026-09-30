// src/hooks/use-hotkeys.ts — global trading hotkeys.
// B/S: switch order tickets to buy/sell · Esc Esc: cancel all orders
// (opt-in via 風控 settings, default off) · Cmd/Ctrl+K: symbol palette.
// Ignored while typing in form fields.

import { useEffect } from 'react';
import { noteEscPress, resetEscCancelArm } from '../lib/esc-cancel-arm';
import { getRiskSettings } from '../lib/risk';
import { cancelAllOrders, notify } from '../lib/trade';

export const TICKET_ACTION_EVENT = 'sj-ticket-action';

function isTyping(): boolean {
    const el = document.activeElement;
    return (
        !!el &&
        (el.tagName === 'INPUT' ||
            el.tagName === 'TEXTAREA' ||
            el.tagName === 'SELECT')
    );
}

export function useHotkeys({
    onOpenPalette,
    onAfterCancelAll,
}: {
    onOpenPalette: () => void;
    onAfterCancelAll: () => void;
}) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            // OS key auto-repeat must never count — holding Esc a beat too
            // long would otherwise arm AND fire cancel-all in one press
            if (e.repeat) return;
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                onOpenPalette();
                return;
            }
            if (isTyping()) return;
            if (e.key === 'Escape') {
                // dialogs／畫圖工具 claim their Esc via preventDefault — that
                // press must not arm the cancel-all window, and it also
                // disarms a pending first press (Esc, 畫圖 Esc, Esc ≠ Esc×2)
                if (e.defaultPrevented) {
                    resetEscCancelArm();
                    return;
                }
                if (!getRiskSettings().escCancelAll) return;
                if (noteEscPress(performance.now())) {
                    void cancelAllOrders().then(onAfterCancelAll);
                } else {
                    notify({
                        kind: 'info',
                        title: '再按一次 Esc 全部刪單',
                        body: '0.6 秒內連按兩次 Esc 撤銷所有未成交委託',
                    });
                }
                return;
            }
            const k = e.key.toLowerCase();
            if (k === 'b' || k === 's') {
                window.dispatchEvent(
                    new CustomEvent(TICKET_ACTION_EVENT, {
                        detail: { action: k === 'b' ? 'Buy' : 'Sell' },
                    }),
                );
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onOpenPalette, onAfterCancelAll]);
}
