import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

const platforms = ['darwin-aarch64', 'darwin-x86_64', 'windows-x86_64', 'linux-x86_64', 'linux-aarch64'];
const cliLabels = ['macOS-arm64', 'macOS-x64', 'Windows-x64.exe', 'Linux-x64', 'Linux-arm64'];
function requireValue(condition, message) { if (!condition) throw new Error(message); }
function repositoryName(repository) {
  requireValue(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ''), 'Expected an owner/repository');
  return repository;
}
function decodeBase64(value, label) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(value.trim()), `Invalid ${label}`);
  return Buffer.from(value.trim(), 'base64');
}
export function validateChannel(config, publicKey, repository) {
  repositoryName(repository);
  const expected = `https://github.com/${repository}/releases/latest/download/latest.json`;
  const updater = config.plugins?.updater;
  requireValue(updater?.endpoints?.length === 1 && updater.endpoints[0] === expected, 'Updater endpoint must belong to this release repository');
  requireValue(updater.pubkey === publicKey.trim(), 'Embedded updater key differs from updater.pub');
  const text = decodeBase64(publicKey, 'updater public key').toString('utf8');
  requireValue(text.startsWith('untrusted comment:') && Buffer.from(text.split('\n')[1] ?? '', 'base64').length === 42, 'Invalid updater public key');
  return expected;
}
export function validateRelease(metadata, release, repository, tag) {
  repositoryName(repository);
  requireValue(/^v\d+\.\d+\.\d+$/.test(tag), 'Stable release tag must be vX.Y.Z');
  requireValue(release.tag_name === tag && metadata.version === tag.slice(1), 'Release tag and updater metadata version differ');
  const assets = new Map(release.assets.map((asset) => [asset.name, asset]));
  for (const label of cliLabels) requireValue(assets.has(`skills-manager-cli-${label}`), `Missing CLI companion: ${label}`);
  for (const platform of platforms) requireValue(metadata.platforms?.[platform], `Missing updater platform: ${platform}`);
  const allPlatforms = [...platforms, ...Object.keys(metadata.platforms).filter((platform) => !platforms.includes(platform))];
  requireValue(allPlatforms.length <= 32, 'Too many updater platform entries');
  return allPlatforms.map((platform) => {
    requireValue(/^[a-z0-9][a-z0-9_-]{0,79}$/.test(platform), 'Invalid updater platform name');
    const entry = metadata.platforms?.[platform];
    requireValue(entry, `Missing updater platform: ${platform}`);
    decodeBase64(entry.signature, `${platform} signature`);
    const prefix = `https://github.com/${repository}/releases/download/${tag}/`;
    requireValue(typeof entry.url === 'string' && entry.url.startsWith(prefix), `${platform} URL points outside this fork release`);
    const tail = entry.url.slice(prefix.length);
    requireValue(!/[?#/]/.test(tail), `${platform} URL must name one release asset`);
    const name = decodeURIComponent(tail);
    requireValue(name && !/[\\/]/.test(name), `${platform} URL has an invalid asset name`);
    const asset = assets.get(name);
    // GitHub gives drafts temporary URLs; verification downloads by authenticated asset ID.
    const draftPrefix = `https://github.com/${repository}/releases/download/untagged-`;
    const draftParts = asset?.browser_download_url?.startsWith(draftPrefix)
      ? asset.browser_download_url.slice(draftPrefix.length).split('/') : [];
    const draftMatches = release.draft === true && draftParts.length === 2
      && /^[a-f0-9]{1,64}$/.test(draftParts[0]) && draftParts[1] === tail;
    requireValue(asset && (asset.browser_download_url === entry.url || draftMatches), `${platform} payload asset is missing or has a different URL`);
    requireValue(assets.has(`${name}.sig`), `${platform} detached signature asset is missing`);
    return { platform, asset, signature: entry.signature, detached: assets.get(`${name}.sig`) };
  });
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', ...options });
  requireValue(result.status === 0, `${binary} failed: ${result.stderr || result.error?.message || result.status}`);
  return result.stdout;
}
function releases(repository) {
  return JSON.parse(command('gh', ['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
}
async function download(repository, id, destination, limit) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  requireValue(token, 'GitHub token missing for draft asset download');
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/assets/${id}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(180_000),
  });
  requireValue(response.ok && response.body, `Asset download failed with HTTP ${response.status}`);
  let size = 0;
  const bound = new Transform({ transform(chunk, _, callback) {
    size += chunk.length;
    callback(size > limit ? new Error('Release asset exceeds download limit') : null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), bound, fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
}
async function verify(repository, tag, publicKey) {
  const release = releases(repository).find((item) => item.tag_name === tag);
  requireValue(release?.draft, 'Expected an unpublished draft release');
  const metadataAsset = release.assets.find((asset) => asset.name === 'latest.json');
  requireValue(metadataAsset, 'Draft is missing latest.json');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-fork-release-'));
  try {
    const metadataPath = path.join(temporary, 'latest.json');
    await download(repository, metadataAsset.id, metadataPath, 1024 * 1024);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    const entries = validateRelease(metadata, release, repository, tag);
    const keyPath = path.join(temporary, 'public-key'); fs.writeFileSync(keyPath, decodeBase64(publicKey, 'public key'));
    for (const [index, entry] of entries.entries()) {
      const artifact = path.join(temporary, `payload-${index}`);
      const signature = `${artifact}.sig`;
      const detached = `${artifact}.detached`;
      fs.writeFileSync(signature, decodeBase64(entry.signature, 'signature'));
      await download(repository, entry.asset.id, artifact, 1024 * 1024 * 1024);
      await download(repository, entry.detached.id, detached, 16 * 1024);
      requireValue(fs.readFileSync(detached, 'utf8').trim() === entry.signature.trim(), `${entry.platform} manifest signature differs from detached signature`);
      command('minisign', ['-Vm', artifact, '-p', keyPath, '-x', signature]);
      console.log(`Verified ${entry.platform} with the fork public key`);
      fs.rmSync(artifact);
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function main() {
  const repository = repositoryName(process.env.GITHUB_REPOSITORY);
  const config = JSON.parse(fs.readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const publicKey = fs.readFileSync('src-tauri/updater.pub', 'utf8').trim();
  validateChannel(config, publicKey, repository);
  const tag = process.env.GITHUB_REF_NAME;
  if (process.argv[2] === 'verify') { await verify(repository, tag, publicKey); return; }
  requireValue(process.argv[2] === 'preflight', 'Expected preflight or verify');
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const cargoVersion = fs.readFileSync('src-tauri/Cargo.toml', 'utf8').split(/\n\[(?!package\])/)[0].match(/^version = "([^"]+)"/m)?.[1];
  requireValue(config.version === version && lock.version === version && lock.packages[''].version === version && cargoVersion === version, 'Package, lockfile, Tauri and Cargo versions must agree');
  requireValue(process.env.GITHUB_REF === `refs/tags/v${version}` && tag === `v${version}`, 'Release must run from the matching vX.Y.Z tag');
  requireValue(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim(), 'Missing TAURI_SIGNING_PRIVATE_KEY secret');
  requireValue(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD?.length, 'Missing TAURI_SIGNING_PRIVATE_KEY_PASSWORD secret');
  command('git', ['fetch', 'origin', 'main']);
  command('git', ['merge-base', '--is-ancestor', process.env.GITHUB_SHA, 'origin/main']);
  const existing = releases(repository).find((item) => item.tag_name === tag);
  requireValue(!existing || existing.draft, 'This release is already published; prepare a new version');
  console.log(`Release channel ready for ${repository} ${tag}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
