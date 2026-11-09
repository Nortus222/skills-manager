import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateChannel, validateRelease, stageCli } from './release-channel.mjs';

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

test('every platform is signed and points to an existing asset on this fork release', () => {
  const { release, metadata } = fixture();
  const entries = validateRelease(metadata, release, repository, tag);
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map((entry) => entry.platform), platforms);
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

test('stages the CLI companion for both native and Windows bundles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-sidecar-'));
  try {
    for (const target of ['aarch64-apple-darwin', 'x86_64-pc-windows-msvc']) {
      const extension = target.includes('windows') ? '.exe' : '';
      const source = path.join(root, 'src-tauri', 'target', target, 'release', `skills-manager-cli${extension}`);
      fs.mkdirSync(path.dirname(source), { recursive: true }); fs.writeFileSync(source, 'compiled-cli');
      const staged = stageCli(root, target, 'release');
      assert.equal(path.basename(staged), `skills-manager-cli-${target}${extension}`);
      assert.equal(fs.readFileSync(staged, 'utf8'), 'compiled-cli');
    }
    assert.throws(() => stageCli(root, '../escape', 'release'));
    assert.throws(() => stageCli(root, 'aarch64-apple-darwin', 'invalid'));
    assert.throws(() => stageCli(root, 'x86_64-unknown-linux-gnu', 'release'), /missing/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
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
