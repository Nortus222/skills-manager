# Releases from the Nortus fork

App update detection and installation both use this repository's channel:

`https://github.com/Nortus222/skills-manager/releases/latest/download/latest.json`

The app embeds the public key in `src-tauri/updater.pub`. The matching private
key and password are GitHub Actions secrets. Keep the same key for future
releases. Rotating it requires a migration for apps already installed.

## One-time Apple setup

Apple Developer ID signing and notarization are separate from the updater
signature. The release workflow requires both.

1. On the Mac that will retain the certificate key, open Keychain Access and
   choose Certificate Assistant → Request a Certificate from a Certificate
   Authority. Enter your email and a common name, leave CA Email Address blank,
   and save the request to disk.
2. Sign in as the Account Holder at
   [Developer Certificates](https://developer.apple.com/account/resources/certificates/list).
   Add a **Developer ID Application** certificate and upload the request.
   Download its `.cer` file and open it on the same Mac.
3. In Keychain Access → login → My Certificates, find the Developer ID
   Application certificate with its private key. Export it as `.p12`, set an
   export password, and keep the full certificate name as the signing identity.
4. In [App Store Connect](https://appstoreconnect.apple.com/), open Users and
   Access → Integrations → App Store Connect API → Team Keys. Request API access
   if needed. Generate a key named `Skills Manager Releases` with Developer
   access. Download the `.p8` once and retain its Key ID and Issuer ID.
5. Supply the local file paths and credential fields through the agent's private
   secret input. They are converted to the GitHub Actions secrets below; private
   certificate or key data belongs outside this repository.

Apple documents the [certificate request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/),
[Developer ID certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/),
and [team API key](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/).
Tauri documents [certificate export and notarization](https://v2.tauri.app/distribute/sign/macos/).

| Actions secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Fork updater key file contents |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password |
| `APPLE_CERTIFICATE` | Base64-encoded exported Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` export password |
| `APPLE_SIGNING_IDENTITY` | Full `Developer ID Application: … (TEAMID)` name |
| `APPLE_API_ISSUER` | Team API Issuer ID |
| `APPLE_API_KEY` | API Key ID |
| `APPLE_API_KEY_BASE64` | Base64-encoded API `.p8` file |

The updater key pair has been provisioned for this fork. Store its local private
recovery copy securely before changing machines. It is not part of Git backup.

## Publish a version

1. Merge the reviewed feature PR into `main`. The owner controls integration.
2. Prepare a new version in a feature worktree with
   `npm run release:prepare -- patch`. Fill in both changelogs, verify, and submit
   the version commit through a PR. The imported upstream `v1.43.3` tag cannot
   serve as the first fork release; use a new version such as `v1.43.4`.
3. After the owner merges it, create and push the matching `vX.Y.Z` tag on that
   merged commit. A manual Build & Release run must also select that tag.
4. The workflow checks channel/key/version consistency, signing-secret presence,
   and that the release commit is on `origin/main`. It refuses to overwrite a
   published release.
5. All five targets build. The CLI is staged through
   `scripts/release-channel.mjs stage-cli <target>` and embedded by
   `src-tauri/tauri.release.conf.json` before signing and notarization.
6. The draft stays unpublished until all builds pass. Every manifest payload is
   checked against this repository and tag, downloaded from the draft, and
   cryptographically verified with `minisign` and the embedded public key.
   macOS bundle and updater-archive notarization checks also remain required.
7. Only then does the workflow publish the draft, making `latest.json` available
   to clients. Failed verification leaves the draft unpublished for inspection.

## Bootstrap installed apps

Apps built before the fork channel change still trust upstream's endpoint and
key. Install a build containing this channel configuration once; those apps can
then receive subsequent fork releases through Settings → Check for updates.
A local build is not proof that the signed publication/update path has passed.

## Local checks

```sh
npm test
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

`npm test` includes the release-channel/asset validation tests. Release signing
and publication need the configured Actions credentials and a real tagged run.
