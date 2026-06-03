"""
Dynamic penny fetcher for the daily cron. Pulls Yahoo's predefined
screeners (aggressive_small_caps, day_gainers, day_losers,
most_actives), filters to sub-$5 listed equity, returns the symbol
list.

Used by record_predictions.py to expand each daily ledger run beyond
the static penny_universe.SYMBOLS — so movers that aren't on the
curated stable list still get analyzed + recorded today.

If yfinance / Yahoo screener call fails for any reason, returns an
empty list so the cron continues with whatever's in the static
universe. Failure is non-fatal by design.
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


def fetch_dynamic_pennies(max_price: float = 5.0) -> List[str]:
    """
    Pull all four screeners and return de-duplicated symbols where the
    listed price is < max_price. Skips ETFs, OTC ('.'-suffixed), futures
    ('=' in symbol), and crypto pairs ('-USD').
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
            price = q.get("regularMarketPrice")
            if not isinstance(price, (int, float)) or price >= max_price:
                continue
            seen.add(sym)
            out.append(sym)
    return out


if __name__ == "__main__":
    syms = fetch_dynamic_pennies()
    print(f"Dynamic pennies fetched: {len(syms)}")
    if syms[:10]:
        print("Sample:", ", ".join(syms[:10]))
