// The locked call, laid over a live prediction. ONE function, used by the signal card AND Hot
// Picks, so the two can never show different calls for the same symbol on the same session.
//
// Before this lived here, Hot Picks displayed the LIVE engine output while the card displayed the
// LOCKED one: a pick could read "BUY 50%" and open to a card saying "DON'T BUY 48%". The locked
// values win for the decision fields (signal, confidence, the predicted high/low, the band);
// everything explanatory (reasons, breakdown, news, ATR, support/resistance) stays live.

export function applyLockToPrediction(prediction, locked) {
    if (!locked) return prediction;
    let pinnedTargets = prediction.priceTargets;
    if (locked.priceTargets && Number.isFinite(locked.priceTargets.predictedHigh)) {
        // BEST CASE: the cron locked a FULL band at market open (possible +
        // probable high/low, anchored to the open entry). Use it wholesale
        // — this is the engine's own committed band, identical for everyone
        // all day. Keep only the LIVE currentPrice so the card still shows
        // where price is NOW relative to the locked band.
        pinnedTargets = {
            ...locked.priceTargets,
            currentPrice: prediction.priceTargets?.currentPrice ?? locked.priceTargets.currentPrice,
            baselinePrice: Number.isFinite(locked.entry) && locked.entry > 0 ? locked.entry : null,
        };
    } else if (pinnedTargets && locked.predictedHigh != null && locked.predictedLow != null && Number.isFinite(locked.entry) && locked.entry > 0) {
        // FALLBACK (legacy ledger row / visit-time lock): pin only the
        // headline possible high/low to the locked values + recompute their
        // % against the locked entry, so the range doesn't drift with live
        // price. Keep the live currentPrice for the "where price is NOW" read.
        pinnedTargets = {
            ...pinnedTargets,
            predictedHigh: locked.predictedHigh,
            predictedLow: locked.predictedLow,
            highPercent: +(((locked.predictedHigh - locked.entry) / locked.entry) * 100).toFixed(2),
            lowPercent: +(((locked.predictedLow - locked.entry) / locked.entry) * 100).toFixed(2),
            baselinePrice: locked.entry,
        };
    }
    // FINAL AUTHORITY: when the lock carries a 7-session band, its day-1 edges ARE the
    // headline Expected High/Low. Without this the two blocks could still split, and did:
    // the HKEX ledger row for 0700.HK carries a forecastBand but NO priceTargets and no
    // expectedMove, so neither branch above fired -- locked.predictedHigh was null -- and the
    // card kept the LIVE band (441.95 HKD) while the table drew the locked one (440.98).
    // Traced by logging renderSignal's entry and its DOM write: 441.95 in, 440.98 out, one
    // render, two different objects.
    //
    // Applied AFTER the branches above rather than as another branch, so it holds whichever
    // path produced pinnedTargets. Everything else on the object (ATR, support, resistance)
    // stays live, because those are explanatory context rather than the committed call.
    const lockedD1 = locked.forecastBand?.days?.[0];
    if (pinnedTargets && Number.isFinite(lockedD1?.high) && Number.isFinite(lockedD1?.low)) {
        const base = Number.isFinite(locked.entry) && locked.entry > 0
            ? locked.entry
            : (Number.isFinite(pinnedTargets.currentPrice) ? pinnedTargets.currentPrice : null);
        pinnedTargets = {
            ...pinnedTargets,
            predictedHigh: lockedD1.high,
            predictedLow: lockedD1.low,
            highPercent: base ? +(((lockedD1.high - base) / base) * 100).toFixed(2) : pinnedTargets.highPercent,
            lowPercent: base ? +(((lockedD1.low - base) / base) * 100).toFixed(2) : pinnedTargets.lowPercent,
            source: 'calibrated-band',
            bandConfidence: locked.forecastBand.confidence ?? pinnedTargets.bandConfidence,
            // THE PRICE THE PERCENTAGES ARE MEASURED FROM, carried explicitly.
            //
            // highPercent/lowPercent are computed against the LOCKED entry (the session
            // open), because that is the baseline the lock exists to hold steady. But the card
            // displays the LIVE price in the middle cell, so SPCX showed "High $159.51
            // (+7.45%) / Current $144.18 / Low $138.15 (-6.94%)" where +7.45% is measured from
            // $148.45, not from the $144.18 sitting between them. Both numbers were right and
            // the pairing was nonsense. Naming the baseline lets the UI say which is which.
            baselinePrice: base,
        };
    }
    return {
        ...prediction,
        signal: locked.signal,
        confidence: locked.confidence,
        priceTargets: pinnedTargets,
        // ONE band feeds both the headline Expected High/Low and the 7-session table. This
        // used to pin only priceTargets, leaving the table to render the live-anchored band,
        // so INTC showed an expected high of $101.70 in one block and $104.05 in the other --
        // same symbol, same day, same stated 80% confidence. The locked band is the one that
        // holds all day, so it wins in both places; falling back to the live band only when
        // the lock carries none (a legacy record predating this).
        forecastBand: locked.forecastBand || prediction.forecastBand,
        // The bars stay LIVE, and the card SAYS they are live. I first tried pinning them to the
        // cron's stored breakdown so they would agree with the locked call by construction, and
        // it broke the whole card: the ledger's breakdown is a lossier shape --
        // {technical:{score}, ai:{...}, sentiment:null, market:null} with NO weight fields at
        // all. Rendering it would have printed "(0%)" for every source and null-crashed on the
        // unavailable ones, which is how "Analysis failed: Cannot read properties of null" got
        // on screen. Trading one honest inconsistency for a fabricated weight and a broken card
        // is not a fix.
        //
        // So the honest arrangement is: locked decision, live inputs, and a label saying which
        // is which. See the 'live now' chip on the Confidence Sources heading.
        breakdownIsLive: true,
    };
}
