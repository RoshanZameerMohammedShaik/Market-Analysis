// Gemini Live API voice — bidirectional WebSocket, native neural voice.
//
// Replaces Web Speech API (browser TTS + browser STT) with Gemini's
// own Live audio dialog model. Free tier offers UNLIMITED RPD/RPM
// for these models (capped only on TPM), so this can run all day
// without burning the regular Mia text quota.
//
// Protocol (from ai.google.dev/api/live):
//   - Connect: wss://generativelanguage.googleapis.com/ws/google.ai
//             .generativelanguage.v1beta.GenerativeService.BidiGenerateContent
//             ?key=API_KEY
//   - First message: { setup: { model, generationConfig, ... } }
//   - Wait for: { setupComplete: {} }
//   - Send mic audio: { realtimeInput: { audio: { mimeType, data: base64 } } }
//   - Receive audio: { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType, data: base64 } }] } } }
//
// Audio specs the API requires:
//   Input  — 16-bit PCM, 16 kHz, little-endian, mono
//   Output — 16-bit PCM, 24 kHz, little-endian, mono
//
// We build the input PCM in an AudioWorklet (off the main thread so
// captioning + UI updates stay smooth) and play output PCM by writing
// chunks to an AudioContext queue. Browser security: getUserMedia
// requires HTTPS, which GitHub Pages provides by default.

const LIVE_MODELS = {
    // Stable Live API models. Both have unlimited RPD per dashboard.
    'native-audio': 'gemini-2.5-flash-native-audio-dialog',
    'flash-live':   'gemini-3-flash-live',
};

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Default voice — Aoede is a warm female voice. Other prebuilt
// options Google ships: Puck, Charon, Kore, Fenrir, Leda, Orus, Zephyr.
// User can override via opts.voiceName when creating a session.
const DEFAULT_VOICE = 'Aoede';

// PCM-encoder AudioWorklet definition. We inject this as a Blob URL
// so we don't need a separate bundled file shipped from disk. The
// worklet downsamples mic audio (whatever the device's native rate is,
// usually 44.1 or 48 kHz) to 16 kHz mono PCM and posts each chunk back
// to the main thread as an Int16Array.
const PCM_WORKLET_SRC = `
class PCMEncoder extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = [];
        this._lastSampleRate = sampleRate; // global in worklet scope
    }
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const channel = input[0]; // mono
        // Decimate to 16 kHz. inputRate / 16000 = decimation factor.
        const ratio = this._lastSampleRate / 16000;
        for (let i = 0; i < channel.length; i += ratio) {
            const idx = Math.floor(i);
            this._buffer.push(channel[idx]);
        }
        // Flush in 100ms chunks (1600 samples at 16kHz) to keep latency low.
        if (this._buffer.length >= 1600) {
            const out = new Int16Array(this._buffer.length);
            for (let i = 0; i < this._buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, this._buffer[i]));
                out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            this.port.postMessage(out, [out.buffer]);
            this._buffer = [];
        }
        return true;
    }
}
registerProcessor('pcm-encoder', PCMEncoder);
`;

let workletBlobUrl = null;
function getWorkletURL() {
    if (workletBlobUrl) return workletBlobUrl;
    const blob = new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' });
    workletBlobUrl = URL.createObjectURL(blob);
    return workletBlobUrl;
}

function int16ToBase64(int16) {
    // Convert Int16Array to base64 string for the API. Doing this on a
    // ~3200-byte chunk every 100ms is cheap; no need for offloading.
    const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToInt16(b64) {
    const binary = atob(b64);
    const buf = new ArrayBuffer(binary.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return new Int16Array(buf);
}

// Reconnect tuning. Google enforces ~15min session caps on Live API; on
// goAway we reconnect immediately (server scheduled this, our quota is
// healthy). On unexpected close we back off so a hard outage doesn't
// hammer the endpoint. Cap total reconnect attempts so a permanently-
// broken model id doesn't drain the user's TPM forever.
const RECONNECT_BACKOFF_MS = [500, 1500, 3500, 7000, 15000];
const MAX_RECONNECT_ATTEMPTS = 8;
// Track recent attempts in a sliding window; "too many" within this
// window means something's actually broken and we should give up.
const RECONNECT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Open a Gemini Live session with auto-reconnect on goAway / unexpected
 * close. The session handle stays valid across reconnects — sendAudio /
 * sendText calls always route to the current WebSocket. Caller doesn't
 * see the reconnects unless they hit the attempt cap.
 *
 * @param {Object} opts
 * @param {string} opts.apiKey      Gemini API key.
 * @param {string} opts.model       Live API model id (defaults to native-audio).
 * @param {string} opts.systemPrompt Mia's system instruction.
 * @param {string} opts.voiceName   Prebuilt voice (default: Aoede).
 * @param {function} opts.onTextOut Receives transcripts of model's spoken output (for captions).
 * @param {function} opts.onTextIn  Receives transcripts of user's mic input (for captions).
 * @param {function} opts.onAudioOut Receives 24kHz Int16 PCM chunks for playback.
 * @param {function} opts.onTurnComplete Fires when model finishes a response.
 * @param {function} opts.onClose   Called only when the FINAL reconnect attempt fails (caller should fall back).
 * @param {function} opts.onError   Called on protocol/auth errors that won't recover via reconnect.
 * @returns {Object} session handle with sendText / sendAudio / close.
 */
export async function openLiveSession(opts = {}) {
    const {
        apiKey,
        model = LIVE_MODELS['native-audio'],
        systemPrompt = '',
        voiceName = DEFAULT_VOICE,
        onTextOut = null,
        onTextIn = null,
        onAudioOut = null,
        onTurnComplete = null,
        onClose = null,
        onError = null,
    } = opts;
    if (!apiKey) throw new Error('Gemini API key required for Live session.');

    // Mutable state shared by every WebSocket the wrapper opens. Only
    // `userClosed` is set by the caller's close(); everything else is
    // managed internally as connections come and go.
    const state = {
        currentWs: null,
        userClosed: false,
        reconnectAttempts: 0,
        recentAttempts: [], // timestamps for sliding-window tracking
        // Buffered audio chunks the caller wants to send while we're
        // mid-reconnect. We replay them once the new socket is ready
        // so a goAway during continuous mic capture doesn't drop a
        // word the user just said.
        pendingAudio: [],
    };

    // Open one WebSocket connection. Returns a Promise that resolves
    // once setupComplete is acknowledged, or rejects on failure. The
    // resolved value is the WebSocket itself (so we can send through it).
    function openOnce() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(apiKey)}`);
            ws.binaryType = 'arraybuffer';
            let setupAcked = false;

            const sendSetup = () => {
                ws.send(JSON.stringify({
                    setup: {
                        model: `models/${model}`,
                        generationConfig: {
                            responseModalities: ['AUDIO'],
                            speechConfig: {
                                voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                                languageCode: 'en-US',
                            },
                        },
                        systemInstruction: { parts: [{ text: systemPrompt }] },
                        inputAudioTranscription: {},
                        outputAudioTranscription: {},
                        realtimeInputConfig: {
                            automaticActivityDetection: {
                                disabled: false,
                                startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
                                endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
                            },
                            activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
                        },
                    },
                }));
            };

            const setupTimeout = setTimeout(() => {
                if (!setupAcked) {
                    try { ws.close(); } catch (_) {}
                    reject(new Error('Live setup timed out — server did not ack.'));
                }
            }, 10_000);

            ws.addEventListener('open', sendSetup);

            ws.addEventListener('message', (ev) => {
                let msg;
                try { msg = JSON.parse(ev.data); }
                catch (e) { console.warn('[mia/live] parse error:', e); return; }

                // Setup ack — flip the gate and resolve openOnce.
                if (msg.setupComplete && !setupAcked) {
                    setupAcked = true;
                    clearTimeout(setupTimeout);
                    resolve(ws);
                    return;
                }

                // Server is asking us to disconnect (session length cap,
                // typically). Don't surface to user; the close handler
                // below will trigger the auto-reconnect path.
                if (msg.goAway) {
                    console.log('[mia/live] Server goAway received; will reconnect transparently.');
                    return;
                }

                // Normal content path.
                if (msg.serverContent) {
                    const c = msg.serverContent;
                    const parts = c.modelTurn?.parts || [];
                    for (const p of parts) {
                        if (p.inlineData?.data && p.inlineData.mimeType?.startsWith('audio/')) {
                            const pcm = base64ToInt16(p.inlineData.data);
                            try { onAudioOut?.(pcm); } catch (_) {}
                        }
                        if (p.text) {
                            try { onTextOut?.(p.text); } catch (_) {}
                        }
                    }
                    if (c.outputTranscription?.text) {
                        try { onTextOut?.(c.outputTranscription.text); } catch (_) {}
                    }
                    if (c.inputTranscription?.text) {
                        try { onTextIn?.(c.inputTranscription.text); } catch (_) {}
                    }
                    if (c.turnComplete || c.generationComplete) {
                        try { onTurnComplete?.(); } catch (_) {}
                    }
                    if (c.interrupted) {
                        try { onTurnComplete?.({ interrupted: true }); } catch (_) {}
                    }
                }
            });

            ws.addEventListener('error', (e) => {
                console.warn('[mia/live] WebSocket error:', e);
                if (!setupAcked) {
                    clearTimeout(setupTimeout);
                    reject(new Error('Live WebSocket error during setup.'));
                }
                // Post-setup errors fall through to the close handler
                // (which decides whether to reconnect).
            });

            ws.addEventListener('close', (ev) => {
                clearTimeout(setupTimeout);
                if (!setupAcked) {
                    // Connection died before we even got setupComplete.
                    // Reject so the openOnce caller can retry / fail.
                    reject(new Error(`Live WS closed before setup (code ${ev.code}).`));
                    return;
                }
                // Post-setup close — kick off auto-reconnect unless the
                // user explicitly called our close(), or unless this WS
                // is no longer the "current" one (a stale callback from
                // an already-replaced socket).
                if (state.userClosed) return;
                if (state.currentWs !== ws) return;
                handleUnexpectedClose(ev);
            });
        });
    }

    // Track an attempt timestamp; prune anything outside the sliding
    // window. Returns true if we're still under the cap.
    function recordAttemptAndCheck() {
        const now = Date.now();
        state.recentAttempts = state.recentAttempts.filter(t => now - t < RECONNECT_WINDOW_MS);
        state.recentAttempts.push(now);
        return state.recentAttempts.length <= MAX_RECONNECT_ATTEMPTS;
    }

    async function handleUnexpectedClose(ev) {
        if (state.userClosed) return;
        const withinCap = recordAttemptAndCheck();
        if (!withinCap) {
            // Too many reconnects in the window — something's actually
            // broken (model retired, bad key, persistent network issue).
            // Stop trying and tell the caller so they can fall back to
            // Web Speech.
            console.warn('[mia/live] Reconnect cap hit; giving up. recent attempts:', state.recentAttempts.length);
            try { onClose?.(ev); } catch (_) {}
            try { onError?.(new Error('Live API: too many reconnects in 5 minutes; falling back.')); } catch (_) {}
            return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(state.reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)];
        state.reconnectAttempts++;
        console.log(`[mia/live] Reconnecting in ${delay}ms (attempt ${state.reconnectAttempts})…`);
        await new Promise(r => setTimeout(r, delay));
        if (state.userClosed) return;
        try {
            const newWs = await openOnce();
            state.currentWs = newWs;
            state.reconnectAttempts = 0; // success → reset backoff
            // Replay any buffered audio that piled up while we were
            // disconnected. Drops oldest if buffer got large to avoid
            // sending stale audio that the model can't usefully respond to.
            if (state.pendingAudio.length > 0) {
                const recent = state.pendingAudio.slice(-20); // ~2 seconds at 100ms chunks
                state.pendingAudio = [];
                for (const chunk of recent) {
                    try {
                        newWs.send(JSON.stringify({
                            realtimeInput: {
                                audio: {
                                    mimeType: 'audio/pcm;rate=16000',
                                    data: int16ToBase64(chunk),
                                },
                            },
                        }));
                    } catch (_) {}
                }
            }
            console.log('[mia/live] Reconnected.');
        } catch (err) {
            console.warn('[mia/live] Reconnect attempt failed:', err);
            // Schedule another attempt; the cap check will eventually
            // stop us if this keeps failing.
            handleUnexpectedClose(ev);
        }
    }

    // Initial connection. If this rejects, surface to the caller —
    // they'd want to fall back to Web Speech rather than retry blindly
    // (a bad key / wrong model id is best caught loudly on first open).
    state.currentWs = await openOnce();

    // Public handle. All sends route through state.currentWs which the
    // reconnect logic keeps current. If a send arrives during the gap
    // between an unexpected close and a successful reconnect, audio
    // gets buffered for replay and text gets dropped (text turns are
    // discrete and replaying them would double-prompt the model).
    return {
        sendText(text) {
            const ws = state.currentWs;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text }] }],
                    turnComplete: true,
                },
            }));
        },
        sendAudio(int16Pcm) {
            const ws = state.currentWs;
            if (state.userClosed) return;
            // Mid-reconnect: buffer so we don't lose words the user
            // is speaking right now.
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                state.pendingAudio.push(int16Pcm);
                // Cap the buffer at ~5 seconds (50 chunks of 100ms)
                // so a long outage doesn't grow it unboundedly.
                if (state.pendingAudio.length > 50) state.pendingAudio.shift();
                return;
            }
            ws.send(JSON.stringify({
                realtimeInput: {
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: int16ToBase64(int16Pcm),
                    },
                },
            }));
        },
        sendAudioStreamEnd() {
            const ws = state.currentWs;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        },
        close() {
            state.userClosed = true;
            try { state.currentWs?.close(); } catch (_) {}
            state.currentWs = null;
        },
        get readyState() {
            return state.currentWs?.readyState ?? WebSocket.CLOSED;
        },
    };
}

/**
 * Spin up the mic capture pipeline for the Live session. Returns a
 * { stop } handle. The caller passes a callback that gets a 16kHz
 * Int16 PCM Uint8Array each ~100ms. Internally:
 *   1. getUserMedia → MediaStream
 *   2. AudioContext + MediaStreamSource
 *   3. AudioWorklet running PCMEncoder
 *   4. worklet.port.onmessage → callback
 *
 * Detached from openLiveSession because the caller may want to start
 * capture after a "tap to start" prompt (browsers want a user gesture
 * before getUserMedia in some configs).
 */
export async function startMicCapture({ onPCMChunk }) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            sampleRate: 16000, // hint; browsers may ignore and resample on our side
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
        },
    });
    // AudioContext sample rate isn't always honored; the worklet decimates
    // to 16kHz regardless of what the device gave us.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule(getWorkletURL());
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-encoder');
    node.port.onmessage = (ev) => {
        try { onPCMChunk?.(ev.data); } catch (_) {}
    };
    source.connect(node);
    // The worklet doesn't need to feed audio to the speakers — we only
    // want the PCM data. So we don't connect node → ctx.destination.
    return {
        stop() {
            try { node.disconnect(); } catch (_) {}
            try { source.disconnect(); } catch (_) {}
            try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
            try { ctx.close(); } catch (_) {}
        },
    };
}

/**
 * Audio playback queue for incoming 24 kHz PCM chunks. Each chunk is
 * scheduled to play immediately after the previous one ends, so the
 * model's voice plays as a continuous stream even though it arrives
 * in many small chunks. clear() lets the caller stop playback if the
 * user interrupts (tap-to-cancel) or the model gets server-interrupted.
 */
export function createAudioOutputQueue() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    let nextStartTime = ctx.currentTime;
    const sources = new Set();

    return {
        push(int16Pcm) {
            if (!int16Pcm || !int16Pcm.length) return;
            // Convert Int16 → Float32 for the AudioBuffer.
            const float = new Float32Array(int16Pcm.length);
            for (let i = 0; i < int16Pcm.length; i++) {
                float[i] = int16Pcm[i] / (int16Pcm[i] < 0 ? 0x8000 : 0x7FFF);
            }
            const buffer = ctx.createBuffer(1, float.length, 24000);
            buffer.copyToChannel(float, 0);
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(ctx.destination);
            const start = Math.max(nextStartTime, ctx.currentTime);
            src.start(start);
            nextStartTime = start + buffer.duration;
            sources.add(src);
            src.onended = () => sources.delete(src);
        },
        clear() {
            // Stop everything queued — the user interrupted.
            for (const s of sources) {
                try { s.stop(); } catch (_) {}
            }
            sources.clear();
            nextStartTime = ctx.currentTime;
        },
        close() {
            this.clear();
            try { ctx.close(); } catch (_) {}
        },
    };
}

export const VOICE_LIVE_MODELS = LIVE_MODELS;
