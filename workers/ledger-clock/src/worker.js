// Fires the Live ledger's slots on time. See ../wrangler.toml for why and for setup.
//
// SLOTS MIRRORS the `schedule:` block and "Decide task" table in .github/workflows/live-ledger.yml;
// tools/ledger_clock_check.py fails CI if the two ever disagree. Times are UTC.

const REPO = 'RoshanZameerMohammedShaik/Market-Analysis';
const WORKFLOW = 'live-ledger.yml';
// Exchange calendar published nightly by tools/write_market_sessions.py. Used only to skip a
// region that is closed for a holiday, so the run does not fail with "no data" and email.
const SESSIONS_URL = 'https://market-ai.pages.dev/model/market_sessions.json';

// [minute, hour, cron weekdays (0 = Sunday), task, regions whose session it records]
export const SLOTS = [
    [35, 13, [1, 2, 3, 4, 5], 'predict-NYSE', ['NYSE']],
    [5, 8, [1, 2, 3, 4, 5], 'predict-LSE-XETRA', ['LSE', 'XETRA']],
    [50, 3, [1, 2, 3, 4, 5], 'predict-NSE', ['NSE']],
    [35, 1, [1, 2, 3, 4, 5], 'predict-HKEX', ['HKEX']],
    [5, 0, [1, 2, 3, 4, 5], 'predict-TYO', ['TYO']],
    [5, 23, [0, 1, 2, 3, 4], 'predict-ASX', ['ASX']],
    [0, 0, [0, 1, 2, 3, 4, 5, 6], 'predict-CRYPTO', []],
    [0, 22, [0, 1, 2, 3, 4, 5, 6], 'resolve-and-recalibrate', []],
];

const TZ = {
    NYSE: 'America/New_York', LSE: 'Europe/London', XETRA: 'Europe/Berlin', NSE: 'Asia/Kolkata',
    HKEX: 'Asia/Hong_Kong', TYO: 'Asia/Tokyo', ASX: 'Australia/Sydney',
};

function localDate(ms, tz) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date(ms));
    const g = (t) => p.find(x => x.type === t)?.value;
    return `${g('year')}-${g('month')}-${g('day')}`;
}

/** The slot due at this tick, or null. */
export function dueSlot(ms) {
    const d = new Date(ms);
    const m = d.getUTCMinutes(), h = d.getUTCHours(), wd = d.getUTCDay();
    return SLOTS.find(([sm, sh, days]) => sm === m && sh === h && days.includes(wd)) || null;
}

/** True when every region the task records is closed today for a published holiday. */
export function allClosed(regions, ms, sessions) {
    if (!regions.length || !sessions?.markets) return false;
    return regions.every((r) => {
        const mk = sessions.markets[r];
        if (!mk?.sessions?.length) return false;
        const day = localDate(ms, TZ[r]);
        const covered = day >= mk.sessions[0] && day <= mk.to;
        return covered && !mk.sessions.includes(day);
    });
}

async function dispatch(env, task) {
    const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
    const init = {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'market-analysis-ledger-clock',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main', inputs: { task } }),
    };
    let r = await fetch(url, init);
    if (r.status >= 500) {
        await new Promise((ok) => setTimeout(ok, 5000));
        r = await fetch(url, init);
    }
    return r.status;   // 204 = accepted
}

async function tick(ms, env) {
    const slot = dueSlot(ms);
    if (!slot) return { at: new Date(ms).toISOString(), action: 'none' };
    const [, , , task, regions] = slot;
    if (!env.GITHUB_DISPATCH_TOKEN) {
        console.log(`${task} due, but GITHUB_DISPATCH_TOKEN is not set; the GitHub schedule is the only trigger.`);
        return { task, action: 'no-token' };
    }
    let sessions = null;
    try {
        const r = await fetch(SESSIONS_URL, { cf: { cacheTtl: 600 } });
        if (r.ok) sessions = await r.json();
    } catch (_) { sessions = null; }
    if (allClosed(regions, ms, sessions)) {
        console.log(`${task} skipped: ${regions.join('+')} closed today (exchange holiday).`);
        return { task, action: 'holiday' };
    }
    const status = await dispatch(env, task);
    console.log(`${task} dispatched: HTTP ${status}`);
    return { task, action: status === 204 ? 'dispatched' : `failed-${status}` };
}

function nextSlots(ms, n = 6) {
    const out = [];
    let t = Math.ceil(ms / 300000) * 300000;
    while (out.length < n && t < ms + 8 * 864e5) {
        const s = dueSlot(t);
        if (s) out.push({ at: new Date(t).toISOString(), task: s[3] });
        t += 300000;
    }
    return out;
}

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(tick(event.scheduledTime, env));
    },
    async fetch(request, env) {
        const { pathname } = new URL(request.url);
        if (pathname === '/status') {
            return new Response(JSON.stringify({
                tokenSet: !!env.GITHUB_DISPATCH_TOKEN, now: new Date().toISOString(), next: nextSlots(Date.now()),
            }, null, 2), { headers: { 'content-type': 'application/json' } });
        }
        return new Response('ledger-clock: GET /status', { status: 404 });
    },
};
