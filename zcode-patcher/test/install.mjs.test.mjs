import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

import { extractZip, zipDirectory } from "../lib/zip.mjs";

const execFileAsync = promisify(execFile);
const PATCHER_ROOT = path.resolve(import.meta.dirname, "..");

async function makeTemp(name) {
  return mkdtemp(path.join(tmpdir(), `zcode-install-test-${name}-`));
}

function runInstaller(args, env) {
  return execFileAsync(process.execPath, [path.join(PATCHER_ROOT, "install.mjs"), ...args], {
    cwd: PATCHER_ROOT,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

test("zip round-trips a nested runtime tree", async () => {
  const root = await makeTemp("zip");
  try {
    const source = path.join(root, "src", "nested", "deeper");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "file.js"), "console.log('héllo')\n".repeat(1000), "utf8");
    await writeFile(path.join(root, "src", "top.txt"), "plain", "utf8");
    const archive = path.join(root, "runtime.zip");
    await zipDirectory(path.join(root, "src"), archive);
    assert.equal((await stat(archive)).size > 0, true);

    const extracted = path.join(root, "out");
    await extractZip(archive, extracted);
    assert.equal(await readFile(path.join(extracted, "nested", "deeper", "file.js"), "utf8"), "console.log('héllo')\n".repeat(1000));
    assert.equal(await readFile(path.join(extracted, "top.txt"), "utf8"), "plain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("install deploys runtime, launcher, and preserves state on reinstall", async () => {
  const root = await makeTemp("install");
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE };
  try {
    const localAppData = path.join(root, "LocalAppData");
    const userProfile = path.join(root, "UserProfile");
    await mkdir(localAppData, { recursive: true });
    await mkdir(userProfile, { recursive: true });
    const fixtureAsar = path.join(root, "ZCode", "resources", "app.asar");
    await mkdir(path.dirname(fixtureAsar), { recursive: true });
    await writeFile(fixtureAsar, "fixture");

    const env = { LOCALAPPDATA: localAppData, USERPROFILE: userProfile };
    const installedRoot = path.join(userProfile, ".zcode-model-discovery-patch");

    await runInstaller(["install", "--no-task", "--no-patch", "--asar", fixtureAsar], env);

    for (const relative of [
      "apply-patch.mjs",
      "install.mjs",
      "patch-manifest.json",
      path.join("payload", "model-discovery.js"),
      path.join("lib", "state.mjs"),
      path.join("lib", "transform.mjs"),
      path.join("node_modules", "@electron", "asar", "package.json"),
      "run-hidden.vbs",
      "run-patch.ps1",
      "node.exe",
    ]) {
      assert.equal(await stat(path.join(installedRoot, relative)).then(s => s.isFile(), () => false), true, `missing ${relative}`);
    }

    const launcher = await readFile(path.join(installedRoot, "run-hidden.vbs"), "utf8");
    assert.match(launcher, new RegExp(`"${path.join(installedRoot, "run-patch.ps1").replace(/\\/g, "\\\\")}"`));
    assert.match(launcher, /,\s*0,\s*False/);
    const runner = await readFile(path.join(installedRoot, "run-patch.ps1"), "utf8");
    assert.match(runner, new RegExp(path.join(installedRoot, "node.exe").replace(/\\/g, "\\\\")));
    assert.match(runner, new RegExp(fixtureAsar.replace(/\\/g, "\\\\")));

    // Reinstall preserves state.json and other runtime-generated data.
    const statePath = path.join(installedRoot, "state.json");
    await writeFile(statePath, '{"status":"preserve-me"}', "utf8");
    await runInstaller(["install", "--no-task", "--no-patch", "--asar", fixtureAsar], env);
    assert.equal(await readFile(statePath, "utf8"), '{"status":"preserve-me"}');
  } finally {
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
    process.env.USERPROFILE = previous.USERPROFILE;
    await rm(root, { recursive: true, force: true });
  }
});

test("install registers a logon-only scheduled task and uninstall cleans up", async () => {
  const root = await makeTemp("task");
  const taskName = `ZCode Installer Test ${Date.now()}`;
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE };
  try {
    const userProfile = path.join(root, "UserProfile");
    await mkdir(userProfile, { recursive: true });
    const fixtureAsar = path.join(root, "ZCode", "resources", "app.asar");
    await mkdir(path.dirname(fixtureAsar), { recursive: true });
    await writeFile(fixtureAsar, "fixture");
    const env = { LOCALAPPDATA: path.join(root, "LocalAppData"), USERPROFILE: userProfile };

    // Task registration may be denied on locked-down, non-elevated sessions; the
    // helper must either register a logon-only task or degrade gracefully.
    const { registerLogonTask } = await import(pathToFileURL(path.join(PATCHER_ROOT, "install.mjs")).href);
    const launcher = path.join(userProfile, "run-hidden.vbs");
    await writeFile(launcher, "placeholder");
    const result = await registerLogonTask(launcher, taskName);
    if (result.registered) {
      const { stdout: query } = await execFileAsync("schtasks.exe", ["/Query", "/TN", taskName, "/XML"]);
      assert.match(query, /LogonTrigger/);
      assert.doesNotMatch(query, /TimeTrigger/);
      await execFileAsync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
    } else {
      assert.match(result.warning, /Could not register/);
    }

    // Uninstall removes runtime but preserves state, backups, logs.
    const installedRoot = path.join(userProfile, ".zcode-model-discovery-patch");
    await runInstaller(["install", "--no-task", "--no-patch", "--asar", fixtureAsar, "--root", installedRoot], env);
    const statePath = path.join(installedRoot, "state.json");
    const backupFile = path.join(installedRoot, "backups", "official.asar");
    const logFile = path.join(installedRoot, "logs", "patcher.log");
    await mkdir(path.dirname(backupFile), { recursive: true });
    await mkdir(path.dirname(logFile), { recursive: true });
    await writeFile(backupFile, "backup");
    await writeFile(logFile, "log");
    await writeFile(statePath, '{"status":"preserve-me"}', "utf8");

    const { stdout } = await runInstaller(["uninstall", "--no-task", "--root", installedRoot], env);
    assert.equal(await stat(path.join(installedRoot, "apply-patch.mjs")).then(() => true, () => false), false);
    assert.equal(await stat(path.join(installedRoot, "node_modules")).then(() => true, () => false), false);
    assert.equal(await stat(statePath).then(() => true, () => false), true);
    assert.equal(await stat(backupFile).then(() => true, () => false), true);
    assert.equal(await stat(logFile).then(() => true, () => false), true);
    assert.match(stdout, /--restore/);
  } finally {
    process.env.LOCALAPPDATA = previous.LOCALAPPDATA;
    process.env.USERPROFILE = previous.USERPROFILE;
    await rm(root, { recursive: true, force: true });
  }
});
