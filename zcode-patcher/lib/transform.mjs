import { readdir, readFile } from "node:fs/promises";
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

const MODERN_RENDERER_PATCH_MARKER = "ZCODE_MODEL_DISCOVERY_MODERN_V1";
const CURRENT_RENDERER_PATCH_MARKER = "ZCODE_MODEL_DISCOVERY_CURRENT_V1";
const MODERN_MBN_SIGNATURE = "function mbn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0})";
const CURRENT_TXN_SIGNATURE = "function txn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0})";
const CURRENT_TXN_SIGNATURE_PATCHED = "function txn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0,baseURL:zcodeBaseURL,apiKeyValue:zcodeApiKey,apiFormat:zcodeApiFormat})";
const CURRENT_TXN_PREFIX = "function txn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0}){let{intl:f}=q(),{providerSettingsService:p}=Og(),";
const CURRENT_TXN_PREFIX_PATCHED = '/*ZCODE_MODEL_DISCOVERY_CURRENT_V1*/function txn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0,baseURL:zcodeBaseURL,apiKeyValue:zcodeApiKey,apiFormat:zcodeApiFormat}){let{intl:f}=q(),{providerSettingsService:p}=Og(),[zcodeDiscoveryPending,zcodeSetDiscoveryPending]=(0,Q.useState)(!1),[zcodeDiscoveryError,zcodeSetDiscoveryError]=(0,Q.useState)(null),zcodeDiscoveryDisabled=!String(zcodeBaseURL??``).trim()||typeof l!==`function`,zcodeDiscover=(0,Q.useCallback)(async()=>{if(zcodeDiscoveryPending||zcodeDiscoveryDisabled)return;zcodeSetDiscoveryPending(!0),zcodeSetDiscoveryError(null);try{const zcodeModule=await import(`./model-discovery.js`),zcodeDiscovered=await zcodeModule.discoverProviderModels({apiKey:zcodeApiKey,baseURL:zcodeBaseURL,apiFormat:zcodeApiFormat,existingModels:i}),zcodeExisting=new Set(i.map(zcodeModel=>String(zcodeModel.modelId??``).trim().toLowerCase()).filter(Boolean)),zcodeNewModels=zcodeDiscovered.filter(zcodeModel=>{const zcodeId=String(zcodeModel.id??``).trim();return zcodeId&&!zcodeExisting.has(zcodeId.toLowerCase())});if(zcodeNewModels.length===0)throw Error(`The provider did not return any new models`);for(const zcodeModel of zcodeNewModels){const zcodeInput=Array.isArray(zcodeModel.modalities?.input)?zcodeModel.modalities.input:[],zcodePersonalConfig={properties:{...(zcodeModel.contextWindow===void 0?{}:{contextWindow:zcodeModel.contextWindow}),...(zcodeModel.modalitiesConfigured?{inputFormat:{supportsText:!0,supportsImage:zcodeInput.includes(`image`),supportsVideo:zcodeInput.includes(`video`),supportsPdf:zcodeInput.includes(`pdf`)}}:{})},optionSpecs:zcodeModel.maxOutputTokens===void 0?{}:{maxOutputTokens:{max:zcodeModel.maxOutputTokens}}};await l({modelId:String(zcodeModel.id).trim(),personalConfig:zcodePersonalConfig,useRecommendedConfig:!0})}}catch(zcodeError){J.error(`[ModelProviderSection] 拉取模型失败`,zcodeError),zcodeSetDiscoveryError(`拉取模型失败，请检查 Base URL、API Key 和接口兼容性`)}finally{zcodeSetDiscoveryPending(!1)}},[zcodeDiscoveryPending,zcodeDiscoveryDisabled,zcodeBaseURL,zcodeApiKey,zcodeApiFormat,i,l]);let '
const CURRENT_TXN_BUTTON = "(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,className:`rounded-lg`,\"data-testid\":Kee,onClick:E,children:[(0,$.jsx)(qc,{\"data-icon\":`inline-start`,\"aria-hidden\":`true`}),f.formatMessage({id:`settings.modelProvider.addModel`})]})";
const CURRENT_TXN_BUTTON_PATCHED = "(0,$.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2`,children:[(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,onClick:zcodeDiscover,disabled:zcodeDiscoveryPending||zcodeDiscoveryDisabled,children:[zcodeDiscoveryPending?`拉取中...`:`拉取模型`]}),(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,className:`rounded-lg`,\"data-testid\":Kee,onClick:E,children:[(0,$.jsx)(qc,{\"data-icon\":`inline-start`,\"aria-hidden\":`true`}),f.formatMessage({id:`settings.modelProvider.addModel`})]}),zcodeDiscoveryError?(0,$.jsx)(`span`,{className:`basis-full text-ui-base text-destructive`,children:zcodeDiscoveryError}):null]})";
const CURRENT_TXN_CALL = "settingsRevision:g??0},e.providerId)";
const CURRENT_TXN_CALL_PATCHED = "settingsRevision:g??0,baseURL:E,apiKeyValue:O,apiFormat:w},e.providerId)";
const MODERN_MBN_SIGNATURE_PATCHED = "function mbn({providerId:e,providerName:t,providerEnabled:n=!0,providerAccess:r,models:i,onTestModel:a,onModelCommit:o,onModelEnabledChange:s,onDeleteModel:c,onAddModel:l,onReorderModelIds:u,settingsRevision:d=0,baseURL:zcodeBaseURL,apiKeyValue:zcodeApiKey,apiFormat:zcodeApiFormat})";
const MODERN_MBN_BUTTON = "(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,className:`rounded-lg`,\"data-testid\":Kee,onClick:E,children:[(0,$.jsx)(qc,{\"data-icon\":`inline-start`,\"aria-hidden\":`true`}),f.formatMessage({id:`settings.modelProvider.addModel`})]})";
const MODERN_MBN_BUTTON_PATCHED = "(0,$.jsxs)(`div`,{className:`flex flex-wrap items-end gap-2`,children:[(0,$.jsx)(X,{type:`button`,variant:`secondary`,size:`default`,onClick:zcodeDiscover,disabled:zcodeDiscoveryPending||zcodeDiscoveryDisabled,children:zcodeDiscoveryPending?`拉取中...`:`拉取模型`}),(0,$.jsxs)(X,{type:`button`,variant:`secondary`,size:`default`,className:`rounded-lg`,\"data-testid\":Kee,onClick:E,children:[(0,$.jsx)(qc,{\"data-icon\":`inline-start`,\"aria-hidden\":`true`}),f.formatMessage({id:`settings.modelProvider.addModel`})]}),zcodeDiscoveryError?(0,$.jsx)(`span`,{className:`basis-full text-ui-base text-destructive`,children:zcodeDiscoveryError}):null]})";
const MODERN_MBN_DISCOVERY_INSERT = "M=S?f.formatMessage({id:`settings.modelProvider.modelMetadata.invalid.${S}`}):null;return(0,$.jsxs)(`div`,{children:[";
const MODERN_MBN_DISCOVERY_INSERT_PATCHED = "M=S?f.formatMessage({id:`settings.modelProvider.modelMetadata.invalid.${S}`}):null;let [zcodeDiscoveryPending,zcodeSetDiscoveryPending]=(0,Q.useState)(!1),[zcodeDiscoveryError,zcodeSetDiscoveryError]=(0,Q.useState)(null),zcodeDiscoveryDisabled=!String(zcodeBaseURL??``).trim()||typeof l!==`function`,zcodeDiscover=(0,Q.useCallback)(async()=>{if(zcodeDiscoveryPending||zcodeDiscoveryDisabled)return;zcodeSetDiscoveryPending(!0),zcodeSetDiscoveryError(null);try{let t=await import(`./model-discovery.js`),r=await t.discoverProviderModels({apiKey:zcodeApiKey,baseURL:zcodeBaseURL,apiFormat:zcodeApiFormat,existingModels:i}),o=new Set(i.map(e=>String(e.modelId??``).trim().toLowerCase()).filter(Boolean)),s=r.filter(e=>{let t=String(e.id??``).trim();return t&&!o.has(t.toLowerCase())});if(s.length===0)throw Error(`The provider did not return any new models`);for(let e of s){let t=Array.isArray(e.modalities?.input)?e.modalities.input:[],r={properties:{...(e.contextWindow===void 0?{}:{contextWindow:e.contextWindow}),...(e.modalitiesConfigured?{inputFormat:{supportsImage:t.includes(`image`),supportsVideo:t.includes(`video`),supportsPdf:t.includes(`pdf`)}}:{})},optionSpecs:e.maxOutputTokens===void 0?{}:{maxOutputTokens:{max:e.maxOutputTokens}}};await l({modelId:String(e.id).trim(),personalConfig:r,useRecommendedConfig:!0})}}catch(t){J.error(`[ModelProviderSection] 拉取模型失败`,t),zcodeSetDiscoveryError(`拉取模型失败，请检查 Base URL、API Key 和接口兼容性`)}finally{zcodeSetDiscoveryPending(!1)}},[zcodeDiscoveryPending,zcodeDiscoveryDisabled,zcodeBaseURL,zcodeApiKey,zcodeApiFormat,i,l]);return(0,$.jsxs)(`div`,{children:[";
const MODERN_MBN_CALL = "settingsRevision:g??0},e.providerId)";
const MODERN_MBN_CALL_PATCHED = "settingsRevision:g??0,baseURL:E,apiKeyValue:O,apiFormat:w},e.providerId)";
const MODERN_MAIN_ANCHOR = "try{await mP(as,t??{},w)}catch(c){w.warn(\"[desktop-network] Chromium network policy bootstrap failed:\",c)}await Oy(Ve)";
const MODERN_MAIN_PATCHED = "try{await mP(as,t??{},w)}catch(c){w.warn(\"[desktop-network] Chromium network policy bootstrap failed:\",c)}/*ZCODE_MODEL_DISCOVERY_CORS_V1*/as.defaultSession.webRequest.onHeadersReceived((e,t)=>{let r;try{r=new URL(e.url)}catch{return t({})}let o=r.protocol===`http:`||r.protocol===`https:`,s=/\\/models\\/?$/u.test(r.pathname)||r.hostname===`models.dev`&&r.pathname===`/models.json`;if(!o||!s)return t({});let a=e.responseHeaders??{};t({responseHeaders:{...a,\"Access-Control-Allow-Origin\":[`*`],\"Access-Control-Allow-Headers\":[`Authorization, Content-Type, X-API-Key, X-Requested-With, Accept, Origin`],\"Access-Control-Allow-Methods\":[`GET, OPTIONS`]}})}),await Oy(Ve)";

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

async function listJavaScriptFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await listJavaScriptFiles(candidate));
    else if (entry.isFile() && candidate.endsWith(".js")) files.push(candidate);
  }
  return files;
}

export async function findRendererBundle(extractedRoot) {
  const rendererRoot = path.join(extractedRoot, "out", "renderer");
  const candidates = [];
  for (const candidate of await listJavaScriptFiles(rendererRoot)) {
    const source = await readFile(candidate, "utf8");
    const legacy = source.includes("function l5(") && source.includes("function CNt()")
      || source.includes(RENDERER_PATCH_MARKER);
    const modern = source.includes(MODERN_MBN_SIGNATURE) || source.includes(MODERN_RENDERER_PATCH_MARKER);
    const current = source.includes(CURRENT_TXN_SIGNATURE) || source.includes(CURRENT_RENDERER_PATCH_MARKER);
    if (legacy || modern || current) candidates.push(candidate);
  }
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one provider editor bundle, found ${candidates.length}`);
  }
  return candidates[0];
}

export function transformRenderer(source) {
  if (source.includes(RENDERER_PATCH_MARKER) || source.includes(MODERN_RENDERER_PATCH_MARKER) || source.includes(CURRENT_RENDERER_PATCH_MARKER)) {
    verifyPatchedRenderer(source);
    return { source, changes: { alreadyPatched: 1 } };
  }
  if (source.includes(CURRENT_TXN_SIGNATURE)) {
    return transformCurrentRenderer(source);
  }
  if (source.includes(MODERN_MBN_SIGNATURE)) {
    return transformModernRenderer(source);
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

function transformCurrentRenderer(source) {
  let transformed = source;
  transformed = replaceExactlyOnce(transformed, CURRENT_TXN_PREFIX, CURRENT_TXN_PREFIX_PATCHED, "current model discovery state");
  transformed = replaceExactlyOnce(transformed, CURRENT_TXN_BUTTON, CURRENT_TXN_BUTTON_PATCHED, "current model discovery button");
  transformed = replaceExactlyOnce(transformed, CURRENT_TXN_CALL, CURRENT_TXN_CALL_PATCHED, "current model discovery provider props");
  verifyPatchedRenderer(transformed);
  return {
    source: transformed,
    changes: { providerEditor: 1, discoveryButton: 1, discoveryImport: 1, currentProviderEditor: 1 },
  };
}

function transformModernRenderer(source) {
  let transformed = source;
  transformed = replaceExactlyOnce(transformed, MODERN_MBN_SIGNATURE, MODERN_MBN_SIGNATURE_PATCHED, "modern model list signature");
  transformed = replaceExactlyOnce(transformed, MODERN_MBN_DISCOVERY_INSERT, MODERN_MBN_DISCOVERY_INSERT_PATCHED, "modern model discovery state");
  transformed = replaceExactlyOnce(transformed, MODERN_MBN_BUTTON, MODERN_MBN_BUTTON_PATCHED, "modern model discovery button");
  transformed = replaceExactlyOnce(transformed, MODERN_MBN_CALL, MODERN_MBN_CALL_PATCHED, "modern model discovery props");
  transformed = transformed.replace("function mbn(", `/*${MODERN_RENDERER_PATCH_MARKER}*/function mbn(`);
  verifyPatchedRenderer(transformed);
  return {
    source: transformed,
    changes: { providerEditor: 1, discoveryButton: 1, discoveryImport: 1, modernProviderEditor: 1 },
  };
}

export function transformMain(source) {
  if (source.includes(MAIN_PATCH_MARKER)) {
    verifyPatchedMain(source);
    return { source, changes: { alreadyPatched: 1 } };
  }
  let transformed;
  if (occurrenceCount(source, MAIN_ANCHOR) === 1) {
    transformed = replaceExactlyOnce(source, MAIN_ANCHOR, MAIN_PATCHED, "model discovery CORS anchor");
  } else if (occurrenceCount(source, MODERN_MAIN_ANCHOR) === 1) {
    transformed = replaceExactlyOnce(source, MODERN_MAIN_ANCHOR, MODERN_MAIN_PATCHED, "modern model discovery CORS anchor");
  } else {
    throw new Error("model discovery CORS anchor expected exactly once in legacy or modern main bundle");
  }
  verifyPatchedMain(transformed);
  return { source: transformed, changes: { discoveryCors: 1 } };
}

function verifyPatchedRenderer(renderer) {
  if (renderer.includes(CURRENT_RENDERER_PATCH_MARKER)) {
    for (const marker of [
      CURRENT_RENDERER_PATCH_MARKER,
      "import(`./model-discovery.js`)",
      "zcodeDiscover",
      "personalConfig",
      "`拉取模型`",
    ]) {
      if (!renderer.includes(marker)) throw new Error(`Patched current renderer is missing marker: ${marker}`);
    }
    return;
  }
  if (renderer.includes(MODERN_RENDERER_PATCH_MARKER)) {
    for (const marker of [
      MODERN_RENDERER_PATCH_MARKER,
      "import(`./model-discovery.js`)",
      "zcodeDiscover",
      "personalConfig",
      "`拉取模型`",
    ]) {
      if (!renderer.includes(marker)) throw new Error(`Patched modern renderer is missing marker: ${marker}`);
    }
    return;
  }
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
