"""Implied-volatility inputs for the volatility forecast, from two free sources.

  * DoltHub post-no-preference/options, table volatility_history: per-stock implied volatility
    (iv_current, annualized) since 2019-02, ~1,500 US names, updated daily. The full-table CSV
    export is one request (~230 MB); the SQL API caps at 1,000 rows and times out on per-symbol
    scans because the table is keyed by date, so the nightly job asks for one DATE instead.
  * CBOE index history: VIX9D (2011+), VIX3M (2009+), VVIX (2006+), the market's implied-vol
    term structure.

  python tools/fetch_vol_inputs.py           full history into model/_ohlc_cache (training)
  latest_stock_iv(before) / cboe_series()    used by tools/write_vol_slice.py each night
"""
import io
import json
import os
import sys
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(REPO, 'model', '_ohlc_cache')
UA = {'User-Agent': 'Mozilla/5.0 (Market-Analysis volatility research)'}
DOLT_SQL = 'https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master?q='
DOLT_CSV = 'https://www.dolthub.com/csv/post-no-preference/options/master/volatility_history'
CBOE = 'https://cdn.cboe.com/api/global/us_indices/daily_prices/{}_History.csv'
CBOE_SERIES = ('VIX9D', 'VIX3M', 'VVIX')


def _get(url, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()


def _sql(q):
    d = json.loads(_get(DOLT_SQL + urllib.parse.quote(q), timeout=60))
    if d.get('query_execution_status') != 'Success':
        raise RuntimeError(d.get('query_execution_message', 'query failed')[:200])
    return d['rows']


def latest_stock_iv(before):
    """{SYMBOL: iv_current} for the latest DoltHub date strictly before `before` (ISO date), and
    that date. Strictly before, because the model was trained on the previous session's IV: the
    nightly run happens before DoltHub publishes the day it is forecasting from."""
    day = _sql(f"SELECT MAX(date) AS d FROM volatility_history WHERE date < '{before}' AND date > DATE_SUB('{before}', INTERVAL 10 DAY)")[0]['d']
    if not day:
        return {}, None
    out, last = {}, ''
    while True:
        rows = _sql(f"SELECT act_symbol, iv_current FROM volatility_history WHERE date = '{day}' "
                    f"AND act_symbol > '{last}' ORDER BY act_symbol LIMIT 1000")
        for r in rows:
            try:
                v = float(r['iv_current'])
            except (TypeError, ValueError):
                continue
            if v > 0:
                out[r['act_symbol'].upper()] = v
        if len(rows) < 1000:
            return out, day
        last = rows[-1]['act_symbol']


def cboe_series(name):
    """[(iso_date, close)] oldest first."""
    import csv
    rows = list(csv.reader(io.StringIO(_get(CBOE.format(name)).decode('utf-8'))))
    head = [h.strip().upper() for h in rows[0]]
    ci = head.index('CLOSE') if 'CLOSE' in head else len(head) - 1
    out = []
    for r in rows[1:]:
        try:
            m, d, y = r[0].split('/')
            out.append((f'{y}-{int(m):02d}-{int(d):02d}', float(r[ci])))
        except (ValueError, IndexError):
            continue
    return out


def main():
    os.makedirs(CACHE, exist_ok=True)
    data = _get(DOLT_CSV, timeout=600)
    with open(os.path.join(CACHE, '_iv_full.csv'), 'wb') as f:
        f.write(data)
    print(f'DoltHub volatility_history: {len(data) / 1e6:.0f} MB')
    for s in CBOE_SERIES:
        rows = cboe_series(s)
        with open(os.path.join(CACHE, f'_cboe_{s}.json'), 'w') as f:
            json.dump(rows, f)
        print(f'CBOE {s}: {len(rows)} days, {rows[0][0]} to {rows[-1][0]}')


if __name__ == '__main__':
    sys.exit(main())
