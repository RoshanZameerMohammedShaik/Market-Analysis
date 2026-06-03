# Build the Android APK for friends-and-family distribution

Sit-down checklist for when you're at your Mac with a free afternoon. The
config files are already in the repo — these are the commands to run.

## One-time setup

### 1. Install Node.js (if you don't already have it)

```bash
brew install node
node --version    # should print v18+ or v20+
```

### 2. Install Android Studio

Download from <https://developer.android.com/studio>. Free, ~3GB.

After install, open Android Studio at least once so it auto-installs the
Android SDK + emulator. Then in Preferences → Build, Execution, Deployment →
Build Tools → Gradle, note the SDK path it uses (usually
`~/Library/Android/sdk`).

### 3. Add the SDK path to your shell

Append to `~/.zshrc`:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

Then `source ~/.zshrc`.

## Per-clone setup (do once per machine)

In the repo root:

```bash
git pull origin main          # grab latest config
npm install                   # installs @capacitor/cli, @capacitor/core, @capacitor/android
npx cap add android           # creates the android/ folder with native scaffolding
npx cap sync                  # copies the web assets into the android project
```

After `cap add android`, the `android/` folder is created with all the
native scaffolding. Commit it to the repo so future clones don't need
to regenerate (`git add android && git commit -m "chore: capacitor android scaffolding"`).

## Build a debug APK (for sharing)

```bash
npm run android:build:debug
```

The APK lands at:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

That file is what you share. AirDrop / email / WeTransfer it to your
friends. They tap to install. Done.

## Build a release APK (signed, smaller, faster)

Release builds need signing. One-time keystore setup:

```bash
keytool -genkey -v -keystore ~/market-analyzer-release.keystore \
        -alias marketanalyzer -keyalg RSA -keysize 2048 -validity 10000
```

Save the password somewhere safe — losing it means you can't update
existing installs. Then:

```bash
npm run android:build:release
```

Output:

```
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

Sign it:

```bash
$ANDROID_HOME/build-tools/<version>/apksigner sign \
    --ks ~/market-analyzer-release.keystore \
    --ks-key-alias marketanalyzer \
    android/app/build/outputs/apk/release/app-release-unsigned.apk
```

Now `app-release-unsigned.apk` is signed and ready to share.

## Updating the app for users

The app loads `https://market-ai.pages.dev` on every launch. So:

- **Code changes** (most updates): just `git push`. Cloudflare Pages
  redeploys, and the next time the user opens the app they see the
  new code. **No rebuild, no re-share.**
- **Capacitor native changes** (rare — splash screen tweaks, plugin
  upgrades, app icon, app name): rebuild the APK and re-share.

## Pre-flight checklist before sharing the first APK

- [ ] App launches and shows the splash overlay
- [ ] Splash settles, BAMM animation completes
- [ ] Main app loads — title, search, hot picks visible
- [ ] Tap "Resources" → panel slides in
- [ ] Tap "Portfolio" → panel slides in (no notch overlap)
- [ ] Mia (💬 launcher) → panel slides in (no notch overlap)
- [ ] Settings gear → menu opens, theme/currency switch works
- [ ] Mia voice mode → listens, responds (test with mic permission)
