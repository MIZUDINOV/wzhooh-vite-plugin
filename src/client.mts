export type PreviewEventType =
  | "bridge.ready"
  | "hmr.connected"
  | "hmr.disconnected"
  | "hmr.updating"
  | "hmr.ready"
  | "hmr.error"
  | "runtime.error"
  | "navigation.changed";

export interface WzhoohPreviewEventV1 {
  source: "wzhooh-preview";
  protocol: 1;
  sequence: number;
  timestamp: number;
  type: PreviewEventType;
  data: Record<string, unknown>;
}

export interface PreviewErrorV1 extends Record<string, unknown> {
  kind: string;
  message: string;
  stack?: string;
  frame?: string;
  file?: string;
  line?: number;
  column?: number;
  plugin?: string;
}

export interface ClientRuntimeOptions {
  hmrNotifier: boolean;
  navigationNotifier: boolean;
  errorNotifier: boolean;
  buildStatus: boolean;
  hmrTimeoutMs: number;
}

type ErrorLike = Record<string, unknown>;

export function sanitizePreviewError(
  value: unknown,
  fallbackKind = "runtime",
): PreviewErrorV1 {
  const limitedString = (
    candidate: unknown,
    limit: number,
  ): string | undefined => {
    if (typeof candidate !== "string" || candidate.length === 0)
      return undefined;
    const withoutOrigins = candidate.replace(/https?:\/\/[^/\s]+/g, "");
    const withoutAbsolutePaths = withoutOrigins
      .replace(/file:\/\/\/(?:workspace|opt\/wzhooh)\/?/gi, "")
      .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:()]+[\\/])+/g, "")
      .replace(/\\/g, "/");
    return withoutAbsolutePaths.slice(0, limit);
  };
  const input = value && typeof value === "object" ? (value as ErrorLike) : {};
  const location =
    input.loc && typeof input.loc === "object"
      ? (input.loc as ErrorLike)
      : undefined;
  const number = (candidate: unknown): number | undefined =>
    typeof candidate === "number" &&
    Number.isFinite(candidate) &&
    candidate >= 0
      ? Math.trunc(candidate)
      : undefined;
  const message =
    limitedString(
      input.message ?? (typeof value === "string" ? value : undefined),
      4_000,
    ) ?? "Unknown preview error";
  const result: PreviewErrorV1 = {
    kind: limitedString(input.kind, 64) ?? fallbackKind,
    message,
  };
  const optionalStrings = {
    stack: limitedString(input.stack, 16_000),
    frame: limitedString(input.frame, 16_000),
    file: limitedString(input.file ?? input.id, 1_000),
    plugin: limitedString(input.plugin, 256),
  };
  for (const [key, optional] of Object.entries(optionalStrings)) {
    if (optional) (result as Record<string, unknown>)[key] = optional;
  }
  const line = number(input.line ?? location?.line);
  const column = number(input.column ?? input.col ?? location?.column);
  if (line !== undefined) result.line = line;
  if (column !== undefined) result.column = column;
  return result;
}

interface HotClient {
  on(event: string, handler: (payload?: unknown) => void): void;
  send(event: string, payload: unknown): void;
}

interface PreviewRuntimeWindow extends Window {
  __wzhoohPreviewClientV1?: boolean;
}

export function installPreviewClient(
  options: ClientRuntimeOptions,
  sanitize: typeof sanitizePreviewError,
  root: PreviewRuntimeWindow = globalThis as unknown as PreviewRuntimeWindow,
  hot: HotClient | undefined = (import.meta as ImportMeta & { hot?: HotClient })
    .hot,
): void {
  if (root.__wzhoohPreviewClientV1) return;
  root.__wzhoohPreviewClientV1 = true;

  let sequence = 0;
  let channelID = "";
  let parentOrigin = "";
  let updating = false;
  let updateTimer: number | undefined;
  let runtimeBuffer: PreviewErrorV1[] = [];

  const emit = (
    type: PreviewEventType,
    data: Record<string, unknown> = {},
    dispatchInsideSite = true,
  ): void => {
    const detail: WzhoohPreviewEventV1 = {
      source: "wzhooh-preview",
      protocol: 1,
      sequence: ++sequence,
      timestamp: Date.now(),
      type,
      data,
    };
    if (dispatchInsideSite)
      root.dispatchEvent(new CustomEvent("wzhooh:preview-event", { detail }));
    if (channelID && root.parent !== root) {
      root.parent.postMessage(
        { ...detail, channel_id: channelID },
        parentOrigin,
      );
    }
  };

  const sendBuildStatus = (state: string, error?: PreviewErrorV1): void => {
    if (options.buildStatus) hot?.send("wzhooh:build-status", { state, error });
  };

  const clearUpdate = (): void => {
    updating = false;
    runtimeBuffer = [];
    if (updateTimer) root.clearTimeout(updateTimer);
    updateTimer = undefined;
  };

  const failUpdate = (error: PreviewErrorV1): void => {
    if (updateTimer) root.clearTimeout(updateTimer);
    updateTimer = undefined;
    updating = false;
    if (options.errorNotifier) {
      emit("hmr.error", error);
      for (const buffered of runtimeBuffer) emit("runtime.error", buffered);
    }
    runtimeBuffer = [];
    sendBuildStatus("error", error);
  };

  const beginUpdate = (): void => {
    updating = true;
    runtimeBuffer = [];
    if (options.hmrNotifier) emit("hmr.updating");
    sendBuildStatus("updating");
    if (updateTimer) root.clearTimeout(updateTimer);
    updateTimer = root.setTimeout(
      () =>
        failUpdate(
          sanitize({ kind: "hmr_timeout", message: "HMR update timed out" }),
        ),
      options.hmrTimeoutMs,
    );
  };

  const runtimeError = (value: unknown, kind: string): void => {
    if (!options.errorNotifier) return;
    const input =
      value && typeof value === "object" ? (value as ErrorLike) : undefined;
    const error = sanitize(
      {
        ...input,
        kind,
        message: input?.message ?? String(value),
        stack: input?.stack,
      },
      kind,
    );
    if (updating) {
      if (runtimeBuffer.length < 50) runtimeBuffer.push(error);
    } else emit("runtime.error", error);
  };

  root.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Record<string, unknown> | null;
    if (
      event.source !== root.parent ||
      !data ||
      data.source !== "wzhooh-editor" ||
      data.protocol !== 1 ||
      data.type !== "bridge.init" ||
      typeof data.channel_id !== "string" ||
      !/^[A-Za-z0-9-]{16,128}$/.test(data.channel_id)
    )
      return;
    channelID = data.channel_id;
    parentOrigin = event.origin;
    emit("bridge.ready", { url: root.location.href });
    if (options.navigationNotifier)
      emit("navigation.changed", { url: root.location.href }, false);
  });

  emit("bridge.ready", { url: root.location.href });

  if (options.navigationNotifier) {
    let lastURL = "";
    const publishURL = (): void => {
      const url = root.location.href;
      if (url === lastURL) return;
      lastURL = url;
      emit("navigation.changed", { url });
    };
    const pushState = root.history.pushState.bind(root.history);
    root.history.pushState = (data, unused, url) => {
      pushState(data, unused, url);
      publishURL();
    };
    const replaceState = root.history.replaceState.bind(root.history);
    root.history.replaceState = (data, unused, url) => {
      replaceState(data, unused, url);
      publishURL();
    };
    root.addEventListener("popstate", publishURL);
    publishURL();
  }

  if (options.errorNotifier) {
    root.addEventListener("error", (event: ErrorEvent) =>
      runtimeError(
        event.error ?? {
          message: event.message,
          file: event.filename,
          line: event.lineno,
          column: event.colno,
        },
        "uncaught_error",
      ),
    );
    root.addEventListener(
      "unhandledrejection",
      (event: PromiseRejectionEvent) =>
        runtimeError(event.reason, "unhandled_rejection"),
    );
  }

  if (!hot) return;
  hot.on("vite:ws:connect", () => {
    if (options.hmrNotifier) emit("hmr.connected");
    sendBuildStatus("ready");
  });
  hot.on("vite:ws:disconnect", () => {
    if (options.hmrNotifier) emit("hmr.disconnected");
    sendBuildStatus("disconnected");
  });
  hot.on("vite:beforeUpdate", beginUpdate);
  hot.on("vite:beforeFullReload", beginUpdate);
  hot.on("vite:afterUpdate", () => {
    clearUpdate();
    if (options.hmrNotifier) emit("hmr.ready");
    sendBuildStatus("ready");
  });
  hot.on("vite:error", (payload: unknown) => {
    const error = sanitize(
      payload && typeof payload === "object" && "err" in payload
        ? (payload as { err: unknown }).err
        : payload,
      "compile",
    );
    failUpdate({ ...error, kind: "compile" });
  });

  sendBuildStatus("ready");
}
