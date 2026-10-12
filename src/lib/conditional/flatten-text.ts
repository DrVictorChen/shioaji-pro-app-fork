// src/lib/conditional/flatten-text.ts — 全平並取消 quantity wording (#226), pure.

/** 「8 張＋6 股」 / 「2 口」: whole lots and the odd remainder of a stock. */
export function quantityText(market: 'stock' | 'futures', quantity: number): string {
    if (market === 'futures') return `${quantity} 口`;
    const lots = Math.floor(quantity / 1000);
    const odd = quantity % 1000;
    return [lots > 0 ? `${lots} 張` : '', odd > 0 ? `${odd} 股` : ''].filter(Boolean).join('＋') || '0 股';
}

/** How a close goes out: futures 範圍市價; stocks 整股市價、零股限價. */
export function closeHowText(market: 'stock' | 'futures', quantity: number): string {
    if (market === 'futures') return '範圍市價';
    const lots = Math.floor(quantity / 1000);
    const odd = quantity % 1000;
    return lots > 0 && odd > 0 ? '整股市價、零股限價' : odd > 0 ? '零股限價' : '整股市價';
}
