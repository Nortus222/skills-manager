import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const windows = JSON.parse(fs.readFileSync('src-tauri/tauri.windows.conf.json', 'utf8')).bundle.windows;
const nsis = fs.readFileSync(`src-tauri/${windows.nsis.template}`, 'utf8');
const wix = fs.readFileSync(`src-tauri/${windows.wix.template}`, 'utf8');
const script = wix.match(/<CustomAction Id="MigrateLegacyProductShortcuts"[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/CustomAction>/)?.[1];

test('Windows installers retain identity while inheriting the current visible name', () => {
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const platformConfig = JSON.parse(fs.readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'));
  assert.equal(platformConfig.productName, undefined);
  assert.equal(config.productName, 'EM Skills');
  assert.equal(windows.wix.upgradeCode, '08c191c4-bdbb-5964-9f50-bc2b2edafd1a');
  assert.match(nsis, /!define PRODUCTNAME "\{\{product_name\}\}"/);
  assert.match(nsis, /!define LEGACY_PRODUCTNAME "skills-manager"/);
  assert.match(nsis, /!define UNINSTKEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\\$\{LEGACY_PRODUCTNAME\}"/);
  assert.match(nsis, /!define MANUPRODUCTKEY "\$\{MANUKEY\}\\\$\{LEGACY_PRODUCTNAME\}"/);
  assert.ok(nsis.indexOf('Call MigrateLegacyShortcuts') < nsis.indexOf('  ; Create start menu shortcut'));
  assert.match(wix, /<Product[\s\S]*?Name="\{\{product_name\}\}"/);
  assert.match(wix, /<\?define LegacyProductName = "skills-manager" \?>/);
  assert.equal((wix.match(/Key="Software\\\\\{\{manufacturer\}\}\\\\\$\(var.LegacyProductName\)"/g) ?? []).length, 6);
  assert.ok(script, 'MSI owns its target-checked legacy shortcut cleanup');
  assert.match(wix, /<CustomAction Id="MigrateLegacyProductShortcuts"[^>]*Execute="commit"[^>]*Impersonate="no"/);
  assert.match(wix, /<Custom Action="MigrateLegacyProductShortcuts" After="CreateShortcuts">/);
  assert.match(wix, /After="CostFinalize" Sequence="execute"/);
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  assert.equal(lock.packages['node_modules/@tauri-apps/cli'].version, '2.10.0', 'review pinned installer templates when updating the bundler');
});

function runMsiCleanup({ appTarget, uninstallTarget, uninstallArguments, extraFile = false, customActionData } = {}) {
  const install = 'C:\\custom path';
  const desktop = 'C:\\Users\\Public\\Desktop';
  const programs = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
  const legacy = 'skills-manager';
  const oldMenu = path.win32.join(programs, legacy);
  const exe = path.win32.join(install, 'skills-manager.exe');
  const desktopLink = path.win32.join(desktop, `${legacy}.lnk`);
  const menuLink = path.win32.join(oldMenu, `${legacy}.lnk`);
  const uninstallLink = path.win32.join(install, `Uninstall ${legacy}.lnk`);
  const currentLink = path.win32.join(desktop, 'EM Skills.lnk');
  const code = '{11111111-2222-3333-4444-555555555555}';
  const files = new Map([
    [desktopLink, { TargetPath: appTarget ?? exe }],
    [menuLink, { TargetPath: appTarget ?? exe }],
    [uninstallLink, { TargetPath: uninstallTarget ?? 'C:\\Windows\\System32\\msiexec.exe', Arguments: uninstallArguments ?? `/x ${code}` }],
    [currentLink, { TargetPath: exe }],
  ]);
  if (extraFile) files.set(path.win32.join(oldMenu, 'personal.txt'), {});
  const folders = new Set([oldMenu]);
  const encodedData = customActionData ?? [legacy, 'skills-manager.exe', install, desktop, programs, 'C:\\Windows\\SysWOW64', 'C:\\Windows\\System32', code].join('|');
  const filesystem = {
    BuildPath: path.win32.join,
    GetAbsolutePathName: path.win32.resolve,
    FileExists: (name) => files.has(name),
    FolderExists: (name) => folders.has(name),
    DeleteFile: (name) => files.delete(name),
    GetFolder: (name) => ({ Files: { Count: [...files.keys()].filter((entry) => path.win32.dirname(entry) === name).length }, SubFolders: { Count: 0 } }),
    DeleteFolder: () => assert.fail('MSI must never recursively delete a legacy directory'),
  };
  const shell = { CreateShortcut: (name) => files.get(name), ExpandEnvironmentStrings: (name) => name };
  vm.runInNewContext(script, {
    ActiveXObject: function (name) { return name === 'Scripting.FileSystemObject' ? filesystem : shell; },
    Session: { Property: (name) => {
      assert.equal(name, 'CustomActionData', 'commit action must use only serialized installer properties');
      return encodedData;
    } },
  });
  return { files, folders, desktopLink, menuLink, uninstallLink, currentLink, oldMenu };
}

test('MSI removes only owned legacy links and leaves directories intact', () => {
  const result = runMsiCleanup();
  assert.equal(result.files.has(result.desktopLink), false);
  assert.equal(result.files.has(result.menuLink), false);
  assert.equal(result.files.has(result.uninstallLink), false);
  assert.equal(result.files.has(result.currentLink), true);
  assert.equal(result.folders.has(result.oldMenu), true);
});

test('MSI preserves foreign shortcut targets and nonempty old folders', () => {
  const foreign = runMsiCleanup({ appTarget: 'C:\\other\\app.exe', uninstallTarget: 'C:\\other\\msiexec.exe' });
  assert.equal(foreign.files.has(foreign.desktopLink), true);
  assert.equal(foreign.files.has(foreign.menuLink), true);
  assert.equal(foreign.files.has(foreign.uninstallLink), true);
  assert.equal(foreign.folders.has(foreign.oldMenu), true);
  const nonempty = runMsiCleanup({ extraFile: true });
  assert.equal(nonempty.folders.has(nonempty.oldMenu), true);
});

test('MSI requires the previous related ProductCode before deleting an uninstall link', () => {
  const result = runMsiCleanup({ uninstallArguments: '/x {99999999-2222-3333-4444-555555555555}' });
  assert.equal(result.files.has(result.uninstallLink), true);
});

for (const customActionData of ['', 'skills-manager|skills-manager.exe', 'skills-manager|skills-manager.exe|C:\\app|||||', 'skills-manager|skills-manager.exe|relative|C:\\desktop|C:\\menu|C:\\Windows|C:\\Windows|{11111111-2222-3333-4444-555555555555}']) {
  test(`MSI fails closed on missing or invalid commit action data: ${JSON.stringify(customActionData)}`, () => {
    const result = runMsiCleanup({ customActionData });
    assert.equal(result.files.size, 4);
    assert.equal(result.folders.has(result.oldMenu), true);
  });
}
