import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, UserConfig, ViteDevServer } from "vite";
import {
  installPreviewClient,
  sanitizePreviewError,
  type BuildStatusSignalV1,
  type BuildStatusState,
  type ClientRuntimeOptions,
  type PreviewErrorV1,
} from "./client.mjs";

export type {
  BuildStatusSignalV1,
  BuildStatusState,
  PreviewErrorV1,
  PreviewEventDataMap,
  PreviewEventType,
  WzhoohPreviewEventV1,
} from "./client.mjs";

export interface WzhoohVitePluginOptions {
  hmrNotifier?: boolean;
  navigationNotifier?: boolean;
  errorNotifier?: boolean;
  buildStatus?: boolean;
  forwardConsole?: boolean;
}

export interface BuildStatusV1 {
  protocol: 1;
  ok: boolean;
  state: BuildStatusState;
  revision: number;
  updated_at: string;
  error?: PreviewErrorV1;
}

class BuildStatusStore {
  private sessionID = "";
  private sequence = 0;
  private value: BuildStatusV1 = {
    protocol: 1,
    ok: false,
    state: "starting",
    revision: 0,
    updated_at: new Date().toISOString(),
  };

  update(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const input = payload as Partial<BuildStatusSignalV1>;
    if (
      input.protocol !== 1 ||
      typeof input.session_id !== "string" ||
      !/^[A-Za-z0-9-]{16,128}$/.test(input.session_id) ||
      typeof input.sequence !== "number" ||
      !Number.isInteger(input.sequence) ||
      input.sequence < 1 ||
      !["starting", "updating", "ready", "error", "disconnected"].includes(
        String(input.state),
      )
    )
      return;

    const newSession = input.session_id !== this.sessionID;
    if (newSession && input.sequence !== 1) return;
    if (newSession) {
      this.sessionID = input.session_id;
      this.sequence = 0;
    }
    if (input.sequence! <= this.sequence) return;

    const state = input.state as BuildStatusState;
    const error =
      state === "error"
        ? sanitizePreviewError(
            (input as Partial<Extract<BuildStatusSignalV1, { state: "error" }>>)
              .error,
            "compile",
          )
        : !newSession && state !== "ready" && state !== "starting"
          ? this.value.error
          : undefined;
    this.sequence = input.sequence!;
    this.value = {
      protocol: 1,
      ok: state === "ready",
      state,
      revision: this.value.revision + 1,
      updated_at: new Date().toISOString(),
      ...(error ? { error } : {}),
    };
  }

  snapshot(): BuildStatusV1 {
    return {
      ...this.value,
      ...(this.value.error ? { error: { ...this.value.error } } : {}),
    };
  }
}

const virtualClientID = "virtual:wzhooh-preview-client";
const resolvedVirtualClientID = `\0${virtualClientID}`;

const isLoopback = (address: string | undefined): boolean =>
  address === "127.0.0.1" ||
  address === "::1" ||
  address === "::ffff:127.0.0.1";

const buildStatusMiddleware =
  (store: BuildStatusStore) =>
  (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    if (
      request.method !== "GET" ||
      request.url?.split("?", 1)[0] !== "/__wzhooh_build_status" ||
      !isLoopback(request.socket.remoteAddress)
    ) {
      next();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(JSON.stringify(store.snapshot()));
  };

const clientSource = (options: ClientRuntimeOptions): string =>
  `const sanitizePreviewError=${sanitizePreviewError.toString()};\n` +
  `(${installPreviewClient.toString()})(${JSON.stringify(options)},sanitizePreviewError);`;

export default function wzhooh(options: WzhoohVitePluginOptions = {}): Plugin {
  const runtimeOptions: ClientRuntimeOptions = {
    hmrNotifier: options.hmrNotifier ?? false,
    navigationNotifier: options.navigationNotifier ?? false,
    errorNotifier: options.errorNotifier ?? false,
    buildStatus: options.buildStatus ?? false,
    hmrTimeoutMs: 10_000,
  };
  const injectClient =
    runtimeOptions.hmrNotifier ||
    runtimeOptions.navigationNotifier ||
    runtimeOptions.errorNotifier ||
    runtimeOptions.buildStatus;
  const status = new BuildStatusStore();

  return {
    name: "wzhooh",
    apply: "serve",
    enforce: "post",
    config(config: UserConfig) {
      return {
        server: {
          ...(runtimeOptions.errorNotifier && config.server?.hmr !== false
            ? { hmr: { overlay: false } }
            : {}),
          forwardConsole: options.forwardConsole
            ? {
                unhandledErrors: true,
                logLevels: ["warn", "error"],
              }
            : false,
        },
      };
    },
    configureServer(server: ViteDevServer) {
      if (!runtimeOptions.buildStatus) return;
      server.ws.on("wzhooh:build-status", (payload) => status.update(payload));
      server.middlewares.use(buildStatusMiddleware(status));
    },
    resolveId(id) {
      return id === virtualClientID ? resolvedVirtualClientID : undefined;
    },
    load(id) {
      return id === resolvedVirtualClientID
        ? clientSource(runtimeOptions)
        : undefined;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        if (!context.server || !injectClient) return [];
        return [
          {
            tag: "script",
            attrs: { type: "module", src: `/@id/${virtualClientID}` },
            injectTo: "head",
          },
        ];
      },
    },
  };
}
