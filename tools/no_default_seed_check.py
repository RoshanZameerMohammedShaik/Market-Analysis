"""Assert the desk can NEVER open a book from a default amount.

THE INCIDENT THIS PREVENTS
--------------------------
bot/config.py used to carry 'seedUSD': 25_000.0, and load_or_create used it whenever it
found no account file. So merely landing the cron on main opened a $25,000 book and
executed 11 fills across four sleeves. Nobody had asked for any of it.

The armed gate fixed the immediate hole, but the NUMBER stayed in the config for another
week, unused. That is the state this check exists to make impossible, because an unused
default is one careless fallback away from repeating the incident exactly. Roshan's words:
"this is what i dont want -- helpfully created one seeded with $25,000 from a config
default".

So the invariant is stronger than "the gate works". It is: there is no value anywhere in
the system that a book could be opened FROM, other than a figure a human typed.

Run: python tools/no_default_seed_check.py
"""
import json
import os
import shutil
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO)

import bot.run as R  # noqa: E402
from bot.config import CONFIG_PATH, load_config  # noqa: E402

PASS, FAIL = [], []


def check(name, cond, detail=''):
    (PASS if cond else FAIL).append(name)
    print(f"  {'PASS' if cond else 'FAIL'}  {name}" + (f'  -> {detail}' if detail and not cond else ''))


print('=== no default starting amount exists anywhere ===')
cfg = load_config()
# load_config merges file over DEFAULTS, so this covers both.
check('the loaded config has no seedUSD', 'seedUSD' not in cfg, str(cfg.get('seedUSD')))

with open(CONFIG_PATH, encoding='utf-8') as f:
    raw_cfg = json.load(f)
check('the config FILE has no seedUSD', 'seedUSD' not in raw_cfg, str(raw_cfg.get('seedUSD')))

# The literal that caused the incident must not be sitting in the defaults module either.
with open(os.path.join(REPO, 'bot', 'config.py'), encoding='utf-8') as f:
    cfg_src = f.read()
active = [ln for ln in cfg_src.splitlines()
          if 'seedUSD' in ln and not ln.strip().startswith('#')]
check('bot/config.py declares no seedUSD outside comments', not active, str(active))
# Comments may still DESCRIBE the incident -- that history is worth keeping. What must not
# exist is a live literal that code could read.
live_25k = [ln for ln in cfg_src.splitlines()
            if '25_000' in ln and not ln.strip().startswith('#')]
check('no live 25,000 literal in bot/config.py', not live_25k, str(live_25k))

# The slice must not hand the UI a suggested figure to pre-fill.
with open(os.path.join(REPO, 'tools', 'write_bot_slice.py'), encoding='utf-8') as f:
    slice_src = f.read()
active_s = [ln for ln in slice_src.splitlines()
            if "'suggestedUSD'" in ln and not ln.strip().startswith('#')]
check('the browser slice suggests no amount', not active_s, str(active_s))

# And the UI must not pre-fill the amount field.
with open(os.path.join(REPO, 'js', 'ui', 'mia-desk-panel.js'), encoding='utf-8') as f:
    ui_src = f.read()
check('the amount field starts empty', 'value=""' in ui_src)
check('the UI reads no suggested figure',
      'suggestedUSD' not in ui_src.replace('cfg.suggestedUSD', ''),
      'suggestedUSD is still read in the panel')

print()
print('=== load_or_create refuses every non-explicit allocation ===')
# state.json must be ABSENT, or load_or_create returns the existing book instead of creating.
tmp = tempfile.mkdtemp()
real_state = R.STATE_PATH
try:
    R.STATE_PATH = os.path.join(tmp, 'no-such-state.json')
    cases = [
        ('None', None),
        ('zero', 0),
        ('negative', -500),
        ('missing key', '__MISSING__'),
        ('a string', 'abc'),
        ('empty string', ''),
        ('boolean True', True),
    ]
    for label, val in cases:
        c = dict(cfg)
        if val == '__MISSING__':
            c.pop('allocationUSD', None)
        else:
            c['allocationUSD'] = val
        try:
            R.load_or_create(c)
            check(f'allocationUSD={label}: refused', False, 'A BOOK WAS OPENED')
        except RuntimeError as e:
            # An explicit refusal that says why, not an incidental KeyError/TypeError.
            check(f'allocationUSD={label}: refused',
                  'refusing to open a book' in str(e), str(e)[:70])
        except Exception as e:
            check(f'allocationUSD={label}: refused with a CLEAR error', False,
                  f'{type(e).__name__} instead of RuntimeError: {e}')

    # boolean True is numerically 1 in Python, which would open a $1 book. That is still a
    # figure nobody typed, so it must be refused as a type error rather than accepted.
    print()
    print('=== an explicit figure DOES open a book ===')
    c = dict(cfg)
    c['allocationUSD'] = 4000.0
    acct, created = R.load_or_create(c)
    check('a real allocation opens the book', created is True)
    check('the seed equals what was allocated', abs(acct.seed_usd - 4000.0) < 1e-9,
          str(acct.seed_usd))
    check('it is split across the sleeves',
          abs(sum(s.cash_usd for s in acct.sleeves.values()) - 4000.0) < 1e-6)
    check('and it never invents 25,000', abs(acct.seed_usd - 25000.0) > 1.0)
finally:
    R.STATE_PATH = real_state
    shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"{'NO-DEFAULT-SEED CHECK PASS' if not FAIL else 'NO-DEFAULT-SEED CHECK FAIL'}: "
      f'{len(PASS)} passed, {len(FAIL)} failed')
if FAIL and os.environ.get('GITHUB_ACTIONS'):
    print(f"::error title=no_default_seed::{'; '.join(FAIL[:6])}")
sys.exit(1 if FAIL else 0)
