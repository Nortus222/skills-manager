# Windows installer identity

The app and installer display names inherit `productName` from `tauri.conf.json`.
The executable, bundle identifier, NSIS registry keys and WiX UpgradeCode retain
their existing identities so the rename upgrades an existing installation.

`installer.nsi` and `main.wxs` are Tauri CLI 2.10.0's installer templates, with local
changes enclosed in `EM SKILLS begin/end` comments. They use the legacy product name for registry
identity, discovery of prior WiX installations and migration of generated links.
Apps displays the current product name. NSIS renames existing owned shortcuts
even during `/UPDATE`; missing shortcuts stay absent. NSIS preserves a destination
shortcut belonging to another app, together with the old owned shortcut.
Uninstall removes either owned NSIS name and preserves unrelated links. WiX uses
the stable legacy registry/search paths too. Its upgrade retains the custom path
and replaces the old Apps registration using the pinned UpgradeCode. MSI creates
current-name shortcuts using standard Windows Installer behavior; its added
legacy-link cleanup below is ownership checked.

The old MSI skips shortcut removal during a major upgrade. A small inline JScript
custom action removes only old links targeting this installation. It runs as an
elevated commit action after MSI has created the new links. The uninstall link
also requires an exact related old ProductCode. Legacy start menu directories are
left intact; the cleanup never recursively deletes a directory. Paths and related ProductCodes are serialized after
`CostFinalize` through `CustomActionData`, with `|` as an illegal-in-path delimiter.
The commit action validates the complete data, runs without impersonation so it
can access common shortcuts during UAC upgrades, and never interpolates paths
into script source. This cleanup is best effort. If enterprise policy disables the Windows Installer scripting engine, the app/Apps
rename and upgrade still succeed, but old MSI shortcuts may remain.

Upstream sources and original SHA-256 values:

- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
  `fe22026f68bdb3292fab376756035496ce0a35e3d580e06ebaa6a28295916eb3`
- https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.10.0/crates/tauri-bundler/src/bundle/windows/msi/main.wxs
  `c49ce8f2f138b70d492ce3135436504e0cdacebd810baa3b59dd6054d42f562b`

The upstream MIT license is preserved in `TAURI-LICENSE-MIT`.
Tauri still provides `utils.nsh`, language files, FileAssociation and plugins.
When upgrading the locked CLI, diff the new upstream template against this pinned
source, carry forward the marked changes and rerun the Windows lifecycle test.

On a Windows x64 CI runner with Node, Rust and `npm ci` completed, run:

```powershell
pwsh -File scripts/test-windows-installer.ps1
```

The test builds real old/new NSIS and MSI installers around a plain Rust executable,
using random fixture identities and temporary directories. It checks an existing
custom path, Apps display/version, `/P /UPDATE`, repeated update, shortcut rename,
shortcut opt-out, foreign-target ownership, MSI major upgrade, data retention and
uninstall. It does not use production keys or the skills library. The upstream baseline template is
fetched at its pinned tag and checked against the hash above.

The fixture does not test signed updater verification or the application framework.
Release validation still needs the signed app's in-app update and library retention.
The fixture deliberately substitutes unique legacy identities and an isolated
UpgradeCode, so it cannot uninstall a production app on the test machine.

`node --test scripts/windows-installer.test.mjs` checks packaging identities and
executes the actual inline MSI cleanup script with isolated shell/filesystem mocks.
The Windows lifecycle fixture remains required for real installer behavior.
