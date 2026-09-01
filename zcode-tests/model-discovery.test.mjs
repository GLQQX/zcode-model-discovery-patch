import assert from "node:assert/strict";
import test from "node:test";

import { discoverProviderModels } from "../zcode-patcher/payload/model-discovery.js";

test("normalizes OpenRouter model metadata including context and image input", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://openrouter.example/v1/",
    apiKey: "secret",
    fetchImpl: async () => new Response(JSON.stringify({
      data: [{
        id: "openai/gpt-4o",
        context_length: 128000,
        top_provider: { max_completion_tokens: 16384 },
        architecture: { input_modalities: ["text", "image"] },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });

  assert.deepEqual(models, [{
    id: "openai/gpt-4o",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    modalities: { input: ["text", "image"], output: ["text"] },
    modalitiesConfigured: true,
  }]);
});

test("enriches an ID-only aliased model from a unique models.dev basename match", async () => {
  const requests = [];
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    apiKey: "provider-secret",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (url === "https://provider.example/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "gcli-gemini-3.1-pro-preview" }] }), { status: 200 });
      }
      if (url === "https://models.dev/models.json") {
        return new Response(JSON.stringify({
          "google/gemini-3.1-pro-preview": {
            id: "google/gemini-3.1-pro-preview",
            limit: { context: 1048576, output: 65536 },
            modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
          },
        }), { status: 200 });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  assert.deepEqual(models, [{
    id: "gcli-gemini-3.1-pro-preview",
    contextWindow: 1048576,
    maxOutputTokens: 65536,
    modalities: { input: ["text", "image", "video", "audio", "pdf"], output: ["text"] },
    modalitiesConfigured: true,
  }]);
  assert.equal(requests.length, 2);
  const metadataRequest = requests.find(request => request.url === "https://models.dev/models.json");
  assert.equal(metadataRequest.url, "https://models.dev/models.json");
  assert.equal(metadataRequest.init.headers.Authorization, undefined);
});

test("does not guess image capability from the model ID when metadata is unavailable", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    fetchImpl: async url => url === "https://provider.example/v1/models"
      ? new Response(JSON.stringify({ data: [{ id: "qwen2.5-vl-72b-instruct" }] }), { status: 200 })
      : new Response("unavailable", { status: 503 }),
  });

  assert.deepEqual(models[0].modalities, { input: ["text"], output: ["text"] });
  assert.equal(models[0].modalitiesConfigured, false);
});

test("provider metadata wins over models.dev while missing fields are filled", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    fetchImpl: async url => url === "https://provider.example/v1/models"
      ? new Response(JSON.stringify({ data: [{
        id: "openai/gpt-5.6-terra",
        context_length: 900000,
        architecture: { input_modalities: ["text"] },
      }] }), { status: 200 })
      : new Response(JSON.stringify({
        "openai/gpt-5.6-terra": {
          id: "openai/gpt-5.6-terra",
          limit: { context: 1050000, output: 128000 },
          modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        },
      }), { status: 200 }),
  });

  assert.equal(models[0].contextWindow, 900000);
  assert.equal(models[0].maxOutputTokens, 128000);
  assert.deepEqual(models[0].modalities, { input: ["text"], output: ["text"] });
  assert.equal(models[0].modalitiesConfigured, true);
});

test("does not apply an ambiguous normalized basename match", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    fetchImpl: async url => url === "https://provider.example/v1/models"
      ? new Response(JSON.stringify({ data: [{ id: "shared-model" }] }), { status: 200 })
      : new Response(JSON.stringify({
        "vendor-a/shared-model": {
          id: "vendor-a/shared-model",
          limit: { context: 111111 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
        "vendor-b/shared-model": {
          id: "vendor-b/shared-model",
          limit: { context: 222222 },
          modalities: { input: ["text", "video"], output: ["text"] },
        },
      }), { status: 200 }),
  });

  assert.equal(models[0].contextWindow, undefined);
  assert.deepEqual(models[0].modalities, { input: ["text"], output: ["text"] });
  assert.equal(models[0].modalitiesConfigured, false);
});

test("preserves metadata on models the user modified manually", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    existingModels: [{
      id: "grok-4.6",
      modified: true,
      contextWindow: 123456,
      maxOutputTokens: 65432,
      modalities: { input: ["text"], output: ["text"] },
      modalitiesConfigured: true,
    }],
    fetchImpl: async url => url === "https://provider.example/v1/models"
      ? new Response(JSON.stringify({ data: [{ id: "grok-4.6" }] }), { status: 200 })
      : new Response(JSON.stringify({
        "xai/grok-4.6": {
          id: "xai/grok-4.6",
          limit: { context: 500000, output: 500000 },
          modalities: { input: ["text", "image"], output: ["text"] },
        },
      }), { status: 200 }),
  });

  assert.equal(models[0].contextWindow, 123456);
  assert.equal(models[0].maxOutputTokens, 65432);
  assert.deepEqual(models[0].modalities, { input: ["text"], output: ["text"] });
  assert.equal(models[0].modified, true);
});

test("keeps provider discovery usable when models.dev is unavailable", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    fetchImpl: async url => url === "https://provider.example/v1/models"
      ? new Response(JSON.stringify({ data: [{ id: "unknown-model" }] }), { status: 200 })
      : new Response("unavailable", { status: 503 }),
  });

  assert.deepEqual(models, [{
    id: "unknown-model",
    modalities: { input: ["text"], output: ["text"] },
    modalitiesConfigured: false,
  }]);
});

test("attaches the current provider kind for immediate ZCode rendering", async () => {
  const models = await discoverProviderModels({
    baseURL: "https://provider.example/v1",
    kinds: ["openai"],
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-5" }] }), { status: 200 }),
  });

  assert.deepEqual(models[0].kinds, ["openai"]);
});

test("requests the normalized models endpoint with bearer authentication", async () => {
  const requests = [];
  await discoverProviderModels({
    baseURL: "https://provider.example/v1///",
    apiKey: "abc123",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });

  const providerRequest = requests.find(request => request.url === "https://provider.example/v1/models");
  assert.equal(providerRequest.url, "https://provider.example/v1/models");
  assert.equal(providerRequest.init.headers.Authorization, "Bearer abc123");
});

test("propagates models endpoint failures so callers can use manual fallback", async () => {
  await assert.rejects(
    discoverProviderModels({
      baseURL: "https://provider.example/v1",
      fetchImpl: async () => new Response("unavailable", { status: 503 }),
    }),
    /503/,
  );
});
