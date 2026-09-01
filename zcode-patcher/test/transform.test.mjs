import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertExactlyOnce,
  findRendererBundle,
  transformMain,
  transformRenderer,
  verifyPatchedSources,
} from "../lib/transform.mjs";

const OFFICIAL_RENDERER = [
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

const PAYLOAD = "export async function discoverProviderModels(){return fetch(`https://models.dev/models.json`)}";

test("rejects missing or duplicate anchors without returning output", () => {
  assert.throws(() => assertExactlyOnce("", "anchor", "provider editor"), /provider editor.*0/i);
  assert.throws(() => assertExactlyOnce("anchor anchor", "anchor", "provider editor"), /provider editor.*2/i);
});

test("transforms the current official renderer and main sources exactly once", () => {
  const rendererResult = transformRenderer(OFFICIAL_RENDERER);
  const mainResult = transformMain(OFFICIAL_MAIN);

  assert.deepEqual(rendererResult.changes, {
    providerEditor: 1,
    discoveryButton: 1,
    discoveryImport: 1,
  });
  assert.deepEqual(mainResult.changes, { discoveryCors: 1 });
  assert.match(rendererResult.source, /existingModels:j/);
  assert.match(rendererResult.source, /onDiscoverModels:me,discoveryPending:ye/);
  assert.match(rendererResult.source, /拉取模型/);
  assert.match(mainResult.source, /ZCODE_MODEL_DISCOVERY_CORS_V1/);
  assert.match(mainResult.source, /models\.dev/);
  verifyPatchedSources({ renderer: rendererResult.source, main: mainResult.source, payload: PAYLOAD });
});

test("is idempotent for sources already patched by this patch version", () => {
  const rendererOnce = transformRenderer(OFFICIAL_RENDERER).source;
  const mainOnce = transformMain(OFFICIAL_MAIN).source;

  assert.deepEqual(transformRenderer(rendererOnce), {
    source: rendererOnce,
    changes: { alreadyPatched: 1 },
  });
  assert.deepEqual(transformMain(mainOnce), {
    source: mainOnce,
    changes: { alreadyPatched: 1 },
  });
});

test("finds the unique provider editor bundle referenced by index.html", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-renderer-find-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = path.join(root, "out", "renderer");
  const assetsRoot = path.join(rendererRoot, "assets");
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(path.join(rendererRoot, "index.html"), [
    '<script type="module" src="./assets/index.js"></script>',
    '<link rel="modulepreload" href="./assets/styles.js">',
  ].join("\n"), "utf8");
  await writeFile(path.join(assetsRoot, "index.js"), "export {};", "utf8");
  await writeFile(path.join(assetsRoot, "styles.js"), OFFICIAL_RENDERER, "utf8");

  assert.equal(
    await findRendererBundle(root),
    path.join(assetsRoot, "styles.js"),
  );
});

test("rejects ambiguous provider editor bundles", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "zcode-renderer-ambiguous-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = path.join(root, "out", "renderer");
  const assetsRoot = path.join(rendererRoot, "assets");
  await mkdir(assetsRoot, { recursive: true });
  await writeFile(path.join(rendererRoot, "index.html"), [
    '<script type="module" src="./assets/one.js"></script>',
    '<link rel="modulepreload" href="./assets/two.js">',
  ].join("\n"), "utf8");
  await writeFile(path.join(assetsRoot, "one.js"), OFFICIAL_RENDERER, "utf8");
  await writeFile(path.join(assetsRoot, "two.js"), OFFICIAL_RENDERER, "utf8");

  await assert.rejects(() => findRendererBundle(root), /expected exactly one provider editor bundle, found 2/i);
});
