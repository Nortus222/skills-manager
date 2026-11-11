# Run on an isolated Windows x64 runner after npm ci, with Rust installed.
# Builds actual Tauri NSIS/MSI installers around a plain fixture executable.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'This lifecycle test requires Windows.' }

$repo = Split-Path $PSScriptRoot -Parent
$cli = Join-Path $repo 'node_modules/@tauri-apps/cli/tauri.js'
$cliPackage = Get-Content (Join-Path $repo 'node_modules/@tauri-apps/cli/package.json') -Raw | ConvertFrom-Json
if ($cliPackage.version -ne '2.10.0') { throw 'Review the vendored template before changing Tauri CLI 2.10.0.' }
$id = [guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "em-installer-$id"
$legacyName = "skills-manager-fixture-$id"
$newName = "EM Skills fixture-$id"
$publisher = "EM installer fixture $id"
$binary = "em-installer-fixture-$id"
$identifier = "com.example.emfixture$id"
$fixtureUpgradeCode = [guid]::NewGuid().ToString()
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$legacyName"
$newUninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$newName"
$manufacturerKey = "HKCU:\Software\$publisher"
$programs = [Environment]::GetFolderPath('Programs')
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$legacyLinks = @((Join-Path $programs "$legacyName.lnk"), (Join-Path $desktop "$legacyName.lnk"))
$newLinks = @((Join-Path $programs "$newName.lnk"), (Join-Path $desktop "$newName.lnk"))
$data = Join-Path $env:APPDATA $identifier
$install = Join-Path $root 'custom install directory'
$commonPrograms = [Environment]::GetFolderPath('CommonPrograms')
$commonDesktop = [Environment]::GetFolderPath('CommonDesktopDirectory')
$msiLegacyLinks = @((Join-Path $commonDesktop "$legacyName.lnk"), (Join-Path $commonPrograms "$legacyName/$legacyName.lnk"), (Join-Path $install "Uninstall $legacyName.lnk"))
$msiNewLinks = @((Join-Path $commonDesktop "$newName.lnk"), (Join-Path $commonPrograms "$newName/$newName.lnk"), (Join-Path $install "Uninstall $newName.lnk"))

function Assert($condition, [string]$message) {
  if (-not $condition) { throw $message }
}
function Run-Installer([string]$path, [string]$arguments) {
  $log = $null
  if ($path -eq 'msiexec.exe') {
    $log = Join-Path $root ("msi-" + [guid]::NewGuid().ToString('N') + '.log')
    $arguments += " /L*V `"$log`""
  }
  $process = Start-Process -FilePath $path -ArgumentList $arguments -PassThru
  if (-not $process.WaitForExit(120000)) {
    $process.Kill()
    throw "Installer timed out: $path $arguments"
  }
  if ($process.ExitCode -ne 0 -and $log -and (Test-Path $log)) {
    Get-Content $log -Tail 100 | Out-Host
  }
  Assert ($process.ExitCode -eq 0) "Installer exited $($process.ExitCode): $path"
}
function New-Link([string]$path, [string]$target) {
  $link = $shell.CreateShortcut($path)
  $link.TargetPath = $target
  $link.Save()
}
function Assert-Registration {
  $registration = Get-ItemProperty $uninstallKey
  Assert ($registration.DisplayName -eq $newName) 'Apps display name was not updated.'
  Assert ($registration.DisplayVersion -eq '1.43.6') 'Apps version was not updated.'
  Assert ($registration.InstallLocation.Trim('"') -eq $install) 'The custom installation directory changed.'
  Assert (-not (Test-Path $newUninstallKey)) 'The rename created a duplicate Apps registration.'
  Assert (Test-Path (Join-Path $install "$binary.exe")) 'The updated executable is missing.'
  Assert ((Get-Content (Join-Path $data 'sentinel')) -eq 'preserve fixture data') 'User data changed.'
}
function Bundle-Fixture([string]$name, [string]$version, [string]$template, [string]$format = 'nsis') {
  $config = @{
    productName = $name; version = $version; identifier = $identifier
    build = @{ frontendDist = '../frontend' }
    bundle = @{
      active = $true; targets = @('nsis'); icon = @(); publisher = $publisher
      windows = @{
        webviewInstallMode = @{ mode = 'skip' }
        nsis = @{ template = $template; installMode = 'currentUser'; languages = @('English') }
      }
    }
  }
  if ($format -eq 'msi') {
    $config.bundle.targets = @('msi')
    $config.bundle.icon = @((Join-Path $repo 'src-tauri/icons/icon.ico'))
    $config.bundle.windows.Remove('nsis')
    $config.bundle.windows.wix = @{ template = $template; upgradeCode = $fixtureUpgradeCode; language = 'en-US' }
  }
  $config | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Encoding utf8
  Push-Location $root
  try {
    & node $cli bundle --ci --no-sign --bundles $format | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Tauri fixture bundle failed.' }
  } finally { Pop-Location }
  $pattern = if ($format -eq 'msi') { '*.msi' } else { '*-setup.exe' }
  $output = @(Get-ChildItem (Join-Path $root "src-tauri/target/release/bundle/$format") -Filter $pattern | Where-Object Name -Like "${name}_*")
  Assert ($output.Count -eq 1) 'Expected one fixture installer.'
  return $output[0].FullName
}

function Get-FixtureMsiRegistration {
  foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall')) {
    if (Test-Path $key) {
      Get-ChildItem $key | Where-Object { $_.GetValue('Publisher') -eq $publisher -and $_.GetValue('WindowsInstaller') -eq 1 } | Get-ItemProperty
    }
  }
}
function Assert-MsiRegistration {
  $entries = @(Get-FixtureMsiRegistration)
  Assert ($entries.Count -eq 1) 'Expected one MSI Apps registration after upgrade.'
  Assert ($entries[0].DisplayName -eq $newName) 'MSI Apps display name did not update.'
  Assert ($entries[0].DisplayVersion -eq '1.43.6') 'MSI Apps version did not update.'
  Assert ($entries[0].InstallLocation.TrimEnd('\') -eq $install) 'MSI lost the existing custom installation path.'
  Assert ((Get-ItemProperty "$manufacturerKey\$legacyName").InstallDir.TrimEnd('\') -eq $install) 'MSI changed its installation registry identity.'
  Assert ((Get-Content (Join-Path $data 'sentinel')) -eq 'preserve fixture data') 'MSI changed user data.'
}

New-Item -ItemType Directory -Force (Join-Path $root 'src-tauri/src'), (Join-Path $root 'frontend'), $data | Out-Null
try {
  # Scope every registry key, executable, data path and shortcut to a random fixture.
  # The only production-template substitution is its legacy identity constant.
  $upstream = Join-Path $root 'upstream.nsi'
  Invoke-WebRequest 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.10.0/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi' -OutFile $upstream
  Assert ((Get-FileHash $upstream -Algorithm SHA256).Hash -eq 'FE22026F68BDB3292FAB376756035496CE0A35E3D580E06EBAA6A28295916EB3') 'Pinned upstream template hash mismatch.'
  $custom = Join-Path $root 'renamed.nsi'
  $template = Get-Content (Join-Path $repo 'src-tauri/windows/installer.nsi') -Raw
  Assert ($template.Contains('!define LEGACY_PRODUCTNAME "skills-manager"')) 'Legacy identity definition is missing.'
  $template.Replace('!define LEGACY_PRODUCTNAME "skills-manager"', "!define LEGACY_PRODUCTNAME `"$legacyName`"") | Set-Content $custom -Encoding utf8
  @"
[package]
name = "$binary"
version = "1.43.5"
edition = "2021"
"@ | Set-Content (Join-Path $root 'src-tauri/Cargo.toml') -Encoding utf8
  'fn main() {}' | Set-Content (Join-Path $root 'src-tauri/src/main.rs') -Encoding utf8
  'fixture' | Set-Content (Join-Path $root 'frontend/index.html') -Encoding utf8
  'preserve fixture data' | Set-Content (Join-Path $data 'sentinel') -Encoding utf8
  & cargo build --release --manifest-path (Join-Path $root 'src-tauri/Cargo.toml')
  if ($LASTEXITCODE -ne 0) { throw 'Fixture executable build failed.' }
  $baseline = Bundle-Fixture $legacyName '1.43.5' $upstream
  $renamed = Bundle-Fixture $newName '1.43.6' $custom

  # Real old installation, updater-style /P /UPDATE replacement, repeat, uninstall.
  Run-Installer $baseline "/S /D=$install"
  Assert ((Get-ItemProperty $uninstallKey).DisplayName -eq $legacyName) 'Baseline installation was not registered.'
  foreach ($link in $legacyLinks) { Assert (Test-Path $link) "Baseline shortcut missing: $link" }
  Run-Installer $renamed '/P /UPDATE'
  Assert-Registration
  foreach ($link in $legacyLinks) { Assert (-not (Test-Path $link)) "Legacy shortcut remains: $link" }
  foreach ($link in $newLinks) {
    Assert (Test-Path $link) "Renamed shortcut missing: $link"
    Assert ($shell.CreateShortcut($link).TargetPath -eq (Join-Path $install "$binary.exe")) "Shortcut targets another executable: $link"
  }
  Run-Installer $renamed '/P /UPDATE'
  Assert-Registration
  Run-Installer (Join-Path $install 'uninstall.exe') "/S _?=$install"
  Assert (-not (Test-Path $uninstallKey)) 'Uninstall left an Apps registration.'
  foreach ($link in $newLinks) { Assert (-not (Test-Path $link)) "Uninstall left shortcut: $link" }
  Assert (Test-Path (Join-Path $data 'sentinel')) 'Default uninstall deleted app data.'

  # Normal passive upgrades must not overwrite a foreign current-name destination.
  $foreignTarget = Join-Path $env:WINDIR 'notepad.exe'
  Run-Installer $baseline "/S /D=$install"
  foreach ($link in $newLinks) { New-Link $link $foreignTarget }
  Run-Installer $renamed '/P'
  Assert-Registration
  foreach ($link in $newLinks) {
    Assert ($shell.CreateShortcut($link).TargetPath -eq $foreignTarget) "Normal upgrade overwrote a foreign destination: $link"
  }
  foreach ($link in $legacyLinks) { Assert (Test-Path $link) "Normal upgrade lost its owned fallback shortcut: $link" }
  Run-Installer (Join-Path $install 'uninstall.exe') "/S _?=$install"
  foreach ($link in $legacyLinks) { Assert (-not (Test-Path $link)) "Uninstall left owned legacy shortcut: $link" }
  foreach ($link in $newLinks) {
    Assert (Test-Path $link) "Uninstall removed a foreign destination: $link"
    Remove-Item $link -Force
  }

  # An updater must preserve a user who opted out of shortcuts.
  Run-Installer $baseline "/S /NS /D=$install"
  Run-Installer $renamed '/P /UPDATE'
  Assert-Registration
  foreach ($link in ($legacyLinks + $newLinks)) { Assert (-not (Test-Path $link)) "Update created an unwanted shortcut: $link" }
  Run-Installer (Join-Path $install 'uninstall.exe') "/S _?=$install"

  # Only shortcut targets belonging to this installation may be changed/deleted.
  Run-Installer $baseline "/S /NS /D=$install"
  $foreignTarget = Join-Path $env:WINDIR 'notepad.exe'
  foreach ($link in $legacyLinks) { New-Link $link $foreignTarget }
  Run-Installer $renamed '/P /UPDATE'
  Assert-Registration
  foreach ($link in $legacyLinks) {
    Assert ($shell.CreateShortcut($link).TargetPath -eq $foreignTarget) "Update modified a foreign shortcut: $link"
  }
  foreach ($link in $newLinks) { Assert (-not (Test-Path $link)) "Update copied a foreign shortcut: $link" }
  Run-Installer (Join-Path $install 'uninstall.exe') "/S _?=$install"
  foreach ($link in $legacyLinks) { Assert (Test-Path $link) "Uninstall deleted a foreign shortcut: $link" }
  # Real MSI major upgrade, retaining the old registry/search paths and UpgradeCode.
  $upstreamWix = Join-Path $root 'upstream.wxs'
  Invoke-WebRequest 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.10.0/crates/tauri-bundler/src/bundle/windows/msi/main.wxs' -OutFile $upstreamWix
  Assert ((Get-FileHash $upstreamWix -Algorithm SHA256).Hash -eq 'C49CE8F2F138B70D492CE3135436504E0CDACEBD810BAA3B59DD6054D42F562B') 'Pinned upstream WiX template hash mismatch.'
  $customWix = Join-Path $root 'renamed.wxs'
  $wix = Get-Content (Join-Path $repo 'src-tauri/windows/main.wxs') -Raw
  Assert ($wix.Contains('<?define LegacyProductName = "skills-manager" ?>')) 'WiX legacy identity definition is missing.'
  $wix.Replace('<?define LegacyProductName = "skills-manager" ?>', "<?define LegacyProductName = `"$legacyName`" ?>") | Set-Content $customWix -Encoding utf8
  $baselineMsi = Bundle-Fixture $legacyName '1.43.5' $upstreamWix 'msi'
  $renamedMsi = Bundle-Fixture $newName '1.43.6' $customWix 'msi'
  Run-Installer 'msiexec.exe' "/i `"$baselineMsi`" /qn /norestart INSTALLDIR=`"$install`""
  Assert (@(Get-FixtureMsiRegistration).Count -eq 1) 'Baseline MSI installation was not registered.'
  foreach ($link in $msiLegacyLinks) { Assert (Test-Path $link) "Baseline MSI shortcut missing: $link" }
  Run-Installer 'msiexec.exe' "/i `"$renamedMsi`" /qn /norestart"
  Assert-MsiRegistration
  foreach ($link in $msiLegacyLinks) { Assert (-not (Test-Path $link)) "Legacy MSI shortcut remains: $link" }
  foreach ($link in $msiNewLinks) { Assert (Test-Path $link) "Renamed MSI shortcut missing: $link" }
  Run-Installer 'msiexec.exe' "/x `"$renamedMsi`" /qn /norestart"
  Assert (@(Get-FixtureMsiRegistration).Count -eq 0) 'MSI uninstall left an Apps registration.'
  foreach ($link in $msiNewLinks) { Assert (-not (Test-Path $link)) "MSI uninstall left shortcut: $link" }

  # MSI cleanup also checks target ownership; a user may have replaced the link.
  Run-Installer 'msiexec.exe' "/i `"$baselineMsi`" /qn /norestart INSTALLDIR=`"$install`""
  New-Link ($msiLegacyLinks[0]) $foreignTarget
  New-Link ($msiLegacyLinks[1]) $foreignTarget
  Run-Installer 'msiexec.exe' "/i `"$renamedMsi`" /qn /norestart"
  Assert-MsiRegistration
  foreach ($link in $msiLegacyLinks[0..1]) {
    Assert ($shell.CreateShortcut($link).TargetPath -eq $foreignTarget) "MSI upgrade modified a foreign shortcut: $link"
  }
  Run-Installer 'msiexec.exe' "/x `"$renamedMsi`" /qn /norestart"
  foreach ($link in $msiLegacyLinks[0..1]) { Assert (Test-Path $link) "MSI uninstall deleted a foreign shortcut: $link" }
  Write-Host 'PASS: NSIS/MSI rename preserves install identity, updates Apps/shortcuts, preserves preferences/data and unrelated links, and uninstalls.'
} finally {
  # Uninstall only this fixture through MSI before removing temporary files/keys.
  foreach ($entry in @(Get-FixtureMsiRegistration)) {
    $cleanup = Start-Process 'msiexec.exe' -ArgumentList "/x $($entry.PSChildName) /qn /norestart" -PassThru
    if (-not $cleanup.WaitForExit(120000)) { $cleanup.Kill() }
  }
  # Every path/key here is unique to this fixture, including failure cleanup.
  foreach ($path in ($legacyLinks + $newLinks + $msiLegacyLinks + $msiNewLinks + @((Join-Path $commonPrograms $legacyName), (Join-Path $commonPrograms $newName), $root, $data))) {
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  }
  foreach ($key in @($uninstallKey, $newUninstallKey, $manufacturerKey)) {
    if (Test-Path $key) { Remove-Item $key -Recurse -Force }
  }
  [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
}
