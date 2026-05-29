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
import { isConfigured } from './settings.js';

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

// Strip stuff that doesn't read well aloud: markdown bold/italic, code
// fences, list bullets, our own §§MIA_UNVERIFIED:...§§ sentinel, link
// brackets, bare URLs, and the agent's TOOL: scaffolding (in case any
// leaks into the streaming buffer before scrubToolNames runs).
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
        // Read currency cleanly: "$1,234" → "1234 dollars" sounds weird;
        // we'll let the engine read the digits naturally and just kill
        // the $ glyph (so "1,234" reads as "one thousand two hundred...").
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
const VOICE_OVERLAY_HTML = `
<div class="mia-voice-overlay" id="mia-voice-overlay" aria-hidden="true">
    <div class="mia-voice-panel" id="mia-voice-panel">
        <div class="mia-voice-head">
            <span class="mia-voice-head-title">Voice mode</span>
            <div class="mia-voice-head-actions">
                <button class="mia-voice-min" id="mia-voice-min" title="Minimize — keep listening while you use the app" aria-label="Minimize">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12 L19 12"/></svg>
                </button>
                <button class="mia-voice-close" id="mia-voice-close" title="Exit voice mode" aria-label="Exit voice mode">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6 L18 18 M18 6 L6 18"/></svg>
                </button>
            </div>
        </div>
        <div class="mia-voice-stage">
            <button class="mia-voice-orb" id="mia-voice-orb" type="button" aria-label="Tap to interrupt" data-state="idle">
                <canvas class="mia-voice-canvas" id="mia-voice-canvas" width="320" height="320"></canvas>
                <span class="mia-voice-orb-mark" aria-hidden="true">
                    <svg viewBox="0 0 32 24" width="60" height="44" xmlns="http://www.w3.org/2000/svg">
                        <path class="mia-voice-orb-ecg-trace" d="M2 14 L6 14 Q8 14 9 12 T11 14 L14 6 L17 16 L20 6 L23 14 Q25 14 26 12 T28 14 L32 14" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                        <path class="mia-voice-orb-ecg-blip" d="M2 14 L6 14 Q8 14 9 12 T11 14 L14 6 L17 16 L20 6 L23 14 Q25 14 26 12 T28 14 L32 14" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </span>
            </button>
            <div class="mia-voice-status" id="mia-voice-status">Mia</div>
            <div class="mia-voice-transcript" id="mia-voice-transcript"></div>
        </div>
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
    interimTranscript: '',
};

export function initVoice() {
    if (!isVoiceSupported()) return;
    insertVoiceButton();
    if (!document.getElementById('mia-voice-overlay')) {
        document.body.insertAdjacentHTML('beforeend', VOICE_OVERLAY_HTML);
        wireOverlayEvents();
    }
}

export function isVoiceSupported() {
    return !!(SR && TTS_AVAILABLE);
}

// Re-attach the mic button after each renderChat() — mia.js rebuilds the
// footer so the button needs to re-insert itself.
export function attachVoiceButton() {
    if (!isVoiceSupported()) return;
    insertVoiceButton();
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
    document.getElementById('mia-launcher')?.addEventListener('click', (e) => {
        if (session.minimized && session.open) {
            e.preventDefault();
            e.stopImmediatePropagation();
            restoreVoice();
        }
    }, true); // capture phase so we beat the chat-toggle handler
}

async function openVoice() {
    if (!isVoiceSupported()) return;
    if (!isConfigured()) return;
    session.open = true;
    session.minimized = false;
    session.autoLoop = true;
    session.history = loadHistory();
    const overlay = document.getElementById('mia-voice-overlay');
    overlay.classList.add('open');
    overlay.classList.remove('minimized');
    overlay.setAttribute('aria-hidden', 'false');
    // Add a body class so the rest of the app can shift right to make
    // room for the docked panel without us touching individual layouts.
    document.body.classList.add('mia-voice-panel-open');
    document.body.classList.remove('mia-voice-minimized');
    setLauncherOrbMode(false);

    // Pull the current theme accent so the orb glow matches whatever
    // theme the user picked. Read it freshly each open so theme switches
    // mid-session work too.
    const cs = getComputedStyle(document.documentElement);
    session.accentRgb = (cs.getPropertyValue('--accent-rgb') || '124, 58, 237').trim();

    setupCanvas();
    startCanvasLoop();
    // Slight delay so the open animation can settle before we ask for the
    // mic — feels less jumpy and keeps the orb visible while the permission
    // prompt fires.
    setTimeout(() => startListening(), 350);
}

function closeVoice() {
    session.open = false;
    session.minimized = false;
    session.autoLoop = false;
    stopListening();
    stopSpeaking();
    abortAgent();
    stopCanvasLoop();
    releaseMic();
    const overlay = document.getElementById('mia-voice-overlay');
    overlay.classList.remove('open', 'minimized');
    overlay.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mia-voice-panel-open', 'mia-voice-minimized');
    setLauncherOrbMode(false);
    setOrbState('idle');
    setStatus('Mia');
    setTranscript('');
}

// Minimize: hide the panel but keep the mic/agent/TTS pipeline alive.
// The Mia launcher swaps to "live orb" mode so the user knows Mia is
// still listening / speaking while they navigate the app.
function minimizeVoice() {
    if (!session.open) return;
    session.minimized = true;
    const overlay = document.getElementById('mia-voice-overlay');
    overlay.classList.add('minimized');
    document.body.classList.add('mia-voice-minimized');
    document.body.classList.remove('mia-voice-panel-open');
    setLauncherOrbMode(true);
    // Canvas RAF stays running — the launcher orb taps the same draw
    // loop via its own canvas (or shares state with the main one).
}

function restoreVoice() {
    if (!session.open) return;
    session.minimized = false;
    const overlay = document.getElementById('mia-voice-overlay');
    overlay.classList.remove('minimized');
    document.body.classList.add('mia-voice-panel-open');
    document.body.classList.remove('mia-voice-minimized');
    setLauncherOrbMode(false);
}

// Toggle the floating Mia launcher between "chat icon" and "live orb"
// modes. In orb mode it shows the active session state through CSS
// pulse + a tinted ring, with the orb-state attribute mirroring the
// main orb so listening/thinking/speaking visuals stay in sync.
function setLauncherOrbMode(on) {
    const launcher = document.getElementById('mia-launcher');
    if (!launcher) return;
    launcher.classList.toggle('mia-launcher-orb', !!on);
    if (on) launcher.dataset.orbState = session.state || 'idle';
    else delete launcher.dataset.orbState;
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
    session.state = s;
    const orb = document.getElementById('mia-voice-orb');
    if (orb) orb.dataset.state = s;
    // Mirror onto the launcher so the minimized-orb avatar reflects
    // the current state (idle, listening, thinking, speaking).
    const launcher = document.getElementById('mia-launcher');
    if (launcher && launcher.classList.contains('mia-launcher-orb')) {
        launcher.dataset.orbState = s;
    }
}
function setStatus(msg) {
    // Keep the "Mia" identity label fixed; the orb's state communicates
    // listening/thinking/speaking visually. We only swap the label out
    // for short error states ("Mic error: …") so we don't need a
    // separate UI region for them.
    const el = document.getElementById('mia-voice-status');
    if (!el) return;
    const isError = /error|couldn|didn|retry/i.test(msg);
    el.textContent = isError ? msg : 'Mia';
}
function setTranscript(msg) {
    const el = document.getElementById('mia-voice-transcript');
    if (!el) return;
    el.textContent = msg;
    // Reset any leftover spoken-sentence DOM structure from a prior turn.
    el.dataset.mode = msg ? 'plain' : 'empty';
    el.scrollTop = el.scrollHeight;
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
}

function highlightTranscript(sentence, charIdx) {
    const el = document.getElementById('mia-voice-transcript');
    if (!el) return;
    // Find the most recent sentence span matching this utterance.
    const sents = el.querySelectorAll('.mia-voice-tx-sent');
    if (!sents.length) return;
    const last = sents[sents.length - 1];
    if (last.dataset.full !== sentence) return;
    const spoken = last.querySelector('.mia-voice-tx-spoken');
    const pending = last.querySelector('.mia-voice-tx-pending');
    if (!spoken || !pending) return;
    const upTo = Math.max(0, Math.min(sentence.length, charIdx));
    spoken.textContent = sentence.slice(0, upTo);
    pending.textContent = sentence.slice(upTo);
    el.scrollTop = el.scrollHeight;
}

function escapeText(s) {
    return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
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
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        setStatus(`Mic error: ${e.error}. Tap to retry.`);
        setOrbState('idle');
    };
    rec.onend = () => {
        // Some browsers fire onend without ever firing a final result if the
        // user said nothing. If we still have a pending finalTranscript, run
        // it. Otherwise drop back to idle and let the user re-tap.
        if (session.state !== 'listening') return;
        const text = (session.finalTranscript + ' ' + session.interimTranscript).trim();
        if (text) handleUserUtterance(text);
        else {
            setStatus('Didn\'t catch that. Tap to try again.');
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

    session.chunker = makeSentenceChunker();
    session.speakQueue = [];
    session.speaking = false;

    let acc = '';
    let firstTokenAt = 0;
    const ac = new AbortController();
    session.abort = ac;

    // If the LLM hasn't streamed a single token within 800ms, slip in a
    // brief acknowledgement so the user doesn't sit in dead silence —
    // dead air is the strongest "this is a bot" signal there is.
    // Composed structurally rather than read from a static list (per
    // [[feedback-dynamic-only]]): one mild lead atom optionally combined
    // with a short tail, so each occurrence reads slightly different.
    const fillerTimer = setTimeout(() => {
        if (firstTokenAt || ac.signal.aborted || !session.open) return;
        const leads = ['okay', 'mm', 'right', 'so'];
        const tails = ['', '', 'one sec', 'let me see', 'thinking'];
        const lead = leads[Math.floor(Math.random() * leads.length)];
        const tail = tails[Math.floor(Math.random() * tails.length)];
        const phrase = tail ? `${lead}, ${tail}…` : `${lead}…`;
        enqueueSpeak(phrase);
    }, 800);

    try {
        const system = buildSystemPrompt() + '\n\n' + buildContextBlock(window.__miaLatestSignal || null);
        for await (const ev of runTurn({ system, messages: session.history, signal: ac.signal, onProgress: () => {} })) {
            if (ev.type === 'tool') {
                // Soft cue — flash the orb to indicate Mia is using a tool.
                pulseOrb();
                continue;
            }
            if (ev.type !== 'delta' || !ev.text) continue;
            if (!firstTokenAt) {
                firstTokenAt = Date.now();
                clearTimeout(fillerTimer);
                setOrbState('speaking');
                setStatus('Mia is speaking…');
            }
            acc += ev.text;
            const sentences = session.chunker.push(ev.text);
            for (const s of sentences) enqueueSpeak(s);
        }
        // Flush any trailing partial sentence.
        const tail = session.chunker.flush();
        for (const s of tail) enqueueSpeak(s);
    } catch (e) {
        clearTimeout(fillerTimer);
        if (e?.name !== 'AbortError') {
            console.warn('[voice] agent error:', e);
            setStatus(`Connection issue. Tap to try again.`);
            setOrbState('idle');
            return;
        }
    } finally {
        clearTimeout(fillerTimer);
        session.abort = null;
    }

    // Persist Mia's final reply into history so it's there when the user
    // closes voice mode and looks at the chat panel.
    if (acc.trim()) {
        const updated = loadHistory();
        updated.push({ role: 'assistant', content: acc.trim() });
        saveHistory(updated);
        session.history = updated;
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
    // Estimated speech duration so we can drive a fallback caption advance
    // on browsers (Firefox, some Safari) that don't fire onboundary. ~5
    // chars/sec at rate=1.05 is roughly conversational TTS pacing.
    const estDurMs = Math.max(800, (next.length / 5.25) * 1000 / u.rate);
    const speakStart = performance.now();
    u.onstart = () => {
        // If onboundary hasn't fired within 200ms of audio starting,
        // assume the browser doesn't support it and start a timer-driven
        // caption advance so the user still sees per-character streaming.
        setTimeout(() => {
            if (boundaryFired || !session.speaking) return;
            const advanceTick = () => {
                if (boundaryFired || !session.speaking) { highlightTimer = null; return; }
                const elapsed = performance.now() - speakStart;
                const ratio = Math.min(1, elapsed / estDurMs);
                const target = Math.floor(ratio * next.length);
                if (target > charIdx) {
                    charIdx = target;
                    highlightTranscript(next, charIdx);
                }
                if (ratio < 1) highlightTimer = setTimeout(advanceTick, 40);
                else highlightTimer = null;
            };
            advanceTick();
        }, 200);
    };
    u.onboundary = (e) => {
        // Each word boundary kicks the synthetic-amplitude clock, which is
        // what makes the orb pulse-with-the-voice during speech.
        session.lastBoundaryTs = performance.now();
        boundaryFired = true;
        if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = null; }
        if (typeof e.charIndex === 'number') {
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

function setupCanvas() {
    const canvas = document.getElementById('mia-voice-canvas');
    if (!canvas) return;
    // Match canvas backing store to display size, accounting for DPR.
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    session.canvas = canvas;
    session.canvasCtx = ctx;
    session.canvasW = rect.width;
    session.canvasH = rect.height;
}

function startCanvasLoop() {
    if (session.rafId) cancelAnimationFrame(session.rafId);
    const tick = (now) => {
        if (!session.open) return;
        drawOrb(now);
        session.rafId = requestAnimationFrame(tick);
    };
    session.rafId = requestAnimationFrame(tick);
}

function stopCanvasLoop() {
    if (session.rafId) cancelAnimationFrame(session.rafId);
    session.rafId = null;
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

function drawOrb(now) {
    const ctx = session.canvasCtx;
    if (!ctx) return;
    const W = session.canvasW;
    const H = session.canvasH;
    const cx = W / 2, cy = H / 2;
    ctx.clearRect(0, 0, W, H);

    // Pick raw amplitude based on state.
    let raw = 0;
    if (session.state === 'listening') raw = readMicAmplitude();
    else if (session.state === 'speaking') raw = syntheticSpeechAmplitude(now);
    else if (session.state === 'thinking') raw = 0.45 + 0.35 * Math.abs(Math.sin(now * 0.005));
    else raw = 0.20 + 0.05 * Math.sin(now * 0.003); // idle breath

    // Smooth so the orb doesn't strobe on noisy frames.
    session.smoothedAmp = session.smoothedAmp * 0.78 + raw * 0.22;
    const amp = session.smoothedAmp;

    // baseR = the outer radius the petals reach near. Eats most of the canvas
    // so the orb feels weighty, ChatGPT-style.
    const baseR = Math.min(W, H) * 0.40;
    const accent = session.accentRgb;

    // Outermost ambient glow halo. Sized so the gradient terminates *inside*
    // the canvas, not at its hard edge — otherwise we get a visible ring
    // where the halo gets clipped (canvas is square-ish but the orb is
    // round visually). Halo terminates at ~95% of the canvas-half so the
    // outer alpha is already 0 by the time it could touch the edge.
    const canvasHalf = Math.min(W, H) / 2;
    const haloR = Math.min(baseR + 60 + amp * 40, canvasHalf * 0.95);
    const haloGrad = ctx.createRadialGradient(cx, cy, baseR * 0.6, cx, cy, haloR);
    haloGrad.addColorStop(0, `rgba(${accent}, ${0.18 + amp * 0.22})`);
    haloGrad.addColorStop(1, `rgba(${accent}, 0)`);
    ctx.fillStyle = haloGrad;
    ctx.beginPath(); ctx.arc(cx, cy, haloR, 0, Math.PI * 2); ctx.fill();

    // Petal/wave layers — four rotating offset blobs that pulse with amp.
    // Each layer is drawn around 1.0 * baseR so the wobble sits *outside*
    // the inner solid orb and is actually visible.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter'; // additive blend → glowy bloom
    const petals = 4;
    for (let p = 0; p < petals; p++) {
        const phase = now * (0.0007 + p * 0.0003) + p * (Math.PI * 2 / petals);
        const layerR = baseR * (0.95 + 0.05 * Math.sin(phase * 0.8) + 0.10 * amp);
        ctx.beginPath();
        const points = 80;
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
        const fill = ctx.createRadialGradient(cx, cy, baseR * 0.55, cx, cy, baseR * 1.35);
        const layerAlpha = (0.22 + amp * 0.22) * (1 - p * 0.14);
        fill.addColorStop(0, `rgba(${accent}, 0)`);
        fill.addColorStop(0.55, `rgba(${accent}, ${layerAlpha * 0.6})`);
        fill.addColorStop(0.85, `rgba(${accent}, ${layerAlpha})`);
        fill.addColorStop(1, `rgba(${accent}, 0)`);
        ctx.fillStyle = fill;
        ctx.fill();
    }
    ctx.restore();

    // Inner solid orb — the bright "ball" the petals halo around.
    const coreR = baseR * (0.62 + 0.06 * amp);
    const core = ctx.createRadialGradient(cx - coreR * 0.32, cy - coreR * 0.36, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(255, 255, 255, ${0.92 + amp * 0.08})`);
    core.addColorStop(0.18, `rgba(${accent}, ${0.95})`);
    core.addColorStop(1, `rgba(${accent}, 0.55)`);
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fill();

    // Specular highlight on the upper-left so the core reads as 3D.
    ctx.fillStyle = `rgba(255, 255, 255, ${0.30 + amp * 0.15})`;
    ctx.beginPath();
    ctx.ellipse(cx - coreR * 0.34, cy - coreR * 0.44, coreR * 0.32, coreR * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fill();
}
