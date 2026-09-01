const MODELS_DEV_URL = "https://models.dev/models.json";
const MODELS_DEV_TIMEOUT_MS = 5000;
const MANUAL_MODEL_FIELDS = [
  "name",
  "contextWindow",
  "maxOutputTokens",
  "modalities",
  "modalitiesConfigured",
  "reasoning",
  "supportsTools",
  "supportsStructuredOutput",
  "defaultKind",
];

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function firstPositive(...values) {
  for (const value of values) {
    const number = positiveInteger(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function valuesFor(payload) {
  if (Array.isArray(payload)) return payload;
  const object = asObject(payload);
  return [object.data, object.models, object.result].find(Array.isArray) ?? [];
}

function modelId(model) {
  const value = model.id ?? model.name ?? model.model;
  return typeof value === "string" ? value.trim() : "";
}

function firstArray(...values) {
  return values.find(Array.isArray);
}

function inputModalitiesFor(model) {
  const source = asObject(model);
  const architecture = asObject(source.architecture);
  const modalities = asObject(source.modalities);
  return firstArray(architecture.input_modalities, source.input_modalities, modalities.input);
}

function outputModalitiesFor(model) {
  const source = asObject(model);
  const architecture = asObject(source.architecture);
  const modalities = asObject(source.modalities);
  return firstArray(architecture.output_modalities, source.output_modalities, modalities.output);
}

function visionFlagFor(model) {
  const source = asObject(model);
  const architecture = asObject(source.architecture);
  for (const value of [source.vision, source.supports_vision, architecture.vision]) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function normalizeModality(value) {
  const modality = String(value).trim().toLowerCase();
  return modality === "vision" ? "image" : modality;
}

function normalizedModalityList(values, fallback) {
  const result = [];
  for (const value of Array.isArray(values) ? values : fallback) {
    const modality = normalizeModality(value);
    if (modality && !result.includes(modality)) result.push(modality);
  }
  return result;
}

function normalizedModalities(model, catalogModel) {
  const providerInput = inputModalitiesFor(model);
  const providerOutput = outputModalitiesFor(model);
  const providerVision = visionFlagFor(model);
  const catalogInput = inputModalitiesFor(catalogModel);
  const catalogOutput = outputModalitiesFor(catalogModel);
  const catalogVision = visionFlagFor(catalogModel);

  let rawInput;
  let configured = false;
  if (providerInput !== undefined) {
    rawInput = providerInput;
    configured = true;
  } else if (providerVision !== undefined) {
    rawInput = providerVision ? ["text", "image"] : ["text"];
    configured = true;
  } else if (catalogInput !== undefined) {
    rawInput = catalogInput;
    configured = true;
  } else if (catalogVision !== undefined) {
    rawInput = catalogVision ? ["text", "image"] : ["text"];
    configured = true;
  }

  const input = normalizedModalityList(["text", ...(rawInput ?? [])], ["text"]);
  const output = normalizedModalityList(providerOutput ?? catalogOutput, ["text"]);
  return {
    modalities: { input, output: output.length > 0 ? output : ["text"] },
    configured,
  };
}

function canonicalBasename(value) {
  const segments = String(value ?? "")
    .trim()
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  let basename = segments.at(-1) ?? "";
  while (/^(?:gcli|go)-/.test(basename)) basename = basename.replace(/^(?:gcli|go)-/, "");
  return basename;
}

function catalogEntries(payload) {
  return Object.entries(asObject(payload)).flatMap(([key, value]) => {
    const model = asObject(value);
    if (Object.keys(model).length === 0) return [];
    const id = modelId(model) || String(key).trim();
    if (!id) return [];
    return [{
      id,
      model,
      identities: [...new Set([String(key).trim(), id].filter(Boolean).map(item => item.toLowerCase()))],
      basename: canonicalBasename(id),
    }];
  });
}

function matchingCatalogModel(entries, id) {
  const normalizedId = String(id).trim().toLowerCase();
  const exact = entries.filter(entry => entry.identities.includes(normalizedId));
  if (exact.length === 1) return exact[0].model;
  if (exact.length > 1) return undefined;

  const basename = canonicalBasename(id);
  if (!basename) return undefined;
  const basenameMatches = entries.filter(entry => entry.basename === basename);
  return basenameMatches.length === 1 ? basenameMatches[0].model : undefined;
}

async function loadModelsDevCatalog(fetchImpl, url, timeoutMs) {
  try {
    const timeoutSignal = globalThis.AbortSignal?.timeout;
    const signal = typeof timeoutSignal === "function" ? timeoutSignal(timeoutMs) : undefined;
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      cache: "no-cache",
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response?.ok) return [];
    return catalogEntries(await response.json());
  } catch {
    return [];
  }
}

function preserveManualModel(discovered, existing) {
  if (asObject(existing).modified !== true) return discovered;
  const result = { ...discovered, modified: true };
  for (const field of MANUAL_MODEL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(existing, field)) result[field] = existing[field];
  }
  return result;
}

function normalizeModel(model, catalogModel, kinds) {
  const source = asObject(model);
  const id = modelId(source);
  if (!id) return null;
  const catalog = asObject(catalogModel);
  const limit = asObject(source.limit);
  const limits = asObject(source.limits);
  const topProvider = asObject(source.top_provider);
  const catalogLimit = asObject(catalog.limit);
  const catalogLimits = asObject(catalog.limits);
  const catalogTopProvider = asObject(catalog.top_provider);
  const contextWindow = firstPositive(
    source.context_length,
    source.contextWindow,
    source.context_window,
    limit.context,
    limits.context,
    catalog.context_length,
    catalog.contextWindow,
    catalog.context_window,
    catalogLimit.context,
    catalogLimits.context,
  );
  const maxOutputTokens = firstPositive(
    source.max_completion_tokens,
    source.max_output_tokens,
    source.maxOutputTokens,
    limit.output,
    limits.output,
    topProvider.max_completion_tokens,
    catalog.max_completion_tokens,
    catalog.max_output_tokens,
    catalog.maxOutputTokens,
    catalogLimit.output,
    catalogLimits.output,
    catalogTopProvider.max_completion_tokens,
  );
  const { modalities, configured } = normalizedModalities(source, catalog);
  const result = {
    id,
    ...(kinds.length === 0 ? {} : { kinds: [...kinds] }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    modalities,
    modalitiesConfigured: configured,
  };
  const displayName = [source.display_name, source.name]
    .find(value => typeof value === "string" && value.trim() && value.trim() !== id);
  if (displayName) result.name = displayName.trim();
  return result;
}

/**
 * Reads an OpenAI-compatible /models endpoint and fills missing public model
 * metadata from models.dev. Provider-supplied fields always win, and the
 * provider API key is never sent to the public metadata catalog.
 */
export async function discoverProviderModels({
  baseURL,
  apiKey = "",
  kinds = [],
  existingModels = [],
  metadataCatalogURL = MODELS_DEV_URL,
  metadataTimeoutMs = MODELS_DEV_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  const endpointBase = String(baseURL ?? "").trim().replace(/\/+$/, "");
  if (!endpointBase) throw new Error("A provider base URL is required to discover models");
  if (typeof fetchImpl !== "function") throw new Error("Model discovery is unavailable because fetch is not supported");

  const headers = { Accept: "application/json" };
  if (String(apiKey).trim()) headers.Authorization = `Bearer ${String(apiKey).trim()}`;
  const catalogPromise = loadModelsDevCatalog(fetchImpl, metadataCatalogURL, metadataTimeoutMs);
  const response = await fetchImpl(`${endpointBase}/models`, { headers });
  if (!response?.ok) throw new Error(`Model discovery request failed with status ${response?.status ?? "unknown"}`);

  const [payload, metadataEntries] = await Promise.all([response.json(), catalogPromise]);
  const normalizedKinds = [...new Set(
    (Array.isArray(kinds) ? kinds : [])
      .map(value => String(value).trim())
      .filter(Boolean),
  )];
  const existingById = new Map(
    (Array.isArray(existingModels) ? existingModels : [])
      .map(item => [modelId(asObject(item)).toLowerCase(), asObject(item)])
      .filter(([id]) => id),
  );
  const seen = new Set();
  return valuesFor(payload).flatMap(item => {
    const source = asObject(item);
    const id = modelId(source);
    const normalized = normalizeModel(source, matchingCatalogModel(metadataEntries, id), normalizedKinds);
    const normalizedId = normalized?.id.toLowerCase();
    if (!normalized || seen.has(normalizedId)) return [];
    seen.add(normalizedId);
    return [preserveManualModel(normalized, existingById.get(normalizedId))];
  });
}
