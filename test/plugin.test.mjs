import assert from "node:assert/strict";
import { test } from "vitest";
import { resolve } from "node:path";
import { build, createServer, resolveConfig } from "vite";
import wzhooh from "../dist/index.mjs";
import { installPreviewClient, sanitizePreviewError } from "../dist/client.mjs";

const fixtureRoot = resolve(import.meta.dirname, "fixtures");
const channelID = "12345678-1234-1234-1234-123456789012";
const secondChannelID = "87654321-4321-4321-4321-210987654321";

class FakeHot {
  handlers = new Map();
  sent = [];

  on(event, handler) {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  send(event, payload) {
    this.sent.push({ event, payload });
  }

  fire(event, payload) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
}

class FakeWindow extends EventTarget {
  __wzhoohPreviewClientV1 = false;
  location = { href: "https://preview.test/" };
  parentMessages = [];
  document;
  crypto = { randomUUID: () => channelID };
  history;
  parent;
  setTimeout = setTimeout;
  clearTimeout = clearTimeout;

  constructor({ readyState = "loading", sameParent = false } = {}) {
    super();
    this.document = { readyState };
    this.parent = sameParent
      ? this
      : {
          postMessage: (message, origin) =>
            this.parentMessages.push({ message, origin }),
        };
    this.history = {
      pushState: (_state, _unused, url) => {
        if (url)
          this.location.href = new URL(String(url), this.location.href).href;
      },
      replaceState: (_state, _unused, url) => {
        if (url)
          this.location.href = new URL(String(url), this.location.href).href;
      },
    };
  }

  postMessage(message, origin) {
    this.parentMessages.push({ message, origin });
  }
}

const options = {
  hmrNotifier: true,
  navigationNotifier: true,
  errorNotifier: true,
  hmrTimeoutMs: 15,
};

const collectEvents = (root) => {
  const events = [];
  root.addEventListener("wzhooh:preview-event", (event) =>
    events.push(event.detail),
  );
  return events;
};

const dispatchMessage = (
  root,
  data,
  { source = root.parent, origin = "https://app.wzhooh.test" } = {},
) => {
  const message = new Event("message");
  Object.defineProperties(message, {
    source: { value: source },
    origin: { value: origin },
    data: { value: data },
  });
  root.dispatchEvent(message);
};

const validBridgeInit = (id = channelID) => ({
  source: "wzhooh-editor",
  protocol: 1,
  type: "bridge.init",
  channel_id: id,
});

const waitForTimers = () =>
  new Promise((resolveTimer) => setTimeout(resolveTimer));

test("Vite config is deterministic and preserves explicitly disabled HMR", async () => {
  const defaults = wzhooh();
  assert.equal(defaults.config({}), undefined);
  assert.deepEqual(defaults.transformIndexHtml.handler("", {}), []);
  assert.equal(defaults.resolveId("other"), undefined);
  assert.equal(defaults.load("other"), undefined);
  assert.equal(
    defaults.resolveId("virtual:wzhooh-preview-client"),
    "\0virtual:wzhooh-preview-client",
  );

  const enabled = wzhooh({ errorNotifier: true, forwardConsole: true });
  assert.deepEqual(enabled.config({}), {
    server: {
      hmr: { overlay: false },
      forwardConsole: { unhandledErrors: true, logLevels: ["warn", "error"] },
    },
  });
  assert.deepEqual(enabled.config({ server: { hmr: false } }), {
    server: {
      forwardConsole: { unhandledErrors: true, logLevels: ["warn", "error"] },
    },
  });

  const resolvedDisabledHMR = await resolveConfig(
    {
      configFile: false,
      plugins: [wzhooh({ errorNotifier: true })],
      server: { hmr: false },
    },
    "serve",
  );
  assert.equal(resolvedDisabledHMR.server.hmr, false);
});

test("real Vite serves the virtual client and production build stays clean", async () => {
  const pluginOptions = {
    hmrNotifier: true,
    navigationNotifier: true,
    errorNotifier: true,
    buildStatus: true,
    forwardConsole: true,
  };
  const server = await createServer({
    root: fixtureRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [wzhooh(pluginOptions)],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const htmlResponse = await fetch(origin);
    assert.equal(htmlResponse.status, 200);
    assert.match(await htmlResponse.text(), /virtual:wzhooh-preview-client/);
    const client = await fetch(`${origin}/@id/virtual:wzhooh-preview-client`);
    assert.equal(client.status, 200);
    const code = await client.text();
    assert.match(code, /wzhooh:preview-event/);
    assert.match(code, /(?:import\.meta|__vite_ssr_import_meta__)\.hot/);
    const status = await fetch(`${origin}/__wzhooh_build_status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    const statusBody = await status.json();
    assert.equal(statusBody.protocol, 1);
    assert.equal(statusBody.ok, true);
    assert.equal(statusBody.revision, 0);
    assert.equal(Number.isNaN(Date.parse(statusBody.updated_at)), false);
    assert.equal(statusBody.error, undefined);
  } finally {
    await server.close();
  }

  const result = await build({
    root: fixtureRoot,
    configFile: false,
    logLevel: "silent",
    plugins: [wzhooh(pluginOptions)],
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (item) => item.output,
  );
  const production = outputs
    .map((item) => ("code" in item ? item.code : String(item.source)))
    .join("\n");
  assert.doesNotMatch(
    production,
    /wzhooh:preview-event|virtual:wzhooh-preview-client|__wzhooh_build_status/,
  );
});

test("sanitizer produces a bounded closed error payload", () => {
  const error = sanitizePreviewError({
    kind: "compile",
    message: `https://preview.test/workspace/src/App.tsx C:\\workspace\\src\\App.tsx ${"x".repeat(5_000)}`,
    stack: "at file:///workspace/src/App.tsx:3:4",
    frame: "/opt/wzhooh/src/App.tsx:3:4",
    id: "/workspace/src/App.tsx",
    loc: { line: 3.9, column: 4.2 },
    plugin: "vite:react",
  });
  assert.deepEqual(Object.keys(error).sort(), [
    "column",
    "file",
    "frame",
    "kind",
    "line",
    "message",
    "plugin",
    "stack",
  ]);
  assert.equal(error.message.includes("preview.test"), false);
  assert.equal(error.message.includes("C:\\workspace"), false);
  assert.equal(error.stack.includes("/workspace/"), false);
  assert.equal(error.file.includes("/workspace/"), false);
  assert.equal(error.message.length, 4_000);
  assert.equal(error.line, 3);
  assert.equal(error.column, 4);

  assert.deepEqual(sanitizePreviewError("plain failure", "compile"), {
    kind: "compile",
    message: "plain failure",
  });
  assert.deepEqual(sanitizePreviewError(null), {
    kind: "runtime",
    message: "Unknown preview error",
  });
  assert.deepEqual(
    sanitizePreviewError({ kind: "", message: "", line: -1, col: Infinity }),
    { kind: "runtime", message: "Unknown preview error" },
  );
});

test("client reports HMR errors and readiness without sending server status", async () => {
  const root = new FakeWindow();
  const hot = new FakeHot();
  const events = collectEvents(root);
  installPreviewClient(options, sanitizePreviewError, root, hot);

  hot.fire("vite:error", {
    err: { message: "/workspace/src/App.tsx failed", plugin: "vite:react" },
  });
  root.dispatchEvent(new Event("load"));
  await waitForTimers();
  assert.equal(events.at(-1).type, "hmr.error");

  hot.fire("vite:beforeUpdate");
  hot.fire("vite:afterUpdate");
  assert.equal(events.at(-1).type, "hmr.ready");
  assert.deepEqual(hot.sent, []);
});

test("client covers HMR, runtime errors, buffering, timeout and reconnect", async () => {
  const root = new FakeWindow({ readyState: "complete" });
  const hot = new FakeHot();
  const events = collectEvents(root);
  installPreviewClient(options, sanitizePreviewError, root, hot);
  await waitForTimers();

  hot.fire("vite:ws:connect");
  assert.equal(events.at(-1).type, "hmr.connected");

  hot.fire("vite:beforeUpdate");
  hot.fire("vite:beforeUpdate");
  root.dispatchEvent(
    new ErrorEvent("error", {
      message: "transient",
      error: new Error("transient"),
    }),
  );
  hot.fire("vite:afterUpdate");
  assert.equal(
    events.some(
      (event) =>
        event.type === "runtime.error" && event.data.message === "transient",
    ),
    false,
  );

  hot.fire("vite:beforeUpdate");
  for (let index = 0; index < 51; index += 1) {
    root.dispatchEvent(
      new ErrorEvent("error", {
        message: `buffered-${index}`,
        error: new Error(`buffered-${index}`),
      }),
    );
  }
  hot.fire("vite:error", { err: { message: "compile failed" } });
  assert.equal(
    events.filter(
      (event) =>
        event.type === "runtime.error" &&
        event.data.message.startsWith("buffered-"),
    ).length,
    50,
  );

  const rejection = new Event("unhandledrejection");
  Object.defineProperty(rejection, "reason", { value: "rejected" });
  root.dispatchEvent(rejection);
  assert.equal(events.at(-1).data.kind, "unhandled_rejection");
  root.dispatchEvent(
    new ErrorEvent("error", {
      message: "fallback error",
      filename: "/workspace/src/main.ts",
      lineno: 7,
      colno: 8,
    }),
  );
  assert.equal(events.at(-1).data.file, "main.ts");

  hot.fire("vite:beforeUpdate");
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
  assert.equal(events.at(-1).data.kind, "hmr_timeout");

  hot.fire("vite:beforeFullReload");
  hot.fire("vite:afterUpdate");
  hot.fire("vite:ws:disconnect");
  assert.equal(events.at(-1).type, "hmr.disconnected");
  assert.deepEqual(hot.sent, []);

  const handlers = [...hot.handlers.values()].reduce(
    (count, values) => count + values.length,
    0,
  );
  installPreviewClient(options, sanitizePreviewError, root, hot);
  assert.equal(
    [...hot.handlers.values()].reduce(
      (count, values) => count + values.length,
      0,
    ),
    handlers,
  );
});

test("navigation is deduplicated and bridge rejects invalid handshakes", () => {
  const root = new FakeWindow();
  const hot = new FakeHot();
  const events = collectEvents(root);
  installPreviewClient(options, sanitizePreviewError, root, hot);
  assert.equal(
    events.filter((event) => event.type === "navigation.changed").length,
    1,
  );

  const invalidMessages = [
    { data: null },
    { data: { ...validBridgeInit(), source: "other" } },
    { data: { ...validBridgeInit(), protocol: 2 } },
    { data: { ...validBridgeInit(), type: "other" } },
    { data: { ...validBridgeInit(), channel_id: 123 } },
    { data: { ...validBridgeInit(), channel_id: "short" } },
    { data: validBridgeInit(), source: {} },
  ];
  for (const item of invalidMessages) {
    dispatchMessage(root, item.data, { source: item.source ?? root.parent });
  }
  assert.equal(root.parentMessages.length, 0);

  dispatchMessage(root, validBridgeInit());
  assert.equal(root.parentMessages.length, 2);
  assert.equal(
    root.parentMessages.every(
      (item) => item.origin === "https://app.wzhooh.test",
    ),
    true,
  );
  assert.deepEqual(
    root.parentMessages.map((item) => item.message.type),
    ["bridge.ready", "navigation.changed"],
  );
  assert.equal(
    events.filter((event) => event.type === "navigation.changed").length,
    1,
  );

  root.history.pushState({}, "", "/one");
  root.history.replaceState({}, "", "/one");
  root.location.href = "https://preview.test/two";
  root.dispatchEvent(new Event("popstate"));
  assert.deepEqual(
    events
      .filter((event) => event.type === "navigation.changed")
      .map((event) => event.data.url),
    [
      "https://preview.test/",
      "https://preview.test/one",
      "https://preview.test/two",
    ],
  );

  dispatchMessage(root, validBridgeInit(secondChannelID), {
    origin: "https://new.wzhooh.test",
  });
  root.history.pushState({}, "", "/three");
  assert.equal(root.parentMessages.at(-1).origin, "https://new.wzhooh.test");
  assert.equal(root.parentMessages.at(-1).message.channel_id, secondChannelID);
});

test("client stays inert when features or HMR are disabled", async () => {
  const root = new FakeWindow({ sameParent: true });
  const hot = new FakeHot();
  const events = collectEvents(root);
  const disabled = {
    hmrNotifier: false,
    navigationNotifier: false,
    errorNotifier: false,
    hmrTimeoutMs: 5,
  };
  installPreviewClient(disabled, sanitizePreviewError, root, hot);
  dispatchMessage(root, validBridgeInit());
  hot.fire("vite:ws:connect");
  hot.fire("vite:beforeUpdate");
  root.dispatchEvent(new ErrorEvent("error", { message: "ignored" }));
  hot.fire("vite:error", { err: { message: "ignored compile" } });
  hot.fire("vite:afterUpdate");
  hot.fire("vite:ws:disconnect");
  assert.deepEqual(
    events.map((event) => event.type),
    ["bridge.ready", "bridge.ready"],
  );
  assert.deepEqual(hot.sent, []);
  assert.deepEqual(root.parentMessages, []);

  const withoutHot = new FakeWindow();
  withoutHot.crypto = undefined;
  installPreviewClient(options, sanitizePreviewError, withoutHot, undefined);
  withoutHot.dispatchEvent(new Event("load"));
  await waitForTimers();
  assert.equal(withoutHot.__wzhoohPreviewClientV1, true);
});

const createStatusHarness = (enabled = true, useHot = true) => {
  const sent = [];
  const middlewares = [];
  const channel = {
    send(...args) {
      sent.push(args);
    },
  };
  const plugin = wzhooh({ buildStatus: enabled });
  plugin.configureServer({
    ...(useHot ? { hot: channel } : {}),
    ws: channel,
    middlewares: {
      use(middleware) {
        middlewares.push(middleware);
      },
    },
  });
  return { channel, sent, middlewares };
};

const invokeMiddleware = (
  middleware,
  { method = "GET", url = "/__wzhooh_build_status", address = "127.0.0.1" },
) => {
  let next = false;
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      this.body = value;
    },
  };
  middleware(
    { method, url, socket: { remoteAddress: address } },
    response,
    () => (next = true),
  );
  return { next, response };
};

test("build status follows server HMR payloads and exposes only loopback GET", () => {
  assert.deepEqual(createStatusHarness(false).middlewares, []);
  const wsFallback = createStatusHarness(true, false);
  wsFallback.channel.send({ type: "update", updates: [] });
  assert.equal(wsFallback.sent.length, 1);
  const { channel, sent, middlewares } = createStatusHarness();
  const middleware = middlewares[0];
  assert.equal(typeof middleware, "function");

  let status = JSON.parse(invokeMiddleware(middleware, {}).response.body);
  assert.equal(status.ok, true);
  assert.equal(status.revision, 0);

  channel.send({
    type: "error",
    err: { message: "/workspace/src/App.tsx failed", stack: "stack" },
  });
  status = JSON.parse(invokeMiddleware(middleware, {}).response.body);
  assert.equal(status.ok, false);
  assert.equal(status.error.message, "App.tsx failed");
  assert.equal(status.error.kind, "compile");
  assert.equal(status.revision, 1);

  channel.send({ type: "update", updates: [] });
  status = JSON.parse(invokeMiddleware(middleware, {}).response.body);
  assert.equal(status.ok, true);
  assert.equal(status.error, undefined);
  assert.equal(status.revision, 2);

  channel.send({ type: "error", err: { message: "again", stack: "stack" } });
  channel.send({ type: "full-reload" });
  status = JSON.parse(invokeMiddleware(middleware, {}).response.body);
  assert.equal(status.ok, true);
  assert.equal(status.revision, 4);

  channel.send({ type: "connected" });
  channel.send("custom:event", { value: 1 });
  status = JSON.parse(invokeMiddleware(middleware, {}).response.body);
  assert.equal(status.revision, 4);
  assert.deepEqual(sent.at(-1), ["custom:event", { value: 1 }]);

  const hostilePayload = {};
  Object.defineProperty(hostilePayload, "type", {
    get() {
      throw new Error("telemetry failure");
    },
  });
  channel.send(hostilePayload);
  assert.equal(sent.length, 7);
  assert.equal(sent[0][0].type, "error");

  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    const result = invokeMiddleware(middleware, {
      address,
      url: "/__wzhooh_build_status?fresh=1",
    });
    assert.equal(result.next, false);
    assert.equal(result.response.statusCode, 200);
    assert.equal(
      result.response.headers["Content-Type"],
      "application/json; charset=utf-8",
    );
    assert.equal(result.response.headers["Cache-Control"], "no-store");
  }
  for (const request of [
    { method: "POST" },
    { url: "/other" },
    { address: "10.0.0.2" },
    { address: null },
  ]) {
    assert.equal(invokeMiddleware(middleware, request).next, true);
  }
});
