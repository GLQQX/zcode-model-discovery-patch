import assert from "node:assert/strict";
import test from "node:test";

import {
  findRendererBundle,
  transformMain,
  transformRenderer,
} from "../lib/transform.mjs";

const CURRENT_TXN_PREFIX = "function txn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0}){let{intl:f}=q(),{providerSettingsService:p}=Og(),";
const CURRENT_TXN_BUTTON = "(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,className:`rounded-lg`,\"data-testid\":Kee,onClick:E,children:[(0,$.jsx)(qc,{\"data-icon\":`inline-start`,\"aria-hidden\":`true`}),f.formatMessage({id:`settings.modelProvider.addModel`})]})";
const CURRENT_TXN_CALL = "settingsRevision:g??0},e.providerId)";
const CURRENT_RENDERER = [
  `${CURRENT_TXN_PREFIX}models=()=>[], state=1;`,
  `const button=${CURRENT_TXN_BUTTON};`,
  `const call=provider({${CURRENT_TXN_CALL};`,
].join("\n");
const CURRENT_MAIN = 'try{await mP(as,t??{},w)}catch(c){w.warn("[desktop-network] Chromium network policy bootstrap failed:",c)}await Oy(Ve)';

test("transforms the current provider editor and modern main-process anchor", () => {
  const renderer = transformRenderer(CURRENT_RENDERER);
  const main = transformMain(CURRENT_MAIN);

  assert.deepEqual(renderer.changes, {
    providerEditor: 1,
    discoveryButton: 1,
    discoveryImport: 1,
    currentProviderEditor: 1,
  });
  assert.match(renderer.source, /ZCODE_MODEL_DISCOVERY_CURRENT_V1/);
  assert.match(renderer.source, /zcodeDiscover/);
  assert.match(renderer.source, /`拉取模型`/);
  assert.match(renderer.source, /baseURL:E,apiKeyValue:O,apiFormat:w/);
  assert.deepEqual(main.changes, { discoveryCors: 1 });
  assert.match(main.source, /ZCODE_MODEL_DISCOVERY_CORS_V1/);
});

test("finds a current provider bundle after it has been patched", async t => {
  const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const root = await mkdtemp(path.join(tmpdir(), "zcode-current-patched-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const rendererRoot = path.join(root, "out", "renderer", "assets");
  await mkdir(rendererRoot, { recursive: true });
  const patched = transformRenderer(CURRENT_RENDERER).source;
  await writeFile(path.join(rendererRoot, "styles.js"), patched, "utf8");

  assert.equal(await findRendererBundle(root), path.join(rendererRoot, "styles.js"));
});

test("is idempotent for current provider editor sources", () => {
  const once = transformRenderer(CURRENT_RENDERER).source;

  assert.deepEqual(transformRenderer(once), {
    source: once,
    changes: { alreadyPatched: 1 },
  });
});
