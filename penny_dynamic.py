"""
Dynamic symbol fetcher for the daily cron. Pulls Yahoo's predefined
screeners (aggressive_small_caps, day_gainers, day_losers,
most_actives) and returns the de-duplicated symbol list.

These are THE SAME FOUR SCREENERS the browser's Hot Picks uses
(js/hotpicks.js), and that is the point: the cron has to analyse
everything the app is willing to recommend.

Why it matters — the bug this fixes. The cron only ever asked for
sub-$5 names, so the ledger universe and the Hot Picks universe
disagreed. DY at $309.61 was shown as a Hot Pick with a full
prediction, but no cron row existed for it, so daily-lock.js fell
through to its visit-time fallback and the card read "today's call ·
locked 11:18 AM" — the time the USER opened the page, not the market
open. Seven of twelve Hot Picks on that screen were in the same state.
An open-locked call is what makes "did today's prediction reach its
target?" answerable at all, because the baseline has to be the same
for everyone regardless of when they looked.

If the Yahoo screener call fails for any reason, returns an empty list
so the cron continues with whatever's in the static universe. Failure
is non-fatal by design.
"""
from __future__ import annotations

import urllib.request
import json
from typing import List

_BASE = "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved"
_SCREENERS = ["aggressive_small_caps", "day_gainers", "day_losers", "most_actives"]
_TIMEOUT = 12  # seconds; cron tolerates slow Yahoo
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; market-analysis-cron/1.0)",
    "Accept": "application/json",
}


def _fetch_one(scr_id: str) -> List[dict]:
    """Fetch one screener; return list of quote dicts or []."""
    url = f"{_BASE}?formatted=false&lang=en-US&region=US&scrIds={scr_id}&count=50"
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[penny_dynamic] {scr_id} fetch failed: {e}")
        return []
    quotes = (data.get("finance", {}).get("result") or [{}])[0].get("quotes") or []
    return quotes


def fetch_dynamic_symbols(max_price: float | None = None) -> List[str]:
    """
    Pull all four screeners and return de-duplicated symbols. Skips OTC
    ('.'-suffixed), futures ('=' in symbol), and crypto pairs ('-USD').

    max_price=None (the default) applies NO price cap, which is what the ledger
    cron wants: it must cover every name Hot Picks can surface, and those run from
    sub-$1 to $300+. A cap is still available for callers that genuinely want only
    pennies.

    A symbol missing regularMarketPrice is KEPT when there is no cap. Dropping it
    would silently exclude names purely because one screener field was absent, and
    the fetch below can still price it.
    """
    seen: set = set()
    out: List[str] = []
    for scr in _SCREENERS:
        for q in _fetch_one(scr):
            sym = q.get("symbol")
            if not sym or sym in seen:
                continue
            if "." in sym or "=" in sym or sym.endswith("-USD"):
                continue
            if (q.get("quoteType") or "").upper() not in ("EQUITY", "ETF"):
                continue
            if max_price is not None:
                price = q.get("regularMarketPrice")
                if not isinstance(price, (int, float)) or price >= max_price:
                    continue
            seen.add(sym)
            out.append(sym)
    return out


def fetch_dynamic_pennies(max_price: float = 5.0) -> List[str]:
    """Sub-$5 subset. Kept so any caller wanting only pennies still has it."""
    return fetch_dynamic_symbols(max_price=max_price)


if __name__ == "__main__":
    syms = fetch_dynamic_symbols()
    print(f"Dynamic movers fetched: {len(syms)}")
    if syms[:10]:
        print("Sample:", ", ".join(syms[:10]))
