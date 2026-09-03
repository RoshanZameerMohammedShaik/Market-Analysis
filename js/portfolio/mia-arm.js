// Starting and stopping Mia 2.0's desk from the browser.
//
// THE PROBLEM THIS SOLVES
// ----------------------
// Mia's executor runs in GitHub Actions, not in the tab, which is the whole reason she keeps
// trading with the browser closed. But that puts her config on the other side of a boundary
// the page cannot write: a static site has no server and no repo credentials. So "press
// Start and choose an amount" needs a way to reach Actions.
//
// Roshan chose a fine-grained personal access token, pasted once and kept in localStorage,
// the same arrangement already used for the Gemini key. That makes Start genuinely one
// click. It is also a real credential sitting in browser storage on a public site, so the
// scope is deliberately the narrowest that works:
//
//     Repository access : ONLY this repository
//     Actions           : Read and write   (dispatch the workflow, read the run's result)
//     Contents          : Read-only        (read back model/bot/config.json to confirm)
//
// With that scope the worst case if the token leaks is someone triggering workflow runs in
// one paper-trading repo. It cannot read private repos, cannot push code, and cannot touch
// anything else in the account. A classic (non-fine-grained) token would grant far more, so
// the UI says "fine-grained" and this module does not try to detect or accommodate the old
// kind beyond letting it work.
//
// RULES THIS FILE FOLLOWS
// -----------------------
//   * The token is NEVER logged, never put in a URL, never included in an error message.
//     redact() runs over everything that could reach console or UI.
//   * It goes in the Authorization HEADER. A token in a query string lands in server logs,
//     proxy logs and Referer headers.
//   * The practice portfolio is debited only AFTER GitHub confirms the desk armed with the
//     exact amount requested. Debiting on click and hoping would destroy the money whenever
//     the workflow failed.

import { allocateToMia, miaAllocatedUSD, reclaimFromMia } from './state.js';

const OWNER = 'RoshanZameerMohammedShaik';
const REPO = 'Market-Analysis';
const WORKFLOW = 'mia-desk.yml';
const BRANCH = 'main';

// Separate key from the Gemini one so revoking either is independent.
const TOKEN_KEY = 'ma-gh-token-v1';
const API = 'https://api.github.com';

// The arm run is checkout + a stdlib-only Python call, so it is quick. This budget covers a
// cold runner and a queue wait without hanging the UI forever.
const CONFIRM_TIMEOUT_MS = 240000;
const POLL_MS = 4000;

export const TOKEN_SCOPE_HELP = {
    url: `https://github.com/settings/personal-access-tokens/new`,
    lines: [
        'Fine-grained token, this repository only',
        'Actions: Read and write',
        'Contents: Read-only',
    ],
};

// ── token storage ────────────────────────────────────────────────────────────

export function hasToken() {
    return !!getToken();
}

function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}

export function setToken(tok) {
    const t = String(tok || '').trim();
    if (!t) throw new Error('Paste a token first.');
    // Shape check only, and deliberately loose: GitHub has changed token prefixes before
    // (ghp_, github_pat_, gho_...) and hard-coding the current set would reject a valid
    // future one. This catches a pasted URL or an obviously truncated string, and the real
    // verification is the API call in verifyToken().
    if (t.length < 20 || /\s/.test(t)) {
        throw new Error('That does not look like a token. Paste the whole value, no spaces.');
    }
    try { localStorage.setItem(TOKEN_KEY, t); } catch (_) {
        throw new Error('Could not save the token: browser storage is unavailable.');
    }
}

export function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (_) {}
}

/** Strip anything token-shaped out of text before it can reach a log or the UI. */
function redact(text) {
    const t = getToken();
    let s = String(text ?? '');
    if (t) s = s.split(t).join('[token redacted]');
    // Also catch a token that is not the stored one, e.g. mid-rotation.
    return s.replace(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/g, '[token redacted]');
}

// ── API plumbing ─────────────────────────────────────────────────────────────

async function gh(path, opts = {}) {
    const tok = getToken();
    if (!tok) throw new Error('No GitHub token saved.');
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            ...opts,
            headers: {
                // HEADER, never a query parameter. See the module note.
                Authorization: `Bearer ${tok}`,
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
                ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
                ...(opts.headers || {}),
            },
        });
    } catch (err) {
        throw new Error(`Could not reach GitHub: ${redact(err.message)}`);
    }
    if (res.status === 401) {
        throw new Error('GitHub rejected the token (401). It may be expired or revoked.');
    }
    if (res.status === 403) {
        throw new Error('GitHub refused (403). The token is probably missing the '
            + '"Actions: Read and write" permission on this repository.');
    }
    if (res.status === 404) {
        throw new Error('GitHub returned 404. The token likely has no access to this '
            + 'repository, or the workflow file is not on the default branch yet.');
    }
    if (!res.ok) {
        let detail = '';
        try { detail = (await res.json())?.message || ''; } catch (_) {}
        throw new Error(`GitHub error ${res.status}${detail ? `: ${redact(detail)}` : ''}`);
    }
    if (res.status === 204) return null;   // dispatch returns no body
    return res.json();
}

/** Cheap round trip that proves the token works and has repo access. */
export async function verifyToken() {
    const r = await gh(`/repos/${OWNER}/${REPO}`);
    return { repo: r?.full_name };
}

// ── reading the desk's committed config ──────────────────────────────────────

/** Read model/bot/config.json through the CONTENTS API, not the deployed site.
 *
 *  The site is served by Cloudflare Pages, whose cache can be hours stale and which answers
 *  a missing file with HTTP 200 and index.html. Neither is acceptable for deciding whether
 *  real money moved, so this reads the repo directly. */
async function readDeskConfig() {
    const r = await gh(`/repos/${OWNER}/${REPO}/contents/model/bot/config.json`
        + `?ref=${BRANCH}&t=${Date.now()}`);
    if (!r?.content) throw new Error('config.json came back empty.');
    // atob gives Latin-1; the config is ASCII, but decode properly anyway so a future
    // non-ASCII note cannot corrupt the parse.
    const bytes = Uint8Array.from(atob(r.content.replace(/\n/g, '')), c => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
}

export async function fetchDeskState() {
    const cfg = await readDeskConfig();
    return {
        armed: !!cfg.armed,
        allocationUSD: cfg.allocationUSD ?? null,
        armedAt: cfg.armedAt ?? null,
        minAllocationUSD: 400,
    };
}

// ── arm / disarm ─────────────────────────────────────────────────────────────

async function dispatch(inputs) {
    const startedAt = Date.now();
    await gh(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
        method: 'POST',
        body: JSON.stringify({ ref: BRANCH, inputs }),
    });
    return startedAt;
}

/** Wait for the dispatched run to finish, then return its conclusion.
 *
 *  workflow_dispatch does not tell you which run it created, so the run is matched on
 *  "created at or after the moment we dispatched". The 30s slack absorbs clock skew between
 *  the browser and GitHub, which would otherwise make a real run invisible and report a
 *  false timeout. */
async function awaitRun(dispatchedAt, onStatus = () => {}) {
    const deadline = dispatchedAt + CONFIRM_TIMEOUT_MS;
    const floor = new Date(dispatchedAt - 30000).toISOString();
    let seen = null;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const r = await gh(`/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`
            + `/runs?event=workflow_dispatch&per_page=5`);
        const run = (r?.workflow_runs || []).find(x => x.created_at >= floor);
        if (!run) continue;
        seen = run;
        if (run.status === 'completed') {
            // A run CANCELLED without us asking means GitHub discarded it: only one run can
            // be pending per concurrency group, so a second click supersedes the first. Say
            // so rather than reporting a mysterious failure.
            if (run.conclusion === 'cancelled') {
                return { conclusion: 'cancelled', url: run.html_url,
                         note: 'GitHub cancelled it, usually because a newer run of the same '
                             + 'kind superseded it. Try once and wait.' };
            }
            return { conclusion: run.conclusion, url: run.html_url };
        }
        // QUEUED is not RUNNING, and conflating them is why a reset looked like it was
        // working for hours. A dispatched control action used to share a concurrency group
        // with the 4h50m trading loop, so it sat pending until that finished. Surfacing the
        // distinction lets the UI say what is actually happening.
        onStatus(run.status === 'queued' || run.status === 'pending' ? 'queued' : 'running');
    }
    return {
        conclusion: 'timeout',
        url: seen?.html_url
            || `https://github.com/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}`,
    };
}

/**
 * Start the desk with `amountUSD`, then move that cash out of the practice portfolio.
 *
 * ORDER MATTERS. GitHub is asked first and the portfolio is debited only once the repo
 * confirms `armed` with this exact amount. Debiting first would delete the money on any
 * workflow failure, and this function is the only place the two books can desync.
 *
 * onProgress(stage, detail) drives the UI: 'dispatching' | 'running' | 'confirming' | 'done'.
 */
export async function armDesk(amountUSD, positions, onProgress = () => {}) {
    const usd = Number(amountUSD);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('Enter an amount.');

    const before = await fetchDeskState();
    if (before.armed) {
        throw new Error('The desk is already running. Stop it before allocating again.');
    }
    if (usd < before.minAllocationUSD) {
        throw new Error(`Minimum is $${before.minAllocationUSD}. Four strategies split the `
            + `allocation and each still has to clear the $25 minimum trade size.`);
    }

    onProgress('dispatching');
    // Sent as a string: workflow_dispatch inputs are strings, and 5000 would otherwise be
    // rejected as the wrong type.
    // Sent as strings: workflow_dispatch inputs are always strings and a number is rejected
    // as the wrong type.
    const n = Math.max(1, Math.floor(Number(positions) || 3));
    const at = await dispatch({ mode: 'arm', allocationUSD: String(usd),
                                positions: String(n) });

    onProgress('running');
    const run = await awaitRun(at, s => onProgress(s));
    if (run.conclusion !== 'success') {
        throw new Error(`The start job ${run.conclusion === 'timeout'
            ? 'is taking longer than expected' : `failed (${run.conclusion})`}. `
            + `Nothing was taken from your portfolio. See ${run.url}`);
    }

    // Verify against the repo rather than trusting a green run. A workflow can succeed
    // while having written something other than what was asked for, and this is the last
    // point at which the two books can still be kept consistent.
    onProgress('confirming');
    const after = await fetchDeskState();
    if (!after.armed) {
        throw new Error('The job succeeded but the desk still reports as not started. '
            + 'Nothing was taken from your portfolio.');
    }
    if (Math.abs(Number(after.allocationUSD) - usd) > 0.01) {
        throw new Error(`The desk armed with $${after.allocationUSD} but $${usd} was `
            + `requested. Nothing was taken from your portfolio; stop the desk and retry.`);
    }

    // Confirmed. Now, and only now, move the cash.
    const moved = allocateToMia({
        amountUSD: usd,
        note: `Allocated to Mia 2.0 at ${after.armedAt || new Date().toISOString()}`,
    });
    onProgress('done', moved);
    return { ...after, ...moved, runUrl: run.url };
}

/**
 * Stop the desk. Does NOT return the cash.
 *
 * Her money is in open positions, and the honest value of a half-liquidated book is not
 * knowable from here. Reclaiming is a separate action that has to sell first, so stopping
 * is kept deliberately narrow: it freezes trading and nothing else. miaAllocatedUSD stays
 * as it was, which is correct, because the capital really is still hers.
 */
export async function disarmDesk(onProgress = () => {}) {
    onProgress('dispatching');
    const at = await dispatch({ mode: 'disarm' });
    onProgress('running');
    const run = await awaitRun(at, s => onProgress(s));
    if (run.conclusion !== 'success') {
        throw new Error(`The stop job ${run.conclusion === 'timeout'
            ? 'is taking longer than expected' : `failed (${run.conclusion})`}. `
            + `See ${run.url}`);
    }
    onProgress('confirming');
    const after = await fetchDeskState();
    if (after.armed) throw new Error('The job succeeded but the desk still reports running.');
    onProgress('done');
    return { ...after, allocatedUSD: miaAllocatedUSD(), runUrl: run.url };
}


/**
 * Wipe the desk and hand the money back.
 *
 * DESTRUCTIVE and deliberately so: it deletes state, every fill, every run row and the
 * learner's conclusions. That record is the entire point of the desk, and it is the only
 * copy -- a market open cannot be replayed -- so the caller must confirm first.
 *
 * `equityUSD` is what comes back to the practice portfolio, and it is the desk's CURRENT
 * equity rather than the original allocation. Returning the allocation would invent or
 * destroy money depending on which way the book had moved; returning equity conserves it.
 * Open positions are treated as liquidated at their last marks, which is a simplification
 * that only holds because this is paper money and the user asked for it explicitly.
 *
 * The reclaim happens only AFTER GitHub confirms the wipe, same ordering as armDesk: if the
 * workflow fails, the desk is untouched and so is the portfolio.
 */
export async function resetDesk(equityUSD, onProgress = () => {}) {
    onProgress('dispatching');
    const at = await dispatch({ mode: 'reset' });
    onProgress('running');
    const run = await awaitRun(at, s => onProgress(s));
    if (run.conclusion !== 'success') {
        throw new Error(`The reset job ${run.conclusion === 'timeout'
            ? 'is taking longer than expected' : `did not complete (${run.conclusion})`}. `
            + `${run.note ? run.note + ' ' : ''}Nothing was changed. See ${run.url}`);
    }
    onProgress('confirming');
    const after = await fetchDeskState();
    // --reset disarms as part of the wipe, so a desk still reporting armed means it did not
    // actually run and the money must NOT be moved.
    if (after.armed) {
        throw new Error('The reset job succeeded but the desk still reports as running. '
            + 'Nothing was taken or returned.');
    }
    let returned = 0;
    const owed = Number(equityUSD);
    if (Number.isFinite(owed) && owed > 0) {
        try {
            reclaimFromMia({ amountUSD: owed, note: 'Returned from Mia 2.0 on reset' });
            returned = owed;
        } catch (err) {
            // The wipe already happened, so surface this rather than swallowing it: the two
            // books are now out of step and the user needs to know by how much.
            throw new Error(`The desk was reset, but returning ${owed.toFixed(2)} to your `
                + `portfolio failed: ${err.message}`);
        }
    }
    onProgress('done');
    return { ...after, returnedUSD: returned, allocatedUSD: miaAllocatedUSD(),
             runUrl: run.url };
}
