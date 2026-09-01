# ZCode Model Discovery Auto-Repatch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, install, and verify a Windows user-level patcher that safely reapplies the ZCode model-discovery UI patch after official `app.asar` updates.

**Architecture:** Keep the patch logic outside ZCode under `zcode-patcher/`, with pure transformation/state helpers separated from the command-line installer. The patcher copies the official ASAR into a temporary workspace, validates unique bundle anchors, applies the renderer/main-process transforms, runs syntax and repack verification, then atomically replaces the installed ASAR only after all checks pass. A PowerShell installer copies the self-contained runtime to `%USERPROFILE%\.zcode-model-discovery-patch` (outside packaged-app `%LOCALAPPDATA%` virtualization) and registers one hidden scheduled task with a logon trigger only.

**Tech Stack:** Node.js 26, ECMAScript modules, Node test runner, PowerShell 5+/7, `@electron/asar` 4.3.0, Windows Task Scheduler.

**Spec:** `docs/superpowers/specs/2026-08-31-zcode-model-discovery-auto-repatch-design.md`

## Global Constraints

- Never overwrite the installed `app.asar` under the ZCode installation directory until extraction, anchor validation, JavaScript syntax checks, repacking, and second-read verification have all succeeded.
- Never send a provider API key or provider configuration to models.dev.
- Do not terminate ZCode; a locked target becomes `pending` and is retried on the next scheduled run.
- Require every renderer and main-process patch anchor to occur exactly once.
- Store one verified backup per official SHA-256 and support `--restore`.
- Treat a new incompatible ZCode bundle as a safe failure: leave the official ASAR unchanged and record `incompatible` for that official hash and patch version.
- Use `@electron/asar` exactly `4.3.0` so scheduled runs do not depend on npm or network access.

---

### Task 1: Create pure state and path safety helpers

**Files:**
- Create: `zcode-patcher/lib/state.mjs`
- Create: `zcode-patcher/test/state.test.mjs`
- Create: `zcode-patcher/package.json`

**Interfaces:**
- Produces: `sha256File(path): Promise<string>`, `readState(path): Promise<PatchState>`, `writeState(path, state): Promise<void>`, `assertChildPath(parent, candidate): string`, `shouldAttemptPatch(state, officialHash, patchVersion): boolean`.
- `PatchState` contains `patchVersion`, `officialHash`, `patchedHash`, `status`, `backupPath`, `pendingPackagePath`, `lastError`, and `updatedAt`.

- [ ] **Step 1: Write the failing state/path tests**

```js
test("rejects a candidate outside the patch root", () => {
  assert.throws(() => assertChildPath("C:\\safe", "C:\\outside\\app.asar"), /outside/i);
});

test("does not retry an incompatible official hash at the same patch version", () => {
  assert.equal(shouldAttemptPatch({
    status: "incompatible",
    officialHash: "abc",
    patchVersion: "1.0.0",
  }, "abc", "1.0.0"), false);
});

test("retries an incompatible official hash after the patch version changes", () => {
  assert.equal(shouldAttemptPatch({
    status: "incompatible",
    officialHash: "abc",
    patchVersion: "1.0.0",
  }, "abc", "1.1.0"), true);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node --test zcode-patcher/test/state.test.mjs`

Expected: FAIL because `zcode-patcher/lib/state.mjs` does not exist.

- [ ] **Step 3: Implement the minimal helpers**

Use `path.resolve` plus a trailing separator comparison in `assertChildPath`; write state through `state.json.tmp` followed by `rename`; calculate uppercase SHA-256 with `createReadStream` and `createHash("sha256")`; return an empty object for missing state and throw for malformed JSON.

- [ ] **Step 4: Run the state tests and verify GREEN**

Run: `node --test zcode-patcher/test/state.test.mjs`

Expected: PASS with no warnings.

- [ ] **Step 5: Commit the state helper deliverable**

```powershell
git add -- zcode-patcher/package.json zcode-patcher/lib/state.mjs zcode-patcher/test/state.test.mjs
git commit -m "feat: add safe zcode patch state helpers"
```

### Task 2: Extract a deterministic current-bundle transformer

**Files:**
- Create: `zcode-patcher/lib/transform.mjs`
- Create: `zcode-patcher/test/transform.test.mjs`
- Copy: `zcode-patcher/payload/model-discovery.js` from `model-discovery.js`
- Read fixture: `zcode-app-src/out/renderer/assets/styles-ubFRashM.js`
- Read fixture: `zcode-app-src/out/main/index.js`

**Interfaces:**
- Consumes: current official or patched renderer/main JavaScript strings and the versioned `model-discovery.js` payload.
- Produces: `findRendererBundle(extractedRoot): Promise<string>`, `transformRenderer(source): { source, changes }`, `transformMain(source): { source, changes }`, `assertExactlyOnce(source, anchor, label): void`, `verifyPatchedSources({ renderer, main, payload }): void`.

- [ ] **Step 1: Write failing transformer behavior tests**

```js
test("rejects missing or duplicate anchors without returning output", () => {
  assert.throws(() => assertExactlyOnce("", "anchor", "provider editor"), /provider editor.*0/i);
  assert.throws(() => assertExactlyOnce("anchor anchor", "anchor", "provider editor"), /provider editor.*2/i);
});

test("transforms the current extracted ZCode sources exactly once", async () => {
  const renderer = await readFile(rendererFixture, "utf8");
  const main = await readFile(mainFixture, "utf8");
  const rendererResult = transformRenderer(renderer);
  const mainResult = transformMain(main);

  assert.equal(rendererResult.changes.providerEditor, 1);
  assert.equal(rendererResult.changes.discoveryButton, 1);
  assert.equal(rendererResult.changes.discoveryImport, 1);
  assert.equal(mainResult.changes.discoveryCors, 1);
  verifyPatchedSources({ renderer: rendererResult.source, main: mainResult.source, payload });
});

test("is idempotent for an already patched bundle", async () => {
  const renderer = await readFile(rendererFixture, "utf8");
  const once = transformRenderer(renderer).source;
  assert.deepEqual(transformRenderer(once), { source: once, changes: { alreadyPatched: 1 } });
});
```

- [ ] **Step 2: Run the transformer tests and verify RED**

Run: `node --test zcode-patcher/test/transform.test.mjs`

Expected: FAIL because the transformer module does not exist.

- [ ] **Step 3: Implement renderer discovery and exact-anchor transforms**

Read `out/renderer/index.html`, resolve referenced JavaScript assets, and select the only asset containing the provider editor boundary `function l5(` followed by `function CNt()`. The transform must add the dynamic `./model-discovery.js` import, discovery state/callback, current provider `kinds`, current model list as `existingModels`, the button props, and the Chinese error text. It must not depend on ZCode's built-in model catalog because missing metadata is filled from models.dev by the payload. Detect `onDiscoverModels:me,discoveryPending:ye` as the idempotence marker.

- [ ] **Step 4: Implement the scoped main-process CORS transform**

Insert one `defaultSession.webRequest.onHeadersReceived` handler that adds `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Headers: Authorization, Content-Type` only when the request URL pathname ends with `/models` or equals `https://models.dev/models.json`. Detect the exact handler marker before applying the transform a second time.

- [ ] **Step 5: Run syntax checks and transformer tests**

Run:

```powershell
node --check zcode-patcher/lib/transform.mjs
node --check zcode-patcher/payload/model-discovery.js
node --test zcode-patcher/test/transform.test.mjs
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit the transformer deliverable**

```powershell
git add -- zcode-patcher/lib/transform.mjs zcode-patcher/payload/model-discovery.js zcode-patcher/test/transform.test.mjs
git commit -m "feat: add deterministic zcode bundle transforms"
```

### Task 3: Implement safe ASAR patching, backup, pending, and restore

**Files:**
- Create: `zcode-patcher/apply-patch.mjs`
- Create: `zcode-patcher/test/apply-patch.test.mjs`
- Modify: `zcode-patcher/package.json`
- Create: `zcode-patcher/patch-manifest.json`

**Interfaces:**
- Consumes: `@electron/asar` 4.3.0, state/path helpers, transforms, installed ASAR path, patch root.
- Produces: `runPatch(options): Promise<{ status, officialHash, patchedHash? }>`, `restorePatch(options): Promise<{ status, restoredHash }>`, CLI flags `--asar`, `--root`, `--restore`, and `--json`.

- [ ] **Step 1: Write failing integration tests against temporary ASAR fixtures**

```js
test("patches, verifies, backs up, and then skips the same installed package", async () => {
  const first = await runPatch(fixtureOptions);
  assert.equal(first.status, "patched");
  assert.equal(await sha256File(backupPath), first.officialHash);
  const second = await runPatch(fixtureOptions);
  assert.equal(second.status, "already-patched");
});

test("leaves the installed ASAR byte-identical when an anchor is incompatible", async () => {
  const before = await sha256File(installedAsar);
  const result = await runPatch(incompatibleFixtureOptions);
  assert.equal(result.status, "incompatible");
  assert.equal(await sha256File(installedAsar), before);
});

test("restores only the verified backup for the active official hash", async () => {
  await runPatch(fixtureOptions);
  const result = await restorePatch(fixtureOptions);
  assert.equal(result.status, "restored");
  assert.equal(await sha256File(installedAsar), result.restoredHash);
});
```

- [ ] **Step 2: Run the integration tests and verify RED**

Run: `node --test zcode-patcher/test/apply-patch.test.mjs`

Expected: FAIL because `runPatch` and `restorePatch` do not exist.

- [ ] **Step 3: Implement the temporary-workspace ASAR pipeline**

Use `mkdtemp(path.join(tmpdir(), "zcode-model-patch-"))`, `@electron/asar.extractAll`, the transformer module, `node --check` via `execFile(process.execPath, ["--check", file])`, `@electron/asar.createPackage`, and `@electron/asar.extractFile` for second-read verification. Remove only the explicitly created temporary directory in a `finally` block.

- [ ] **Step 4: Implement backup and installation state transitions**

Before replacement, copy the official package to `backups/<UPPERCASE_SHA256>.asar`, verify the copied hash, and never overwrite an existing backup whose hash differs. Write `status: "pending"` plus a fully validated pending package path when rename fails with `EPERM`, `EACCES`, or `EBUSY`. On other failures write `status: "incompatible"` with the failing stage and leave the installed ASAR unchanged.

- [ ] **Step 5: Implement verified restore**

Require `state.officialHash` and `state.backupPath`, verify both the backup hash and its parent path, copy to a same-directory temporary file, rename it over `app.asar`, and verify the installed hash before writing `status: "restored"`.

- [ ] **Step 6: Install the pinned ASAR dependency and run all patcher tests**

Run:

```powershell
npm install --prefix zcode-patcher --save-exact @electron/asar@4.3.0
node --test zcode-patcher/test/*.test.mjs
```

Expected: all patcher tests pass with no network access required after installation.

- [ ] **Step 7: Commit the patch engine deliverable**

```powershell
git add -- zcode-patcher/apply-patch.mjs zcode-patcher/lib zcode-patcher/test zcode-patcher/package.json zcode-patcher/package-lock.json zcode-patcher/patch-manifest.json
git commit -m "feat: add safe zcode asar repatcher"
```

### Task 4: Install the patcher and register the scheduled task

**Files:**
- Create: `zcode-patcher/install.ps1`
- Create: `zcode-patcher/uninstall.ps1`
- Create: `zcode-patcher/test/install-script.test.ps1`

**Interfaces:**
- Consumes: source `zcode-patcher` directory and installed ZCode ASAR path.
- Produces: `%USERPROFILE%\.zcode-model-discovery-patch`, scheduled task `ZCode Model Discovery Patch`, launcher `run-hidden.vbs`, and preserved backups/state/logs on uninstall.

- [ ] **Step 1: Write a failing isolated installer test**

The test sets a temporary `LOCALAPPDATA`, calls `install.ps1 -SkipScheduledTask -ZCodeAsar <fixture>`, and asserts the installed runtime contains `apply-patch.mjs`, `payload/model-discovery.js`, `node_modules/@electron/asar`, and a generated launcher whose command uses absolute paths and `wscript.exe` hidden execution.

- [ ] **Step 2: Run the installer test and verify RED**

Run: `pwsh -NoProfile -File zcode-patcher/test/install-script.test.ps1`

Expected: FAIL because `install.ps1` does not exist.

- [ ] **Step 3: Implement installation and task registration**

Copy source files without test fixtures into `%USERPROFILE%\.zcode-model-discovery-patch`, preserve existing `state.json`, `logs`, and `backups`, generate `run-hidden.vbs`, and register one user-level logon task. Run the patcher once immediately after installation.

- [ ] **Step 4: Implement non-destructive uninstall**

Delete only the scheduled task definitions and launcher/runtime files. Keep `state.json`, `logs`, and `backups`, and print the exact `node apply-patch.mjs --restore` command instead of silently restoring.

- [ ] **Step 5: Run installer tests and inspect task XML**

Run:

```powershell
pwsh -NoProfile -File zcode-patcher/test/install-script.test.ps1
pwsh -NoProfile -File zcode-patcher/install.ps1
schtasks.exe /Query /TN "ZCode Model Discovery Patch" /XML
```

Expected: installer test passes; task XML contains only a logon trigger and a hidden launcher; the immediate run reports `already-patched` or `patched`.

- [ ] **Step 6: Commit the deployment deliverable**

```powershell
git add -- zcode-patcher/install.ps1 zcode-patcher/uninstall.ps1 zcode-patcher/test/install-script.test.ps1
git commit -m "feat: install zcode auto-repatch task"
```

### Task 5: Prove update safety and end-to-end recovery

**Files:**
- Modify: `zcode-patcher/test/apply-patch.test.mjs`
- Modify: `zcode-tests/zcode-model-discovery-smoke.mjs`
- Write runtime artifacts only under: `%USERPROFILE%\.zcode-model-discovery-patch`

**Interfaces:**
- Consumes: current installed ZCode, current known-good official backup, installed patcher and scheduled task.
- Produces: verified patched ASAR, one official backup, `state.json`, patcher log, and a working model-discovery UI after restart.

- [ ] **Step 1: Run the complete regression suite**

Run:

```powershell
node --test zcode-tests/model-discovery.test.mjs zcode-tests/model-discovery-ui.test.mjs zcode-tests/model-discovery-cors.test.mjs
node --test zcode-patcher/test/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 2: Simulate a compatible official update in an isolated copy**

Copy the verified official ASAR backup to a temporary location, point `apply-patch.mjs --asar` at that copy, assert the first run reports `patched`, assert a second run reports `already-patched`, and compare the injected payload SHA-256 with the deployed payload.

- [ ] **Step 3: Simulate an incompatible official update**

Extract a temporary official copy, duplicate the provider-editor anchor, repack it, run the patcher, and assert the command exits non-zero, reports `incompatible`, and leaves the simulated installed ASAR SHA-256 unchanged.

- [ ] **Step 4: Verify the real installed package and scheduled task**

Run the installed patcher manually with `--json`, verify `state.json` contains the current official and patched hashes, verify the backup hash equals `officialHash`, and confirm Task Scheduler reports the task as ready with its next run time.

- [ ] **Step 5: Run the real ZCode CDP smoke test**

Start ZCode with remote debugging, open model settings, use the actual “拉取模型” button, confirm `/v1/models` returns HTTP 200, confirm the expected model count and metadata values, confirm no renderer error boundary appears, restart ZCode, and confirm the saved models remain present.

- [ ] **Step 6: Commit final verification adjustments**

```powershell
git add -- zcode-tests zcode-patcher
git commit -m "test: verify zcode update recovery"
```
