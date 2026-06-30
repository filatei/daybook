# Daybook — Android app (Trusted Web Activity)

The Android app is a **Trusted Web Activity (TWA)**: a thin native wrapper around
the existing PWA at https://daybook.torama.money. It ships a real
Play-Store-installable `.aab`/`.apk` with its own icon and identity, runs
fullscreen (no browser chrome), and the PWA's features keep working inside it:

- **Push notifications** — Web Push (VAPID), enabled in-app via Profile → Enable notifications.
- **Offline** — the service worker (`sw.js`) + the offline outbox.
- **Bluetooth thermal printing** — Web Bluetooth (`useBTPrinter.js`) works in the TWA.

Because it's a TWA, you **never rebuild the app to ship UI changes** — push the web
app as usual and the Android app updates automatically on next launch.

App identity: **package `money.torama.daybook`**, host `daybook.torama.money`.

---

## One-time prerequisites

- Node 18+ and Java JDK 17 installed.
- Install Bubblewrap: `npm i -g @bubblewrap/cli`
- Bubblewrap will offer to download the Android SDK + JDK on first `build`; accept.

## 1. Generate (or reuse) a signing keystore

Use ONE keystore for the life of the app — losing it means you can't update the
Play listing. Keep it out of git (already covered by storing it under `android/`,
add to `.gitignore`).

```bash
cd android
keytool -genkeypair -v -keystore android.keystore -alias daybook \
  -keyalg RSA -keysize 2048 -validity 9125 \
  -dname "CN=Torama Technologies, O=Torama Technologies, L=Yenagoa, C=NG"
# remember the store + key passwords
```

## 2. Put the key's SHA-256 into Digital Asset Links

The TWA only runs fullscreen (no URL bar) if the site verifies the app. Get the
fingerprint and paste it into `frontend/src/public/.well-known/assetlinks.json`,
replacing `REPLACE_WITH_YOUR_SIGNING_KEY_SHA256_FINGERPRINT`:

```bash
keytool -list -v -keystore android.keystore -alias daybook | grep SHA256
```

> If you publish via **Google Play App Signing** (recommended), ALSO add the
> SHA-256 that Play shows under *Release → Setup → App signing*. assetlinks.json
> can list multiple fingerprints — include both your upload key and Play's key.

Then deploy the web app so `https://daybook.torama.money/.well-known/assetlinks.json`
is live (it's served as a normal static file from `frontend/dist`).

## 3. Build the Android app

```bash
cd android
bubblewrap init --manifest ./twa-manifest.json   # first time only; reads this file
bubblewrap build                                  # produces app-release-bundle.aab + app-release-signed.apk
```

- `app-release-bundle.aab` → upload to Google Play Console.
- `app-release-signed.apk` → for direct install / sideload testing.

## 4. Test

Install the APK on an Android phone:
```bash
adb install -r app-release-signed.apk
```
Open it — it should launch fullscreen with no browser bar (proves asset-link
verification worked). Then sign in, go to **Profile → Enable notifications**, and
trigger a notification (e.g. submit a daily report) to confirm push arrives.

---

## Server env required for push (see ../DEPLOY or secrets)

```
VAPID_PUBLIC_KEY=<public key>
VAPID_PRIVATE_KEY=<private key>     # SECRET — set in deploy secrets, never commit
VAPID_SUBJECT=mailto:support@torama.money
```

Generate a fresh pair any time with: `npx web-push generate-vapid-keys`
(the public key must match the one the frontend fetches from
`/api/push/vapid-public-key`, which reads `VAPID_PUBLIC_KEY`).
