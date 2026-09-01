"""
Resolve outcomes for matured forward windows on every unresolved
ledger row. Multi-horizon: each row is revisited as +1d, +3d, +5d,
+10d, +20d horizons mature, and that horizon's slot in the row's
"horizons" dict is filled in.

Per horizon we record:
  {
    "actualClose":     192.30,    // close on the horizon-end date
    "actualHigh":      193.80,    // best price during the window
    "actualLow":       186.10,    // worst price during the window
    "directionMatch":  true,      // did it go the way the engine said
    "capturedPct":     58,        // % of predicted-direction move captured
                                  //   computed against ATR-derived expected move
    "rangeHit":        "inside"   // inside | beyond_right | below_right | wrong_dir
  }

Idempotent: rewrites the entire JSONL file once with all updates.
Cheap because rows are small and the file rotates yearly.

Usage:
    python record_outcomes.py
"""
import datetime
import json
import math
import os
from collections import defaultdict

import yfinance as yf

from ledger_universe import HORIZONS_DAYS
from price_round import round_price

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
LEDGER_DIR = os.path.join(SCRIPT_DIR, 'model', 'ledger')

import ledger_store  # noqa: E402


def ledger_path_for_year(year: int) -> str:
    return os.path.join(LEDGER_DIR, f'{year}.jsonl')


def load_rows(path: str = None):
    """Every ledger row, across all monthly shards.

    The ledger is sharded by month because a single year file hit GitHub's hard 100 MB blob
    limit and made every push fail outright. `path` is accepted and ignored so existing
    callers keep working unchanged.
    """
    return list(ledger_store.iter_rows())


def save_rows(path, rows):
    """Write rows back to the shard each one belongs to, atomically per shard.

    This resolver REWRITES rows in place (filling matured horizons), so it cannot append.
    Rows are grouped by their own date, and each shard goes through a temp file plus
    os.replace, so an interrupted run leaves either the old shard or the new one and never
    half of each. The ledger is the only copy of this history and a market open cannot be
    replayed.

    A row with an unusable date lands in a quarantine shard rather than being dropped or
    filed under today: misfiling it would corrupt that month's coverage figures, and
    dropping it would delete data to tidy up a formatting problem.
    """
    by_shard = {}
    for r in rows:
        mk = ledger_store.month_key(r.get('date')) or 'unresolved-dates'
        by_shard.setdefault(mk, []).append(r)
    for mk, group in sorted(by_shard.items()):
        target = os.path.join(LEDGER_DIR, f'{mk}.jsonl')
        tmp = target + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            for r in group:
                # allow_nan=False: a bare NaN is invalid JSON and has silently broken the
                # browser's calibration load before.
                f.write(json.dumps(r, allow_nan=False) + '\n')
        os.replace(tmp, target)
    print(f'  wrote {len(rows):,} rows across {len(by_shard)} shard(s): '
          f'{", ".join(sorted(by_shard))}')


def trading_days_passed(prediction_date: str, today: datetime.date) -> int:
    """Approximate trading days between two ISO dates (M-F count)."""
    d0 = datetime.date.fromisoformat(prediction_date)
    if today <= d0:
        return 0
    days = 0
    cur = d0 + datetime.timedelta(days=1)
    while cur <= today:
        if cur.weekday() < 5:  # Mon-Fri
            days += 1
        cur += datetime.timedelta(days=1)
    return days


# A single-day move beyond this ratio is a corporate action (split, reverse
# split, redenomination), not a return. Two AEHL rows in this ledger read +1192%
# and +1803% in one day; unguarded they moved a 1,096-row sample's mean return
# from -0.07% to +2.59% and its stdev from 1.6 to 65.3. Genuine penny moves of
# 50-100% are real and must NOT be filtered, so the bar is set well above them.
MAX_DAILY_RATIO = 3.0

# Below this the close is unchanged to within float noise. A flat close is NOT a
# miss: `move > 0` is False for BUY and `move < 0` is False for SELL, so the old
# code scored an untraded symbol wrong in BOTH directions. 105 of 1,096 sampled
# rows were flat, and one symbol (OST, high == low on 60 of 60 days) alone
# supplied 56 of the 156 rows in the 60-70% confidence bucket, single-handedly
# making that bucket look 28% accurate.
FLAT_EPS = 1e-9


def fetch_window(symbol: str, start_iso: str, days_needed: int = 0):
    """Daily bars from start_iso through today as a DATE-KEYED series.

    Returns {'dates': [iso, ...], 'close'/'high'/'low': [...], 'index': {iso: i}}
    or None.

    Why dated: the previous version returned bare lists, which left
    resolve_horizon no option but POSITIONAL indexing (`closes[h_days]`). Since
    the caller cached one window per SYMBOL, every row of that symbol was graded
    against a window anchored to some other row's date. 84.6% of resolved rows
    shared a graded close with another row, spreading up to 86 calendar days
    apart, and the resulting hit rate read 76% BUY and 73% SELL simultaneously,
    which is impossible. Dates make the anchor explicit and let one wide fetch
    per symbol serve every row correctly.
    """
    end = datetime.date.today() + datetime.timedelta(days=1)
    start = datetime.date.fromisoformat(start_iso)
    df = yf.download(symbol, start=start.isoformat(), end=end.isoformat(),
                     interval='1d', progress=False, auto_adjust=False)
    if df.empty:
        return None

    def col(name):
        v = df[name].values.tolist() if hasattr(df[name], 'values') else []
        # MultiIndex case for a single ticker — flatten
        return [x[0] if isinstance(x, list) else x for x in v]

    closes, highs, lows = col('Close'), col('High'), col('Low')
    try:
        dates = [d.date().isoformat() if hasattr(d, 'date') else str(d)[:10]
                 for d in df.index.tolist()]
    except Exception:
        return None

    # Align all four series. They are extracted independently and a column-shape
    # skew would otherwise grade a high/low window against a different close.
    n = min(len(dates), len(closes), len(highs), len(lows))
    dates, closes, highs, lows = dates[:n], closes[:n], highs[:n], lows[:n]

    # Drop bars that are unusable, keeping the series internally consistent.
    keep = [i for i in range(n)
            if closes[i] and highs[i] and lows[i]
            and not math.isnan(closes[i]) and not math.isnan(highs[i]) and not math.isnan(lows[i])
            and closes[i] > 0 and highs[i] >= lows[i] > 0]
    dates = [dates[i] for i in keep]
    closes = [closes[i] for i in keep]
    highs = [highs[i] for i in keep]
    lows = [lows[i] for i in keep]
    if not dates:
        return None
    return {'dates': dates, 'close': closes, 'high': highs, 'low': lows,
            'index': {d: i for i, d in enumerate(dates)}}


def find_anchor(bars, row_date: str, entry: float):
    """Which bar does this row's `entry` price actually correspond to?

    Returns (index, how) or (None, reason).

    This exists because the ledger's stored `entry` matches its own date's close
    only ~25% of the time: record_predictions.py takes `close[-1]` at the
    market-open cron, which is usually the PREVIOUS session. Grading by date
    therefore treats a 2-day forecast as a 1-day one. Measured effect of
    anchoring on the matching bar instead: out-of-sample day-1 band coverage
    68.4% -> 84.1%.

    Price match is tried first and preferred, within a +/-4 session window so a
    coincidental match far away cannot win. Falling back to the date keeps older
    rows gradable, but the choice is recorded on the outcome so it is auditable
    rather than silent.
    """
    idx = bars['index'].get(row_date)
    closes = bars['close']
    if entry and entry > 0:
        lo = max(0, (idx - 4) if idx is not None else 0)
        hi = min(len(closes), (idx + 2) if idx is not None else len(closes))
        for i in range(lo, hi):
            if abs(closes[i] - entry) / entry < 0.001:
                return i, 'entry-match'
    if idx is not None:
        return idx, 'date'
    return None, 'no-bar-for-date'


# Keys dropped from a stored outcome when null/false. Every reader accesses these
# with .get() / optional chaining, so absent and null are indistinguishable to them.
#
# directionMatch is deliberately NOT in this list even though it is often null:
# audit_engine.py and audit_summary.py index it directly (h['directionMatch']), so
# omitting it would raise KeyError rather than degrade.
#
# This is not cosmetic. The re-resolution added anchorDate/anchorHow/targetDate/flat
# to all 291,214 horizons and pushed model/ledger/2026.jsonl to 114.7 MiB, past
# GitHub's 100 MiB per-file HARD limit, which rejects the push outright.
_OMIT_WHEN_EMPTY = ('anchorDate', 'targetDate', 'flat', 'actualHigh', 'actualLow',
                    'capturedPct', 'rangeHit', 'pctMove')


def compact_outcome(o, row_date=None):
    """Drop fields that carry no information when absent.

    Also drops anchorDate when it merely repeats the row's own date, which is the
    case on 71.8% of horizons. A reader wanting the anchor date uses
    `outcome.get('anchorDate') or row['date']`; anchorHow still records HOW the
    bar was chosen, which is the part that matters for auditing.

    Worth 5.3 MiB on the current ledger. That is the difference between a file
    GitHub accepts and one it rejects outright, so it is load-bearing rather than
    tidiness.
    """
    if not isinstance(o, dict):
        return o
    out = {k: v for k, v in o.items()
           if not (k in _OMIT_WHEN_EMPTY and (v is None or v is False))}
    if row_date and out.get('anchorDate') == row_date:
        out.pop('anchorDate', None)
    return out


def resolve_horizon(row: dict, h_days: int, bars):
    """Outcome dict for horizon h_days, anchored on the row's OWN bar.

    `bars` is the dated series from fetch_window. The anchor is located per-row by
    find_anchor, so one cached window per symbol is now correct rather than
    silently grading every row against the first row's date.
    """
    if not bars or not bars.get('dates'):
        return None

    entry = row.get('entry')
    if not isinstance(entry, (int, float)) or entry != entry or entry <= 0:
        return None  # NaN or absent entry: 650 such rows exist; never gradable

    a_idx, a_how = find_anchor(bars, row.get('date'), float(entry))
    if a_idx is None:
        return None

    closes, highs, lows, dates = bars['close'], bars['high'], bars['low'], bars['dates']
    tgt = a_idx + h_days
    if tgt >= len(closes):
        return None  # window not matured

    actual_close = float(closes[tgt])
    if math.isnan(actual_close) or actual_close <= 0:
        # yfinance returns NaN closes on unsettled bars (NSE especially: intraday
        # H/L populate before the daily close settles). Coercing that to
        # directionMatch=False silently inverted a whole region's calibration
        # once already, so treat it as "not yet matured" and let the next cron
        # retry rather than freezing a wrong answer.
        return None

    # Corporate-action guard. A split shows up as an impossible one-day ratio.
    ratio = max(actual_close / entry, entry / actual_close)
    if ratio > MAX_DAILY_RATIO ** max(1, h_days ** 0.5):
        return {'unresolvable': 'suspected-corporate-action',
                'anchorDate': dates[a_idx], 'anchorHow': a_how,
                'actualClose': round_price(actual_close), 'directionMatch': None,
                'capturedPct': None, 'rangeHit': None, 'pctMove': None}

    window_high = float(max(highs[a_idx + 1:tgt + 1])) if tgt > a_idx else None
    window_low = float(min(lows[a_idx + 1:tgt + 1])) if tgt > a_idx else None

    signal = row['signal']
    move = actual_close - entry
    pct_move = (move / entry) * 100 if entry else 0

    # A FLAT close validates neither direction. The old code returned
    # `move > 0` for BUY and `move < 0` for SELL, both False when move == 0, so
    # an untraded symbol was scored WRONG whichever way the engine called it.
    # 105 of 1,096 sampled rows were flat, and one zero-range symbol supplied 56
    # of the 156 rows in the 60-70% confidence bucket, dragging that bucket to an
    # apparent 28% accuracy. null means "no directional outcome", which the
    # calibrator already skips.
    if signal in ('BUY', 'SELL') and abs(move) <= max(FLAT_EPS, entry * 1e-9):
        direction_match = None
    elif signal == 'BUY':
        direction_match = move > 0
    elif signal == 'SELL':
        direction_match = move < 0
    elif signal == 'NEUTRAL':
        direction_match = abs(pct_move) < 1.0  # NEUTRAL hits when close to flat
    else:
        # NO_TRADE — engine abstained, there's nothing to score against.
        direction_match = None

    # ── Target-capture quality (capturedPct + rangeHit) ──────────────────
    # directionMatch is binary (did it go the right way at all). capturedPct
    # adds QUALITY: of the move the engine implicitly predicted (expectedMove,
    # stored on the row at prediction time), what fraction did price actually
    # capture IN THE PREDICTED DIRECTION? Measured against the window's best
    # favorable excursion (high for BUY, low for SELL) — "did it reach the
    # target zone at any point", not just where it happened to close.
    #
    # Cap at 100 (reaching/exceeding the target is a full win, overshoot isn't
    # extra credit), floor at 0 (wrong-direction = 0%, directionMatch already
    # carries the up/down truth). null when the row predates target storage or
    # is non-directional — we don't fabricate it for legacy rows.
    captured_pct = None
    range_hit = None
    expected_move = row.get('expectedMove')
    if (signal in ('BUY', 'SELL') and direction_match is not None
            and isinstance(expected_move, (int, float)) and expected_move > 0):
        if direction_match is False:
            # Directionally wrong (closed the wrong way) = a miss, full stop.
            # We do NOT credit a trivial intraday wiggle in the right
            # direction on a call that ultimately closed against us — that
            # would let losing calls show a misleading "3% captured".
            captured_pct = 0
            range_hit = 'wrong_dir'
        else:
            # Direction was right — measure how much of the predicted move
            # the best favorable excursion captured (high for BUY, low for
            # SELL): "did it reach the target zone at any point in the window".
            if signal == 'BUY':
                favorable = (window_high - entry) if window_high is not None else move
            else:  # SELL — favorable excursion is downward
                favorable = (entry - window_low) if window_low is not None else -move
            raw = max(0.0, favorable / expected_move)
            captured_pct = int(round(min(1.0, raw) * 100))
            range_hit = 'reached' if raw >= 1.0 else 'inside'

    return {
        # Which bar this row was graded against, and how that bar was chosen.
        # Without this the anchor is implicit and a regression is invisible.
        'anchorDate': dates[a_idx],
        'anchorHow': a_how,
        'targetDate': dates[tgt],
        'flat': direction_match is None and signal in ('BUY', 'SELL'),
        'actualClose': round_price(actual_close),
        'actualHigh': round_price(window_high),
        'actualLow': round_price(window_low),
        'pctMove': round(pct_move, 3),
        'directionMatch': direction_match,
        'capturedPct': captured_pct,
        'rangeHit': range_hit,
    }


RERESOLVE = False
stats = defaultdict(int)


def main():
    import sys
    global RERESOLVE
    RERESOLVE = '--reresolve' in sys.argv
    if RERESOLVE:
        print('RERESOLVE MODE: every matured horizon will be recomputed from scratch.')
    today = datetime.date.today()
    year = today.year
    path = ledger_path_for_year(year)
    rows = load_rows(path)
    if not rows:
        # Legit no-op on the very first cron of a new year (or fresh repo).
        print(f"No ledger rows for {year} — nothing to resolve.")
        return

    # Cache of fetched bars per symbol so we don't re-download for each horizon.
    bars_cache = {}

    updated = 0
    skipped_immature = 0
    fetched = 0
    errors = 0
    rows_with_unresolved_due = 0

    # Earliest row date per symbol, so ONE window covers every row of that
    # symbol. Previously the window began at whichever row happened to be seen
    # first, which is what made a per-symbol cache unsafe. Anchoring is now
    # per-row, so a wide window plus a symbol-keyed cache is both correct and
    # cheap: ~1,100 fetches instead of ~67,000.
    earliest = {}
    for r in rows:
        sym, d = r.get('symbol'), r.get('date')
        if sym and d and (sym not in earliest or d < earliest[sym]):
            earliest[sym] = d

    for row in rows:
        passed = trading_days_passed(row['date'], today)
        if RERESOLVE:
            # The corrupted values are frozen by the `is None` gate below, so they
            # never self-correct. --reresolve rebuilds every matured horizon.
            unresolved_horizons = [h for h in HORIZONS_DAYS if passed >= h]
        else:
            unresolved_horizons = [h for h in HORIZONS_DAYS if row['horizons'].get(str(h)) is None and passed >= h]
        if not unresolved_horizons:
            if any(row['horizons'].get(str(h)) is None for h in HORIZONS_DAYS):
                skipped_immature += 1
            continue
        rows_with_unresolved_due += 1

        sym = row['symbol']
        if sym not in bars_cache:
            try:
                # Start 10 calendar days before this symbol's FIRST row so
                # find_anchor's backward search window always has bars available.
                start = datetime.date.fromisoformat(earliest.get(sym, row['date']))
                start = (start - datetime.timedelta(days=10)).isoformat()
                bars_cache[sym] = fetch_window(sym, start)
                fetched += 1
            except Exception as e:
                bars_cache[sym] = None
                errors += 1
                print(f'  [warn] fetch {sym}: {e}')

        bars = bars_cache.get(sym)
        if not bars:
            continue

        for h in unresolved_horizons:
            outcome = resolve_horizon(row, h, bars)
            if outcome is None:
                continue
            if outcome.get('unresolvable'):
                stats['corporate-action'] += 1
            else:
                stats['anchor:' + str(outcome.get('anchorHow'))] += 1
                if outcome.get('flat'):
                    stats['flat (no directional outcome)'] += 1
            row['horizons'][str(h)] = compact_outcome(outcome)
            updated += 1

    save_rows(path, rows)
    print(f"Resolved horizons: {updated}, fetched: {fetched}, immature: {skipped_immature}, errors: {errors}")
    print(f"Rows considered for resolution: {rows_with_unresolved_due} (of {len(rows)} total in {year}.jsonl)")
    if stats:
        print('Grading breakdown:')
        for k in sorted(stats):
            print(f'  {k}: {stats[k]:,}')

    # Hard-fail when we had work to do (mature horizons due) but resolved
    # zero AND most fetches failed — that's yfinance being down across the
    # board, not a legit no-op.
    if rows_with_unresolved_due > 0 and updated == 0 and errors > 0:
        ratio = errors / rows_with_unresolved_due
        if ratio > 0.5:
            print(f'\nERROR: {errors} fetch errors out of {rows_with_unresolved_due} rows due for resolution. Likely yfinance unavailable.', file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()
