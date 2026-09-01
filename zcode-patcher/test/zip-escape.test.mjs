import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { extractZip } from "../lib/zip.mjs";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

test("zip extraction refuses entries that escape the destination", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-zip-escape-"));
  try {
    const data = Buffer.from("evil");
    const comp = deflateRawSync(data);
    const name = Buffer.from("../evil.txt");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(local.length + name.length + comp.length, 42);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + name.length, 12);
    eocd.writeUInt32LE(local.length + name.length + comp.length, 16);

    const archive = path.join(root, "evil.zip");
    await mkdir(path.join(root, "out"), { recursive: true });
    await writeFile(archive, Buffer.concat([local, name, comp, central, name, eocd]));

    await assert.rejects(
      () => extractZip(archive, path.join(root, "out")),
      /escapes the destination/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
