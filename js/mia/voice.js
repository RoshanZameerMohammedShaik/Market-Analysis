// Mia voice mode (Version A — free).
//
// What this module does:
//   1. Adds a mic button next to the send button in the chat footer.
//   2. On click, opens a full-panel "voice mode" overlay with a glowing orb.
//   3. Listens via Web Speech API (free, native to Chrome/Edge/Safari).
//   4. On final transcript, runs the existing Mia agent (runTurn) with the
//      same tools and the same Gemini backend the text mode uses.
//   5. Streams the reply, breaks it into sentence-sized chunks, and speaks
//      each chunk via SpeechSynthesis so the user starts hearing audio
//      within ~1 second of the model's first token (not after the whole
//      reply finishes).
//   6. Drives the orb's amplitude in real time:
//        - while listening: from the mic AnalyserNode
//        - while speaking: from the synthesised utterance boundary events
//          (browser TTS does not expose raw audio, so we approximate with
//          a smooth oscillation that pauses at sentence boundaries — looks
//          right to the eye, and matches how ChatGPT's orb behaves visually)
//   7. Tap the orb anytime to interrupt: cancels recognition, cancels TTS,
//      aborts the streaming agent. Tap again to keep talking.
//   8. After Mia finishes speaking, the mic auto-reopens so you can keep
//      having a conversation without tapping anything.
//
// Why we approximate amplitude during speech: the only browsers that
// expose raw TTS audio are behind paid realtime APIs. Browser native
// SpeechSynthesis emits 'boundary' events at word boundaries — we use
// those plus a smoothed sinusoid to drive the orb. The user experience
// is indistinguishable from a real waveform unless you put them side by
// side with an oscilloscope.
//
// Free and self-contained: no infra cost, no new dependencies.

import { runTurn } from './agent.js';
import { buildSystemPrompt, buildContextBlock } from './prompt.js';
import { loadHistory, saveHistory } from './memory.js';
import { renderThread, actionVerbFor } from './mia.js';
import { openSidePanel, closeSidePanel, isSidePanelOpen } from '../ui/side-panel-stack.js';
import { setLauncherVis } from '../ui/launcher-vis.js';
import { isConfigured, loadSettings } from './settings.js';
import { openLiveSession, startMicCapture, createAudioOutputQueue, VOICE_LIVE_MODELS } from './voice-live.js';
import { runTool } from './tools.js';
import { TOOL_DECLARATIONS } from './tool-schemas.js';
import * as miaSound from './sound.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const TTS_AVAILABLE = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

// Sentence-boundary chunker. We feed this with streaming deltas and pull
// "ready to speak" sentences out the other end. Anything that ends with
// .  ?  !  ;  : (or a newline) flushes; otherwise we hold the trailing
// fragment until more text arrives or the stream finishes.
function makeSentenceChunker() {
    let buf = '';
    return {
        push(text) {
            buf += text;
            const out = [];
            const SENTENCE_END = /([\.\?\!\;\:])(\s|$)/;
            while (true) {
                const m = buf.match(SENTENCE_END);
                if (!m) break;
                const cut = m.index + 1;
                out.push(buf.slice(0, cut).trim());
                buf = buf.slice(cut).replace(/^\s+/, '');
            }
            // Hard newline acts like sentence end (handles list bullets,
            // numbered points etc. — gives Mia natural pauses).
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                out.push(buf.slice(0, nl).trim());
                buf = buf.slice(nl + 1);
            }
            return out.filter(s => s.length > 0);
        },
        flush() {
            const rest = buf.trim();
            buf = '';
            return rest ? [rest] : [];
        },
    };
}

// Strip emoji + pictographs before sending to TTS. Web Speech API's
// browser voices verbalize emojis as their Unicode names ("smiling
// face with smiling eyes", "thumbs up sign") which sounds robotic and
// breaks immersion. The visible chat bubble keeps the emoji — only
// the audio stream gets stripped.
//
// Cast a wide net by combining several Unicode property classes:
//   Extended_Pictographic   — most emoji (faces, hearts, animals, etc.)
//   Emoji                   — broader set including dingbats
//   Emoji_Modifier          — skin-tone modifiers U+1F3FB..U+1F3FF
//   Emoji_Component         — zero-width joiner glue + keycap chars
// Also explicitly cover regional indicators (flags) and the ZWJ /
// variation selector codepoints that build composite emoji sequences.
const EMOJI_REGEX = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Emoji_Component}|[\u{1F1E6}-\u{1F1FF}]|[‍️]/gu;

// Strip stuff that doesn't read well aloud: markdown bold/italic, code
// fences, list bullets, our own §§MIA_UNVERIFIED:...§§ sentinel, link
// brackets, bare URLs, the agent's TOOL: scaffolding, and emoji.
//
// Currency / percent handling:
//   "$84.44" → "84.44" — TTS reads "$" as "dollar" each time, so a
//      sentence like "$85.27 - $84.44" sounds like "dollar 85.27 dollar
//      84.44" — clunky with multiple prices in one sentence. Strip the
//      glyph; Mia's prompt is responsible for whether to add "dollars"
//      verbally when the context calls for it.
//   "0.98%" → "0.98 percent" — make sure TTS pronounces it consistently
//      (some engines say "percent", some say "percentage sign", some
//      say nothing). Inserting the word ourselves removes the ambiguity.
//   Markdown bold residues (`**` or stray `*`) and table pipes (`|`)
//      get scrubbed too; otherwise TTS reads them as "asterisk" / "bar".
function speakable(text) {
    return String(text || '')
        .replace(/§§MIA_UNVERIFIED:[^§]*§§/g, '')
        .replace(/```[\s\S]*?```/g, ' (code) ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/^[\s\-\*\+]+/gm, '')
        .replace(/^\d+\.\s+/gm, '')
        .replace(/[#>]/g, '')
        // Strip any lingering markdown / pipe / asterisk noise.
        .replace(/\*+/g, '')
        .replace(/\|/g, ' ')
        // Currency: drop the $ glyph entirely. "$84.44" → "84.44".
        // The TTS will read the digits naturally (e.g. "eighty-four
        // point four four") and Mia's prompt handles whether to add
        // "dollars" in the spoken phrasing for context.
        .replace(/\$(?=\d)/g, '')
        // Percent: insert the word so the engine pronounces it
        // consistently. "0.98%" → "0.98 percent".
        .replace(/(\d)\s*%/g, '$1 percent')
        // Strip emoji so the TTS doesn't read them as Unicode names.
        .replace(EMOJI_REGEX, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Voice panel docks to the right side instead of taking the whole screen.
// User can see and interact with the app while Mia talks (and also use
// Mia's navigation tools — controlSelectSymbol etc. — while still in
// voice mode). Has a minimize button: collapsing the panel turns the
// floating Mia launcher into a live orb that breathes/pulses with the
// session state, so the user knows Mia is still listening / speaking
// while they work.
//
// The orb's central core embeds Mia's M ECG SVG (her brand mark) so
// the visual identity ties together: Mia logo on launcher, on welcome
// avatar, and now beating inside the orb during voice sessions.
//
// Voice mode renders as an overlay layer INSIDE the chat panel, not as a
// separate side panel. CSS blurs the chat content behind it. That way
// switching from chat to voice doesn't open a second panel — same panel,
// different mode. The minimize / close controls live in the overlay
// itself; the chat panel header stays underneath.
const VOICE_OVERLAY_HTML = `
<div class="mia-voice-overlay" id="mia-voice-overlay" aria-hidden="true">
    <div class="mia-voice-stage">
        <div class="mia-voice-head">
            <span class="mia-voice-head-title">Converse</span>
            <div class="mia-voice-head-actions">
                <button class="mia-voice-min" id="mia-voice-min" title="Minimize — keep listening while you use the app" aria-label="Minimize">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12 L19 12"/></svg>
                </button>
                <button class="mia-voice-close" id="mia-voice-close" title="Exit voice mode" aria-label="Exit voice mode">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
                </button>
            </div>
        </div>
        <button class="mia-voice-orb" id="mia-voice-orb" type="button" aria-label="Tap to interrupt" data-state="idle">
            <canvas class="mia-voice-canvas" id="mia-voice-canvas" width="380" height="380"></canvas>
            <span class="mia-voice-orb-mark" aria-hidden="true">
                <svg viewBox="0 0 32 24" width="60" height="44" xmlns="http://www.w3.org/2000/svg">
                    <path class="mia-voice-orb-ecg-trace" d="M2 14 L6 14 Q8 14 9 12 T11 14 L14 6 L17 16 L20 6 L23 14 Q25 14 26 12 T28 14 L32 14" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.0" stroke-linecap="round" stroke-linejoin="round"/>
                    <path class="mia-voice-orb-ecg-blip" d="M2 14 L6 14 Q8 14 9 12 T11 14 L14 6 L17 16 L20 6 L23 14 Q25 14 26 12 T28 14 L32 14" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </span>
        </button>
        <div class="mia-voice-identity">
            <div class="mia-voice-status" id="mia-voice-status">Mia</div>
            <div class="mia-voice-subtitle">Market Intelligence Analyst</div>
        </div>
        <div class="mia-voice-transcript" id="mia-voice-transcript"></div>
    </div>
</div>`;

// State for the active voice session. Reset when the overlay opens.
const session = {
    open: false,
    minimized: false, // panel hidden but session still alive (mic + TTS active)
    state: 'idle', // idle | listening | thinking | speaking
    rec: null,
    audioCtx: null,
    analyser: null,
    micStream: null,
    rafId: null,
    abort: null,
    chunker: null,
    speakQueue: [],
    speaking: false,
    autoLoop: true,
    history: [], // local working copy so we can persist after each turn
    canvasCtx: null,
    canvas: null,
    canvasW: 0,
    canvasH: 0,
    amplitude: 0,
    smoothedAmp: 0,
    speechClock: 0,
    accentRgb: '124, 58, 237', // overwritten from CSS at open time
    lastBoundaryTs: 0,
    lastSpokenChunkLen: 0,
    finalTranscript: '',
    // Live API mode (Gemini native voice). Populated when settings.voiceLive
    // is on; null otherwise. liveSession is the WebSocket handle, liveMic
    // is the AudioWorklet capture handle, liveAudioOut is the playback queue.
    liveMode: false,
    liveSession: null,
    liveMic: null,
    liveAudioOut: null,
    interimTranscript: '',
    // Live-mode per-turn buffers. The Live API streams transcription
    // text in tiny fragments (often single words or syllables). We
    // accumulate them into running strings and flush to the visible
    // captions + chat history on turnComplete. Without these, the UI
    // got one DOM block per fragment → "word below word" stacking.
    liveUserUtterance: '',     // current turn's user-spoken text
    liveMiaUtterance: '',      // current turn's Mia-spoken text
    liveTurnPersisted: false,  // guard so a single turn only saves once
    // When a connect is in flight, the first transition into 'listening'
    // plays the warm "connected/ready" resolve instead of the ordinary
    // listening cue. Set at connect time, cleared once consumed / on close.
    awaitingConnectCue: false,
};

export function initVoice() {
    if (!isVoiceSupported()) return;
    insertVoiceButton();
    ensureVoiceOverlayMounted();
}

// The voice overlay lives inside .mia-panel so chat and voice share the
// same container. mia.js's renderChat() rebuilds the panel innerHTML on
// every open/back-from-settings, which would wipe the overlay — so we
// re-mount on every call. Cheap; the markup is static.
function ensureVoiceOverlayMounted() {
    const panel = document.getElementById('mia-panel');
    if (!panel) return;
    if (panel.querySelector('#mia-voice-overlay')) return;
    panel.insertAdjacentHTML('beforeend', VOICE_OVERLAY_HTML);
    wireOverlayEvents();
}

export function isVoiceSupported() {
    return !!(SR && TTS_AVAILABLE);
}

// Re-attach the mic button + voice overlay after each renderChat() —
// mia.js rebuilds the panel innerHTML so both need to re-insert.
export function attachVoiceButton() {
    if (!isVoiceSupported()) return;
    insertVoiceButton();
    ensureVoiceOverlayMounted();
    // Hook the chat-panel close button so closing the panel while voice
    // is active treats it as minimize (panel slides away, voice keeps
    // running, launcher becomes orb). Without this hook, closing chat
    // would leave voice running with no visible UI at all.
    const closeBtn = document.getElementById('mia-close-btn');
    if (closeBtn && !closeBtn.dataset.voiceHooked) {
        closeBtn.dataset.voiceHooked = '1';
        closeBtn.addEventListener('click', (e) => {
            if (session.open && !session.minimized) {
                e.preventDefault();
                e.stopImmediatePropagation();
                minimizeVoice();
            }
        }, true); // capture so we beat mia.js's togglePanel
    }
    // If a voice session was already active when the panel re-rendered
    // (e.g., user opened settings and came back), restore the visual
    // state so the orb/transcript pick up where they left off.
    if (session.open && !session.minimized) {
        const panel = document.getElementById('mia-panel');
        if (panel) panel.classList.add('voice-active');
        const overlay = document.getElementById('mia-voice-overlay');
        if (overlay) overlay.setAttribute('aria-hidden', 'false');
        setupCanvas();
        startCanvasLoop();
        setOrbState(session.state);
    }
}

function insertVoiceButton() {
    const foot = document.querySelector('.mia-foot');
    if (!foot) return;
    if (foot.querySelector('.mia-voice-btn')) return;
    if (!isConfigured()) return; // No backend yet — voice would have nothing to call.
    const btn = document.createElement('button');
    btn.className = 'mia-voice-btn';
    btn.id = 'mia-voice-btn';
    btn.title = 'Voice mode — talk to Mia';
    btn.setAttribute('aria-label', 'Open voice mode');
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="9" y="3" width="6" height="12" rx="3"/>
            <path d="M5 11a7 7 0 0 0 14 0"/>
            <path d="M12 18v3"/>
        </svg>`;
    btn.addEventListener('click', openVoice);
    // Insert before the action button so the order reads: textarea | mic | send.
    const actionBtn = foot.querySelector('.mia-action-btn');
    if (actionBtn) foot.insertBefore(btn, actionBtn);
    else foot.appendChild(btn);
}

function wireOverlayEvents() {
    document.getElementById('mia-voice-close').addEventListener('click', closeVoice);
    document.getElementById('mia-voice-min').addEventListener('click', minimizeVoice);
    document.getElementById('mia-voice-orb').addEventListener('click', onOrbTap);
    // The Mia launcher is the entry point AND the minimized handle —
    // tapping it while a session is minimized re-opens the panel.
    // GUARD against re-attaching: wireOverlayEvents runs on every
    // renderChat/overlay re-mount, and #mia-launcher is persistent — without
    // a dedup flag the listener stacked, so one tap fired N times (and the
    // extra onOrbTap()->startListening() calls raced the SR teardown). Match
    // the dataset-flag pattern wireLauncherHoldToVoice already uses.
    const launcher = document.getElementById('mia-launcher');
    if (launcher && !launcher.dataset.voiceTapWired) {
        launcher.dataset.voiceTapWired = '1';
        launcher.addEventListener('click', (e) => {
            if (session.minimized && session.open) {
                e.preventDefault();
                e.stopImmediatePropagation();
                // While minimized, the launcher acts as both the orb (interrupt
                // mid-sentence) AND the restore handle. If Mia is actively
                // speaking or thinking, treat the tap as an interrupt — same
                // as tapping the main orb. If she's listening or idle, just
                // restore the panel so the user can see what's going on.
                if (session.state === 'speaking' || session.state === 'thinking') {
                    onOrbTap();
                } else {
                    restoreVoice();
                }
            }
        }, true); // capture phase so we beat the chat-toggle handler
    }
    wireLauncherHoldToVoice();
}

// Long-press on the Mia launcher opens voice mode directly. Mirrors
// the send-button hold-to-clear-chat pattern: short tap = toggle chat
// panel (existing behavior), long press (700ms) = jump straight into
// voice mode. Cancels the click so the chat panel doesn't open
// behind/in front of the voice overlay.
function wireLauncherHoldToVoice() {
    const launcher = document.getElementById('mia-launcher');
    if (!launcher || launcher.dataset.holdToVoiceWired === '1') return;
    launcher.dataset.holdToVoiceWired = '1';

    const HOLD_MS = 700;
    let holdTimer = null;
    let armed = false;
    let pressed = false;

    const begin = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        // Don't trigger hold while a voice session is already running —
        // the tap-to-restore path handles that.
        if (session.open) return;
        if (!isVoiceSupported() || !isConfigured()) return;
        pressed = true;
        armed = false;
        launcher.classList.add('mia-launcher-arming');
        holdTimer = setTimeout(() => {
            if (!pressed) return;
            armed = true;
            launcher.classList.remove('mia-launcher-arming');
            launcher.classList.add('mia-launcher-fired');
            setTimeout(() => launcher.classList.remove('mia-launcher-fired'), 500);
            try { openVoice(); } catch (_) {}
        }, HOLD_MS);
    };
    const cleanup = () => {
        pressed = false;
        if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
        launcher.classList.remove('mia-launcher-arming');
    };
    const end = (e) => {
        if (armed) {
            // We fired voice — swallow the click so togglePanel doesn't
            // also open the chat panel underneath.
            e?.preventDefault?.();
            e?.stopImmediatePropagation?.();
        }
        cleanup();
    };

    launcher.addEventListener('mousedown', begin);
    launcher.addEventListener('touchstart', begin, { passive: true });
    launcher.addEventListener('mouseup', end);
    launcher.addEventListener('touchend', end);
    launcher.addEventListener('mouseleave', cleanup);
    launcher.addEventListener('touchcancel', cleanup);
    // If voice fired, also swallow the synthesized click that follows.
    launcher.addEventListener('click', (e) => {
        if (armed) {
            e.preventDefault();
            e.stopImmediatePropagation();
            armed = false;
        }
    }, true);
}

async function openVoice() {
    if (!isVoiceSupported()) return;
    if (!isConfigured()) return;
    session.open = true;
    session.minimized = false;
    session.autoLoop = true;
    session.history = loadHistory();
    // Make sure the chat panel is open and switch it to voice mode. The
    // panel itself stays mounted; only the overlay layer + blur class
    // change. Chat content (head, thread, foot) fades+blurs behind.
    // Route .open through the side-panel stack so the Portfolio panel
    // (if also open) recomputes its layout.
    if (!isSidePanelOpen('mia')) openSidePanel('mia');
    const panel = document.getElementById('mia-panel');
    ensureVoiceOverlayMounted();
    if (panel) panel.classList.add('voice-active');
    const overlay = document.getElementById('mia-voice-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('mia-voice-minimized');
    setLauncherOrbMode(false);

    // Pull the current theme accent so the orb glow matches whatever
    // theme the user picked. Read it freshly each open so theme switches
    // mid-session work too.
    const cs = getComputedStyle(document.documentElement);
    session.accentRgb = (cs.getPropertyValue('--accent-rgb') || '124, 58, 237').trim();

    setupCanvas();
    startCanvasLoop();

    // Branch: Live API (neural voice) or classic Web Speech path.
    // Settings flag opts the user in; default off so existing users get
    // the same experience they had before.
    const settings = loadSettings();
    session.liveMode = !!settings.voiceLive && !!settings.geminiKey;
    if (session.liveMode) {
        // Slight delay before starting the WebSocket so the panel
        // animation finishes — keeps the orb in view while we boot
        // the connection (which can take ~500ms-1s).
        setTimeout(() => startLiveVoice(), 350);
    } else {
        // Soft "powering up" cue + flag so the first listen plays the warm
        // "ready" resolve (mirrors the Live path). The mic-permission wait is
        // this path's "connecting" moment.
        try { miaSound.connecting(); } catch (_) {}
        session.awaitingConnectCue = true;
        // Slight delay so the open animation can settle before we ask
        // for the mic — feels less jumpy and keeps the orb visible
        // while the permission prompt fires.
        setTimeout(() => startListening(), 350);
    }
}

// ── Gemini Live API voice path ────────────────────────────────────
// Bidirectional WebSocket: server hears the mic raw, sends audio
// chunks back which we play through an AudioContext queue. No browser
// TTS, no browser STT. Falls back to Web Speech if any step fails so
// the user gets a working voice mode either way.
async function startLiveVoice() {
    const settings = loadSettings();
    // Soft "powering up" cue at connect time. Set a flag so the first
    // transition into 'listening' plays the warm "connected/ready" resolve
    // instead of the ordinary listening cue. Play connecting() BEFORE
    // setOrbState('thinking') so it isn't shadowed by the thinking loop.
    try { miaSound.connecting(); } catch (_) {}
    session.awaitingConnectCue = true;
    setOrbState('thinking');
    setStatus('Connecting…', { shimmer: true });
    let liveSess = null;
    let mic = null;
    let audioOut = null;
    try {
        audioOut = createAudioOutputQueue();
        session.liveAudioOut = audioOut;

        // Reset per-turn buffers up front so any state from a prior
        // session (after reconnect) doesn't bleed into this one's
        // first transcription chunks.
        session.liveUserUtterance = '';
        session.liveMiaUtterance = '';
        session.liveTurnPersisted = false;

        const systemPrompt = buildSystemPrompt() + '\n\n' + buildContextBlock(window.__miaLatestSignal || null);
        liveSess = await openLiveSession({
            apiKey: settings.geminiKey,
            systemPrompt,
            // Native tool calling — Mia gets the same registry voice mode
            // had no access to before. Gemini Live decides from speech
            // intent which tool to invoke; onToolCall dispatches it.
            functionDeclarations: TOOL_DECLARATIONS,
            onTextOut: (text) => {
                // Mia caption — append to the running utterance, not a new
                // div per fragment. Live streams these in word/syllable
                // chunks; one DOM block per chunk made the captions stack
                // vertically (word-below-word). Now we maintain a single
                // rolling block for the current Mia utterance and let it
                // grow inline, exactly like normal sentence captions.
                if (!text) return;
                const fragment = String(text);
                session.liveMiaUtterance += fragment;
                renderLiveMiaCaption(session.liveMiaUtterance);
                if (session.minimized) setLauncherCaption(session.liveMiaUtterance, 'mia');
                // A new Mia turn started — reset persistence flag so
                // turnComplete knows there's something to save.
                session.liveTurnPersisted = false;
            },
            onTextIn: (text) => {
                // User caption — same buffering: append, then render once
                // so the user's spoken text grows in place, not stacked.
                if (!text) return;
                session.liveUserUtterance += String(text);
                renderLiveUserCaption(session.liveUserUtterance);
                if (session.minimized) setLauncherCaption(session.liveUserUtterance, 'user');
            },
            onAudioOut: (pcm) => {
                if (session.state !== 'speaking') {
                    setOrbState('speaking');
                    setStatus('Mia is speaking…');
                }
                audioOut.push(pcm);
            },
            onTurnComplete: (info) => {
                if (info?.interrupted) {
                    audioOut.clear();
                    // Interrupted = user spoke over Mia. Persist whatever
                    // we got and reset captions immediately; the audio
                    // queue is already cleared above so there's no risk
                    // of cutting off speech.
                    persistLiveTurn();
                    setOrbState('listening');
                    setStatus('Listening…', { shimmer: true });
                    return;
                }
                // Generation finished but the audio queue may still be
                // playing many seconds of buffered speech. Persisting +
                // resetting captions here cut Mia's transcription off
                // mid-sentence. Wait for the playback to actually drain
                // before archiving the caption + flipping to listening.
                waitForLivePlaybackDrain().then(() => {
                    if (!session.open || !session.liveMode) return;
                    persistLiveTurn();
                    setOrbState('listening');
                    setStatus('Listening…', { shimmer: true });
                });
            },
            onToolCall: async ({ id, name, args }) => {
                // Mia's native tool dispatch. Live decided from voice
                // intent that a tool was needed; we run it, send the
                // result back as a toolResponse, and Mia weaves it into
                // her spoken reply.
                pulseOrb();
                const verb = actionVerbFor(name);
                const cap = verb.charAt(0).toUpperCase() + verb.slice(1) + '…';
                setStatus(cap, { shimmer: true });
                if (session.minimized) setLauncherCaption(cap, 'mia', { shimmer: true });
                try {
                    const out = await runTool(name, args || {});
                    const payload = out.error
                        ? { error: out.error }
                        : (out.result ?? { ok: true });
                    liveSess?.sendToolResponse(id, payload);
                } catch (e) {
                    console.warn('[mia/live] tool', name, 'threw:', e);
                    liveSess?.sendToolResponse(id, { error: e.message || String(e) });
                }
            },
            onClose: () => {
                console.log('[mia/live] WebSocket closed.');
            },
            onReconnect: () => {
                // Clear any tail audio from the previous socket so we
                // don't double-speak with the new one.
                try { audioOut.clear(); } catch (_) {}
            },
            onError: (e) => {
                console.warn('[mia/live] error:', e);
            },
        });
        session.liveSession = liveSess;

        // Start mic capture and pipe each PCM chunk straight to the WS.
        mic = await startMicCapture({
            onPCMChunk: (pcm) => {
                liveSess.sendAudio(pcm);
            },
        });
        session.liveMic = mic;
        setOrbState('listening');
        setStatus('Listening…');
    } catch (err) {
        console.warn('[mia/live] Failed to start; falling back to Web Speech:', err);
        // Tear down anything we partially built.
        try { mic?.stop(); } catch (_) {}
        try { liveSess?.close(); } catch (_) {}
        try { audioOut?.close(); } catch (_) {}
        session.liveSession = null;
        session.liveMic = null;
        session.liveAudioOut = null;
        session.liveMode = false;
        // Fall through to the classic path.
        setStatus('Live unavailable — switching to standard voice…');
        setTimeout(() => startListening(), 600);
    }
}

function stopLiveVoice() {
    try { session.liveMic?.stop(); } catch (_) {}
    try { session.liveSession?.close(); } catch (_) {}
    try { session.liveAudioOut?.close(); } catch (_) {}
    session.liveMic = null;
    session.liveSession = null;
    session.liveAudioOut = null;
    session.liveMode = false;
}

function closeVoice() {
    // Soft falling cue as the session ends (best-effort; gated by mute +
    // not-speaking inside the sound engine). Fire before we tear down so
    // it isn't suppressed by a lingering speaking flag.
    try { miaSound.setSpeaking(false); miaSound.listeningOff(); } catch (_) {}
    session.open = false;
    session.minimized = false;
    session.autoLoop = false;
    session.awaitingConnectCue = false;
    // Tear down both Live and Web Speech paths — whichever was active.
    // Idempotent if either wasn't running.
    stopLiveVoice();
    stopListening();
    stopSpeaking();
    abortAgent();
    stopCanvasLoop();
    releaseMic();
    const panel = document.getElementById('mia-panel');
    if (panel) panel.classList.remove('voice-active');
    const overlay = document.getElementById('mia-voice-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mia-voice-minimized');
    setLauncherOrbMode(false);
    setOrbState('idle');
    setStatus('Mia');
    setTranscript('');
    // After voice fully closes, return launcher to whatever mode the
    // chat panel state implies. If panel is still open (user wants
    // to keep chatting in chat-mode after voice ends), launcher
    // stays hidden. If panel is closed, launcher becomes visible.
    setLauncherVis(isSidePanelOpen('mia') ? 'hidden' : 'visible');
    // Note: we don't close the Mia panel itself when voice closes —
    // user might want to drop back to chat in the same panel. They
    // close the panel separately via the chat ✕ button.
}

// Minimize: collapse the WHOLE chat panel (panel + voice overlay both
// slide off-screen together since they share a container now) but keep
// the mic/agent/TTS pipeline alive. The Mia launcher swaps to live-orb
// mode so the user knows Mia is still listening / speaking while they
// use the app.
function minimizeVoice() {
    if (!session.open) return;
    session.minimized = true;
    // Closing the panel via the stack is intentional — minimize means
    // "get the panel out of the way". The voice session keeps running.
    // Going through the stack also re-promotes any other open panel
    // (Portfolio) to the right edge.
    closeSidePanel('mia');
    document.body.classList.add('mia-voice-minimized');
    setLauncherOrbMode(true);
    setLauncherVis('orb');
}

function restoreVoice() {
    if (!session.open) return;
    session.minimized = false;
    // Re-open via the stack so layout is correct relative to any
    // Portfolio panel that may have moved while voice was minimized.
    if (!isSidePanelOpen('mia')) openSidePanel('mia');
    const panel = document.getElementById('mia-panel');
    if (panel) panel.classList.add('voice-active');
    ensureVoiceOverlayMounted();
    const overlay = document.getElementById('mia-voice-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.remove('mia-voice-minimized');
    setLauncherOrbMode(false);
    // Voice panel is open in voice-active mode — hide the launcher
    // (the panel is the focus). When voice closes entirely, the
    // closeVoice path will set this back to 'visible'.
    setLauncherVis('hidden');
    // Re-setup the canvas in case the panel re-rendered while minimized.
    setupCanvas();
    startCanvasLoop();
}

// Toggle the floating Mia launcher between "chat icon" and "live orb"
// modes. In orb mode it shows a real canvas-rendered orb (same
// drawOrb code as the main voice canvas, just smaller and tinted with
// a Siri-style multi-hue palette so the minimized state visually
// distinguishes itself from the chat-panel orb).
function setLauncherOrbMode(on) {
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return;
    launcher.classList.toggle('mia-launcher-orb', !!on);
    if (on) {
        launcher.dataset.orbState = session.state || 'idle';
        ensureLauncherCanvas(launcher);
        ensureLauncherCaption();
        const canvas = launcher.querySelector('.mia-launcher-canvas');
        if (canvas) {
            registerOrbTarget('launcher', canvas, SIRI_PALETTE, {
                petals: 6,        // smaller petal layer; ribbons carry the motion now
                haloMul: 1.45,    // bigger glow halo so the orb feels luminous
                flow: 1.0,        // colors rotate around the orb over time
                glowAlpha: 1.35,  // brighter petals at small size
                ribbons: 5,       // 5 sinuous color ribbons curling around the orb
            });
        }
    } else {
        delete launcher.dataset.orbState;
        unregisterOrbTarget('launcher');
        const canvas = launcher.querySelector('.mia-launcher-canvas');
        if (canvas) canvas.remove();
        clearLauncherCaption();
    }
}

function ensureLauncherCanvas(launcher) {
    if (launcher.querySelector('.mia-launcher-canvas')) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'mia-launcher-canvas';
    // Insert before existing children so the canvas sits behind the
    // ready-dot and any logo, not on top of them.
    launcher.insertBefore(canvas, launcher.firstChild);
}

// Floating mini-caption shown next to the minimized launcher orb so the
// user can still see what they're saying / what Mia is saying without
// re-opening the panel. Positioned with `position: fixed` to the left
// of the launcher; the launcher's own coords drive placement so window
// resizes / mobile layouts work without extra wiring.
//
// Pairs with .mia-launcher-glass — a soft backdrop-blur "glass plate"
// that activates only when the caption is visible, covering the orb +
// caption area so the underlying page reads softer behind the active
// conversation.
function ensureLauncherCaption() {
    if (!document.getElementById('mia-launcher-glass')) {
        const glass = document.createElement('div');
        glass.id = 'mia-launcher-glass';
        glass.className = 'mia-launcher-glass';
        glass.setAttribute('aria-hidden', 'true');
        document.body.appendChild(glass);
    }
    if (document.getElementById('mia-launcher-caption')) return;
    const el = document.createElement('div');
    el.id = 'mia-launcher-caption';
    el.className = 'mia-launcher-caption';
    el.setAttribute('aria-live', 'polite');
    el.dataset.role = 'idle';
    document.body.appendChild(el);
}

function setLauncherCaption(text, role, opts = {}) {
    ensureLauncherCaption();
    const el = document.getElementById('mia-launcher-caption');
    const glass = document.getElementById('mia-launcher-glass');
    if (!el) return;
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        el.classList.remove('visible', 'shimmer');
        glass?.classList.remove('visible');
        el.dataset.role = 'idle';
        return;
    }
    el.dataset.role = role || 'idle';
    el.textContent = trimmed;
    el.classList.add('visible');
    el.classList.toggle('shimmer', !!opts.shimmer);
    glass?.classList.add('visible');
    scheduleLauncherCaptionFade();
}

let launcherCaptionFadeTimer = null;
function scheduleLauncherCaptionFade() {
    if (launcherCaptionFadeTimer) clearTimeout(launcherCaptionFadeTimer);
    // Fade after 4.5s of no updates. Each new setLauncherCaption call
    // resets this timer, so during active speech the caption stays up.
    launcherCaptionFadeTimer = setTimeout(() => {
        const el = document.getElementById('mia-launcher-caption');
        const glass = document.getElementById('mia-launcher-glass');
        if (el) el.classList.remove('visible');
        if (glass) glass.classList.remove('visible');
        launcherCaptionFadeTimer = null;
    }, 4500);
}

function clearLauncherCaption() {
    const el = document.getElementById('mia-launcher-caption');
    const glass = document.getElementById('mia-launcher-glass');
    if (el) {
        el.classList.remove('visible');
        el.textContent = '';
    }
    if (glass) glass.classList.remove('visible');
    if (launcherCaptionFadeTimer) { clearTimeout(launcherCaptionFadeTimer); launcherCaptionFadeTimer = null; }
}

function releaseMic() {
    if (session.micStream) {
        try { session.micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        session.micStream = null;
    }
    if (session.audioCtx) {
        try { session.audioCtx.close(); } catch (_) {}
        session.audioCtx = null;
    }
    session.analyser = null;
}

function setOrbState(s) {
    const prev = session.state;
    session.state = s;
    const orb = document.getElementById('mia-voice-orb');
    if (orb) orb.dataset.state = s;
    // Mirror onto the launcher so the minimized-orb avatar reflects
    // the current state (idle, listening, thinking, speaking).
    const launcher = document.getElementById('mia-launcher');
    if (launcher && launcher.classList.contains('mia-launcher-orb')) {
        launcher.dataset.orbState = s;
    }
    // Sound design hook. This is the single voice-state chokepoint, so
    // it's the right place to drive the audio cues. Crucially:
    //   - 'speaking' tells the sound engine to SUPPRESS everything (we
    //     never talk over Mia's actual voice) and stops the thinking loop.
    //   - leaving 'speaking' clears the gate so ticks/thinking resume.
    //   - 'thinking' starts the bubble loop (between utterances, while she
    //     reasons / runs tools — this is allowed in voice mode).
    //   - 'listening' fires the soft rising cue + ensures the loop is off.
    if (prev !== s) {
        try {
            if (s === 'speaking') {
                miaSound.setSpeaking(true);
                miaSound.stopThinking();
            } else {
                if (prev === 'speaking') miaSound.setSpeaking(false);
                if (s === 'thinking') {
                    miaSound.startThinking();
                } else if (s === 'listening') {
                    miaSound.stopThinking();
                    // First listen after a connect → play the warm "ready"
                    // resolve; otherwise the ordinary listening cue.
                    if (session.awaitingConnectCue) {
                        session.awaitingConnectCue = false;
                        miaSound.connected();
                    } else {
                        miaSound.listeningOn();
                    }
                } else if (s === 'idle') {
                    miaSound.stopThinking();
                }
            }
        } catch (_) { /* sound is best-effort, never break voice */ }
    }
}
function setStatus(msg, opts = {}) {
    // Default behavior keeps the "Mia" identity label fixed; the orb's
    // state communicates listening/thinking/speaking visually. We swap
    // the label out for: (a) short error states, (b) tool-action lines
    // ("Checking the news…") that the caller marks with opts.shimmer so
    // the user sees what's happening during otherwise-silent waits.
    const el = document.getElementById('mia-voice-status');
    if (!el) return;
    const isError = /error|couldn|didn|retry/i.test(msg);
    const showLiteral = isError || !!opts.shimmer;
    el.textContent = showLiteral ? msg : 'Mia';
    el.classList.toggle('shimmer', !!opts.shimmer && !isError);
}
function setTranscript(msg) {
    const el = document.getElementById('mia-voice-transcript');
    if (!el) return;
    el.textContent = msg;
    // Reset any leftover spoken-sentence DOM structure from a prior turn.
    el.dataset.mode = msg ? 'plain' : 'empty';
    el.scrollTop = el.scrollHeight;
    // Mirror to launcher caption while minimized so the user sees their
    // spoken text floating next to the orb without reopening the panel.
    if (session.minimized) setLauncherCaption(msg, 'user');
}

// Live-mode caption renderers. Live streams transcriptions as small
// fragments (word/syllable chunks). We keep ONE growing element per
// speaker per turn and overwrite its text — so the caption flows like
// a sentence (left to right, wrapping naturally) instead of stacking
// vertically (one line per fragment, which is what was happening
// when each fragment created a new div via appendTranscript).
//
// User and Mia captions live as separate spans so they can have
// distinct styling (user = lighter/right-aligned, Mia = bold/left).
// On turn boundary they get archived as static rows and a new pair
// of growing spans is created for the next turn.
function ensureLiveTranscriptScaffold() {
    const el = document.getElementById('mia-voice-transcript');
    if (!el) return null;
    if (el.dataset.mode !== 'live') {
        el.innerHTML = '';
        el.dataset.mode = 'live';
    }
    let live = el.querySelector('.mia-voice-tx-live');
    if (!live) {
        live = document.createElement('div');
        live.className = 'mia-voice-tx-live';
        live.innerHTML = `
            <div class="mia-voice-tx-line mia-voice-tx-user" data-role="user"></div>
            <div class="mia-voice-tx-line mia-voice-tx-mia" data-role="mia"></div>
        `;
        el.appendChild(live);
    }
    return el;
}

function renderLiveUserCaption(text) {
    const el = ensureLiveTranscriptScaffold();
    if (!el) return;
    const userLine = el.querySelector('.mia-voice-tx-live .mia-voice-tx-user');
    if (userLine) {
        userLine.textContent = text;
        userLine.classList.toggle('empty', !text.trim());
    }
    el.scrollTop = el.scrollHeight;
}

function renderLiveMiaCaption(text) {
    const el = ensureLiveTranscriptScaffold();
    if (!el) return;
    const miaLine = el.querySelector('.mia-voice-tx-live .mia-voice-tx-mia');
    if (miaLine) {
        miaLine.textContent = text;
        miaLine.classList.toggle('empty', !text.trim());
    }
    el.scrollTop = el.scrollHeight;
}

// On turnComplete: archive the current live captions as a static
// "history" row above and reset the live spans for the next turn.
// Also persists user + Mia text into Mia's chat history so the
// thread reflects the conversation when the user returns to chat.
function persistLiveTurn() {
    if (session.liveTurnPersisted) return;
    const userText = String(session.liveUserUtterance || '').trim();
    const miaText = String(session.liveMiaUtterance || '').trim();
    if (!userText && !miaText) return;
    session.liveTurnPersisted = true;

    // Archive in the in-panel transcript — keep the visual record
    // visible above the now-empty live row.
    const el = document.getElementById('mia-voice-transcript');
    if (el) {
        const live = el.querySelector('.mia-voice-tx-live');
        if (live) {
            const archive = document.createElement('div');
            archive.className = 'mia-voice-tx-archive';
            if (userText) archive.appendChild(makeArchiveLine(userText, 'user'));
            if (miaText) archive.appendChild(makeArchiveLine(miaText, 'mia'));
            el.insertBefore(archive, live);
        }
    }

    // Persist into Mia's chat history so the chat panel shows the
    // voice-mode conversation. Re-load fresh — another tab or the
    // chat panel itself may have appended in parallel.
    const updated = loadHistory();
    if (userText) updated.push({ role: 'user', content: userText });
    if (miaText) updated.push({ role: 'assistant', content: miaText });
    saveHistory(updated);
    session.history = updated;
    syncChatThread();

    // Reset for the next turn.
    session.liveUserUtterance = '';
    session.liveMiaUtterance = '';
    renderLiveUserCaption('');
    renderLiveMiaCaption('');
}

function makeArchiveLine(text, role) {
    const div = document.createElement('div');
    div.className = `mia-voice-tx-line mia-voice-tx-${role}`;
    div.dataset.role = role;
    div.textContent = text;
    return div;
}

// Resolves once the Live audio output queue has drained (i.e., the
// last scheduled buffer has finished playing). Polled cheaply via the
// queue's isPlaying() probe. Cap at 30s so a stuck queue can't hold
// the listening state hostage forever.
function waitForLivePlaybackDrain() {
    const audioOut = session.liveAudioOut;
    if (!audioOut?.isPlaying) return Promise.resolve();
    return new Promise(resolve => {
        const start = Date.now();
        const tick = () => {
            if (!session.liveMode || !session.liveAudioOut) return resolve();
            if (!audioOut.isPlaying()) return resolve();
            if (Date.now() - start > 30000) return resolve();
            setTimeout(tick, 120);
        };
        tick();
    });
}

// Mia-speaking transcript: each utterance becomes a sentence span we
// can highlight progressively as boundary events fire. Old sentences
// stay above so the user sees the running monologue.
function appendTranscript(sentence) {
    const el = document.getElementById('mia-voice-transcript');
    if (!el) return;
    if (el.dataset.mode !== 'speaking') {
        el.innerHTML = '';
        el.dataset.mode = 'speaking';
    }
    const span = document.createElement('div');
    span.className = 'mia-voice-tx-sent';
    span.dataset.full = sentence;
    span.innerHTML = `<span class="mia-voice-tx-spoken"></span><span class="mia-voice-tx-pending">${escapeText(sentence)}</span>`;
    el.appendChild(span);
    el.scrollTop = el.scrollHeight;
    // Mirror Mia's most recent sentence into the launcher caption so the
    // user can read along while minimized. highlightTranscript will keep
    // updating it word-by-word as the synthesizer speaks.
    if (session.minimized) setLauncherCaption(sentence, 'mia');
}

// Snap a character index up to the END of the word that contains it, so
// the caption always advances on whole-word boundaries. Without this
// snap a fallback timer (which thinks in characters) leaves half-words
// stranded — "becau" / "becaus" / "because" — which reads as broken
// streaming, not word-by-word like real captions.
function snapToWordBoundary(sentence, charIdx) {
    if (charIdx <= 0) return 0;
    if (charIdx >= sentence.length) return sentence.length;
    let i = charIdx;
    while (i < sentence.length && /\S/.test(sentence[i])) i++;
    return i;
}

// Pre-compute the index AFTER each word in the sentence (i.e., the
// position right after the last non-space char of every word). The
// timer-driven caption fallback uses this list to step word-by-word
// rather than character-by-character, which is what the user reads as
// "real captioning" instead of "broken typewriter."
function computeWordEnds(sentence) {
    const ends = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(sentence)) !== null) {
        ends.push(m.index + m[0].length);
    }
    return ends;
}

function highlightTranscript(sentence, charIdx) {
    const el = document.getElementById('mia-voice-transcript');
    const upTo = snapToWordBoundary(sentence, Math.max(0, Math.min(sentence.length, charIdx)));
    if (el) {
        // Find the most recent sentence span matching this utterance.
        const sents = el.querySelectorAll('.mia-voice-tx-sent');
        if (sents.length) {
            const last = sents[sents.length - 1];
            if (last.dataset.full === sentence) {
                const spoken = last.querySelector('.mia-voice-tx-spoken');
                const pending = last.querySelector('.mia-voice-tx-pending');
                if (spoken && pending) {
                    spoken.textContent = sentence.slice(0, upTo);
                    pending.textContent = sentence.slice(upTo);
                    el.scrollTop = el.scrollHeight;
                }
            }
        }
    }
    // Mirror the spoken portion into the launcher caption so the user
    // reads along with what Mia is actually saying out loud — matches
    // the audio pace, not just the full sentence dumped at once.
    if (session.minimized) {
        const partial = sentence.slice(0, upTo);
        if (partial.trim()) setLauncherCaption(partial, 'mia');
    }
}

function escapeText(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// Re-render the chat thread behind the voice overlay so the user sees
// their conversation populate live. The chat content is blurred + dimmed
// by .voice-active CSS, but messages should still be visibly arriving as
// the user talks. Falls back to session.history when no override is
// passed (e.g., user-bubble append, final assistant persist).
function syncChatThread(historyOverride) {
    if (!document.getElementById('mia-thread')) return;
    try {
        renderThread(historyOverride || session.history);
    } catch (_) { /* mia-thread not mounted yet — fine, will sync next render */ }
}

function onOrbTap() {
    // Universal interrupt: whatever Mia's doing, stop it, then either
    // listen again or close depending on state.
    if (session.state === 'speaking' || session.state === 'thinking') {
        stopSpeaking();
        abortAgent();
        // Restart listening immediately — that's the "interrupt mid-sentence"
        // feel the user wanted from ChatGPT's voice mode.
        startListening();
        return;
    }
    if (session.state === 'listening') {
        // Manually trigger end-of-speech: user wants to commit what they've
        // said so far without waiting for silence detection.
        stopListening();
        const text = (session.finalTranscript + ' ' + session.interimTranscript).trim();
        if (text) handleUserUtterance(text);
        else startListening(); // Empty — just re-arm.
        return;
    }
    // idle → start listening
    startListening();
}

function startListening() {
    if (!session.open) return;
    stopSpeaking();
    abortAgent();
    setOrbState('listening');
    setStatus('Listening…');
    setTranscript('');
    session.finalTranscript = '';
    session.interimTranscript = '';

    try {
        ensureMicAnalyser();
    } catch (err) {
        // Mic permission denied or no input device — fall back to a
        // synthesised idle pulse so the orb still moves visibly.
        console.warn('[voice] mic analyser unavailable:', err);
    }

    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
        let interim = '';
        let finalT = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            if (r.isFinal) finalT += r[0].transcript;
            else interim += r[0].transcript;
        }
        if (finalT) session.finalTranscript += finalT;
        session.interimTranscript = interim;
        const display = (session.finalTranscript + ' ' + interim).trim();
        setTranscript(display);
    };
    rec.onerror = (e) => {
        console.warn('[voice] recognition error:', e.error);
        // 'no-speech' = the user just paused. We DON'T want to drop to
        // idle and force a tap to resume — voice mode should feel like
        // an open mic. The onend handler re-arms automatically. Same
        // story for 'aborted' (we cancelled it ourselves).
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        // 'audio-capture' / 'not-allowed' / 'network' / etc. are real
        // problems the user needs to know about; halt and surface.
        setStatus(`Mic error: ${e.error}. Tap to retry.`);
        setOrbState('idle');
    };
    rec.onend = () => {
        // Some browsers fire onend without ever firing a final result if the
        // user said nothing. If we have text, run the turn. If not,
        // auto-rearm so voice mode behaves like an always-on mic — silent
        // moments shouldn't kick the user back to a tap-to-resume state.
        if (session.state !== 'listening') return;
        const text = (session.finalTranscript + ' ' + session.interimTranscript).trim();
        if (text) {
            handleUserUtterance(text);
            return;
        }
        // No speech this round — restart listening transparently. autoLoop
        // controls whether voice mode keeps itself alive (true while the
        // overlay is open and the user hasn't closed it). Status stays as
        // "Listening…" so the user sees no break in the conversation flow.
        if (session.autoLoop && session.open) {
            // setTimeout(0) puts the new SR.start() in the next tick, so
            // the previous instance has fully torn down before we spin up
            // a fresh one — Chrome throws InvalidStateError if you call
            // start() on a recognizer that isn't quite finished ending.
            setTimeout(() => {
                if (session.open && session.state === 'listening') startListening();
            }, 0);
        } else {
            setOrbState('idle');
        }
    };

    try {
        rec.start();
        session.rec = rec;
    } catch (err) {
        console.warn('[voice] failed to start recognition:', err);
        setStatus('Couldn\'t start the mic. Tap to retry.');
        setOrbState('idle');
    }
}

function stopListening() {
    const rec = session.rec;
    session.rec = null;
    if (!rec) return;
    try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch (_) {}
}

async function ensureMicAnalyser() {
    if (session.analyser && session.audioCtx?.state !== 'closed') return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    session.micStream = stream;
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    session.audioCtx = ctx;
    session.analyser = analyser;
}

async function handleUserUtterance(text) {
    setOrbState('thinking');
    setStatus('Thinking…');
    setTranscript(text);

    // Persist the user turn into Mia's chat history so the side panel and
    // voice mode share state. Anything you say to Mia by voice shows up in
    // the chat panel too — and vice versa.
    session.history.push({ role: 'user', content: text });
    saveHistory(session.history);
    syncChatThread(); // user bubble appears behind the blur immediately

    session.chunker = makeSentenceChunker();
    session.speakQueue = [];
    session.speaking = false;

    let acc = '';
    let firstTokenAt = 0;
    let lastThreadSync = 0;
    const ac = new AbortController();
    session.abort = ac;

    try {
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(window.__miaLatestSignal || null);
        for await (const ev of runTurn({ system, messages: session.history, signal: ac.signal, onProgress: () => {} })) {
            if (ev.type === 'tool') {
                // Surface WHAT Mia is doing, not just that something is
                // happening. The actionVerbFor map (shared with the chat
                // path's tool badges) gives a user-friendly verb per tool
                // name — never the raw tool identifier. Updates both the
                // in-panel status text AND the floating launcher caption
                // so minimized users see it too. Shimmer class is added
                // so the status text reads as "in-progress" with a
                // ChatGPT-style left-to-right light sweep.
                pulseOrb();
                const verb = actionVerbFor(ev.name);
                const cap = verb.charAt(0).toUpperCase() + verb.slice(1) + '…';
                setStatus(cap, { shimmer: true });
                if (session.minimized) setLauncherCaption(cap, 'mia', { shimmer: true });
                continue;
            }
            if (ev.type !== 'delta' || !ev.text) continue;
            if (!firstTokenAt) {
                firstTokenAt = Date.now();
                setOrbState('speaking');
                setStatus('Mia is speaking…');
            }
            acc += ev.text;
            const sentences = session.chunker.push(ev.text);
            for (const s of sentences) enqueueSpeak(s);
            // Throttled live render of Mia's streaming reply into the chat
            // thread so the user sees the message grow behind the blur in
            // sync with hearing it. Throttle keeps re-render cost low.
            const now = Date.now();
            if (now - lastThreadSync > 250) {
                lastThreadSync = now;
                syncChatThread([...session.history, { role: 'assistant', content: acc }]);
            }
        }
        // Flush any trailing partial sentence.
        const tail = session.chunker.flush();
        for (const s of tail) enqueueSpeak(s);
    } catch (e) {
        if (e?.name !== 'AbortError') {
            console.warn('[voice] agent error:', e);
            setStatus(`Connection issue. Tap to try again.`);
            setOrbState('idle');
            return;
        }
    } finally {
        session.abort = null;
    }

    // Persist Mia's final reply into history so it's there when the user
    // closes voice mode and looks at the chat panel.
    if (acc.trim()) {
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: acc.trim() });
        saveHistory(updated);
        session.history = updated;
        syncChatThread(); // final, non-throttled render with the complete reply
    }

    // Wait until the speak queue drains before going back to listen.
    waitForSpeakDrain().then(() => {
        if (!session.open || !session.autoLoop) return;
        // If user already interrupted (state would be listening) bail.
        if (session.state === 'speaking') startListening();
    });
}

function enqueueSpeak(sentence) {
    const txt = speakable(sentence);
    if (!txt) return;
    session.speakQueue.push(txt);
    if (!session.speaking) drainSpeakQueue();
}

function drainSpeakQueue() {
    if (session.speaking) return;
    const next = session.speakQueue.shift();
    if (!next) return;
    session.speaking = true;
    // Stream the spoken text into the visible transcript word-by-word as
    // the TTS utterance fires boundary events. The user reads what Mia
    // is saying in lock-step with hearing it — same reason captioning
    // boosts comprehension on streaming video.
    appendTranscript(next);
    let charIdx = 0;
    let boundaryFired = false;
    let highlightTimer = null;
    const u = new SpeechSynthesisUtterance(next);
    const v = pickVoice();
    if (v) u.voice = v;
    // Adaptive pacing for a more human cadence:
    // - Full statements (ending in . ! ?) read slightly slower so the
    //   beat at the end has weight — declarative cadence.
    // - Clause-y / comma-ending fragments stay at the brisker rate so the
    //   thought feels in-flight and connects to the next utterance.
    // - Pitch varies in a tiny ±0.04 band per utterance so a multi-
    //   sentence response doesn't read in a perfect monotone.
    const lastChar = next.trim().slice(-1);
    const isFullStop = ['.', '!', '?'].includes(lastChar);
    u.rate = isFullStop ? 1.0 : 1.05;
    u.pitch = 1.02 + (Math.random() * 0.08 - 0.04);

    // Pre-tokenize the sentence into word-end indices. Caption advance
    // jumps to whichever word-end is closest to the current audio
    // position, which keeps the visible text aligned with the spoken
    // word — never half a word, never lagging by a paragraph. This
    // word-grid is shared by both the boundary path (Chrome/Edge) and
    // the timer fallback (Firefox/Safari) so the on-screen behavior is
    // identical regardless of browser support.
    const wordEnds = computeWordEnds(next);
    const words = wordEnds.length || 1;
    // ~3.2 words/sec at rate=1.05 is conversational TTS. Scale by the
    // actual rate so a slower utterance gives the caption longer per word.
    const wordDurMs = Math.max(120, (1000 / 3.2) / u.rate);

    u.onstart = () => {
        // Start the per-word fallback advance immediately. If onboundary
        // fires we cancel it (the browser is doing real word sync); if
        // it doesn't, this drives caption advance at ~roughly the audio
        // pace. No 200ms delay — that just left the first word stranded.
        let wordIdx = 0;
        const advanceTick = () => {
            if (boundaryFired || !session.speaking) { highlightTimer = null; return; }
            wordIdx++;
            if (wordIdx >= words) { highlightTimer = null; return; }
            charIdx = wordEnds[wordIdx - 1];
            highlightTranscript(next, charIdx);
            highlightTimer = setTimeout(advanceTick, wordDurMs);
        };
        highlightTimer = setTimeout(advanceTick, wordDurMs);
    };
    u.onboundary = (e) => {
        // Each word boundary kicks the synthetic-amplitude clock, which is
        // what makes the orb pulse-with-the-voice during speech.
        session.lastBoundaryTs = performance.now();
        boundaryFired = true;
        if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
        if (typeof e.charIndex === 'number') {
            // Snap to the word-end at or after charIndex so the caption
            // shows the WHOLE word the synthesizer just started speaking
            // (and the partial-word leading up to it stays in pending).
            charIdx = e.charIndex;
            highlightTranscript(next, charIdx);
        }
    };
    u.onend = () => {
        session.speaking = false;
        if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
        // Clear the per-utterance highlight; the sentence stays visible
        // in the transcript history until the next listen wipes it.
        highlightTranscript(next, next.length);
        if (session.speakQueue.length > 0) {
            // Insert a small natural beat between utterances. Sentence
            // endings get a longer pause (~180ms) so the listener has a
            // moment to register the statement; clause/comma endings get
            // a shorter pause (~80ms) so the thought stays in-flight.
            // Without this gap, the queue chains utterances back-to-back
            // with no breath, which is the dead giveaway "this is a bot."
            const gap = isFullStop ? 180 : 80;
            setTimeout(() => drainSpeakQueue(), gap);
        }
    };
    u.onerror = (e) => {
        // 'canceled' / 'interrupted' fires when we call cancel() ourselves
        // — that's expected, not a bug. Other errors we log.
        if (e.error && e.error !== 'canceled' && e.error !== 'interrupted') {
            console.warn('[voice] tts error:', e.error);
        }
        session.speaking = false;
        if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
        if (session.speakQueue.length > 0) drainSpeakQueue();
    };
    try { speechSynthesis.speak(u); }
    catch (err) { console.warn('[voice] speak failed:', err); session.speaking = false; }
}

function waitForSpeakDrain() {
    return new Promise(resolve => {
        const tick = () => {
            if (!session.speaking && session.speakQueue.length === 0) return resolve();
            setTimeout(tick, 100);
        };
        tick();
    });
}

function stopSpeaking() {
    session.speakQueue = [];
    try { speechSynthesis.cancel(); } catch (_) {}
    session.speaking = false;
}

function abortAgent() {
    try { session.abort?.abort(); } catch (_) {}
    session.abort = null;
}

let cachedVoice = null;
function pickVoice() {
    if (cachedVoice) return cachedVoice;
    const voices = speechSynthesis.getVoices();
    if (!voices?.length) return null;
    // Prefer a high-quality English neural voice when available. Edge ships
    // "Microsoft Aria Online (Natural)" / "Guy Online (Natural)" which sound
    // close to Cortana — far better than the OS default. Chrome on macOS has
    // "Samantha" / "Karen". Fall back to any en-* voice; last resort: first
    // available.
    // Preference order: neural cloud voices first (best quality), then OS
    // native voices that are decent, then "any female en voice" because Mia
    // is presented as female. David / Mark are last-resort fallbacks.
    const preferred = [
        /Aria.*Natural/i,
        /Jenny.*Natural/i,
        /Guy.*Natural/i,
        /Samantha/i,
        /Google US English/i,
        /Karen/i,
        /Daniel/i,
        /Zira/i,
        /Microsoft.*Female/i,
    ];
    for (const re of preferred) {
        const v = voices.find(x => re.test(x.name));
        if (v) { cachedVoice = v; return v; }
    }
    const en = voices.find(v => /^en[-_]/i.test(v.lang));
    cachedVoice = en || voices[0];
    return cachedVoice;
}
// Voices load async on most browsers. Refresh the cache when the list
// changes so the first-open utterance uses the good voice, not the default.
if (TTS_AVAILABLE) {
    speechSynthesis.addEventListener?.('voiceschanged', () => { cachedVoice = null; });
}

function pulseOrb() {
    const orb = document.getElementById('mia-voice-orb');
    if (!orb) return;
    orb.classList.remove('pulse');
    void orb.offsetWidth; // restart animation
    orb.classList.add('pulse');
}

// ---------- Canvas / orb rendering ----------

// Render targets for the orb: the main voice-mode canvas inside the
// chat panel AND, when minimized, a small canvas inside the launcher.
// Both share session.state and session.smoothedAmp so they pulse in
// lock-step with what Mia is actually doing. The launcher target uses
// a Siri-style multi-hue palette to visually distinguish the
// minimized/active orb from the main orb.
const orbTargets = new Map(); // key (string) -> { ctx, W, H, palette }

// Siri-style palette — extra hues so the rotation around the orb feels
// like a continuous gradient sweep, not three jumpy color bands.
const SIRI_PALETTE = [
    '56, 189, 248',   // sky-400
    '129, 140, 248',  // indigo-400
    '167, 139, 250',  // violet-400
    '236, 72, 153',   // pink-500
    '244, 114, 182',  // pink-400
    '99, 102, 241',   // indigo-500
];

function registerOrbTarget(key, canvas, palette, opts = {}) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); // reset in case the canvas was reused
    ctx.scale(dpr, dpr);
    orbTargets.set(key, {
        ctx,
        W: rect.width,
        H: rect.height,
        palette: palette || null,
        // Render-quality knobs per target. Defaults match the original
        // main-orb behavior; the launcher overrides for smoother flow.
        petals: opts.petals || 4,
        haloMul: opts.haloMul != null ? opts.haloMul : 1.0,
        flow: opts.flow != null ? opts.flow : 0,         // 0..1: how much palette rotates over time
        glowAlpha: opts.glowAlpha != null ? opts.glowAlpha : 1.0, // multiplier on petal alpha
        ribbons: opts.ribbons || 0, // count of orbiting string-ribbons drawn around the core
        ribbonWidth: opts.ribbonWidth != null ? opts.ribbonWidth : 1.0, // multiplier on the per-ribbon stroke width
    });
}

function unregisterOrbTarget(key) {
    orbTargets.delete(key);
}

function setupCanvas() {
    const canvas = document.getElementById('mia-voice-canvas');
    if (!canvas) return;
    // Trial: give the main orb the same Siri-style palette + flow as the
    // launcher so the chat-panel orb reads iridescent instead of theme-
    // tinted single-color. Ribbon count kept low (3) and glow neutral so
    // it doesn't get noisy at the larger 240px panel size.
    // ribbonWidth 0.5 makes the main-orb ribbons noticeably thinner than
    // the launcher's — they read as "strings" instead of bands.
    // To revert to the original single-accent orb, pass `null` for the
    // palette and drop the opts.
    registerOrbTarget('main', canvas, SIRI_PALETTE, {
        petals: 6,
        flow: 0.6,      // gentler color rotation than launcher (which is 1.0)
        ribbons: 3,
        glowAlpha: 1.0,
        ribbonWidth: 0.5,
        haloMul: 1.0,
        // Note: drawOrb uses Math.min(W, H) * 0.40 for baseR. With our
        // canvas at 150% of the button (so ~360px when button is 240),
        // baseR becomes ~144 — but the visible orb the user perceives
        // is still the 240px button. That intentional gap between baseR
        // and the visible boundary is what gives the halo room to fade
        // out softly instead of hitting an arbitrary cap.
    });
}

function startCanvasLoop() {
    if (session.rafId) cancelAnimationFrame(session.rafId);
    const tick = (now) => {
        // Loop runs as long as a session is alive (open OR minimized).
        // When fully closed, all targets get unregistered.
        if (!session.open && orbTargets.size === 0) return;
        // Smooth amplitude once per frame, then render every target with
        // that shared value so all orbs pulse in sync.
        updateAmplitude(now);
        for (const target of orbTargets.values()) drawOrb(now, target);
        session.rafId = requestAnimationFrame(tick);
    };
    session.rafId = requestAnimationFrame(tick);
}

function updateAmplitude(now) {
    let raw = 0;
    if (session.state === 'listening') {
        // Live mode mic exposes its own analyser via the capture handle;
        // Web Speech path uses the standalone session.analyser. Both
        // return 0..1 RMS in the speech band.
        if (session.liveMode && session.liveMic?.getAmplitude) raw = session.liveMic.getAmplitude();
        else raw = readMicAmplitude();
    } else if (session.state === 'speaking') {
        // Live mode reads RMS from the actual playback path so the orb
        // pulses with what Leda is saying RIGHT NOW. Web Speech path
        // can't read TTS audio so it falls back to a synthetic carrier.
        if (session.liveMode && session.liveAudioOut?.getAmplitude) raw = session.liveAudioOut.getAmplitude();
        else raw = syntheticSpeechAmplitude(now);
    } else if (session.state === 'thinking') raw = 0.45 + 0.35 * Math.abs(Math.sin(now * 0.005));
    else raw = 0.20 + 0.05 * Math.sin(now * 0.003); // idle breath
    // EMA smoothing — heavier on Live mode (real RMS) since we already
    // smoothed at the analyser level. Web Speech path uses synthetic amp
    // and benefits from a brisker response so the orb feels alive.
    const k = session.liveMode ? 0.86 : 0.78;
    session.smoothedAmp = session.smoothedAmp * k + raw * (1 - k);
}

function stopCanvasLoop() {
    if (session.rafId) cancelAnimationFrame(session.rafId);
    session.rafId = null;
    orbTargets.clear();
}

function readMicAmplitude() {
    if (!session.analyser) return 0;
    const buf = new Uint8Array(session.analyser.frequencyBinCount);
    session.analyser.getByteFrequencyData(buf);
    // Average the low-mid frequency bins where speech energy lives. Skip
    // the very lowest bins (room rumble) and the very highest (tape hiss).
    let sum = 0, count = 0;
    const lo = Math.floor(buf.length * 0.05);
    const hi = Math.floor(buf.length * 0.55);
    for (let i = lo; i < hi; i++) { sum += buf[i]; count++; }
    const avg = count ? sum / count / 255 : 0;
    return avg;
}

function syntheticSpeechAmplitude(now) {
    // Browser TTS gives no audio access; we approximate amplitude with a
    // dual-sinusoid that "breathes" like a voice and gets a kick on each
    // word boundary event. The result looks like a real waveform.
    const sinceBoundary = (now - session.lastBoundaryTs) / 1000; // seconds
    const kick = Math.max(0, 1 - sinceBoundary * 4); // decay over 250ms
    const carrier = 0.55 + 0.20 * Math.sin(now * 0.012) + 0.12 * Math.sin(now * 0.027);
    return Math.min(1, carrier + kick * 0.35);
}

function drawOrb(now, target) {
    const { ctx, W, H, palette, petals, haloMul, flow, glowAlpha, ribbons, ribbonWidth } = target;
    if (!ctx) return;
    const cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);

    // Amplitude is shared across targets — updated once per frame in
    // startCanvasLoop's tick. All orbs (main + launcher) pulse together.
    const amp = session.smoothedAmp;

    // ── State drive ──────────────────────────────────────────────────────
    // The orb now reacts to WHAT Mia is doing, not just how loud it is.
    // Each voice state gets its own "flow signature" so the ribbons read as
    // neurons carrying information in a direction:
    //   listening → signals flow INWARD (drawing the user's words in),
    //               medium speed, scales with mic amplitude
    //   thinking  → signals SWIRL fast both ways (busy computation), no net
    //               direction, brightness pulses
    //   speaking  → signals flow OUTWARD (Mia emitting), speed + brightness
    //               ride the TTS amplitude
    //   idle      → slow gentle drift, dim
    // dir: +1 outward, -1 inward, 0 swirl. spd: ribbon phase multiplier.
    // pktBright: neuron-packet glow multiplier.
    const st = session.state || 'idle';
    let flowDir = 1, flowSpd = 1, pktBright = 1, pktDensity = 1;
    if (st === 'listening') { flowDir = -1; flowSpd = 0.9 + amp * 1.4; pktBright = 0.85 + amp * 0.6; pktDensity = 1; }
    else if (st === 'thinking') { flowDir = 0; flowSpd = 2.1; pktBright = 1.15; pktDensity = 1.4; }
    else if (st === 'speaking') { flowDir = 1; flowSpd = 1.1 + amp * 1.6; pktBright = 0.9 + amp * 0.8; pktDensity = 1.2; }
    else { flowDir = 1; flowSpd = 0.5; pktBright = 0.5; pktDensity = 0.7; }

    // baseR = the outer radius the petals reach near. Eats most of the canvas
    // so the orb feels weighty, ChatGPT-style.
    const baseR = Math.min(W, H) * 0.40;

    // Palette = either a static accent (chat-panel orb, theme-tinted) or a
    // multi-hue Siri-style array that cycles per petal layer (launcher orb).
    // Single-color palette gets duplicated so the per-petal lookup still
    // works without branching downstream.
    const palettes = palette && palette.length ? palette : [session.accentRgb, session.accentRgb, session.accentRgb];
    // Time-shifted palette index so the colors flow AROUND the orb instead
    // of locking each petal to one hue. flow=0 → static (main orb); flow=1
    // → palette completes a full revolution every ~6.3s (launcher orb).
    const flowOffset = flow * (now * 0.00025);
    const pickColor = (i) => {
        const idx = (i + flowOffset * palettes.length) % palettes.length;
        const lo = Math.floor(idx) % palettes.length;
        const hi = (lo + 1) % palettes.length;
        const t = idx - Math.floor(idx);
        return blendRgbStrings(palettes[lo], palettes[hi], t);
    };
    const corePalette = pickColor(0);

    // Outermost ambient glow halo. Sized so the gradient terminates *inside*
    // the canvas, not at its hard edge — otherwise we get a visible ring
    // where the halo gets clipped (canvas is square-ish but the orb is
    // round visually). Halo terminates at ~95% of the canvas-half so the
    // outer alpha is already 0 by the time it could touch the edge.
    const canvasHalf = Math.min(W, H) / 2;
    const haloR = Math.min(baseR + (60 + amp * 40) * haloMul, canvasHalf * 0.97);
    const haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.6, cx, cy, haloR);
    haloGrad.addColorStop(0, `rgba(${corePalette}, ${(0.18 + amp * 0.22) * glowAlpha})`);
    haloGrad.addColorStop(1, `rgba(${corePalette}, 0)`);
    ctx.fillStyle = haloGrad;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Ribbons — flowing color "strings" that orbit the core at varying
    // radii. Each ribbon is a stroked sinusoid wrapped around a base
    // circumference, so it reads as a flexible flowing line. Multiple
    // ribbons at different phases + radii create the rotating color
    // currents you see on iOS Siri. Drawn UNDER the petals so the orb
    // core stays focal, but glows through additive blend.
    if (ribbons > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        // Collected per-ribbon geometry so we can lay travelling "neuron
        // packets" onto the SAME paths after stroking the strands.
        const ribbonGeo = [];
        for (let r = 0; r < ribbons; r++) {
            // flowSpd scales how fast the strand animates; flowDir biases the
            // orbit so the whole strand visibly drifts in/out (in swirl mode
            // flowDir=0 leaves only the intrinsic per-ribbon spin).
            const ribbonPhase = now * (0.0008 + r * 0.0004) * flowSpd + r * 1.7;
            // Base radius slightly outside the core so ribbons orbit the
            // ball rather than sit inside it. Each ribbon picks its own band.
            const baseRibbonR = baseR * (0.78 + r * 0.06) + amp * baseR * 0.04;
            // Stroke width: thin "strings" that thicken slightly with amp.
            const baseLineW = baseR * 0.022 + amp * baseR * 0.02;
            const lineW = Math.max(0.6, baseLineW * (ribbonWidth || 1.0));
            const ribbonAccent = pickColor(r * 1.2 + 0.6); // offset hue from petals
            ctx.strokeStyle = `rgba(${ribbonAccent}, ${(0.50 + amp * 0.30) * glowAlpha})`;
            ctx.lineWidth = lineW;
            ctx.beginPath();
            const segs = 140;
            // Net angular drift gives the strand a sense of travel direction:
            // inward (listening) the strand spirals toward the core, outward
            // (speaking) away from it. Encoded as a slow radial breathing tied
            // to flowDir so the strand's mean radius eases in/out over time.
            const driftR = flowDir * Math.sin(now * 0.0011 + r) * baseR * 0.05;
            const geo = { accent: ribbonAccent, pts: [] };
            for (let i = 0; i <= segs; i++) {
                const t = (i / segs) * Math.PI * 2;
                const wobble1 = Math.sin(t * 3 + ribbonPhase * 1.4) * baseR * (0.10 + amp * 0.10);
                const wobble2 = Math.sin(t * 5 - ribbonPhase * 0.8) * baseR * (0.05 + amp * 0.06);
                const rr = baseRibbonR + driftR + wobble1 + wobble2;
                const angle = t + ribbonPhase * 0.6 * (flowDir === 0 ? 1 : 1);
                const x = cx + Math.cos(angle) * rr;
                const y = cy + Math.sin(angle) * rr;
                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                geo.pts.push(x, y);
            }
            ctx.stroke();
            ribbonGeo.push(geo);
        }

        // ── Neuron packets ──────────────────────────────────────────────
        // Bright dots that travel ALONG each strand like signals down an
        // axon. Their position is a phase that advances with flowSpd and
        // moves in flowDir (so they run inward when listening, outward when
        // speaking, and just race around when thinking). A few packets per
        // strand, evenly spaced, each with a soft glow + comet trail.
        const pktsPerRibbon = Math.max(1, Math.round(2 * pktDensity));
        const travel = (now * 0.00022 * flowSpd) * (flowDir === 0 ? 1 : flowDir < 0 ? -1 : 1);
        for (let r = 0; r < ribbonGeo.length; r++) {
            const geo = ribbonGeo[r];
            const n = geo.pts.length / 2;          // sample count along strand
            for (let k = 0; k < pktsPerRibbon; k++) {
                // phase in [0,1) along the strand; spaced by k, advancing by travel
                let ph = (travel + k / pktsPerRibbon + r * 0.13) % 1;
                if (ph < 0) ph += 1;
                const fi = ph * (n - 1);
                const i0 = Math.floor(fi);
                const f = fi - i0;
                const x = geo.pts[i0 * 2] * (1 - f) + geo.pts[(i0 + 1) * 2] * f;
                const y = geo.pts[i0 * 2 + 1] * (1 - f) + geo.pts[(i0 + 1) * 2 + 1] * f;
                const pr = (baseR * 0.045 + amp * baseR * 0.02) * (ribbonWidth ? Math.max(0.7, ribbonWidth) : 1);
                const g = ctx.createRadialGradient(x, y, 0, x, y, pr * 2.6);
                const a = Math.min(1, (0.7 + amp * 0.4) * pktBright * glowAlpha);
                g.addColorStop(0, `rgba(255,255,255,${a})`);
                g.addColorStop(0.35, `rgba(${geo.accent},${a * 0.9})`);
                g.addColorStop(1, `rgba(${geo.accent},0)`);
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(x, y, pr * 2.6, 0, Math.PI * 2); ctx.fill();
            }
        }
        ctx.restore();
    }

    // Petal/wave layers — N rotating offset blobs that pulse with amp and
    // each pick a hue from the palette via flow-shifted lookup. With more
    // petals (launcher uses 8) and time-shifted color, the orb reads as a
    // continuous iridescent gradient sweep instead of distinct lobes.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter'; // additive blend → glowy bloom
    // Petal swirl picks up the state flow speed too, so the whole orb
    // breathes faster while thinking/speaking and calms when idle.
    const petalSpd = 0.6 + 0.4 * flowSpd;
    for (let p = 0; p < petals; p++) {
        const phase = now * (0.0007 + p * 0.0003) * petalSpd + p * (Math.PI * 2 / petals);
        const layerR = baseR * (0.95 + 0.05 * Math.sin(phase * 0.8) + 0.10 * amp);
        ctx.beginPath();
        const points = 96;
        for (let i = 0; i <= points; i++) {
            const t = (i / points) * Math.PI * 2;
            // Wobble shape: low-frequency overall undulation + high-frequency
            // detail; both grow with amp, so quiet idle looks like a smooth
            // breathing circle and loud speech looks like a flower.
            const lowFreq = (baseR * 0.10 + baseR * 0.18 * amp) * Math.sin(t * 3 + phase * 1.6);
            const highFreq = (baseR * 0.04 + baseR * 0.08 * amp) * Math.sin(t * 7 - phase * 0.6);
            const r = layerR + lowFreq + highFreq;
            const x = cx + Math.cos(t) * r;
            const y = cy + Math.sin(t) * r;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const petalAccent = pickColor(p);
        const fill = ctx.createRadialGradient(cx, cy, baseR * 0.55, cx, cy, baseR * 1.35);
        // More petals → less per-petal alpha so the additive blend doesn't
        // wash the orb out to white. Fade-out tied to petal count, not 4.
        const layerAlpha = (0.22 + amp * 0.22) * (1 - p / petals * 0.55) * glowAlpha;
        fill.addColorStop(0, `rgba(${petalAccent}, 0)`);
        fill.addColorStop(0.55, `rgba(${petalAccent}, ${layerAlpha * 0.6})`);
        fill.addColorStop(0.85, `rgba(${petalAccent}, ${layerAlpha})`);
        fill.addColorStop(1, `rgba(${petalAccent}, 0)`);
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.restore();

    // Inner solid orb — the bright "ball" the petals halo around.
    // Sized smaller (was 0.62) so the petals + ribbons + ECG mark have
    // more room to read, and the core feels like an inner light source
    // rather than a dominant ball.
    const coreR = baseR * (0.48 + 0.05 * amp);
    const core = ctx.createRadialGradient(cx - coreR * 0.32, cy - coreR * 0.36, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(255, 255, 255, ${0.92 + amp * 0.08})`);
    core.addColorStop(0.18, `rgba(${corePalette}, ${0.95})`);
    core.addColorStop(1, `rgba(${corePalette}, 0.55)`);
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Specular highlight on the upper-left so the core reads as 3D.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.30 + amp * 0.15})`;
    ctx.beginPath();
    ctx.ellipse(cx - coreR * 0.34, cy - coreR * 0.44, coreR * 0.32, coreR * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
}

// Linear blend two "r, g, b" rgb strings. Used to interpolate between
// adjacent palette colors so the flow rotation reads smoothly instead
// of stepping through discrete hues.
function blendRgbStrings(a, b, t) {
    const pa = a.split(',').map(s => parseInt(s.trim(), 10));
    const pb = b.split(',').map(s => parseInt(s.trim(), 10));
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return `${r}, ${g}, ${bl}`;
}
