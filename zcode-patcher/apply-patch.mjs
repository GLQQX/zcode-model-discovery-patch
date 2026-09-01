import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createPackage, extractAll, extractFile } from "@electron/asar";

import {
  assertChildPath,
  moveFileWithExdevFallback,
  readState,
  sha256File,
  shouldAttemptPatch,
  writeState,
} from "./lib/state.mjs";
import {
  findRendererBundle,
  transformMain,
  transformRenderer,
  verifyPatchedSources,
} from "./lib/transform.mjs";

const execFileAsync = promisify(execFile);
const MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const BUSY_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function nowIso() {
  return new Date().toISOString();
}

function errorText(error, stage) {
  const message = error instanceof Error ? error.message : String(error);
  return `${stage}: ${message}`;
}

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readPatchManifest(root) {
  for (const candidate of [path.join(root, "patch-manifest.json"), path.join(MODULE_ROOT, "patch-manifest.json")]) {
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new Error("patch-manifest.json was not found");
}

async function resolveOptions(options = {}) {
  const root = path.resolve(options.root ?? MODULE_ROOT);
  const manifest = await readPatchManifest(root);
  const patchVersion = options.patchVersion ?? manifest.patchVersion;
  if (typeof patchVersion !== "string" || patchVersion.length === 0) {
    throw new Error("A non-empty patch version is required");
  }
  const asarPath = path.resolve(
    options.asarPath
      ?? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "ZCode", "resources", "app.asar"),
  );
  const payloadPath = path.resolve(options.payloadPath ?? path.join(root, "payload", "model-discovery.js"));
  const expectedPayloadHash = options.payloadSha256 ?? manifest.payloadSha256;
  if (expectedPayloadHash) {
    const payloadHash = await sha256File(payloadPath);
    if (payloadHash !== String(expectedPayloadHash).toUpperCase()) {
      throw new Error(`Payload integrity check failed: expected ${expectedPayloadHash}, found ${payloadHash}`);
    }
  }
  return {
    ...options,
    asarPath,
    root,
    patchVersion,
    payloadPath,
    seedBackupPath: options.seedBackupPath ? path.resolve(options.seedBackupPath) : null,
    statePath: path.join(root, "state.json"),
    backupsRoot: path.join(root, "backups"),
    pendingRoot: path.join(root, "pending"),
    replaceInstalledFile: options.replaceInstalledFile ?? replaceInstalledFile,
  };
}

async function createExtractionInput(sourceAsar, tempRoot, sidecarFallback = null) {
  const inputAsar = path.join(tempRoot, "input", "app.asar");
  await mkdir(path.dirname(inputAsar), { recursive: true });
  await copyFile(sourceAsar, inputAsar);

  const sourceSidecar = await exists(`${sourceAsar}.unpacked`)
    ? `${sourceAsar}.unpacked`
    : sidecarFallback;
  const inputSidecar = `${inputAsar}.unpacked`;
  if (sourceSidecar && await exists(sourceSidecar)) {
    await symlink(sourceSidecar, inputSidecar, process.platform === "win32" ? "junction" : "dir");
    return { inputAsar, inputSidecar };
  }
  return { inputAsar, inputSidecar: null };
}

async function checkJavaScript(filePath) {
  await execFileAsync(process.execPath, ["--check", filePath], { windowsHide: true });
}

async function buildPatchedPackage({ sourceAsar, sourceSidecar, payloadPath, tempRoot }) {
  const { inputAsar, inputSidecar } = await createExtractionInput(sourceAsar, tempRoot, sourceSidecar);
  const extractedRoot = path.join(tempRoot, "extracted");
  extractAll(inputAsar, extractedRoot);
  if (inputSidecar) await unlink(inputSidecar);

  const rendererPath = await findRendererBundle(extractedRoot);
  const mainPath = path.join(extractedRoot, "out", "main", "index.js");
  const payload = await readFile(payloadPath, "utf8");
  const rendererResult = transformRenderer(await readFile(rendererPath, "utf8"));
  const mainResult = transformMain(await readFile(mainPath, "utf8"));
  await writeFile(rendererPath, rendererResult.source, "utf8");
  await writeFile(mainPath, mainResult.source, "utf8");

  const payloadTarget = path.join(path.dirname(rendererPath), "model-discovery.js");
  await copyFile(payloadPath, payloadTarget);
  await Promise.all([checkJavaScript(rendererPath), checkJavaScript(mainPath), checkJavaScript(payloadTarget)]);
  verifyPatchedSources({ renderer: rendererResult.source, main: mainResult.source, payload });

  const packagePath = path.join(tempRoot, "output", "app.asar");
  await mkdir(path.dirname(packagePath), { recursive: true });
  await createPackage(extractedRoot, packagePath);

  const rendererRelative = path.relative(extractedRoot, rendererPath);
  const mainRelative = path.relative(extractedRoot, mainPath);
  const payloadRelative = path.relative(extractedRoot, payloadTarget);
  verifyPatchedSources({
    renderer: extractFile(packagePath, rendererRelative).toString("utf8"),
    main: extractFile(packagePath, mainRelative).toString("utf8"),
    payload: extractFile(packagePath, payloadRelative).toString("utf8"),
  });
  return {
    packagePath,
    rendererChanges: rendererResult.changes,
    mainChanges: mainResult.changes,
  };
}

async function inspectPatchedPackage({ sourceAsar, sourceSidecar, tempRoot, allowLegacyMain = false }) {
  const { inputAsar, inputSidecar } = await createExtractionInput(sourceAsar, tempRoot, sourceSidecar);
  const extractedRoot = path.join(tempRoot, "inspected");
  extractAll(inputAsar, extractedRoot);
  if (inputSidecar) await unlink(inputSidecar);
  const rendererPath = await findRendererBundle(extractedRoot);
  const mainPath = path.join(extractedRoot, "out", "main", "index.js");
  const payloadPath = path.join(path.dirname(rendererPath), "model-discovery.js");
  const sources = {
    renderer: await readFile(rendererPath, "utf8"),
    main: await readFile(mainPath, "utf8"),
    payload: await readFile(payloadPath, "utf8"),
  };
  try {
    verifyPatchedSources(sources);
    return { current: true };
  } catch (error) {
    if (!allowLegacyMain) throw error;
    for (const marker of [
      "onDiscoverModels:me,discoveryPending:ye",
      "import(`./model-discovery.js`)",
      "existingModels:j",
    ]) {
      if (!sources.renderer.includes(marker)) throw error;
    }
    if (!sources.payload.includes("https://models.dev/models.json") || sources.payload.includes("VISION_MODEL_ID")) {
      throw error;
    }
    for (const marker of ["onHeadersReceived", "Access-Control-Allow-Origin", "models"]) {
      if (!sources.main.includes(marker)) throw error;
    }
    return { current: false };
  }
}

async function ensureVerifiedBackup({ sourceAsar, backupPath, officialHash }) {
  await mkdir(path.dirname(backupPath), { recursive: true });
  if (await exists(backupPath)) {
    const existingHash = await sha256File(backupPath);
    if (existingHash !== officialHash) {
      throw new Error(`Existing backup hash mismatch: expected ${officialHash}, found ${existingHash}`);
    }
    return;
  }

  const temporaryBackup = `${backupPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await copyFile(sourceAsar, temporaryBackup);
    const copiedHash = await sha256File(temporaryBackup);
    if (copiedHash !== officialHash) {
      throw new Error(`Backup verification failed: expected ${officialHash}, found ${copiedHash}`);
    }
    await moveFileWithExdevFallback(temporaryBackup, backupPath);
  } finally {
    await rm(temporaryBackup, { force: true });
  }
}

async function replaceInstalledFile(sourcePackage, installedAsar) {
  const stagedPath = path.join(
    path.dirname(installedAsar),
    `.${path.basename(installedAsar)}.zcode-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await copyFile(sourcePackage, stagedPath);
    await rename(stagedPath, installedAsar);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

async function writePatchState(config, previous, updates) {
  const updatedOrPrevious = key => Object.hasOwn(updates, key) ? updates[key] : previous[key] ?? null;
  const next = {
    patchVersion: config.patchVersion,
    officialHash: updatedOrPrevious("officialHash"),
    patchedHash: updatedOrPrevious("patchedHash"),
    status: updates.status,
    backupPath: updatedOrPrevious("backupPath"),
    pendingPackagePath: updates.pendingPackagePath ?? null,
    pendingBaseHash: updates.pendingBaseHash ?? null,
    lastError: updates.lastError ?? null,
    updatedAt: nowIso(),
  };
  await writeState(config.statePath, next);
  return next;
}

async function installPendingPackage(config, state, currentHash) {
  if (
    state.status !== "pending"
    || state.patchVersion !== config.patchVersion
    || (state.pendingBaseHash ?? state.officialHash) !== currentHash
    || !state.pendingPackagePath
    || !state.patchedHash
  ) {
    return null;
  }

  const pendingPath = assertChildPath(config.pendingRoot, state.pendingPackagePath);
  if (!(await exists(pendingPath)) || await sha256File(pendingPath) !== state.patchedHash) return null;

  try {
    await config.replaceInstalledFile(pendingPath, config.asarPath);
    const installedHash = await sha256File(config.asarPath);
    if (installedHash !== state.patchedHash) {
      throw new Error(`Installed hash mismatch: expected ${state.patchedHash}, found ${installedHash}`);
    }
    await rm(pendingPath, { force: true });
    await writePatchState(config, state, {
      status: "patched",
      officialHash: state.officialHash,
      patchedHash: state.patchedHash,
      backupPath: state.backupPath,
    });
    return { status: "patched", officialHash: state.officialHash, patchedHash: state.patchedHash, retried: true };
  } catch (error) {
    if (BUSY_ERROR_CODES.has(error?.code)) {
      await writePatchState(config, state, {
        status: "pending",
        officialHash: state.officialHash,
        patchedHash: state.patchedHash,
        backupPath: state.backupPath,
        pendingPackagePath: pendingPath,
        pendingBaseHash: currentHash,
        lastError: errorText(error, "install-pending"),
      });
      return { status: "pending", officialHash: state.officialHash, patchedHash: state.patchedHash };
    }
    throw error;
  }
}

async function seedExistingPatch(config, previous, installedHash) {
  const officialHash = await sha256File(config.seedBackupPath);
  if (officialHash === installedHash) {
    throw new Error("Seed backup is identical to the installed package; an already patched install was expected");
  }

  let officialTemp;
  let installedTemp;
  try {
    officialTemp = await mkdtemp(path.join(tmpdir(), "zcode-model-seed-official-"));
    const officialBuild = await buildPatchedPackage({
      sourceAsar: config.seedBackupPath,
      sourceSidecar: `${config.asarPath}.unpacked`,
      payloadPath: config.payloadPath,
      tempRoot: officialTemp,
    });
    if (officialBuild.rendererChanges.alreadyPatched || officialBuild.mainChanges.alreadyPatched) {
      throw new Error("Seed backup already contains the model-discovery patch");
    }

    const desiredHash = await sha256File(officialBuild.packagePath);
    installedTemp = await mkdtemp(path.join(tmpdir(), "zcode-model-seed-installed-"));
    await inspectPatchedPackage({
      sourceAsar: config.asarPath,
      tempRoot: installedTemp,
      allowLegacyMain: installedHash !== desiredHash,
    });

    const backupPath = assertChildPath(
      config.backupsRoot,
      path.join(config.backupsRoot, `${officialHash}.asar`),
    );
    await ensureVerifiedBackup({
      sourceAsar: config.seedBackupPath,
      backupPath,
      officialHash,
    });

    if (installedHash !== desiredHash) {
      const pendingPath = assertChildPath(
        config.pendingRoot,
        path.join(config.pendingRoot, `${officialHash}-${config.patchVersion}.asar`),
      );
      await copyFile(officialBuild.packagePath, pendingPath);
      if (await sha256File(pendingPath) !== desiredHash) {
        throw new Error("Seeded pending package hash verification failed");
      }
      try {
        await config.replaceInstalledFile(pendingPath, config.asarPath);
      } catch (error) {
        if (!BUSY_ERROR_CODES.has(error?.code)) throw error;
        await writePatchState(config, previous, {
          status: "pending",
          officialHash,
          patchedHash: desiredHash,
          backupPath,
          pendingPackagePath: pendingPath,
          pendingBaseHash: installedHash,
          lastError: errorText(error, "install-seeded-upgrade"),
        });
        return { status: "pending", officialHash, patchedHash: desiredHash };
      }
      const finalHash = await sha256File(config.asarPath);
      if (finalHash !== desiredHash) {
        throw new Error(`Installed seeded upgrade hash mismatch: expected ${desiredHash}, found ${finalHash}`);
      }
      await rm(pendingPath, { force: true });
      await writePatchState(config, previous, {
        status: "patched",
        officialHash,
        patchedHash: desiredHash,
        backupPath,
      });
      return { status: "patched", officialHash, patchedHash: desiredHash, upgradedLegacy: true };
    }

    await writePatchState(config, previous, {
      status: "patched",
      officialHash,
      patchedHash: installedHash,
      backupPath,
    });
    return { status: "seeded", officialHash, patchedHash: installedHash };
  } finally {
    if (officialTemp) await rm(officialTemp, { recursive: true, force: true });
    if (installedTemp) await rm(installedTemp, { recursive: true, force: true });
  }
}

export async function runPatch(options = {}) {
  const config = await resolveOptions(options);
  await Promise.all([
    mkdir(config.root, { recursive: true }),
    mkdir(config.backupsRoot, { recursive: true }),
    mkdir(config.pendingRoot, { recursive: true }),
  ]);
  const previous = await readState(config.statePath);
  const installedHash = await sha256File(config.asarPath);

  if (config.seedBackupPath) {
    return seedExistingPatch(config, previous, installedHash);
  }

  if (previous.patchedHash === installedHash && previous.patchVersion === config.patchVersion) {
    await writePatchState(config, previous, {
      status: "patched",
      officialHash: previous.officialHash,
      patchedHash: installedHash,
      backupPath: previous.backupPath,
    });
    if (previous.pendingPackagePath) await rm(previous.pendingPackagePath, { force: true });
    return { status: "already-patched", officialHash: previous.officialHash, patchedHash: installedHash };
  }

  const pendingResult = await installPendingPackage(config, previous, installedHash);
  if (pendingResult) return pendingResult;

  let officialHash = installedHash;
  let sourceAsar = config.asarPath;
  if (
    previous.patchedHash === installedHash
    && previous.patchVersion !== config.patchVersion
    && previous.officialHash
    && previous.backupPath
  ) {
    const verifiedBackup = assertChildPath(config.backupsRoot, previous.backupPath);
    const backupHash = await sha256File(verifiedBackup);
    if (backupHash !== previous.officialHash) {
      throw new Error(`Cannot upgrade patch: official backup hash mismatch for ${verifiedBackup}`);
    }
    officialHash = previous.officialHash;
    sourceAsar = verifiedBackup;
  }

  if (!shouldAttemptPatch(previous, officialHash, config.patchVersion)) {
    return { status: "incompatible", officialHash, skipped: true };
  }

  let stage = "prepare";
  let tempRoot;
  try {
    stage = "create-temporary-workspace";
    tempRoot = await mkdtemp(path.join(tmpdir(), "zcode-model-patch-"));
    stage = "extract-transform-verify";
    const build = await buildPatchedPackage({
      sourceAsar,
      sourceSidecar: sourceAsar === config.asarPath ? null : `${config.asarPath}.unpacked`,
      payloadPath: config.payloadPath,
      tempRoot,
    });
    if (build.rendererChanges.alreadyPatched || build.mainChanges.alreadyPatched) {
      throw new Error("Installed package already contains the patch but has no matching state; use --seed-backup");
    }
    const generatedPackage = build.packagePath;
    const patchedHash = await sha256File(generatedPackage);

    stage = "backup";
    const backupPath = assertChildPath(config.backupsRoot, path.join(config.backupsRoot, `${officialHash}.asar`));
    await ensureVerifiedBackup({ sourceAsar, backupPath, officialHash });

    stage = "stage-pending-package";
    const pendingPath = assertChildPath(
      config.pendingRoot,
      path.join(config.pendingRoot, `${officialHash}-${config.patchVersion}.asar`),
    );
    await copyFile(generatedPackage, pendingPath);
    if (await sha256File(pendingPath) !== patchedHash) {
      throw new Error("Pending package hash verification failed");
    }

    stage = "install";
    try {
      await config.replaceInstalledFile(pendingPath, config.asarPath);
    } catch (error) {
      if (!BUSY_ERROR_CODES.has(error?.code)) throw error;
      await writePatchState(config, previous, {
        status: "pending",
        officialHash,
        patchedHash,
        backupPath,
        pendingPackagePath: pendingPath,
        pendingBaseHash: officialHash,
        lastError: errorText(error, stage),
      });
      return { status: "pending", officialHash, patchedHash };
    }

    stage = "verify-installed";
    const finalHash = await sha256File(config.asarPath);
    if (finalHash !== patchedHash) {
      throw new Error(`Installed hash mismatch: expected ${patchedHash}, found ${finalHash}`);
    }
    await rm(pendingPath, { force: true });
    await writePatchState(config, previous, {
      status: "patched",
      officialHash,
      patchedHash,
      backupPath,
    });
    return { status: "patched", officialHash, patchedHash };
  } catch (error) {
    const lastError = errorText(error, stage);
    await writePatchState(config, previous, {
      status: "incompatible",
      officialHash,
      patchedHash: null,
      backupPath: null,
      pendingPackagePath: null,
      lastError,
    });
    return { status: "incompatible", officialHash, error: lastError };
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function restorePatch(options = {}) {
  const config = await resolveOptions(options);
  const state = await readState(config.statePath);
  if (!state.officialHash || !state.backupPath) {
    throw new Error("No verified official backup is recorded in state.json");
  }
  const backupPath = assertChildPath(config.backupsRoot, state.backupPath);
  const backupHash = await sha256File(backupPath);
  if (backupHash !== state.officialHash) {
    throw new Error(`Official backup hash mismatch: expected ${state.officialHash}, found ${backupHash}`);
  }

  await config.replaceInstalledFile(backupPath, config.asarPath);
  const restoredHash = await sha256File(config.asarPath);
  if (restoredHash !== state.officialHash) {
    throw new Error(`Restored hash mismatch: expected ${state.officialHash}, found ${restoredHash}`);
  }
  await writePatchState(config, state, {
    status: "restored",
    officialHash: state.officialHash,
    patchedHash: state.patchedHash,
    backupPath,
  });
  return { status: "restored", restoredHash };
}

function parseCliArgs(argv) {
  const parsed = { json: false, restore: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") parsed.json = true;
    else if (argument === "--restore") parsed.restore = true;
    else if (argument === "--asar") parsed.asarPath = argv[++index];
    else if (argument === "--root") parsed.root = argv[++index];
    else if (argument === "--seed-backup") parsed.seedBackupPath = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (argv.some((argument, index) => ["--asar", "--root", "--seed-backup"].includes(argument) && !argv[index + 1])) {
    throw new Error("--asar, --root, and --seed-backup require a path argument");
  }
  return parsed;
}

async function appendLog(root, result) {
  const logsRoot = path.join(root, "logs");
  await mkdir(logsRoot, { recursive: true });
  await appendFile(path.join(logsRoot, "patcher.log"), `${nowIso()} ${JSON.stringify(result)}\n`, "utf8");
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const result = args.restore ? await restorePatch(args) : await runPatch(args);
  const root = path.resolve(args.root ?? MODULE_ROOT);
  await appendLog(root, result);
  process.stdout.write(`${args.json ? JSON.stringify(result) : `${result.status}\n`}`);
  if (result.status === "incompatible") process.exitCode = 1;
  else if (result.status === "pending") process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async error => {
    const result = { status: "failed", error: error instanceof Error ? error.message : String(error) };
    try {
      const args = parseCliArgs(process.argv.slice(2));
      await appendLog(path.resolve(args.root ?? MODULE_ROOT), result);
    } catch {}
    process.stderr.write(`${JSON.stringify(result)}\n`);
    process.exitCode = 1;
  });
}
