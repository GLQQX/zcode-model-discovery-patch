// Build the single-file installer with Windows IExpress:
// stages runtime.zip (patcher + node.exe) beside a setup.cmd that runs
// `node install.mjs --selftest`, then packs them into ZCodeModelDiscoveryPatch-Setup.exe.
//
// Usage: node build-installer.mjs [--node <node.exe>] [--out <Setup.exe>] [--keep-stage]
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { zipDirectory } from "./lib/zip.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

const RUNTIME_FILES = [
  "apply-patch.mjs",
  "install.mjs",
  "package.json",
  "package-lock.json",
  "patch-manifest.json",
];
const RUNTIME_DIRS = ["lib", "payload", "node_modules"];

const SETUP_CMD = [
  "@echo off",
  "setlocal",
  "start \"\" /wait \"%~dp0node.exe\" \"%~dp0install.mjs\" --selftest",
  "exit /b %ERRORLEVEL%",
  "",
].join("\r\n");

async function parseArgs(argv) {
  const options = { node: null, out: null, keepStage: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--node") options.node = argv[++index];
    else if (argument === "--out") options.out = argv[++index];
    else if (argument === "--keep-stage") options.keepStage = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.node) {
    const { stdout } = await execFileAsync("where", ["node.exe"]);
    options.node = stdout.split(/\r?\n/)[0].trim();
  }
  return options;
}

async function sha256File(filePath) {
  const { createReadStream } = await import("node:fs");
  const { pipeline } = await import("node:stream/promises");
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex").toUpperCase();
}

function sedFor(stageRoot, outputName) {
  return [
    "[Version]",
    "Class=IEXPRESS",
    "SEDVersion=3",
    "[Options]",
    "PackagePurpose=InstallApp",
    "ShowInstallProgramWindow=1",
    "HideExtractAnimation=1",
    "UseLongFileName=1",
    "InsideCompressed=1",
    "CAB_FixedSize=0",
    "CAB_ResvCodeSigning=0",
    "RebootMode=N",
    "InstallPrompt=%InstallPrompt%",
    "DisplayLicense=%DisplayLicense%",
    "FinishMessage=%FinishMessage%",
    "TargetName=%TargetName%",
    "FriendlyName=%FriendlyName%",
    "AppLaunched=%AppLaunched%",
    "PostInstallCmd=%PostInstallCmd%",
    "AdminQuietInstCmd=%AdminQuietInstCmd%",
    "UserQuietInstCmd=%UserQuietInstCmd%",
    "SourceFiles=SourceFiles",
    "[Strings]",
    "InstallPrompt=",
    "DisplayLicense=",
    "FinishMessage=ZCode model-discovery patch installation finished.",
    `TargetName=${outputName}`,
    "FriendlyName=ZCode Model Discovery Patch",
    "AppLaunched=cmd.exe /c setup.cmd",
    "PostInstallCmd=<None>",
    "AdminQuietInstCmd=cmd.exe /c setup.cmd",
    "UserQuietInstCmd=cmd.exe /c setup.cmd",
    "FILE0=setup.cmd",
    "FILE1=runtime.zip",
    "[SourceFiles]",
    `SourceFiles0=${stageRoot}\\`,
    "[SourceFiles0]",
    "%FILE0%=",
    "%FILE1%=",
    "",
  ].join("\r\n");
}

async function main() {
  const options = await parseArgs(process.argv.slice(2));
  const nodeStat = await stat(options.node).catch(() => null);
  if (!nodeStat?.isFile()) throw new Error(`Node.js runtime was not found: ${options.node}`);

  const stageRoot = await mkdtemp(path.join(tmpdir(), "zcode-model-discovery-installer-"));
  let succeeded = false;
  try {
    const payloadRoot = path.join(stageRoot, "runtime");
    await mkdir(payloadRoot, { recursive: true });
    for (const file of RUNTIME_FILES) await copyFile(path.join(HERE, file), path.join(payloadRoot, file));
    for (const directory of RUNTIME_DIRS) {
      await copyTree(path.join(HERE, directory), path.join(payloadRoot, directory));
    }
    await copyFile(options.node, path.join(payloadRoot, "node.exe"));
    // setup.cmd lives at stage root (next to runtime.zip), not inside it:
    await writeFile(path.join(stageRoot, "setup.cmd"), SETUP_CMD, "ascii");

    const archive = path.join(stageRoot, "runtime.zip");
    await zipDirectory(payloadRoot, archive);

    const outputFile = path.resolve(options.out ?? path.join(HERE, "..", "dist", "ZCodeModelDiscoveryPatch-Setup.exe"));
    await mkdir(path.dirname(outputFile), { recursive: true });
    const sedPath = path.join(stageRoot, "installer.sed");
    await writeFile(sedPath, sedFor(stageRoot, path.join(stageRoot, "ZCodeModelDiscoveryPatch-Setup.exe")), "ascii");

    const iexpress = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "iexpress.exe");
    await execFileAsync(iexpress, ["/N", "/Q", sedPath], { cwd: stageRoot });
    const built = path.join(stageRoot, "ZCodeModelDiscoveryPatch-Setup.exe");
    const builtStat = await stat(built).catch(() => null);
    if (!builtStat?.isFile()) throw new Error("IExpress failed to create the installer");
    await copyFile(built, outputFile);

    succeeded = true;
    process.stdout.write(`${JSON.stringify({
      path: outputFile,
      sha256: await sha256File(outputFile),
      sizeBytes: builtStat.size,
      bundledNode: options.node,
    })}\n`);
  } finally {
    if (succeeded && !options.keepStage) await rm(stageRoot, { recursive: true, force: true });
    else process.stderr.write(`IExpress staging files preserved for diagnosis: ${stageRoot}\n`);
  }
}

async function copyTree(source, destination) {
  const { readdir, copyFile: copy, mkdir: makeDir } = await import("node:fs/promises");
  await makeDir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTree(path.join(source, entry.name), path.join(destination, entry.name));
    else await copy(path.join(source, entry.name), path.join(destination, entry.name));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
