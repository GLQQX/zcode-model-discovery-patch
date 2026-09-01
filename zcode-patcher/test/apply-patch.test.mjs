import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createPackage, createPackageWithOptions, extractAll, extractFile } from "@electron/asar";

import { restorePatch, runPatch } from "../apply-patch.mjs";
import { readState, sha256File } from "../lib/state.mjs";

const PATCH_VERSION = "2.0.0";
const PAYLOAD_PATH = fileURLToPath(new URL("../payload/model-discovery.js", import.meta.url));

const OFFICIAL_RENDERER_ANCHORS = [
  "function hNt({models:e,apiKeyValue:t,currentApiFormat:n,apiFormatOptions:r,onTestModel:i,onModelCommit:a,onDeleteModel:o,onAddModel:s,readOnly:c})",
  "c?null:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(JMt,{mode:`add`,open:h,draft:_,draftErrorMessage:k,onOpenChange:D,onDraftChange:T,onCommit:O,maxOutputTokensLookupPending:x}),(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`lg`,\"data-testid\":mie,className:`mt-1`,onClick:w,children:[(0,$.jsx)(Fc,{className:`mr-1 size-3.5`}),l.formatMessage({id:`settings.modelProvider.addModel`})]})]})",
  "function l5(",
  "[j,M]=(0,Q.useState)(()=>xNt(e)),N=(0,Q.useRef)(null)",
  "de=(0,Q.useCallback)(e=>{le([...j,{...e,modified:!0}])},[j,le]),fe=(0,Q.useCallback)",
  "(0,$.jsx)(hNt,{models:j,apiKeyValue:D,currentApiFormat:C,apiFormatOptions:iNt(e),onTestModel:r?se:void 0,onModelCommit:ue,onDeleteModel:W,onAddModel:de,readOnly:g})",
  "function CNt()",
].join(";");

const OFFICIAL_MAIN = [
  "async function boot(){",
  "try{await V6(qD,t??{},k)}catch(c){k.warn(\"[desktop-network] Chromium network policy bootstrap failed:\",c)}await wG(on),XCe()",
  "}",
].join("");

async function createFixture(t, { compatible = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-patcher-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appSource = path.join(root, "app-source");
  const assets = path.join(appSource, "out", "renderer", "assets");
  const mainRoot = path.join(appSource, "out", "main");
  const installRoot = path.join(root, "install");
  const patchRoot = path.join(root, "patch-root");
  await mkdir(assets, { recursive: true });
  await mkdir(mainRoot, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await mkdir(path.join(patchRoot, "payload"), { recursive: true });
  await writeFile(
    path.join(appSource, "out", "renderer", "index.html"),
    '<link rel="modulepreload" href="./assets/styles-test.js">',
    "utf8",
  );
  const rendererAnchors = compatible
    ? OFFICIAL_RENDERER_ANCHORS
    : OFFICIAL_RENDERER_ANCHORS.replace("function hNt(", "function incompatible(");
  await writeFile(path.join(assets, "styles-test.js"), `/*${rendererAnchors}*/\nexport {};\n`, "utf8");
  await writeFile(path.join(mainRoot, "index.js"), OFFICIAL_MAIN, "utf8");
  await writeFile(path.join(appSource, "native.bin"), "native-sidecar", "utf8");
  await copyFile(PAYLOAD_PATH, path.join(patchRoot, "payload", "model-discovery.js"));
  const asarPath = path.join(installRoot, "app.asar");
  await createPackageWithOptions(appSource, asarPath, { unpack: "native.bin" });
  return { asarPath, patchRoot, root };
}

function optionsFor(fixture, overrides = {}) {
  return {
    asarPath: fixture.asarPath,
    root: fixture.patchRoot,
    patchVersion: PATCH_VERSION,
    payloadPath: path.join(fixture.patchRoot, "payload", "model-discovery.js"),
    ...overrides,
  };
}

async function removeCurrentMainPatchMarker(t, asarPath) {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-patcher-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extracted = path.join(root, "extracted");
  const repacked = path.join(root, "legacy.asar");
  extractAll(asarPath, extracted);
  const mainPath = path.join(extracted, "out", "main", "index.js");
  const main = await readFile(mainPath, "utf8");
  assert.match(main, /ZCODE_MODEL_DISCOVERY_CORS_V1/u);
  await writeFile(mainPath, main.replace("/*ZCODE_MODEL_DISCOVERY_CORS_V1*/", ""), "utf8");
  await createPackage(extracted, repacked);
  await copyFile(repacked, asarPath);
}

test("patches, verifies, backs up, and then skips the same installed package", async t => {
  const fixture = await createFixture(t);
  const originalHash = await sha256File(fixture.asarPath);

  const first = await runPatch(optionsFor(fixture));

  assert.equal(first.status, "patched");
  assert.equal(first.officialHash, originalHash);
  assert.notEqual(first.patchedHash, originalHash);
  assert.equal(
    await sha256File(path.join(fixture.patchRoot, "backups", `${originalHash}.asar`)),
    originalHash,
  );
  assert.match(
    extractFile(fixture.asarPath, path.join("out", "renderer", "assets", "model-discovery.js")).toString("utf8"),
    /models\.dev\/models\.json/,
  );
  assert.equal(extractFile(fixture.asarPath, "native.bin").toString("utf8"), "native-sidecar");

  const second = await runPatch(optionsFor(fixture));
  assert.equal(second.status, "already-patched");
  assert.equal(second.patchedHash, first.patchedHash);
});

test("leaves the installed ASAR byte-identical when a required anchor is incompatible", async t => {
  const fixture = await createFixture(t, { compatible: false });
  const before = await sha256File(fixture.asarPath);

  const result = await runPatch(optionsFor(fixture));

  assert.equal(result.status, "incompatible");
  assert.equal(await sha256File(fixture.asarPath), before);
  const state = await readState(path.join(fixture.patchRoot, "state.json"));
  assert.equal(state.status, "incompatible");
  assert.equal(state.officialHash, before);

  const repeated = await runPatch(optionsFor(fixture));
  assert.equal(repeated.status, "incompatible");
  assert.equal(repeated.skipped, true);
});

test("records a locked install as pending and retries it on the next run", async t => {
  const fixture = await createFixture(t);
  const busyInstall = async () => {
    const error = new Error("file is busy");
    error.code = "EBUSY";
    throw error;
  };

  const pending = await runPatch(optionsFor(fixture, { replaceInstalledFile: busyInstall }));

  assert.equal(pending.status, "pending");
  const pendingState = await readState(path.join(fixture.patchRoot, "state.json"));
  assert.equal(pendingState.status, "pending");
  assert.equal(await readFile(pendingState.pendingPackagePath).then(() => true), true);

  const retried = await runPatch(optionsFor(fixture));
  assert.equal(retried.status, "patched");
  assert.equal(await sha256File(fixture.asarPath), retried.patchedHash);
});

test("restores only the verified backup for the active official hash", async t => {
  const fixture = await createFixture(t);
  const originalHash = await sha256File(fixture.asarPath);
  await runPatch(optionsFor(fixture));

  const result = await restorePatch(optionsFor(fixture));

  assert.equal(result.status, "restored");
  assert.equal(result.restoredHash, originalHash);
  assert.equal(await sha256File(fixture.asarPath), originalHash);
  const state = await readState(path.join(fixture.patchRoot, "state.json"));
  assert.equal(state.status, "restored");
});

test("seeds a manually patched install and repatches it after the patcher version changes", async t => {
  const fixture = await createFixture(t);
  const seedBackupPath = path.join(fixture.root, "official-seed.asar");
  await copyFile(fixture.asarPath, seedBackupPath);
  const officialHash = await sha256File(seedBackupPath);

  const bootstrap = await runPatch(optionsFor(fixture));
  assert.equal(bootstrap.status, "patched");
  const installedPatchedHash = await sha256File(fixture.asarPath);
  await rm(path.join(fixture.patchRoot, "state.json"), { force: true });
  await rm(path.join(fixture.patchRoot, "backups"), { recursive: true, force: true });
  await rm(path.join(fixture.patchRoot, "pending"), { recursive: true, force: true });

  const seeded = await runPatch(optionsFor(fixture, { seedBackupPath }));

  assert.equal(seeded.status, "seeded");
  assert.equal(seeded.officialHash, officialHash);
  assert.equal(seeded.patchedHash, installedPatchedHash);
  assert.equal(
    await sha256File(path.join(fixture.patchRoot, "backups", `${officialHash}.asar`)),
    officialHash,
  );

  const upgraded = await runPatch(optionsFor(fixture, { patchVersion: "2.0.1" }));
  assert.equal(upgraded.status, "patched");
  assert.equal(upgraded.officialHash, officialHash);
});

test("rejects a tampered deployed payload before changing the installed ASAR", async t => {
  const fixture = await createFixture(t);
  const before = await sha256File(fixture.asarPath);
  await writeFile(path.join(fixture.patchRoot, "payload", "model-discovery.js"), "export const tampered = true;\n", "utf8");

  await assert.rejects(runPatch(optionsFor(fixture)), /payload integrity/i);

  assert.equal(await sha256File(fixture.asarPath), before);
  assert.deepEqual(await readState(path.join(fixture.patchRoot, "state.json")), {});
});

test("clears prior patched state when an incompatible official update arrives", async t => {
  const fixture = await createFixture(t);
  assert.equal((await runPatch(optionsFor(fixture))).status, "patched");
  const priorState = await readState(path.join(fixture.patchRoot, "state.json"));
  assert.ok(priorState.patchedHash);
  assert.ok(priorState.backupPath);

  const incompatibleUpdate = await createFixture(t, { compatible: false });
  await copyFile(incompatibleUpdate.asarPath, fixture.asarPath);
  const updatedHash = await sha256File(fixture.asarPath);

  const result = await runPatch(optionsFor(fixture));

  assert.equal(result.status, "incompatible");
  const updatedState = await readState(path.join(fixture.patchRoot, "state.json"));
  assert.equal(updatedState.officialHash, updatedHash);
  assert.equal(updatedState.patchedHash, null);
  assert.equal(updatedState.backupPath, null);
});

test("upgrades a markerless legacy patch when seeding from a verified official backup", async t => {
  const fixture = await createFixture(t);
  const seedBackupPath = path.join(fixture.root, "legacy-official-seed.asar");
  await copyFile(fixture.asarPath, seedBackupPath);
  const officialHash = await sha256File(seedBackupPath);
  assert.equal((await runPatch(optionsFor(fixture))).status, "patched");
  await removeCurrentMainPatchMarker(t, fixture.asarPath);
  const legacyHash = await sha256File(fixture.asarPath);
  await rm(path.join(fixture.patchRoot, "state.json"), { force: true });
  await rm(path.join(fixture.patchRoot, "backups"), { recursive: true, force: true });
  await rm(path.join(fixture.patchRoot, "pending"), { recursive: true, force: true });

  const result = await runPatch(optionsFor(fixture, { seedBackupPath }));

  assert.equal(result.status, "patched");
  assert.equal(result.officialHash, officialHash);
  assert.notEqual(result.patchedHash, legacyHash);
  assert.equal(await sha256File(fixture.asarPath), result.patchedHash);
});

test("retries a locked legacy seed upgrade without requiring the seed argument again", async t => {
  const fixture = await createFixture(t);
  const seedBackupPath = path.join(fixture.root, "locked-legacy-official-seed.asar");
  await copyFile(fixture.asarPath, seedBackupPath);
  assert.equal((await runPatch(optionsFor(fixture))).status, "patched");
  await removeCurrentMainPatchMarker(t, fixture.asarPath);
  const legacyHash = await sha256File(fixture.asarPath);
  await rm(path.join(fixture.patchRoot, "state.json"), { force: true });
  await rm(path.join(fixture.patchRoot, "backups"), { recursive: true, force: true });
  await rm(path.join(fixture.patchRoot, "pending"), { recursive: true, force: true });
  const busyInstall = async () => {
    const error = new Error("file is busy");
    error.code = "EBUSY";
    throw error;
  };

  const pending = await runPatch(optionsFor(fixture, { seedBackupPath, replaceInstalledFile: busyInstall }));
  assert.equal(pending.status, "pending");
  assert.equal(await sha256File(fixture.asarPath), legacyHash);

  const retried = await runPatch(optionsFor(fixture));
  assert.equal(retried.status, "patched");
  assert.equal(await sha256File(fixture.asarPath), retried.patchedHash);
});
