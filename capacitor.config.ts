import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wrapper config for Market Analyzer.
//
// Strategy: the app is hosted at https://market-ai.pages.dev (Cloudflare
// Pages, auto-deployed from GitHub). The native Android shell loads
// that URL inside its WebView — so every code change you push goes
// live in the installed APK on the user's next launch. No app rebuild
// required for content changes.
//
// `appId` is the package identifier (reverse-DNS form) — must be
// unique per Play Store entry but for friends-and-family APK sharing
// any unique value works. I picked `com.marketanalyzer.app` because
// it reads like a real product. Change later if you grab a real
// domain.

const config: CapacitorConfig = {
    appId: 'com.marketanalyzer.app',
    appName: 'Market Analyzer',
    // Crucial: server.url makes the app load from the live URL on
    // every launch, instead of bundling a static copy. This is what
    // lets `git push` deploy to the installed app — no rebuild.
    // androidScheme: 'https' so links/redirects inside the WebView
    // resolve correctly.
    server: {
        url: 'https://market-ai.pages.dev',
        androidScheme: 'https',
        cleartext: false,
    },
    // No webDir needed since we serve from server.url. Capacitor
    // requires it to exist as a path, so we point at a placeholder
    // folder we'll create (`www/`) with just an index.html that says
    // "this app loads its content from market-ai.pages.dev". Only
    // shown if server.url is unreachable.
    webDir: 'www',
    android: {
        // White on black status bar so the splash screen reads cleanly.
        backgroundColor: '#000000',
        // Allow the WebView's window-open calls (e.g. opening news links
        // in an external browser) to work as expected.
        allowMixedContent: false,
    },
    plugins: {
        SplashScreen: {
            // The HTML splash inside our app does the cinematic
            // sequence (shimmer → settle → BAMM). Capacitor's native
            // splash is just a 1-second black bridge between launch
            // and WebView ready, so the user sees solid black until
            // the HTML splash takes over — no white flash.
            launchShowDuration: 1500,
            launchAutoHide: true,
            backgroundColor: '#000000',
            androidSplashResourceName: 'splash',
            androidScaleType: 'CENTER_CROP',
            showSpinner: false,
        },
    },
};

export default config;
