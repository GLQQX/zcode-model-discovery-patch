import assert from 'node:assert/strict';

const cdpHttpEndpoint = process.env.ZCODE_CDP_ENDPOINT ?? 'http://127.0.0.1:9333';
const providerName = process.env.ZCODE_PROVIDER_NAME ?? 'test-provider';
const shouldPull = process.argv.includes('--pull');
const observeCurrent = process.argv.includes('--current');
const observationMs = Number(process.env.ZCODE_OBSERVATION_MS ?? 12_000);

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(check, { timeoutMs = 20_000, intervalMs = 100, description }) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await check();
    if (lastValue) return lastValue;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}; last value: ${JSON.stringify(lastValue)}`);
}

async function connectToPage() {
  const targets = await fetch(`${cdpHttpEndpoint}/json`).then((response) => response.json());
  const pageTarget = targets.find((target) => target.type === 'page' && target.title === 'ZCode');
  assert.ok(pageTarget?.webSocketDebuggerUrl, 'ZCode page target was not found');

  const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
      return;
    }
    events.push(message);
  });

  function call(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  return { socket, call, evaluate, events };
}

const cdp = await connectToPage();
try {
  await cdp.call('Runtime.enable');
  await cdp.call('Network.enable');

  if (!observeCurrent) {
    await waitFor(
      () => cdp.evaluate("Boolean(document.querySelector('[data-testid=task-settings-button]'))"),
      { description: 'the ZCode workspace' },
    );
    await cdp.evaluate("document.querySelector('[data-testid=task-settings-button]').click(); true");

    await waitFor(
      () => cdp.evaluate("Boolean(Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === '模型设置'))"),
      { description: 'the model settings navigation item' },
    );
    await cdp.evaluate("Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === '模型设置').click(); true");

    await waitFor(
      () => cdp.evaluate(`Boolean(Array.from(document.querySelectorAll('[aria-label]')).find((node) => node.getAttribute('aria-label') === ${JSON.stringify(providerName)}))`),
      { description: `provider ${providerName}` },
    );
    await cdp.evaluate(`Array.from(document.querySelectorAll('[aria-label]')).find((node) => node.getAttribute('aria-label') === ${JSON.stringify(providerName)}).click(); true`);

    await waitFor(
      () => cdp.evaluate("Boolean(Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === '拉取模型'))"),
      { description: 'the pull-models button' },
    );
  }

  const before = await cdp.evaluate("Array.from(document.querySelectorAll('input')).filter((node) => node.placeholder === '模型 ID').map((node) => node.value)");
  const eventStart = cdp.events.length;

  let completionTimedOut = false;
  if (shouldPull) {
    await cdp.evaluate("Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === '拉取模型').click(); true");
    await waitFor(
      () => {
        const response = cdp.events.slice(eventStart).find((event) =>
          event.method === 'Network.responseReceived'
          && /\/models(?:\?|$)/.test(event.params.response.url),
        );
        return response?.params.response ?? null;
      },
      { description: 'the models API response' },
    );
    try {
      await waitFor(
        () => cdp.evaluate("Boolean(Array.from(document.querySelectorAll('button')).find((node) => node.textContent.trim() === '拉取模型'))"),
        { description: 'the completed pull-models state' },
      );
    } catch {
      completionTimedOut = true;
    }
  }

  const observedUntil = Date.now() + observationMs;
  let lastSnapshot;
  while (Date.now() < observedUntil) {
    lastSnapshot = await cdp.evaluate(`(() => {
      const bodyText = document.body?.innerText ?? '';
      return {
        hasErrorBoundary: bodyText.includes('这块界面出了点问题'),
        hasFailureMessage: bodyText.includes('拉取模型失败'),
        modelIds: Array.from(document.querySelectorAll('input'))
          .filter((node) => node.placeholder === '模型 ID')
          .map((node) => node.value),
        visualBadgeCount: Array.from(document.querySelectorAll('*'))
          .filter((node) => node.children.length === 0 && node.textContent.trim() === '视觉').length,
        buttonTexts: Array.from(document.querySelectorAll('button'))
          .map((node) => node.textContent.trim())
          .filter(Boolean),
        bodyTail: bodyText.slice(-2000),
      };
    })()`);
    if (lastSnapshot.hasErrorBoundary || lastSnapshot.hasFailureMessage) break;
    await sleep(250);
  }

  const networkResponses = cdp.events.slice(eventStart)
    .filter((event) => event.method === 'Network.responseReceived' && /\/models(?:\?|$)/.test(event.params.response.url))
    .map((event) => ({ url: event.params.response.url, status: event.params.response.status }));
  const runtimeExceptions = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);

  const report = {
    providerName,
    pulled: shouldPull,
    beforeCount: before.length,
    afterCount: lastSnapshot.modelIds.length,
    modelIds: lastSnapshot.modelIds,
    visualBadgeCount: lastSnapshot.visualBadgeCount,
    hasErrorBoundary: lastSnapshot.hasErrorBoundary,
    hasFailureMessage: lastSnapshot.hasFailureMessage,
    networkResponses,
    runtimeExceptions,
    completionTimedOut,
    buttonTexts: lastSnapshot.buttonTexts,
    bodyTail: lastSnapshot.bodyTail,
  };
  console.log(JSON.stringify(report, null, 2));

  assert.equal(report.hasErrorBoundary, false, 'the model settings error boundary was rendered');
  assert.equal(report.hasFailureMessage, false, 'the pull-models failure message was rendered');
  assert.equal(report.completionTimedOut, false, 'the pull-models operation did not return to its idle state');
  assert.ok(report.afterCount > 0, 'no models were shown after discovery');
  if (shouldPull) {
    assert.ok(report.networkResponses.some((response) => response.status === 200), 'the models endpoint did not return HTTP 200');
  }
} finally {
  cdp.socket.close();
}
