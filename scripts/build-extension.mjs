#!/usr/bin/env node
import {readFile, lstat, mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
let out = path.join(root, 'dist'), tag;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--out' && process.argv[i + 1]) out = path.resolve(process.argv[++i]);
  else if (process.argv[i] === '--tag' && process.argv[i + 1]) tag = process.argv[++i];
  else throw Error('Usage: node scripts/build-extension.mjs [--out DIRECTORY] [--tag vVERSION]');
}
const files = [
  'manifest.json', 'background.mjs', 'core.mjs', 'cache.mjs', 'cache-store.mjs',
  'cache-transfer.mjs', 'cache-editor.mjs', 'name-policy.js', 'main.js', 'content.js',
  'popup.html', 'popup.css', 'popup.mjs', 'file-transfer.mjs',
  'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png'
].sort();
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Manifest requires an x.y.z version');
const core = await readFile(path.join(root, 'core.mjs'), 'utf8');
if (core.match(/export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] !== version) throw Error('Manifest/core version mismatch');
if (tag !== undefined && tag !== `v${version}`) throw Error('Release tag must equal v' + version);
const declared = [manifest.background.service_worker, manifest.action.default_popup,
  ...Object.values(manifest.icons), ...manifest.content_scripts.flatMap(s => s.js)];
for (const file of declared) if (!files.includes(file)) throw Error('Manifest entry missing from allowlist: ' + file);
const table = Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// ZIP STORE: fixed order, timestamp and metadata. Never include local data or tests.
const local = [], central = [];
let offset = 0;
for (const file of files) {
  const full = path.join(root, file);
  if (!(await lstat(full)).isFile()) throw Error('Expected regular file: ' + file);
  for (let parent = path.dirname(full); parent !== root; parent = path.dirname(parent)) {
    if ((await lstat(parent)).isSymbolicLink()) throw Error('Symlink directory: ' + file);
  }
  const data = await readFile(full), name = Buffer.from(file), crc = crc32(data);
  if (data.length > 0xffffffff || offset > 0xffffffff) throw Error('ZIP64 not supported');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0x21, 12);
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  local.push(header, name, data);
  const entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
  entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(0x21, 14);
  entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
  entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(0x20, 38); entry.writeUInt32LE(offset, 42);
  central.push(entry, name); offset += header.length + name.length + data.length;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...local, directory, end]);
const name = `cravesage-translator-mini-${version}-extension.zip`;
const hash = createHash('sha256').update(zip).digest('hex');
await mkdir(out, {recursive: true});
await writeFile(path.join(out, name), zip);
await writeFile(path.join(out, 'SHA256SUMS'), `${hash}  ${name}\n`);
console.log(`${path.join(out, name)}\n${files.length} allowlisted files; SHA256 ${hash}`);
