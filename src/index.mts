import type { IncomingMessage, ServerResponse } from "node:http";
import type { HMRPayload, Plugin, UserConfig, ViteDevServer } from "vite";
import {
  installPreviewClient,
  sanitizePreviewError,
  type ClientRuntimeOptions,
  type PreviewErrorV1,
} from "./client.mjs";

export type {
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
  revision: number;
  updated_at: string;
  error?: PreviewErrorV1;
}

class BuildStatusStore {
  private value: BuildStatusV1 = {
    protocol: 1,
    ok: true,
    revision: 0,
    updated_at: new Date().toISOString(),
  };

  observe(payload: HMRPayload): void {
    if (
      payload.type !== "error" &&
      payload.type !== "update" &&
      payload.type !== "full-reload"
    )
      return;
    const error =
      payload.type === "error"
        ? { ...sanitizePreviewError(payload.err, "compile"), kind: "compile" }
        : undefined;
    this.value = {
      protocol: 1,
      ok: !error,
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
    hmrTimeoutMs: 10_000,
  };
  const injectClient =
    runtimeOptions.hmrNotifier ||
    runtimeOptions.navigationNotifier ||
    runtimeOptions.errorNotifier;
  const status = new BuildStatusStore();

  return {
    name: "wzhooh",
    apply: "serve",
    enforce: "post",
    config(config: UserConfig) {
      const server: NonNullable<UserConfig["server"]> = {
        ...(runtimeOptions.errorNotifier && config.server?.hmr !== false
          ? { hmr: { overlay: false } }
          : {}),
        ...(options.forwardConsole
          ? {
              forwardConsole: {
                unhandledErrors: true,
                logLevels: ["warn", "error"],
              },
            }
          : {}),
      };
      return Object.keys(server).length > 0 ? { server } : undefined;
    },
    configureServer(server: ViteDevServer) {
      if (!options.buildStatus) return;
      const channel = server.hot ?? server.ws;
      const originalSend = channel.send.bind(channel);
      channel.send = ((payloadOrEvent: HMRPayload | string, data?: unknown) => {
        if (typeof payloadOrEvent !== "string") {
          try {
            status.observe(payloadOrEvent);
          } catch {
            // Build telemetry must never interrupt Vite's own HMR channel.
          }
        }
        if (typeof payloadOrEvent === "string")
          originalSend(payloadOrEvent, data);
        else originalSend(payloadOrEvent);
      }) as typeof channel.send;
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
