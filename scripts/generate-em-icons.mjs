// Regenerate desktop, web and tray icons from the shared SVG with the pinned Tauri CLI.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const iconDirectory = join(root, 'src-tauri', 'icons');
const temporary = mkdtempSync(join(tmpdir(), 'em-icons-'));
const source = join(root, 'public', 'em-skills.svg');
const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

function render(input, output, sizes = []) {
  const args = [cli, 'icon', input, '--output', output];
  for (const size of sizes) args.push('--png', String(size));
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Icon rendering failed with exit code ${result.status}`);
}

function stabilizeIcns(path) {
  const bytes = readFileSync(path);
  const entries = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length) throw new Error('Invalid ICNS entry');
    entries.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  // Tauri emits the same images in an arbitrary order. Keep regeneration free of binary churn.
  entries.sort((left, right) => Buffer.compare(left.subarray(0, 4), right.subarray(0, 4)));
  writeFileSync(path, Buffer.concat([bytes.subarray(0, 8), ...entries]));
}

try {
  const desktop = join(temporary, 'desktop');
  render(source, desktop);
  stabilizeIcns(join(desktop, 'icon.icns'));
  // Tauri also generates mobile assets. Only desktop assets already used by this app belong here.
  for (const name of readdirSync(desktop)) {
    if (/^(?:\d+x\d+(?:@2x)?\.png|Square\d+x\d+Logo\.png|StoreLogo\.png|icon\.(?:ico|icns))$/.test(name)) {
      copyFileSync(join(desktop, name), join(iconDirectory, name));
    }
  }
  const png = join(temporary, 'png');
  render(source, png, [1024]);
  copyFileSync(join(png, '1024x1024.png'), join(iconDirectory, 'icon.png'));
  copyFileSync(join(png, '1024x1024.png'), join(root, 'assets', 'icon.png'));
  copyFileSync(join(desktop, '32x32.png'), join(root, 'public', 'icons', '32x32.png'));

  const artwork = readFileSync(source, 'utf8').match(/<g id="em-mark">([\s\S]*?)<\/g>/)?.[1];
  if (!artwork) throw new Error('The source SVG must contain the em-mark group');
  const bare = (paths) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640" viewBox="192 192 640 640">${paths}</svg>`;
  const colorSource = join(temporary, 'mark-color.svg');
  const monoSource = join(temporary, 'mark-mono.svg');
  writeFileSync(colorSource, bare(artwork.replace(/#FFFFFF|#32D2BE/g, color => color === '#FFFFFF' ? '#32D2BE' : '#FFFFFF')));
  writeFileSync(monoSource, bare(artwork.replaceAll('#32D2BE', '#FFFFFF')));
  const sizes = [16, 20, 24, 32];
  const colorOutput = join(temporary, 'color');
  const monoOutput = join(temporary, 'mono');
  render(colorSource, colorOutput, [...sizes, 1024]);
  render(monoSource, monoOutput, sizes);
  copyFileSync(join(colorOutput, '1024x1024.png'), join(iconDirectory, 'icon-source.png'));
  for (const size of sizes) {
    copyFileSync(join(monoOutput, `${size}x${size}.png`), join(iconDirectory, 'tray', `tray-icon-${size}.png`));
    copyFileSync(join(colorOutput, `${size}x${size}.png`), join(iconDirectory, 'tray', `tray-icon-color-${size}.png`));
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
