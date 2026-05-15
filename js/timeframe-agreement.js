// Cross-timeframe agreement scoring.
//
// generateMultiTimeframePrediction already weighted-blends daily / weekly / 4h
// internally. But that hides the agreement vs disagreement signal. Surface it
// explicitly so the engine can boost when all 3 align and penalize when they
// contradict.
//
// Score: 0..1 fraction of timeframes whose direction matches the final signal.
//   1.0 (3/3) -> +4 boost
//   0.67 (2/3) -> 0 (default; the pipeline already integrated this)
//   0.33 (1/3) -> -3 (final signal disagrees with majority)
//   0.0  (0/3) -> -5 (signal contradicts every timeframe; very weak)

export function timeframeAgreement(finalSignal, tfPredictions) {
    if (!finalSignal || !tfPredictions) return null;
    const sigs = ['daily', 'weekly', 'fourHour']
        .map(k => tfPredictions[k]?.signal)
        .filter(Boolean);
    if (sigs.length === 0) return null;

    const matches = sigs.filter(s => s === finalSignal).length;
    const agreement = matches / sigs.length;
    return {
        agreement: +agreement.toFixed(2),
        matchCount: matches,
        total: sigs.length,
        breakdown: { daily: tfPredictions.daily?.signal, weekly: tfPredictions.weekly?.signal, fourHour: tfPredictions.fourHour?.signal },
    };
}

export function timeframeAgreementAdjustment(finalSignal, agreement) {
    if (!agreement || (finalSignal !== 'BUY' && finalSignal !== 'SELL')) return { adjust: 0, reason: null };
    const a = agreement.agreement;
    if (agreement.total < 2) return { adjust: 0, reason: null };
    if (a >= 1.0) return { adjust: +4, reason: `All ${agreement.total} timeframes agree on ${finalSignal}` };
    if (a <= 0.0) return { adjust: -5, reason: `All ${agreement.total} timeframes disagree with ${finalSignal} — very weak signal` };
    if (a <= 0.34) return { adjust: -3, reason: `Only ${agreement.matchCount}/${agreement.total} timeframes agree with ${finalSignal}` };
    return { adjust: 0, reason: null };
}
