// ZCode model-discovery patcher: install / uninstall / scheduled task.
// Single entry point replacing the previous setup.ps1 / install.ps1 / uninstall.ps1.
//
// Usage:
//   node install.mjs install  [--asar <app.asar>] [--root <dir>] [--node <node.exe>]
//                             [--seed-backup <official.asar>] [--no-task] [--no-patch]
//   node install.mjs uninstall [--root <dir>] [--no-task] [--keep-runtime]
//   node install.mjs selftest  (extracts an embedded runtime.zip next to this file)
import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { extractZip, zipDirectory } from "./lib/zip.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TASK_NAME = "ZCode Model Discovery Patch";
const TASK_NAME_LEGACY = `${TASK_NAME} - Logon`;
const BUSY_PATCH_EXIT = 2;

const RUNTIME_FILES = [
  "apply-patch.mjs",
  "install.mjs",
  "package.json",
  "package-lock.json",
  "patch-manifest.json",
];
const RUNTIME_DIRS = ["lib", "payload", "node_modules"];

async function exists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function fail(message) {
  throw new Error(message);
}

/** Find the installed ZCode app.asar: explicit path first, then known locations. */
async function findZCodeAsar(explicit) {
  if (explicit) return path.resolve(explicit);

  const locals = process.env.LOCALAPPDATA ?? "";
  const roots = [locals, process.env.ProgramFiles ?? "", process.env["ProgramFiles(x86)"] ?? ""]
    .filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    const candidate = path.join(root, "Programs", "ZCode", "resources", "app.asar");
    if (await exists(candidate)) candidates.push(path.resolve(candidate));
  }
  if (locals) {
    const candidate = path.join(locals, "ZCode", "resources", "app.asar");
    if (await exists(candidate)) candidates.push(path.resolve(candidate));
  }
  if (process.env.ProgramFiles && await exists(path.join(process.env.ProgramFiles, "ZCode", "resources", "app.asar"))) {
    candidates.push(path.resolve(path.join(process.env.ProgramFiles, "ZCode", "resources", "app.asar")));
  }

  const withExecutable = candidates.filter(candidate =>
    path.basename(path.dirname(path.dirname(path.dirname(candidate)))) === "ZCode"
    || candidates.length === 1);
  const pool = withExecutable.length > 0 ? withExecutable : candidates;
  if (pool.length === 0) {
    fail("ZCode installation was not found. Install ZCode first, or pass --asar with the path to app.asar.");
  }
  const newest = await newestByMtime(pool);
  return newest ?? pool[0];
}

async function newestByMtime(paths) {
  let best = null;
  for (const candidate of paths) {
    const mtime = (await stat(candidate)).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: candidate, mtime };
  }
  return best?.path;
}

async function findNodeRuntime(explicit, sourceRoot) {
  if (explicit) {
    if (!(await exists(explicit))) fail(`Node.js runtime was not found: ${explicit}`);
    return path.resolve(explicit);
  }
  const bundled = path.join(sourceRoot, "node.exe");
  if (await exists(bundled)) return bundled;
  // Running from a source checkout (no bundled node.exe): reuse the current interpreter.
  return process.execPath;
}

async function copyRuntime(sourceRoot, destinationRoot) {
  for (const directory of RUNTIME_DIRS) {
    await copyDirectory(path.join(sourceRoot, directory), path.join(destinationRoot, directory));
  }
  for (const file of RUNTIME_FILES) {
    await copyFile(path.join(sourceRoot, file), path.join(destinationRoot, file));
  }
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else await copyFile(from, to);
  }
}

function escapeVbs(value) {
  return value.replace(/"/g, '""');
}

/** Write the hidden logon launcher: wscript runs run-patch.ps1 invisible. */
async function writeHiddenLauncher(runtimeRoot, nodePath, asarPath) {
  const logsRoot = path.join(runtimeRoot, "logs");
  await mkdir(logsRoot, { recursive: true });

  const runnerPath = path.join(runtimeRoot, "run-patch.ps1");
  const runner = [
    '$ErrorActionPreference = "Continue"',
    `New-Item -ItemType Directory -Path '${logsRoot.replace(/'/g, "''")}' -Force | Out-Null`,
    `& '${nodePath.replace(/'/g, "''")}' '${path.join(runtimeRoot, "apply-patch.mjs").replace(/'/g, "''")}' --asar '${asarPath.replace(/'/g, "''")}' --root '${runtimeRoot.replace(/'/g, "''")}' --json *>> '${path.join(logsRoot, "scheduled-output.log").replace(/'/g, "''")}'`,
    "exit $LASTEXITCODE",
    "",
  ].join("\n");
  await writeFile(runnerPath, runner, "utf8");

  const launcherPath = path.join(runtimeRoot, "run-hidden.vbs");
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const launcher = [
    `Set shell = CreateObject("WScript.Shell")`,
    `shell.Run """${escapeVbs(powershell)}"" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${escapeVbs(runnerPath)}""", 0, False`,
    "",
  ].join("\r\n");
  await writeFile(launcherPath, launcher, "ascii");
  return launcherPath;
}

async function registerLogonTask(launcherPath, taskName = TASK_NAME) {
  // Register a hidden logon task. schtasks.exe is tried first; on locked-down
  // systems both routes may be denied, which is reported but not fatal.
  const wscript = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  const command = `"${wscript}" "${launcherPath}"`;
  try {
    await execFileAsync("schtasks.exe", ["/Create", "/TN", taskName, "/TR", command, "/SC", "ONLOGON", "/F"]);
    return { registered: true, via: "schtasks" };
  } catch (schtasksError) {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$action = New-ScheduledTaskAction -Execute $env:WSCRIPT -Argument ('\"\"' + $env:LAUNCHER + '\"\"')",
      "$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)",
      "$settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -MultipleInstances IgnoreNew",
      "$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
      `Register-ScheduledTask -TaskName $env:TASKNAME -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    ].join("\n");
    try {
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        env: {
          ...process.env,
          WSCRIPT: wscript,
          LAUNCHER: launcherPath,
          TASKNAME: taskName,
        },
      });
      return { registered: true, via: "powershell" };
    } catch (powershellError) {
      return {
        registered: false,
        warning: `Could not register the logon scheduled task (${schtasksError?.message ?? schtasksError}; ${powershellError?.message ?? powershellError}). The patch is installed, but it will not re-apply automatically after ZCode updates. Re-run install with elevated privileges if you want the auto-repatch task.`,
      };
    }
  }
}

async function unregisterTasks() {
  for (const taskName of [TASK_NAME, TASK_NAME_LEGACY]) {
    try {
      await execFileAsync("schtasks.exe", ["/Delete", "/TN", taskName, "/F"]);
    } catch (error) {
      if (!String(error?.message ?? "").includes("cannot find") && !String(error?.stderr ?? "").includes("cannot find")) {
        // Absent tasks are expected; surface anything else as a warning, not a failure.
        process.stderr.write(`Warning: could not remove scheduled task ${taskName}: ${error?.message ?? error}\n`);
      }
    }
  }
}

async function runPatcher(nodePath, runtimeRoot, asarPath, seedBackup) {
  const args = [
    path.join(runtimeRoot, "apply-patch.mjs"),
    "--asar", asarPath,
    "--root", runtimeRoot,
    "--json",
  ];
  if (seedBackup) args.push("--seed-backup", seedBackup);
  try {
    const { stdout } = await execFileAsync(nodePath, args, { windowsHide: true });
    process.stdout.write(`${stdout}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${error?.stdout ?? ""}\n`);
    process.stderr.write(`${error?.stderr ?? error?.message ?? error}\n`);
    return error?.code ?? 1;
  }
}

async function install(options) {
  const sourceRoot = HERE;
  const runtimeRoot = path.resolve(options.root ?? path.join(process.env.USERPROFILE ?? "", ".zcode-model-discovery-patch"));
  const asarPath = await findZCodeAsar(options.asar);
  if (!(await exists(asarPath))) fail(`ZCode app.asar was not found: ${asarPath}`);
  const nodePath = await findNodeRuntime(options.node, sourceRoot);

  const selfInstall = path.resolve(sourceRoot) === path.resolve(runtimeRoot);
  if (!selfInstall) await copyRuntime(sourceRoot, runtimeRoot);

  const installedNode = path.join(runtimeRoot, "node.exe");
  if (!selfInstall || options.node) {
    await copyFile(nodePath, installedNode);
  }
  const runNode = (await exists(installedNode)) ? installedNode : nodePath;

  const launcherPath = await writeHiddenLauncher(runtimeRoot, runNode, asarPath);

  if (!options.noPatch) {
    const exitCode = await runPatcher(runNode, runtimeRoot, asarPath, options.seedBackup);
    if (exitCode !== 0 && exitCode !== BUSY_PATCH_EXIT) {
      fail(`Initial patch run failed with exit code ${exitCode}`);
    }
  }

  let taskResult = { registered: false };
  if (!options.noTask) taskResult = await registerLogonTask(launcherPath);

  process.stdout.write(`Installed ZCode model-discovery patcher at ${runtimeRoot}\n`);
  if (taskResult.registered) {
    process.stdout.write(`Registered logon scheduled task: ${TASK_NAME}\n`);
  } else if (!options.noTask) {
    process.stderr.write(`${taskResult.warning}\n`);
  }
}

async function uninstall(options) {
  const runtimeRoot = path.resolve(options.root ?? path.join(process.env.USERPROFILE ?? "", ".zcode-model-discovery-patch"));
  if (!options.noTask) await unregisterTasks();
  if (options.keepRuntime) return;

  const nodePath = (await exists(path.join(runtimeRoot, "node.exe")))
    ? path.join(runtimeRoot, "node.exe")
    : "node.exe";
  const restoreCommand = `& "${nodePath}" "${path.join(runtimeRoot, "apply-patch.mjs")}" --root "${runtimeRoot}" --restore --json`;

  for (const file of [...RUNTIME_FILES, "run-patch.ps1", "run-hidden.vbs", "node.exe"]) {
    await rm(path.join(runtimeRoot, file), { force: true });
  }
  const rootPrefix = runtimeRoot.endsWith(path.sep) ? runtimeRoot : runtimeRoot + path.sep;
  for (const directory of [...RUNTIME_DIRS, "pending"]) {
    const candidate = path.resolve(path.join(runtimeRoot, directory));
    if (!candidate.startsWith(rootPrefix)) fail(`Refusing to remove a path outside the patcher root: ${candidate}`);
    await rm(candidate, { recursive: true, force: true });
  }

  process.stdout.write("Removed scheduled tasks and patcher runtime files. Preserved state.json, backups, and logs.\n");
  process.stdout.write(`To restore before uninstalling the runtime, run: ${restoreCommand}\n`);
}

/** Used by the single-file installer: extract embedded runtime.zip beside this script, then install. */
async function selfExtract(options) {
  const archive = path.join(HERE, "runtime.zip");
  if (!(await exists(archive))) fail("The embedded runtime archive is missing.");
  const runtimeRoot = await mkdtemp(path.join(tmpdir(), "zcode-model-discovery-runtime-"));
  try {
    await extractZip(archive, runtimeRoot);
    const installScript = path.join(runtimeRoot, "install.mjs");
    const nodePath = path.join(runtimeRoot, "node.exe");
    if (!(await exists(installScript)) || !(await exists(nodePath))) {
      fail("The embedded patcher runtime is incomplete.");
    }
    const args = [installScript, "install", "--node", nodePath];
    if (options.asar) args.push("--asar", options.asar);
    if (options.root) args.push("--root", options.root);
    if (options.seedBackup) args.push("--seed-backup", options.seedBackup);
    await execFileAsync(nodePath, args, { windowsHide: true, stdio: "inherit" });
    process.stdout.write("ZCode model-discovery patch installed.\n");
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { command: null, asar: null, root: null, node: null, seedBackup: null, noTask: false, noPatch: false, keepRuntime: false, selftest: false };
  const valueFlags = { "--asar": "asar", "--root": "root", "--node": "node", "--seed-backup": "seedBackup" };
  const boolFlags = { "--no-task": "noTask", "--no-patch": "noPatch", "--keep-runtime": "keepRuntime", "--selftest": "selftest" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (index === 0 && !argument.startsWith("--")) {
      options.command = argument;
    } else if (valueFlags[argument]) {
      options[valueFlags[argument]] = argv[++index];
      if (!options[valueFlags[argument]]) fail(`${argument} requires a value`);
    } else if (argument in boolFlags) {
      options[boolFlags[argument]] = true;
    } else {
      fail(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selftest) return selfExtract(options);
  switch (options.command) {
    case "install": return install(options);
    case "uninstall": return uninstall(options);
    default: fail("Usage: node install.mjs <install|uninstall> [--asar p] [--root d] [--node n] [--seed-backup p] [--no-task] [--no-patch] [--keep-runtime] [--selftest]");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

export { findZCodeAsar, install, uninstall, registerLogonTask, TASK_NAME };
