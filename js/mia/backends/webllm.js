// WebLLM has been retired — this module is intentionally a stub so any
// stale imports or settings still resolve cleanly. All exports are inert.

export function isWebGPUSupported() { return false; }
export function isMobile() {
    if (typeof navigator === 'undefined') return false;
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
}
export function isAvailableForTier() { return { ok: false, reason: 'WebLLM is retired — use Groq or Cloudflare API key.' }; }
export function getActiveTier() { return null; }
export async function loadModel() { throw new Error('WebLLM retired'); }
export async function* stream() { throw new Error('WebLLM retired'); }
export async function clearCache() {
    try {
        if (typeof indexedDB?.databases === 'function') {
            const dbs = await indexedDB.databases();
            for (const db of dbs) {
                if (db?.name && /webllm|mlc/i.test(db.name)) indexedDB.deleteDatabase(db.name);
            }
        }
    } catch (_) {}
    return { ok: true };
}
