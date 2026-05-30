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

/**
 * Open a Gemini Live session.
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
 * @param {function} opts.onClose   Called on socket close (clean or errored).
 * @param {function} opts.onError   Called on protocol/auth errors before close.
 * @returns {Object} session handle with sendText / sendAudio / close.
 */
export async function openLiveSession({
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
} = {}) {
    if (!apiKey) throw new Error('Gemini API key required for Live session.');

    const ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(apiKey)}`);
    ws.binaryType = 'arraybuffer';

    let setupAcked = false;
    let closed = false;

    const sendJson = (obj) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(obj));
    };

    // Promise that resolves when we receive setupComplete, so callers
    // can wait before sending content. Times out at 10s.
    const setupReady = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (!setupAcked) reject(new Error('Live setup timed out — server did not ack.'));
        }, 10_000);
        ws.addEventListener('open', () => {
            // Send the setup message immediately on open.
            sendJson({
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
                    // Transcribe both sides so we can render captions in the panel.
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
            });
        });
        const ackHandler = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.setupComplete) {
                    setupAcked = true;
                    clearTimeout(timeout);
                    ws.removeEventListener('message', ackHandler);
                    resolve();
                }
            } catch (_) {}
        };
        ws.addEventListener('message', ackHandler);
    });

    ws.addEventListener('message', (ev) => {
        try {
            const msg = JSON.parse(ev.data);
            if (msg.serverContent) {
                const c = msg.serverContent;
                // Output audio chunks → decode and forward to playback.
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
                // Captions / transcripts.
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
                    // User started talking mid-reply (server detected). The
                    // playback side should stop the current audio queue so
                    // we don't keep speaking over the user.
                    try { onTurnComplete?.({ interrupted: true }); } catch (_) {}
                }
            }
            if (msg.goAway) {
                console.warn('[mia/live] Server signaled goAway:', msg.goAway);
            }
        } catch (e) {
            console.warn('[mia/live] Failed to parse server message:', e);
        }
    });

    ws.addEventListener('error', (e) => {
        try { onError?.(e); } catch (_) {}
    });
    ws.addEventListener('close', (e) => {
        closed = true;
        try { onClose?.(e); } catch (_) {}
    });

    // Wait for setup ack before returning the handle so the caller doesn't
    // have to know about the protocol. Throws if setup fails / times out.
    await setupReady;

    return {
        // Send a turn of text input (instead of streaming mic audio).
        sendText(text) {
            sendJson({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text }] }],
                    turnComplete: true,
                },
            });
        },
        // Send a chunk of 16 kHz Int16Array PCM mic audio. Caller can
        // pipe a stream of these directly from the AudioWorklet output.
        sendAudio(int16Pcm) {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            sendJson({
                realtimeInput: {
                    audio: {
                        mimeType: 'audio/pcm;rate=16000',
                        data: int16ToBase64(int16Pcm),
                    },
                },
            });
        },
        // Tell the server we've stopped speaking (when we manage VAD ourselves).
        sendAudioStreamEnd() {
            sendJson({ realtimeInput: { audioStreamEnd: true } });
        },
        close() {
            closed = true;
            try { ws.close(); } catch (_) {}
        },
        get readyState() { return ws.readyState; },
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
