import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { validateChannel, validateRelease } from './release-channel.mjs';

const repository = 'Nortus222/skills-manager';
const tag = 'v1.43.4';
const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64'];
function fixture() {
  const release = { tag_name: tag, assets: [] };
  const metadata = { version: '1.43.4', platforms: {} };
  for (const platform of platforms) {
    const name = `${platform}.bundle`;
    const url = `https://github.com/${repository}/releases/download/${tag}/${name}`;
    release.assets.push({ id: release.assets.length + 1, name, browser_download_url: url });
    release.assets.push({ id: release.assets.length + 1, name: `${name}.sig` });
    metadata.platforms[platform] = { url, signature: 'c2ln' };
  }
  for (const label of ['macOS-arm64', 'macOS-x64', 'Windows-x64.exe', 'Linux-x64', 'Linux-arm64']) {
    release.assets.push({ id: release.assets.length + 1, name: `skills-manager-cli-${label}` });
  }
  return { release, metadata };
}

test('fork detection and installer config trust the fork-owned public key and endpoint', () => {
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const publicKey = fs.readFileSync('src-tauri/updater.pub', 'utf8').trim();
  assert.equal(validateChannel(config, publicKey, repository), `https://github.com/${repository}/releases/latest/download/latest.json`);
  assert.throws(() => validateChannel(config, 'wrong-key', repository), /key/i);
  assert.throws(() => validateChannel(config, publicKey, 'someone/else'), /endpoint|repository/i);
});

test('fork branding preserves existing installation and update identity', () => {
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const windows = JSON.parse(fs.readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'));
  assert.equal(config.productName, 'EM Skills');
  assert.equal(config.identifier, 'com.agentskills.desktop');
  assert.equal(windows.productName, undefined);
  assert.equal(windows.bundle.windows.wix.upgradeCode, '08c191c4-bdbb-5964-9f50-bc2b2edafd1a');
  assert.match(fs.readFileSync('src-tauri/Cargo.toml', 'utf8'), /^default-run = "skills-manager"$/m);
});

test('every platform is signed and points to an existing asset on this fork release', () => {
  const { release, metadata } = fixture();
  const entries = validateRelease(metadata, release, repository, tag);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.platform), platforms);
});

test('accepts temporary draft asset URLs while metadata names the final tagged URLs', () => {
  const { release, metadata } = fixture();
  release.draft = true;
  for (const asset of release.assets) {
    if (asset.browser_download_url) asset.browser_download_url = asset.browser_download_url.replace(tag, 'untagged-6751d11e6697ce5200d6');
  }
  assert.equal(validateRelease(metadata, release, repository, tag).length, 5);
  release.draft = false;
  assert.throws(() => validateRelease(metadata, release, repository, tag));
  release.draft = true;
  const first = release.assets[0];
  const draftURL = first.browser_download_url;
  first.browser_download_url = draftURL.replace(repository, 'someone/else');
  assert.throws(() => validateRelease(metadata, release, repository, tag));
  first.browser_download_url = draftURL.replace('darwin-aarch64.bundle', 'wrong.bundle');
  assert.throws(() => validateRelease(metadata, release, repository, tag));
  first.browser_download_url = draftURL;
  metadata.platforms['darwin-aarch64'].url = metadata.platforms['darwin-aarch64'].url.replace(tag, 'untagged-6751d11e6697ce5200d6');
  assert.throws(() => validateRelease(metadata, release, repository, tag));
});

for (const [name, corrupt] of [
  ['foreign repository', (m) => { m.platforms['darwin-aarch64'].url = 'https://github.com/xingkongliang/skills-manager/releases/download/v1.43.4/darwin-aarch64.bundle'; }],
  ['different release tag', (m) => { m.platforms['darwin-aarch64'].url = m.platforms['darwin-aarch64'].url.replace(tag, 'v1.43.3'); }],
  ['missing platform', (m) => { delete m.platforms['linux-aarch64']; }],
  ['missing signature', (m) => { m.platforms['windows-x86_64'].signature = ''; }],
  ['wrong metadata version', (m) => { m.version = '1.43.3'; }],
  ['missing payload asset', (_, r) => { r.assets.splice(0, 1); }],
  ['missing detached signature', (_, r) => { r.assets.splice(1, 1); }],
  ['missing CLI companion', (_, r) => { r.assets.pop(); }],
  ['URL query', (m) => { m.platforms['linux-x86_64'].url += '?redirect=elsewhere'; }],
]) {
  test(`refuses publication for ${name}`, () => {
    const { release, metadata } = fixture(); corrupt(metadata, release);
    assert.throws(() => validateRelease(metadata, release, repository, tag));
  });
}

test('validates optional platform entries too', () => {
  const { release, metadata } = fixture();
  metadata.platforms['windows-x86_64-nsis'] = { ...metadata.platforms['windows-x86_64'], url: 'https://example.com/unverified.exe' };
  assert.throws(() => validateRelease(metadata, release, repository, tag));
});

test('rejects platform names that could escape verification storage', () => {
  const { release, metadata } = fixture();
  metadata.platforms['../../outside'] = { ...metadata.platforms['windows-x86_64'] };
  assert.throws(() => validateRelease(metadata, release, repository, tag));
});

test('preflight refuses a protected signing key without its password before running release tools', () => {
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const result = spawnSync(process.execPath, ['scripts/release-channel.mjs', 'preflight'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: '', GITHUB_REPOSITORY: repository,
      GITHUB_REF: `refs/tags/v${version}`, GITHUB_REF_NAME: `v${version}`,
      TAURI_SIGNING_PRIVATE_KEY: 'test-key-present', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing TAURI_SIGNING_PRIVATE_KEY_PASSWORD/);
});
