"""
Write the retrain marker after a successful retrain so the next
should_retrain.py run measures new resolutions from this point.

Marker: model/.last_retrain.json  { "at": ISO_UTC, "resolved_total": N }
"""
import json
import os
import sys

# Add the tools/ dir itself to the path so `should_retrain` imports
# whether this is run as `python tools/mark_retrain.py` or as a module.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from should_retrain import count_resolved  # noqa: E402 (path set above)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKER = os.path.join(REPO, 'model', '.last_retrain.json')


def main():
    # Stamp time on the CLI via an arg so the script stays deterministic
    # for resume/replay (Date.now() banned in workflow scripts, but this
    # is a plain Python cron step so datetime is fine here).
    import datetime
    payload = {
        'at': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'resolved_total': count_resolved(),
    }
    os.makedirs(os.path.dirname(MARKER), exist_ok=True)
    with open(MARKER, 'w', encoding='utf-8') as f:
        json.dump(payload, f)
    print(f'[mark_retrain] wrote marker: {payload}')


if __name__ == '__main__':
    main()
