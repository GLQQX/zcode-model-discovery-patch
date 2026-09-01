import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const bundlePath = new URL("../zcode-app-src/out/renderer/assets/styles-ubFRashM.js", import.meta.url);

test("custom provider editor exposes model discovery and persists the discovered models", async () => {
  const bundle = await readFile(bundlePath, "utf8");
  const editorStart = bundle.indexOf("function l5(");
  const editorEnd = bundle.indexOf("function CNt()", editorStart);
  const providerEditor = bundle.slice(editorStart, editorEnd);

  assert.match(bundle, /onDiscoverModels:me,discoveryPending:ye/);
  assert.doesNotMatch(providerEditor, /modelProviderService:ge/);
  assert.match(bundle, /discoverProviderModels\(\{apiKey:D,baseURL:T,kinds:\[oa\(C\)\],existingModels:j\}\)/);
  assert.doesNotMatch(providerEditor, /getCatalogProviders\(ENt\)/);
  assert.match(providerEditor, /\[ye,T,D,C,j,e,i,B,z\]/);
  assert.match(bundle, /`拉取模型`/);
  assert.match(bundle, /onClick:G/);
});
