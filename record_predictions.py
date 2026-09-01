"""
Record open-of-day predictions for every symbol in a given region.

Usage:
    python record_predictions.py --region NYSE
    python record_predictions.py --region CRYPTO

Writes one append-only JSONL row per symbol per day to:
    model/ledger/<year>.jsonl

Schema (predicted phase):
    {
      "symbol":           "AAPL",
      "region":           "NYSE",
      "date":             "2026-05-20",            // ISO trading date
      "predictedAt":      "2026-05-20T13:30:00Z",  // UTC timestamp of prediction
      "entry":            187.50,                   // price at prediction
      "signal":           "BUY",                    // BUY / SELL / NEUTRAL
      "confidence":       68,                       // 0-100
      "indicators":       { "rsi": 52, "macdHist": 0.3, ... },
      "horizons":         { "1": null, "3": null, "5": null, "10": null, "20": null }
    }

The "horizons" dict gets filled in by record_outcomes.py as each
forward window matures.

Exit codes:
    0 = at least one row written
    1 = zero rows written (counts get printed for diagnosis); this fails
        the workflow loudly so silent regressions don't go unnoticed.
"""
import argparse
import datetime
import json
import os
import sys
import time
import traceback

import yfinance as yf

from backtest import generate_prediction
from price_round import round_price
from forecast_band import forecast_bands
from ai_infer import ai_prediction
from shared_features import extract_ohlcv
from ledger_universe import symbols_for_region, region_for, HORIZONS_DAYS

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')

# Print a sample of what each skipped-*/error symbol failed for so we can
# diagnose silent zero-row runs from the workflow log.
_DIAG_SAMPLES_PER_REASON = 5
_diag_samples = {}


def _add_diag(reason: str, symbol: str, detail: str):
    bucket = _diag_samples.setdefault(reason, [])
    if len(bucket) < _DIAG_SAMPLES_PER_REASON:
        bucket.append(f'{symbol}: {detail}')


def ledger_path_for(date_iso: str) -> str:
    """The MONTHLY shard this row belongs in.

    Was f'{year}.jsonl', and that file reached 101.30 MB -- past GitHub's hard 100 MB blob
    limit. Every cron then failed at the commit step with the rows already written to the
    runner's disk, so several market opens were lost before the cause was even visible (the
    push error lives in a job log that returns 403 without repo admin).

    Sharding by month also makes the duplicate check below cheaper: it now reads one ~30 MB
    shard instead of scanning the whole year.
    """
    return os.path.join(LEDGER_DIR, f'{date_iso[:7]}.jsonl')


def already_predicted_today(path: str, date_iso: str, symbol: str) -> bool:
    """Avoid duplicate predictions if a cron retries."""
    if not os.path.exists(path):
        return False
    needle = f'"date": "{date_iso}"'
    sym_needle = f'"symbol": "{symbol}"'
    with open(path, 'r') as f:
        for line in f:
            if needle in line and sym_needle in line:
                return True
    return False


# Yahoo intermittently rate-limits / times out a batch of symbols — most
# often on the back-to-back XETRA+LSE combined cron, where the second leg
# hits Yahoo while it's still throttling the first. A throttled call returns
# an empty DataFrame (or raises), indistinguishable per-call from a symbol
# that genuinely has no data. Retrying with backoff absorbs the transient
# throttle: a truly-dead symbol still returns empty after all attempts (and
# is honestly bucketed skipped-no-data), but a throttled-but-real symbol
# recovers on a later attempt. This is what stops the whole-region
# "0 rows, 95%+ no-data -> exit 1" guard from firing on a transient Yahoo
# hiccup, WITHOUT masking a genuine market-closed / Yahoo-down day (those
# still return empty after every retry and still go red, as intended).
_FETCH_RETRIES = 3
_FETCH_BACKOFF_S = (2, 4, 8)


def fetch_recent_candles(symbol: str, period='6mo'):
    """Pull the trailing window needed to compute indicators (RSI, MACD, BB, etc.).

    Retries on a transient empty/raising response with exponential backoff
    before giving up — see module note above.
    """
    last_why = 'empty-df'
    for attempt in range(_FETCH_RETRIES):
        try:
            df = yf.download(symbol, period=period, interval='1d', progress=False, auto_adjust=False)
        except Exception as e:
            last_why = f'download-raised: {type(e).__name__}: {e}'
            df = None
        if df is not None and not df.empty:
            try:
                ohlcv = extract_ohlcv(df)
            except Exception as e:
                # An extract failure is deterministic (data-shape issue), not
                # transient — don't waste retries on it.
                return None, f'extract-failed: {e}'
            return ohlcv, None
        # Transient empty/raise: back off and retry, except after the last try.
        if attempt < _FETCH_RETRIES - 1:
            time.sleep(_FETCH_BACKOFF_S[attempt])
    return None, last_why


def candles_as_records(close, high, low, volume, n=120):
    out = []
    n = min(n, len(close))
    for i in range(len(close) - n, len(close)):
        out.append({
            'open': float(close[i]),  # we don't have open here; close-as-open is fine for indicator calc
            'close': float(close[i]),
            'high': float(high[i]),
            'low': float(low[i]),
            'volume': float(volume[i]),
        })
    return out


def record_for_symbol(symbol: str, date_iso: str, batch_started: str):
    region = region_for(symbol)
    path = ledger_path_for(date_iso)
    if already_predicted_today(path, date_iso, symbol):
        return ('skipped-dup', symbol)

    candles_data, why = fetch_recent_candles(symbol)
    if candles_data is None:
        _add_diag('skipped-no-data', symbol, why or 'unknown')
        return ('skipped-no-data', symbol)
    close, high, low, volume = candles_data
    if len(close) < 30:
        _add_diag('skipped-thin', symbol, f'len(close)={len(close)}')
        return ('skipped-thin', symbol)

    # Stamped HERE, right after this symbol's own price came back, not once for
    # the whole region. A region run walks hundreds of symbols sequentially with
    # retries and sleeps, so it spans a long wall-clock window: NYSE writes 651
    # rows in one pass. Sharing one batch timestamp claimed every one of those
    # rows was locked at 14:25 when the last of them was really read closer to
    # 15:10, which let the grader credit ~45 minutes of price action to a
    # prediction that did not exist yet. That is the same defect as the pre-lock
    # credit, just at finer granularity, and it survives fixing the other one.
    locked_at = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

    candles = candles_as_records(close, high, low, volume)
    pred = generate_prediction(candles)
    if not pred or not pred.get('signal'):
        _add_diag('skipped-no-pred', symbol, f'pred={pred}')
        return ('skipped-no-pred', symbol)
    entry_price = float(close[-1])

    # AI inference, same models and same numbers as the browser (ai_infer mirrors
    # js/ai-model.js; tools/ai_sync_check.py asserts they agree to 1e-9).
    # Tier mirrors classifyTier in js/calibration.js so the cron picks the same
    # model the browser would: sub-$1 uses the isolated penny weights.
    try:
        # classifyTier's penny bucket is price < $1 alone; volume only separates
        # the higher tiers, and the AI has no separate model for those, so it plays
        # no part in this decision.
        tier = 'penny' if entry_price < 1 else None
        ai_block = ai_prediction(candles, tier=tier)
    except Exception as e:
        # Never let the AI stage kill a row. A missing AI opinion is recoverable;
        # a lost prediction for the day is not, because the open cannot be replayed.
        _add_diag('ai-failed', symbol, f'{type(e).__name__}: {e}')
        ai_block = {'score': 50, 'available': False, 'reason': f'{type(e).__name__}'}

    row = {
        'symbol': symbol,
        'region': region,
        'date': date_iso,
        # This row's OWN lock instant: when its price was read. The grader slices
        # the session at this timestamp, so it has to be per-row to be honest.
        'predictedAt': locked_at,
        # When the region's batch began. Diagnostic only; the gap between this and
        # predictedAt is how long the run took to reach this symbol.
        'batchStartedAt': batch_started,
        'entry': round_price(entry_price),
        'signal': pred['signal'],
        'confidence': int(pred['confidence']),
        # Provenance: which engine logic produced this call. recalibrate_from_
        # ledger.py + the trust panel aggregate ONLY current-engine rows, so a
        # scoring change (e.g. the 1d mean-reversion rebalance) rebuilds its
        # track record from scratch instead of inheriting the prior engine's
        # hit-rate. See backtest.ENGINE_VERSION. Falls back to a sentinel for
        # the (impossible) case where the engine didn't stamp one.
        'engineVersion': pred.get('engineVersion', 'unversioned'),
        # weightedScore (0-100 bull scale) + dispersion (0-80 evidence
        # conflict): the JS learner (calibration-thresholds.js) reads these
        # off each row to derive buy/sell SCORE thresholds + dispersion
        # penalties. They were never stored before, so the learner was
        # permanently stuck on bootstrap defaults. Now persisted.
        'weightedScore': pred.get('weightedScore'),
        'dispersion': pred.get('dispersion'),
        # Minimal source breakdown the JS source-weight learner reads. The
        # Python cron is TECHNICALS-ONLY (it has no AI/sentiment/market
        # sources — those live only in the browser engine), so we honestly
        # populate ONLY the technical source with the engine's own 0-100
        # score and leave the others null. source-weights.js skips null
        # sources, so it learns the technical source's real hit-rate and
        # holds the rest at baseline — grounded, not faked. (A full 4-source
        # breakdown would require the browser engine to write the ledger,
        # which isn't possible against a git-committed file on free infra.)
        # The cron used to hardcode ai/sentiment/market to null, so the LOCKED and
        # GRADED prediction came from three indicators while the browser showed a
        # four-source blend that included this same LSTM. The user saw one analysis
        # and the ledger recorded another.
        #
        # `ai` is now real. It is RECORDED but deliberately does NOT influence the
        # signal yet: the LSTM measures 53.35% against a triple-barrier label whose
        # own base rate is 53.58%, so it is indistinguishable from always saying
        # "up", and letting an unproven source move the locked call would be
        # exactly the mistake this project already made once by tuning a
        # mean-reversion tilt on leaked outcomes. Recording costs nothing and gives
        # forward-graded data to decide on. Once resolved rows exist,
        # tools/skill_report.py --source ai answers whether it earns weight.
        #
        # Because the signal is unchanged, engineVersion stays put and the existing
        # track record remains comparable.
        'breakdown': {
            'technical': {'score': pred.get('weightedScore')},
            'ai': ai_block,
            'sentiment': None, 'market': None,
        },
        # Directional expected-move distance (price) this call implies, so
        # record_outcomes can grade capturedPct against the row's OWN stored
        # target — no JS<->Python re-derivation. None for non-directional /
        # ATR-unavailable rows; those simply get capturedPct=null.
        'expectedMove': pred.get('expectedMove'),
        # Full possible + probable price-target bands the engine LOCKED at this
        # symbol's market open, anchored to the open entry. The browser
        # (daily-lock via ledger-reader.readTodayLock) reads these directly so
        # the displayed band is the one committed at open, held all day — not a
        # re-derivation that could drift from the engine. None for
        # NEUTRAL/NO_TRADE (no directional band) or when ATR was unavailable.
        'priceTargets': pred.get('priceTargets'),
        # The CALIBRATED 7-day High/Low band, which is what the app actually
        # displays. Stored separately from priceTargets rather than replacing it:
        #
        #   priceTargets  = the legacy ATR-and-confidence heuristic. Never
        #                   validated. Measured containment 52.6%.
        #   forecastBand  = z solved from realized ledger outcomes per volatility
        #                   tier and horizon. Measured containment 80.0%.
        #
        # Until now the cron wrote ONLY the heuristic, so every accuracy number in
        # the scorecard graded a forecast no user ever saw. Both are kept for one
        # calibration cycle so the two can be compared on identical rows; the
        # heuristic goes once forecastBand has its own out-of-sample history.
        # `calibrated` may be False (sub-penny), and the grader must respect that
        # rather than reporting an unvalidated band as an 80% claim.
        'forecastBand': forecast_bands(candles, entry_price,
                                       mode='perDay') if candles else None,
        'indicators': pred.get('indicators') or {},
        'horizons': {str(h): None for h in HORIZONS_DAYS},
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a') as f:
        f.write(json.dumps(row) + '\n')
    return ('ok', symbol)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--region', required=True, help='Region tag (NYSE, CRYPTO, NSE, LSE, HKEX, TYO, XETRA, ASX)')
    args = ap.parse_args()

    symbols = symbols_for_region(args.region)

    # Union the static list with everything Yahoo's four predefined screeners
    # surface today — the SAME four the browser's Hot Picks uses. US stocks only
    # (NYSE region); other regions have no predefined screeners and crypto is its
    # own thing. Failure is non-fatal: if the screener call 503s the cron continues
    # with the static list.
    #
    # This used to cap at $5, which made the ledger universe and the Hot Picks
    # universe disagree. Hot Picks would show DY at $309.61 with a full prediction
    # while the cron had never analysed it, so daily-lock.js fell through to its
    # visit-time fallback and the card read "today's call · locked 11:18 AM" — the
    # moment the USER opened the page rather than the market open. Seven of the
    # twelve Hot Picks on that screen were in the same state. The open lock is the
    # thing that makes "did today's call reach its target?" answerable, because the
    # baseline has to be identical for everyone regardless of when they looked, so
    # the cron has to cover everything the app is willing to recommend.
    if args.region == 'NYSE':
        try:
            from penny_dynamic import fetch_dynamic_symbols
            dynamic = fetch_dynamic_symbols()   # no price cap
            seen = set(symbols)
            added = 0
            for s in dynamic:
                if s not in seen:
                    symbols.append(s)
                    seen.add(s)
                    added += 1
            print(f'Dynamic movers: {added} added on top of {len(symbols) - added} static.')
        except Exception as e:
            print(f'Dynamic mover fetch failed (continuing with static list): {e}')

    if not symbols:
        print(f'No symbols for region {args.region}')
        # Empty universe is a config bug, not a runtime issue — fail loud.
        sys.exit(1)

    now = datetime.datetime.now(datetime.timezone.utc)
    date_iso = now.strftime('%Y-%m-%d')
    # Batch start, for diagnostics only. NOT the lock time of any individual row:
    # see record_for_symbol, which stamps each row when ITS price is actually read.
    batch_started = now.strftime('%Y-%m-%dT%H:%M:%SZ')

    path_for_today = ledger_path_for(date_iso)
    print(f'Recording {args.region} predictions for {date_iso} ({len(symbols)} symbols).')
    print(f'Output path: {path_for_today}')
    print(f'yfinance version: {getattr(yf, "__version__", "?")}')

    counts = {'ok': 0, 'skipped-dup': 0, 'skipped-no-data': 0, 'skipped-thin': 0, 'skipped-no-pred': 0, 'error': 0}
    for sym in symbols:
        try:
            status, _ = record_for_symbol(sym, date_iso, batch_started)
            counts[status] = counts.get(status, 0) + 1
        except Exception as e:
            counts['error'] += 1
            _add_diag('error', sym, f'{type(e).__name__}: {e}')
            # Print first few full tracebacks so we can fix root cause.
            if counts['error'] <= 3:
                traceback.print_exc()

    print(f'Done: {counts}')

    # Show diagnostic samples for whatever bucket dominated. This is what
    # makes the silent-failure mode loud — without these lines the workflow
    # would just say "success" with no rows written.
    for reason in ('skipped-no-data', 'skipped-thin', 'skipped-no-pred', 'error'):
        if reason in _diag_samples and _diag_samples[reason]:
            print(f'\n[{reason}] sample of {len(_diag_samples[reason])} (showing up to {_DIAG_SAMPLES_PER_REASON}):')
            for s in _diag_samples[reason]:
                print(f'  {s}')

    # Also surface what's actually on disk for this run.
    if os.path.exists(path_for_today):
        size = os.path.getsize(path_for_today)
        with open(path_for_today, 'r') as f:
            line_count = sum(1 for _ in f)
        print(f'\nLedger file: {path_for_today}  ({size} bytes, {line_count} lines)')
    else:
        print(f'\nLedger file does not exist: {path_for_today}')

    # Hard-fail logic: distinguish "nothing to do" (legitimate) from "broken"
    # (regression). All-dup or all-no-data on a holiday/weekend isn't a bug.
    # Real failure is when symbols error out, fail to fetch, or produce
    # garbage indicators in numbers higher than a few outliers.
    err = counts.get('error', 0)
    no_data = counts.get('skipped-no-data', 0)
    no_pred = counts.get('skipped-no-pred', 0)
    thin = counts.get('skipped-thin', 0)
    total = sum(counts.values())
    real_failures = err + no_pred + thin
    no_data_ratio = (no_data / total) if total else 1.0

    if counts['ok'] == 0 and counts['skipped-dup'] > 0 and real_failures == 0:
        # Re-run for a region that already wrote rows today: legit no-op.
        # Requiring skipped-dup == total was too strict: a replay sees dups
        # for every symbol that had data on the first pass PLUS no-data for
        # the ones that are delisted/halted, so a single dataless symbol made
        # the replay exit 1. Any dup at all proves today's rows already exist,
        # which is the only thing this guard needs to establish.
        print(f'\nNothing new to write: {counts["skipped-dup"]} of {total} symbols '
              f'already predicted today (cron retry / manual replay). Exit 0.')
        return
    if counts['ok'] == 0 and no_data_ratio >= 0.95:
        # Likely a market-closed / holiday day, OR yfinance is down across
        # the board. Either way, the script can't do its job today.
        # Exit 1 so the workflow shows red — if it's a holiday the next
        # cron clears it; if yfinance is really down we want to see it.
        print(f'\nERROR: zero rows written and {no_data} of {total} symbols had no data. Likely market-closed or yfinance-unavailable.', file=sys.stderr)
        sys.exit(1)
    if counts['ok'] == 0:
        print(f'\nERROR: zero rows written for region {args.region}. See diagnostic samples above.', file=sys.stderr)
        sys.exit(1)
    if real_failures > 0 and real_failures / total > 0.30:
        # > 30% of the universe failed with real errors. Suspect a systemic
        # issue (yfinance API change, generate_prediction crash on a new
        # data shape, etc.) — surface it.
        print(f'\nERROR: {real_failures} of {total} symbols hit real failures (errors+no-pred+thin). Likely systemic.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
