// Minimal ZIP reader/writer over node:zlib — enough for the patcher's
// self-extracting runtime (deflate entries, no encryption, no zip64).
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(path.join(directory, entry.name), relative));
    else files.push({ absolute: path.join(directory, entry.name), relative });
  }
  return files;
}

export async function zipDirectory(sourceDir, archivePath) {
  const entries = [];
  for (const file of await collectFiles(sourceDir)) {
    const data = await readFile(file.absolute);
    const compressed = deflateRawSync(data, { level: 9 });
    const { time, day } = dosDateTime(new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(Buffer.byteLength(file.relative), 26);
    entries.push({ name: file.relative, data, compressed, local });
  }

  let offset = 0;
  const chunks = [];
  const central = [];
  for (const entry of entries) {
    chunks.push(entry.local, Buffer.from(entry.name, "utf8"), entry.compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(20, 4);         // version made by
    header.writeUInt16LE(20, 6);         // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(entry.local.readUInt16LE(10), 12);
    header.writeUInt16LE(entry.local.readUInt16LE(12), 14);
    header.writeUInt32LE(entry.local.readUInt32LE(14), 16);
    header.writeUInt32LE(entry.local.readUInt32LE(18), 20);
    header.writeUInt32LE(entry.local.readUInt32LE(22), 24);
    header.writeUInt16LE(Buffer.byteLength(entry.name), 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, Buffer.from(entry.name, "utf8"));
    offset += entry.local.length + Buffer.byteLength(entry.name) + entry.compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await writeFile(archivePath, Buffer.concat([...chunks, centralBuffer, eocd]));
}

export async function extractZip(archivePath, destinationDir) {
  const archive = await readFile(archivePath);
  let cursor = archive.length - 22;
  while (cursor >= 0 && archive.readUInt32LE(cursor) !== EOCD) cursor -= 1;
  if (cursor < 0) throw new Error("ZIP end-of-central-directory record was not found");
  const entryCount = archive.readUInt16LE(cursor + 10);
  let centralOffset = archive.readUInt32LE(cursor + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(centralOffset) !== CENTRAL_HEADER) {
      throw new Error(`Corrupt central directory at entry ${index}`);
    }
    const method = archive.readUInt16LE(centralOffset + 10);
    const compressedSize = archive.readUInt32LE(centralOffset + 20);
    const nameLength = archive.readUInt16LE(centralOffset + 28);
    const extraLength = archive.readUInt16LE(centralOffset + 30);
    const commentLength = archive.readUInt16LE(centralOffset + 32);
    const localOffset = archive.readUInt32LE(centralOffset + 42);
    const name = archive.toString("utf8", centralOffset + 46, centralOffset + 46 + nameLength);
    centralOffset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/")) continue;
    const target = path.join(destinationDir, ...name.split("/"));
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(destinationDir) + path.sep)) {
      throw new Error(`ZIP entry escapes the destination directory: ${name}`);
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}
