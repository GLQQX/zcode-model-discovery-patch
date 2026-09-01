import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const mainPath = new URL("../zcode-app-src/out/main/index.js", import.meta.url);

test("main process enables CORS only for model discovery requests", async () => {
  const main = await readFile(mainPath, "utf8");
  const handlerStart = main.indexOf("defaultSession.webRequest.onHeadersReceived");

  assert.notEqual(handlerStart, -1, "expected a main-process response-header handler");

  const handler = main.slice(handlerStart, handlerStart + 1600);
  assert.match(handler, /\/models/);
  assert.match(handler, /Access-Control-Allow-Origin/);
  assert.match(handler, /Access-Control-Allow-Headers/);
});
