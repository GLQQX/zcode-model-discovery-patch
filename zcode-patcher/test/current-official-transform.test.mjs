import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  findRendererBundle,
  transformMain,
  transformRenderer,
  verifyPatchedSources,
} from "../lib/transform.mjs";

const execFileAsync = promisify(execFile);
const officialRoot = process.env.ZCODE_OFFICIAL_EXTRACTED_ROOT;

test("transforms and syntax-checks the current official extracted sources", {
  skip: officialRoot ? false : "ZCODE_OFFICIAL_EXTRACTED_ROOT is not set",
}, async t => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "zcode-real-transform-"));
  t.after(() => rm(outputRoot, { recursive: true, force: true }));
  const rendererPath = await findRendererBundle(officialRoot);
  const mainPath = path.join(officialRoot, "out", "main", "index.js");
  const payloadPath = fileURLToPath(new URL("../payload/model-discovery.js", import.meta.url));
  const payload = await readFile(payloadPath, "utf8");
  const rendererResult = transformRenderer(await readFile(rendererPath, "utf8"));
  const mainResult = transformMain(await readFile(mainPath, "utf8"));
  verifyPatchedSources({ renderer: rendererResult.source, main: mainResult.source, payload });

  const transformedRenderer = path.join(outputRoot, "renderer.mjs");
  const transformedMain = path.join(outputRoot, "main.mjs");
  await writeFile(transformedRenderer, rendererResult.source, "utf8");
  await writeFile(transformedMain, mainResult.source, "utf8");

  await execFileAsync(process.execPath, ["--check", transformedRenderer]);
  await execFileAsync(process.execPath, ["--check", transformedMain]);
  await execFileAsync(process.execPath, ["--check", payloadPath]);
  assert.deepEqual(rendererResult.changes, {
    providerEditor: 1,
    discoveryButton: 1,
    discoveryImport: 1,
  });
  assert.deepEqual(mainResult.changes, { discoveryCors: 1 });
});
