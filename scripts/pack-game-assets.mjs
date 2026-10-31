#!/usr/bin/env node
// Packs the game files the replay viewer can use into one tar, to unpack on the
// server under /var/www/momarchive-game, which nginx serves at /game/.
//
//   node scripts/pack-game-assets.mjs "<Momentum Mod Playtest install>" game-assets.tar
//
// What goes in is what Momentum Mod itself ships: its own materials and models,
// the engine's (platform), and the Half-Life 2 archive it mounts. The viewer
// reads a VPK a few kilobytes at a time with range requests, so the archive is
// copied as it is. Every path is lowercased, since the viewer asks for lowercase
// paths the way the engine's filesystem matches them, and a Linux filesystem
// does not.
import { createReadStream, createWriteStream, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { once } from 'node:events';

const [gameDir, out] = process.argv.slice(2);
if (!gameDir || !out) {
  console.error('usage: node scripts/pack-game-assets.mjs <Momentum install dir> <out.tar>');
  process.exit(1);
}

/** Directories copied file by file, under the game root. */
const TREES = ['momentum/materials', 'momentum/models', 'platform/materials'];
/** The mounted Half-Life 2 archive: its directory and its numbered parts. */
const MOUNT = 'mount';
const VPK = /^hl2_(dir|\d{3})\.vpk$/i;

const files = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile()) files.push(path);
  }
};
for (const tree of TREES) walk(join(gameDir, tree));
for (const name of readdirSync(join(gameDir, MOUNT))) {
  if (VPK.test(name)) files.push(join(gameDir, MOUNT, name));
}

/** A ustar header; long paths are split between the prefix and the name. */
function header(path, size) {
  const block = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    // the last slash that leaves a name short enough and a prefix that fits
    let split = -1;
    for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
      if (Buffer.byteLength(path.slice(i + 1)) > 100) break;
      if (Buffer.byteLength(path.slice(0, i)) <= 155) {
        split = i;
        break;
      }
    }
    if (split < 0) throw new Error(`path too long for a tar header: ${path}`);
    prefix = path.slice(0, split);
    name = path.slice(split + 1);
  }
  const field = (offset, length, value) => block.write(value, offset, length, 'utf8');
  const octal = (offset, length, value) =>
    field(offset, length, value.toString(8).padStart(length - 1, '0') + '\0');
  field(0, 100, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, Math.floor(Date.now() / 1000));
  block.fill(' ', 148, 156);
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  field(345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  field(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return block;
}

const tar = createWriteStream(out);
const write = async (chunk) => {
  if (!tar.write(chunk)) await once(tar, 'drain');
};
let bytes = 0;
for (const file of files) {
  const path = relative(gameDir, file).replace(/\\/g, '/').toLowerCase();
  const { size } = statSync(file);
  await write(header(path, size));
  for await (const chunk of createReadStream(file)) await write(chunk);
  const pad = (512 - (size % 512)) % 512;
  if (pad) await write(Buffer.alloc(pad));
  bytes += size;
}
await write(Buffer.alloc(1024));
tar.end();
await once(tar, 'finish');
console.log(`${files.length} files, ${(bytes / 1e9).toFixed(2)} GB -> ${out}`);
