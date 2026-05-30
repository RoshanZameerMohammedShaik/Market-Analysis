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

// Live API model IDs. Verified against Google's get-started-websocket
// example (ai.google.dev/gemini-api/docs/live-api/get-started-websocket).
// The dashboard's display labels ("Gemini 2.5 Flash Native Audio Dialog")
// are NOT the API IDs — Google uses '...-live-preview' suffixed IDs in
// the actual API. We try the newer 3.1 first; if the user's account
// doesn't have access, the 2.5 fallback usually does.
const LIVE_MODELS = {
    'flash-live':   'gemini-3.1-flash-live-preview',
    'flash-25':     'gemini-2.5-flash-preview-native-audio-dialog',
    'flash-20':     'gemini-2.0-flash-live-001',
};

const WS_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Default voice — Leda. Roshan auditioned the Gemini Live voice
// catalog in AI Studio and picked her: female, friendly, slightly
// higher pitch — fits Mia's "warm but professional analyst" persona
// better than the lower-key Aoede default.
// Other prebuilt voices Google ships: Aoede, Puck, Charon, Kore,
// Fenrir, Orus, Zephyr.
const DEFAULT_VOICE = 'Leda';

// Live API setup messages have implicit size limits the preview models
// don't document — but our full ~20K-char Mia system prompt (with the
// tool registry, math rules, calibration grounding, etc.) returns 1007
// 'Invalid frame payload' on every Live model we tried. We compact down
// to identity + voice persona only. Tools / data lookups can still
// route through the text path; voice is for conversation, not RAG.
function compactPromptForLive(fullPrompt) {
    if (!fullPrompt) return 'You are Mia, a warm and numerate market intelligence analyst. Be concise.';
    // Voice prompt: identity + tone from the BASE prompt's opening, plus
    // a non-negotiable grounding rule. The full ~20K-char text-mode
    // prompt 1007s the Live setup; this compact version sticks to ~1.2K
    // and front-loads the rules that prevent hallucination.
    const identityHead = fullPrompt.slice(0, 600).trim();
    const groundingRule = `

VOICE GROUNDING — NON-NEGOTIABLE:
- You have tools (functions). You MUST call them for any factual claim about prices, signals, news, calibration, ledger data, hot picks, or what is on screen.
- Never state a price, percentage, or signal you have not just received from a tool result. If you don't have it, call the tool — don't guess and don't apologize for guessing.
- If a tool fails or returns no data, SAY SO. Don't fabricate a fallback number.
- If the user asks you to "load X", "switch to X", "show me X", "analyze X" — you MUST call select_symbol (or analyze_symbol) BEFORE saying you've done it. Never claim a UI action you didn't take.
- For "the current price of X", use get_current_signal (when X is loaded) or analyze_symbol (when not).
- For news / current events / things outside the engine: call web_search.
- Speak like a human: short sentences, conversational rhythm, but every number you say must trace back to a tool you just called.`;
    return identityHead + groundingRule + '\n\nKeep replies brief and conversational — this is voice mode.';
}

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
 * @param {Array}    opts.functionDeclarations Optional Gemini FunctionDeclaration array; when present, model can natively call tools mid-conversation.
 * @param {function} opts.onToolCall  Receives { id, name, args } per requested tool call. Caller invokes the tool and replies via session.sendToolResponse(id, result).
 * @returns {Object} session handle with sendText / sendAudio / sendToolResponse / close.
 */
export async function openLiveSession(opts = {}) {
    const {
        apiKey,
        model = LIVE_MODELS['flash-live'],
        systemPrompt = '',
        voiceName = DEFAULT_VOICE,
        onTextOut = null,
        onTextIn = null,
        onAudioOut = null,
        onTurnComplete = null,
        onClose = null,
        onError = null,
        functionDeclarations = null,
        onToolCall = null,
    } = opts;
    if (!apiKey) throw new Error('Gemini API key required for Live session.');

    // Try the chain of Live model IDs in order until one accepts the
    // setup. Different free-tier accounts have different access tiers
    // for preview models — flash-live (3.1) may 1008 for some, while
    // flash-25 native-audio works. We discover which one works by
    // attempting the connection rather than asking ahead of time.
    const modelChain = model
        ? [model, ...Object.values(LIVE_MODELS).filter(m => m !== model)]
        : Object.values(LIVE_MODELS);

    // Mutable state shared by every WebSocket the wrapper opens. Only
    // `userClosed` is set by the caller's close(); everything else is
    // managed internally as connections come and go.
    const state = {
        currentWs: null,
        userClosed: false,
        reconnectAttempts: 0,
        recentAttempts: [], // timestamps for sliding-window tracking
        successfulModel: null, // populated on first successful setup
        // Buffered audio chunks the caller wants to send while we're
        // mid-reconnect. We replay them once the new socket is ready
        // so a goAway during continuous mic capture doesn't drop a
        // word the user just said.
        pendingAudio: [],
    };

    // Open one WebSocket connection with a specific model. Returns a
    // Promise that resolves once setupComplete is acknowledged, or
    // rejects on failure. The resolved value is { ws, modelUsed } so
    // the caller knows which model in the chain actually worked.
    function openOnce(modelId) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(apiKey)}`);
            ws.binaryType = 'arraybuffer';
            let setupAcked = false;

            // Wire format for the raw WebSocket Live API:
            //   { "setup": { "model": "models/...",
            //                "generationConfig": { "responseModalities": [...],
            //                                      "speechConfig": {...} },
            //                "systemInstruction": { "parts": [...] } } }
            // The Python/JS SDKs use a `config={}` parameter that maps to
            // this `setup` envelope on the wire — I previously copied
            // `{config:...}` straight from an SDK example which is why
            // every model 1007'd: the server got valid JSON it didn't
            // recognize. Reference: ai.google.dev/api/live#bidigeneratecontentsetup
            const sendSetup = () => {
                const compactPrompt = compactPromptForLive(systemPrompt);
                const generationConfig = { responseModalities: ['AUDIO'] };
                if (voiceName) {
                    generationConfig.speechConfig = {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName } },
                    };
                }
                const setupBody = {
                    model: `models/${modelId}`,
                    generationConfig,
                    systemInstruction: { parts: [{ text: compactPrompt }] },
                    // Server-side STT/TTS captions. Without these, onTextIn /
                    // onTextOut never fire and the user can't see what they
                    // said or what Mia is saying.
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                };
                // Native tool calling. Pass FunctionDeclarations and the
                // model picks/executes tools mid-conversation. We dispatch
                // toolCall messages to runTool() in the message handler.
                //
                // No toolConfig.functionCallingConfig at the setup level —
                // we tried setting mode='AUTO' explicitly to insure against
                // a server-side default change, but Live's setup proto
                // rejects the field with 1007 ("Inconsistent data") even
                // though AUTO is the documented default elsewhere. Plain
                // `tools` alone works; the model defaults to AUTO without
                // needing the explicit hint.
                if (functionDeclarations && functionDeclarations.length) {
                    setupBody.tools = [{ functionDeclarations }];
                }
                const setupMsg = { setup: setupBody };
                const setupJson = JSON.stringify(setupMsg);
                // Log payload size so a future 1007 (which is usually a
                // schema or size violation) shows up alongside the model
                // identifier; lets us narrow "what changed" without a
                // network capture.
                console.log('[mia/live] Sending setup for model:', modelId, 'promptChars:', compactPrompt.length, 'voiceRequest:', voiceName || '(default)', 'tools:', functionDeclarations?.length || 0, 'setupBytes:', setupJson.length);
                ws.send(setupJson);
            };

            const setupTimeout = setTimeout(() => {
                if (!setupAcked) {
                    try { ws.close(); } catch (_) {}
                    reject(new Error('Live setup timed out — server did not ack.'));
                }
            }, 10_000);

            ws.addEventListener('open', sendSetup);

            ws.addEventListener('message', async (ev) => {
                // Live API frames arrive as Blobs (browser default for
                // binaryType='blob') OR ArrayBuffers (we set arraybuffer
                // for raw audio out) — both must be decoded to UTF-8
                // before JSON.parse. Plain strings are also possible.
                // Earlier we passed `ev.data` straight to JSON.parse,
                // which threw "Unexpected token 'o', '[object ArrayBuffer]'"
                // on the very setupComplete frame and timed out the
                // openOnce handshake.
                let text;
                if (typeof ev.data === 'string') {
                    text = ev.data;
                } else if (ev.data instanceof ArrayBuffer) {
                    text = new TextDecoder('utf-8').decode(ev.data);
                } else if (ev.data instanceof Blob) {
                    text = await ev.data.text();
                } else {
                    console.warn('[mia/live] unknown frame type:', typeof ev.data);
                    return;
                }
                let msg;
                try { msg = JSON.parse(text); }
                catch (e) { console.warn('[mia/live] parse error:', e, 'preview:', text.slice(0, 200)); return; }

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
                        // Skip modelTurn.text on AUDIO modality. The model
                        // sometimes attaches the full reply text in one
                        // shot here, which made captions render the whole
                        // sentence first and then "stream" via the
                        // separate outputTranscription deltas — looked
                        // like the caption was repeating itself. The
                        // streaming outputTranscription is what we want
                        // to show the user; ignore the bulk text path.
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

                // Native tool-call request from the model. The model has
                // decided (from the user's voice) to call one of our
                // FunctionDeclarations. We dispatch to onToolCall, the
                // caller runs the tool, and replies via sendToolResponse.
                // Reference: ai.google.dev/api/live#bidigeneratecontenttoolcall
                if (msg.toolCall?.functionCalls?.length) {
                    for (const fc of msg.toolCall.functionCalls) {
                        try {
                            onToolCall?.({ id: fc.id, name: fc.name, args: fc.args || {} });
                        } catch (e) {
                            console.warn('[mia/live] onToolCall handler threw:', e);
                        }
                    }
                }

                // Some models also send toolCallCancellation if a long-running
                // tool was preempted by user interrupt. We just log it; tools
                // here are short-lived so cancellation is best-effort.
                if (msg.toolCallCancellation) {
                    console.log('[mia/live] toolCallCancellation:', msg.toolCallCancellation);
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
            // Reuse the model that worked on initial connection — no need
            // to walk the chain again. If the same model now rejects, the
            // catch falls through to scheduling another retry.
            const newWs = await openOnce(state.successfulModel);
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

    // Initial connection — walk the model chain until one accepts the
    // setup. The first to ack setupComplete becomes the "winning" model
    // that reconnects will reuse. If ALL models 1008/4xx, surface the
    // last error so the caller falls back to Web Speech.
    let lastErr = null;
    for (const candidateModel of modelChain) {
        try {
            const ws = await openOnce(candidateModel);
            state.currentWs = ws;
            state.successfulModel = candidateModel;
            console.log('[mia/live] Connected on model:', candidateModel);
            break;
        } catch (e) {
            console.log('[mia/live] Model', candidateModel, 'rejected setup:', e.message);
            lastErr = e;
        }
    }
    if (!state.currentWs) {
        throw lastErr || new Error('No Live API model accepted the connection.');
    }

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
        // Reply to a toolCall with the tool's result (or an error string).
        // Live API expects a FunctionResponse keyed back to the original
        // call id so it can stitch the result into the conversation.
        // Reference: ai.google.dev/api/live#bidigeneratecontenttoolresponse
        sendToolResponse(id, result) {
            const ws = state.currentWs;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            // Live wants `response` as a structured object; wrap primitives
            // and errors so the model gets something parseable.
            const responseObj = (result && typeof result === 'object' && !Array.isArray(result))
                ? result
                : { value: result };
            ws.send(JSON.stringify({
                toolResponse: {
                    functionResponses: [{
                        id,
                        // The model passes a function name back when emitting
                        // toolCall — Live uses the id to match. Echoing the
                        // name field is harmless and matches Google's example.
                        response: responseObj,
                    }],
                },
            }));
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
    // Also branch to an analyser so the orb can read mic amplitude
    // while listening. The analyser is purely measurement — it doesn't
    // touch the PCM the worklet ships up to the WS, and doesn't need
    // ctx.destination either (we don't want to play the user's mic
    // back through the speakers, that's just feedback).
    const analyser = ctx.createAnalyser();
    // Larger FFT + heavier smoothing on the mic path. The orb was
    // reading raw 256-bin energy with light smoothing, which produced
    // visible flicker as individual frames jumped between speech-band
    // peaks. 512 bins narrows each band, smoothing 0.85 averages
    // adjacent frames so the orb breathes instead of strobing.
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.85;
    source.connect(analyser);
    return {
        stop() {
            try { node.disconnect(); } catch (_) {}
            try { source.disconnect(); } catch (_) {}
            try { analyser.disconnect(); } catch (_) {}
            try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
            try { ctx.close(); } catch (_) {}
        },
        getAmplitude() {
            const buf = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(buf);
            let sum = 0, count = 0;
            const lo = Math.floor(buf.length * 0.05);
            const hi = Math.floor(buf.length * 0.55);
            for (let i = lo; i < hi; i++) { sum += buf[i]; count++; }
            return count ? sum / count / 255 : 0;
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
    // Insert an AnalyserNode between sources and destination so callers
    // can read the actual RMS of what's playing — that's how the orb
    // gets to pulse with Leda's voice instead of a synthetic sine.
    // smoothing 0.8 + fftSize 512 keeps the orb tracking the cadence
    // of speech without strobing on individual phoneme attacks.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    analyser.connect(ctx.destination);

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
            src.connect(analyser);
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
        // Returns 0..1 amplitude reading from the playback path. Cheap
        // — the orb's render loop calls this once per frame at 60fps.
        getAmplitude() {
            const buf = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteFrequencyData(buf);
            // Average the speech band (skip very-low room rumble + very-high
            // hiss). Same heuristic as the mic readMicAmplitude path so the
            // orb's reactivity feels consistent across listen/speak modes.
            let sum = 0, count = 0;
            const lo = Math.floor(buf.length * 0.05);
            const hi = Math.floor(buf.length * 0.55);
            for (let i = lo; i < hi; i++) { sum += buf[i]; count++; }
            return count ? sum / count / 255 : 0;
        },
        // Returns true while there are still scheduled buffers playing —
        // caller can use this to know when Leda has stopped speaking
        // (vs. just paused between chunks during a long reply).
        isPlaying() {
            return nextStartTime > ctx.currentTime;
        },
        close() {
            this.clear();
            try { analyser.disconnect(); } catch (_) {}
            try { ctx.close(); } catch (_) {}
        },
    };
}

export const VOICE_LIVE_MODELS = LIVE_MODELS;
