import { readFile } from "node:fs/promises";
import path from "node:path";

import { assertChildPath } from "./state.mjs";

const RENDERER_PATCH_MARKER = "onDiscoverModels:me,discoveryPending:ye";
const MAIN_PATCH_MARKER = "ZCODE_MODEL_DISCOVERY_CORS_V1";

const HNT_SIGNATURE = "function hNt({models:e,apiKeyValue:t,currentApiFormat:n,apiFormatOptions:r,onTestModel:i,onModelCommit:a,onDeleteModel:o,onAddModel:s,readOnly:c})";
const HNT_SIGNATURE_PATCHED = "function hNt({models:e,apiKeyValue:t,currentApiFormat:n,apiFormatOptions:r,onTestModel:i,onModelCommit:a,onDeleteModel:o,onAddModel:s,readOnly:c,onDiscoverModels:G,discoveryPending:V,discoveryDisabled:ee,discoveryError:te})";

const HNT_FOOTER = "c?null:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(JMt,{mode:`add`,open:h,draft:_,draftErrorMessage:k,onOpenChange:D,onDraftChange:T,onCommit:O,maxOutputTokensLookupPending:x}),(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`lg`,\"data-testid\":mie,className:`mt-1`,onClick:w,children:[(0,$.jsx)(Fc,{className:`mr-1 size-3.5`}),l.formatMessage({id:`settings.modelProvider.addModel`})]})]})";
const HNT_FOOTER_PATCHED = "c?null:(0,$.jsxs)($.Fragment,{children:[(0,$.jsx)(JMt,{mode:`add`,open:h,draft:_,draftErrorMessage:k,onOpenChange:D,onDraftChange:T,onCommit:O,maxOutputTokensLookupPending:x}),(0,$.jsxs)(`div`,{className:`mt-1 flex flex-wrap gap-2`,children:[G?(0,$.jsx)(X,{type:`button`,variant:`secondary`,size:`lg`,onClick:G,disabled:V||ee,children:V?`拉取中...`:`拉取模型`}):null,(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`lg`,\"data-testid\":mie,onClick:w,children:[(0,$.jsx)(Fc,{className:`mr-1 size-3.5`}),l.formatMessage({id:`settings.modelProvider.addModel`})]})]}),te?(0,$.jsx)(`p`,{className:`mt-1 text-ui-base text-destructive`,children:te}):null]})";

const L5_STATE = "[j,M]=(0,Q.useState)(()=>xNt(e)),N=(0,Q.useRef)(null)";
const L5_STATE_PATCHED = "[j,M]=(0,Q.useState)(()=>xNt(e)),[ye,be]=(0,Q.useState)(!1),[xe,Se]=(0,Q.useState)(null),N=(0,Q.useRef)(null)";

const L5_DISCOVERY_INSERT = "de=(0,Q.useCallback)(e=>{le([...j,{...e,modified:!0}])},[j,le]),fe=(0,Q.useCallback)";
const L5_DISCOVERY_INSERT_PATCHED = "de=(0,Q.useCallback)(e=>{le([...j,{...e,modified:!0}])},[j,le]),me=(0,Q.useCallback)(async()=>{if(ye||!T.trim())return;be(!0),Se(null);try{let t=await import(`./model-discovery.js`),r=await t.discoverProviderModels({apiKey:D,baseURL:T,kinds:[oa(C)],existingModels:j});if(r.length===0)throw Error(`The provider did not return any models`);let a=p5(r),o=n5({provider:e,draft:R.current,readOnlyEndpoints:i,now:Date.now()});M(a),B(z({...o,apiKey:D,apiKeyRequired:D.trim().length>0,models:a}))}catch(t){J.error(`[ModelProviderSection] 拉取模型失败`,t),Se(`拉取模型失败，请检查 Base URL、API Key 和接口兼容性`)}finally{be(!1)}},[ye,T,D,C,j,e,i,B,z]),fe=(0,Q.useCallback)";

const HNT_CALL = "(0,$.jsx)(hNt,{models:j,apiKeyValue:D,currentApiFormat:C,apiFormatOptions:iNt(e),onTestModel:r?se:void 0,onModelCommit:ue,onDeleteModel:W,onAddModel:de,readOnly:g})";
const HNT_CALL_PATCHED = "(0,$.jsx)(hNt,{models:j,apiKeyValue:D,currentApiFormat:C,apiFormatOptions:iNt(e),onTestModel:r?se:void 0,onModelCommit:ue,onDeleteModel:W,onAddModel:de,readOnly:g,onDiscoverModels:me,discoveryPending:ye,discoveryDisabled:!T.trim(),discoveryError:xe})";

const MAIN_ANCHOR = "}catch(c){k.warn(\"[desktop-network] Chromium network policy bootstrap failed:\",c)}await wG(on),XCe()";
const MAIN_PATCHED = "}catch(c){k.warn(\"[desktop-network] Chromium network policy bootstrap failed:\",c)}/*ZCODE_MODEL_DISCOVERY_CORS_V1*/qD.defaultSession.webRequest.onHeadersReceived((e,t)=>{let r;try{r=new URL(e.url)}catch{return t({})}let o=r.protocol===`http:`||r.protocol===`https:`,s=/\\/models\\/?$/u.test(r.pathname)||r.hostname===`models.dev`&&r.pathname===`/models.json`;if(!o||!s)return t({});let a=e.responseHeaders??{};t({responseHeaders:{...a,\"Access-Control-Allow-Origin\":[`*`],\"Access-Control-Allow-Headers\":[`Authorization, Content-Type, X-API-Key, X-Requested-With, Accept, Origin`],\"Access-Control-Allow-Methods\":[`GET, OPTIONS`]}})}),await wG(on),XCe()";

function occurrenceCount(source, anchor) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = source.indexOf(anchor, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + anchor.length;
  }
}

export function assertExactlyOnce(source, anchor, label) {
  const count = occurrenceCount(source, anchor);
  if (count !== 1) throw new Error(`${label} expected exactly once, found ${count}`);
}

function replaceExactlyOnce(source, before, after, label) {
  assertExactlyOnce(source, before, label);
  return source.replace(before, after);
}

export async function findRendererBundle(extractedRoot) {
  const rendererRoot = path.join(extractedRoot, "out", "renderer");
  const indexPath = path.join(rendererRoot, "index.html");
  const html = await readFile(indexPath, "utf8");
  const assets = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/gu)]
    .map(match => match[1]);
  const candidates = [];
  for (const asset of [...new Set(assets)]) {
    const candidate = assertChildPath(rendererRoot, path.join(rendererRoot, asset));
    const source = await readFile(candidate, "utf8");
    if (source.includes("function l5(") && source.includes("function CNt()")) candidates.push(candidate);
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one provider editor bundle, found ${candidates.length}`);
  }
  return candidates[0];
}

export function transformRenderer(source) {
  if (source.includes(RENDERER_PATCH_MARKER)) {
    verifyPatchedRenderer(source);
    return { source, changes: { alreadyPatched: 1 } };
  }
  assertExactlyOnce(source, "function l5(", "provider editor start");
  assertExactlyOnce(source, "function CNt()", "provider editor end");
  let transformed = source;
  transformed = replaceExactlyOnce(transformed, HNT_SIGNATURE, HNT_SIGNATURE_PATCHED, "model list signature");
  transformed = replaceExactlyOnce(transformed, HNT_FOOTER, HNT_FOOTER_PATCHED, "model discovery button");
  transformed = replaceExactlyOnce(transformed, L5_STATE, L5_STATE_PATCHED, "model discovery state");
  transformed = replaceExactlyOnce(transformed, L5_DISCOVERY_INSERT, L5_DISCOVERY_INSERT_PATCHED, "model discovery import");
  transformed = replaceExactlyOnce(transformed, HNT_CALL, HNT_CALL_PATCHED, "model discovery props");
  verifyPatchedRenderer(transformed);
  return {
    source: transformed,
    changes: { providerEditor: 1, discoveryButton: 1, discoveryImport: 1 },
  };
}

export function transformMain(source) {
  if (source.includes(MAIN_PATCH_MARKER)) {
    verifyPatchedMain(source);
    return { source, changes: { alreadyPatched: 1 } };
  }
  const transformed = replaceExactlyOnce(source, MAIN_ANCHOR, MAIN_PATCHED, "model discovery CORS anchor");
  verifyPatchedMain(transformed);
  return { source: transformed, changes: { discoveryCors: 1 } };
}

function verifyPatchedRenderer(renderer) {
  for (const marker of [
    RENDERER_PATCH_MARKER,
    "import(`./model-discovery.js`)",
    "existingModels:j",
    "discoveryDisabled:!T.trim()",
    "`拉取模型`",
  ]) {
    if (!renderer.includes(marker)) throw new Error(`Patched renderer is missing marker: ${marker}`);
  }
}

function verifyPatchedMain(main) {
  for (const marker of [MAIN_PATCH_MARKER, "Access-Control-Allow-Origin", "models.dev", "/models"] ) {
    if (!main.includes(marker)) throw new Error(`Patched main process is missing marker: ${marker}`);
  }
}

export function verifyPatchedSources({ renderer, main, payload }) {
  verifyPatchedRenderer(renderer);
  verifyPatchedMain(main);
  if (!payload.includes("https://models.dev/models.json")) {
    throw new Error("Model discovery payload is missing the models.dev catalog URL");
  }
  if (payload.includes("VISION_MODEL_ID")) {
    throw new Error("Model discovery payload still contains name-based vision guessing");
  }
}
