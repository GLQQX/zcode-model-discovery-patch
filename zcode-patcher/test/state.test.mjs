import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertChildPath,
  moveFileWithExdevFallback,
  readState,
  sha256File,
  shouldAttemptPatch,
  writeState,
} from "../lib/state.mjs";

test("rejects a candidate outside the patch root", () => {
  assert.throws(
    () => assertChildPath("C:\\safe", "C:\\outside\\app.asar"),
    /outside/i,
  );
});

test("accepts and normalizes a candidate inside the patch root", () => {
  assert.equal(
    assertChildPath("C:\\safe", "C:\\safe\\backups\\app.asar"),
    path.resolve("C:\\safe\\backups\\app.asar"),
  );
});

test("does not retry an incompatible official hash at the same patch version", () => {
  assert.equal(shouldAttemptPatch({
    status: "incompatible",
    officialHash: "ABC",
    patchVersion: "1.0.0",
  }, "ABC", "1.0.0"), false);
});

test("retries an incompatible official hash after the patch version changes", () => {
  assert.equal(shouldAttemptPatch({
    status: "incompatible",
    officialHash: "ABC",
    patchVersion: "1.0.0",
  }, "ABC", "1.1.0"), true);
});

test("writes state atomically and reads it back", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-state-test-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const statePath = path.join(root, "state.json");
  const state = { status: "patched", officialHash: "ABC", patchedHash: "DEF" };

  await writeState(statePath, state);

  assert.deepEqual(await readState(statePath), state);
  assert.equal(await readFile(`${statePath}.tmp`, "utf8").catch(error => error.code), "ENOENT");
});

test("returns an empty object when the state file is missing", async () => {
  const statePath = path.join(tmpdir(), `missing-zcode-state-${process.pid}-${Date.now()}.json`);
  assert.deepEqual(await readState(statePath), {});
});

test("calculates an uppercase SHA-256", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-hash-test-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const file = path.join(root, "payload.txt");
  await writeFile(file, "abc", "utf8");

  assert.equal(
    await sha256File(file),
    "BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD",
  );
});

test("copies and removes a completed temporary file when rename reports EXDEV", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-state-exdev-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  const source = path.join(root, "state.json.tmp");
  const destination = path.join(root, "state.json");
  await writeFile(source, '{"status":"patched"}', "utf8");
  const renameFile = async () => {
    const error = new Error("virtualized directory");
    error.code = "EXDEV";
    throw error;
  };

  await moveFileWithExdevFallback(source, destination, { renameFile });

  assert.equal(await readFile(destination, "utf8"), '{"status":"patched"}');
  await assert.rejects(readFile(source, "utf8"), /ENOENT/u);
});
