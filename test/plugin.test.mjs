import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createServer } from "vite";
import wzhooh, {
  BuildStatusStore,
  buildStatusMiddleware,
} from "../dist/index.mjs";
import { installPreviewClient, sanitizePreviewError } from "../dist/client.mjs";

class FakeHot {
  handlers = new Map();
  sent = [];

  on(event, handler) {
    this.handlers.set(event, handler);
  }

  send(event, payload) {
    this.sent.push({ event, payload });
  }

  fire(event, payload) {
    this.handlers.get(event)?.(payload);
  }
}

class FakeWindow extends EventTarget {
  __wzhoohPreviewClientV1 = false;
  CustomEvent = CustomEvent;
  location = { href: "https://preview.test/" };
  parentMessages = [];
  parent = {
    postMessage: (message, origin) =>
      this.parentMessages.push({ message, origin }),
  };
  history = {
    pushState: (_state, _unused, url) => {
      if (url)
        this.location.href = new URL(String(url), this.location.href).href;
    },
    replaceState: (_state, _unused, url) => {
      if (url)
        this.location.href = new URL(String(url), this.location.href).href;
    },
  };
  setTimeout = setTimeout;
  clearTimeout = clearTimeout;
}

const options = {
  hmrNotifier: true,
  navigationNotifier: true,
  errorNotifier: true,
  buildStatus: true,
  hmrTimeoutMs: 15,
};

test("defaults stay inert and production HTML is untouched", () => {
  const plugin = wzhooh();
  assert.deepEqual(plugin.config(), { server: {} });
  assert.deepEqual(plugin.transformIndexHtml.handler("", {}), []);
  assert.equal(
    plugin.resolveId("virtual:wzhooh-preview-client"),
    "\0virtual:wzhooh-preview-client",
  );
});

test("enabled config uses public Vite server options and dev injection", () => {
  const plugin = wzhooh({ errorNotifier: true, forwardConsole: true });
  assert.deepEqual(plugin.config(), {
    server: {
      hmr: { overlay: false },
      forwardConsole: { unhandledErrors: true, logLevels: ["warn", "error"] },
    },
  });
  const tags = plugin.transformIndexHtml.handler("", { server: {} });
  assert.equal(tags[0].attrs.src, "/@id/virtual:wzhooh-preview-client");
});

test("Vite serves the injected virtual client through its public module pipeline", async () => {
  const server = await createServer({
    root: resolve(import.meta.dirname, "../../.."),
    configFile: false,
    logLevel: "silent",
    plugins: [
      wzhooh({ hmrNotifier: true, errorNotifier: true, buildStatus: true }),
    ],
    server: { host: "127.0.0.1", port: 0 },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.equal(typeof address, "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const html = await fetch(origin).then((response) => response.text());
    assert.match(html, /virtual:wzhooh-preview-client/);
    const client = await fetch(`${origin}/@id/virtual:wzhooh-preview-client`);
    assert.equal(client.status, 200);
    const code = await client.text();
    assert.match(code, /wzhooh:preview-event/);
    assert.match(code, /import\.meta\s*\.hot/);
    const status = await fetch(`${origin}/__wzhooh_build_status`);
    assert.equal(status.status, 200);
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.equal((await status.json()).protocol, 1);
  } finally {
    await server.close();
  }
});

test("sanitizes paths and limits error payloads", () => {
  const error = sanitizePreviewError({
    message: `broken at C:\\workspace\\src\\App.tsx ${"x".repeat(5_000)}`,
    stack: "at file:///workspace/src/App.tsx:3:4",
    file: "/workspace/src/App.tsx",
    loc: { line: 3, column: 4 },
    plugin: "vite:react",
  });
  assert.equal(error.message.includes("C:\\workspace"), false);
  assert.equal(error.stack.includes("/workspace/"), false);
  assert.equal(error.file.includes("/workspace/"), false);
  assert.equal(error.message.length, 4_000);
  assert.equal(error.line, 3);
  assert.equal(error.column, 4);
});

test("HMR buffers transient runtime noise, reports compile errors, recovers, and times out", async () => {
  const root = new FakeWindow();
  const hot = new FakeHot();
  const events = [];
  root.addEventListener("wzhooh:preview-event", (event) =>
    events.push(event.detail),
  );
  installPreviewClient(options, sanitizePreviewError, root, hot);

  hot.fire("vite:beforeUpdate");
  root.dispatchEvent(
    new ErrorEvent("error", {
      message: "transient",
      error: new Error("transient"),
    }),
  );
  hot.fire("vite:afterUpdate");
  assert.equal(
    events.some((event) => event.type === "runtime.error"),
    false,
  );
  assert.equal(events.at(-1).type, "hmr.ready");

  hot.fire("vite:beforeUpdate");
  hot.fire("vite:error", { err: { message: "/workspace/src/App.tsx failed" } });
  assert.equal(events.at(-1).type, "hmr.error");
  assert.equal(events.at(-1).data.kind, "compile");
  hot.fire("vite:afterUpdate");
  assert.equal(events.at(-1).type, "hmr.ready");

  root.dispatchEvent(
    new ErrorEvent("error", { message: "fatal", error: new Error("fatal") }),
  );
  assert.equal(events.at(-1).type, "runtime.error");
  assert.equal(events.at(-1).data.message, "fatal");

  hot.fire("vite:beforeUpdate");
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(events.at(-1).type, "hmr.error");
  assert.equal(events.at(-1).data.kind, "hmr_timeout");

  hot.fire("vite:ws:disconnect");
  assert.equal(events.at(-1).type, "hmr.disconnected");
  assert.equal(hot.sent.at(-1).payload.state, "disconnected");
});

test("navigation is deduplicated and bridge pins source, channel, and origin", () => {
  const root = new FakeWindow();
  const hot = new FakeHot();
  const events = [];
  root.addEventListener("wzhooh:preview-event", (event) =>
    events.push(event.detail),
  );
  installPreviewClient(options, sanitizePreviewError, root, hot);
  root.history.pushState({}, "", "/one");
  root.history.replaceState({}, "", "/one");
  assert.equal(
    events.filter((event) => event.type === "navigation.changed").length,
    2,
  );

  const message = new Event("message");
  Object.defineProperties(message, {
    source: { value: root.parent },
    origin: { value: "https://app.wzhooh.test" },
    data: {
      value: {
        source: "wzhooh-editor",
        protocol: 1,
        type: "bridge.init",
        channel_id: "12345678-1234-1234-1234-123456789012",
      },
    },
  });
  root.dispatchEvent(message);
  assert.equal(root.parentMessages.length, 2);
  assert.equal(
    root.parentMessages.every(
      (item) => item.origin === "https://app.wzhooh.test",
    ),
    true,
  );
  assert.equal(
    root.parentMessages[0].message.channel_id,
    "12345678-1234-1234-1234-123456789012",
  );
});

test("build status clears compile errors only on ready", () => {
  const store = new BuildStatusStore();
  store.update({
    state: "error",
    error: { message: "/workspace/src/App.tsx failed" },
  });
  store.update({ state: "updating" });
  assert.equal(store.snapshot().error.message, "App.tsx failed");
  store.update({ state: "ready" });
  assert.equal(store.snapshot().ok, true);
  assert.equal(store.snapshot().error, undefined);
  assert.equal(store.snapshot().revision, 3);
});

test("build status endpoint is GET and loopback only", () => {
  const store = new BuildStatusStore();
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(value) {
      this.body = value;
    },
  };
  let next = false;
  buildStatusMiddleware(store)(
    {
      method: "GET",
      url: "/__wzhooh_build_status",
      socket: { remoteAddress: "127.0.0.1" },
    },
    response,
    () => (next = true),
  );
  assert.equal(next, false);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.equal(JSON.parse(response.body).protocol, 1);

  buildStatusMiddleware(store)(
    {
      method: "GET",
      url: "/__wzhooh_build_status",
      socket: { remoteAddress: "10.0.0.2" },
    },
    response,
    () => (next = true),
  );
  assert.equal(next, true);
});
