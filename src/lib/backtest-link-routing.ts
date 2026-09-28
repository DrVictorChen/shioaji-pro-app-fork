/** Pick one existing backtest panel; honor the panel that created the link. */
export function selectBacktestPanelId(
    blocks: readonly { id: string; type: string }[],
    requested?: string,
): string | undefined {
    return blocks.find((block) => block.type === 'backtest' && block.id === requested)?.id
        ?? blocks.find((block) => block.type === 'backtest')?.id;
}

/** Preserve the initial URL target if a child panel clears it before App effects run. */
export function requestedBacktestPanelId(
    eventTarget: unknown,
    urlTarget: string | null,
    initialTarget: string | null,
): string | undefined {
    return [eventTarget, urlTarget, initialTarget]
        .find((value): value is string => typeof value === 'string' && value.length > 0);
}
