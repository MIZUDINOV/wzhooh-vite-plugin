import type { ViteHotContext } from "vite/types/hot.d.ts";

export interface PreviewErrorV1 {
  kind: string;
  message: string;
  stack?: string;
  frame?: string;
  file?: string;
  line?: number;
  column?: number;
  plugin?: string;
}

export interface PreviewEventDataMap {
  "bridge.ready": { url: string };
  "hmr.connected": Record<string, never>;
  "hmr.disconnected": Record<string, never>;
  "hmr.updating": Record<string, never>;
  "hmr.ready": Record<string, never>;
  "hmr.error": PreviewErrorV1;
  "runtime.error": PreviewErrorV1;
  "navigation.changed": { url: string };
}

export type PreviewEventType = keyof PreviewEventDataMap;

type PreviewEventFor<Type extends PreviewEventType> = {
  source: "wzhooh-preview";
  protocol: 1;
  sequence: number;
  timestamp: number;
  type: Type;
  data: PreviewEventDataMap[Type];
};

export type WzhoohPreviewEventV1 = {
  [Type in PreviewEventType]: PreviewEventFor<Type>;
}[PreviewEventType];

export interface ClientRuntimeOptions {
  hmrNotifier: boolean;
  navigationNotifier: boolean;
  errorNotifier: boolean;
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
    return withoutOrigins
      .replace(/file:\/\/\/(?:workspace|opt\/wzhooh)\/?/gi, "")
      .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:()]+[\\/])+/g, "")
      .replace(/\\/g, "/")
      .slice(0, limit);
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
  const stack = limitedString(input.stack, 16_000);
  const frame = limitedString(input.frame, 16_000);
  const file = limitedString(input.file ?? input.id, 1_000);
  const plugin = limitedString(input.plugin, 256);
  const line = number(input.line ?? location?.line);
  const column = number(input.column ?? input.col ?? location?.column);

  return {
    kind: limitedString(input.kind, 64) ?? fallbackKind,
    message:
      limitedString(
        input.message ?? (typeof value === "string" ? value : undefined),
        4_000,
      ) ?? "Unknown preview error",
    ...(stack ? { stack } : {}),
    ...(frame ? { frame } : {}),
    ...(file ? { file } : {}),
    ...(plugin ? { plugin } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

interface PreviewRuntimeWindow extends Window {
  __wzhoohPreviewClientV1?: boolean;
}

export function installPreviewClient(
  options: ClientRuntimeOptions,
  sanitize: typeof sanitizePreviewError,
  root: PreviewRuntimeWindow = globalThis as unknown as PreviewRuntimeWindow,
  hot: ViteHotContext | undefined = (
    import.meta as ImportMeta & { hot?: ViteHotContext }
  ).hot,
): void {
  if (root.__wzhoohPreviewClientV1) return;
  root.__wzhoohPreviewClientV1 = true;

  let sequence = 0;
  let channelID = "";
  let parentOrigin = "";
  let updating = false;
  let updateTimer: number | undefined;
  let runtimeBuffer: PreviewErrorV1[] = [];
  let lastNavigationEvent: PreviewEventFor<"navigation.changed"> | undefined;
  const postToParent = <Type extends PreviewEventType>(
    detail: PreviewEventFor<Type>,
  ): void => {
    if (!channelID || root.parent === root) return;
    root.parent.postMessage({ ...detail, channel_id: channelID }, parentOrigin);
  };
  const replayToParent = <Type extends PreviewEventType>(
    detail: PreviewEventFor<Type>,
  ): PreviewEventFor<Type> => {
    const replay = { ...detail, sequence: ++sequence, timestamp: Date.now() };
    postToParent(replay);
    return replay;
  };

  const emit = <Type extends PreviewEventType>(
    type: Type,
    data: PreviewEventDataMap[Type],
  ): PreviewEventFor<Type> => {
    const detail = {
      source: "wzhooh-preview",
      protocol: 1,
      sequence: ++sequence,
      timestamp: Date.now(),
      type,
      data,
    } as PreviewEventFor<Type>;
    root.dispatchEvent(new CustomEvent("wzhooh:preview-event", { detail }));
    postToParent(detail);
    return detail;
  };

  const clearUpdate = (): void => {
    updating = false;
    runtimeBuffer = [];
    if (updateTimer !== undefined) root.clearTimeout(updateTimer);
    updateTimer = undefined;
  };

  const failUpdate = (error: PreviewErrorV1): void => {
    if (updateTimer !== undefined) root.clearTimeout(updateTimer);
    updateTimer = undefined;
    updating = false;
    if (options.errorNotifier) {
      emit("hmr.error", error);
      for (const buffered of runtimeBuffer) emit("runtime.error", buffered);
    }
    runtimeBuffer = [];
  };

  const beginUpdate = (): void => {
    updating = true;
    runtimeBuffer = [];
    if (options.hmrNotifier) emit("hmr.updating", {});
    if (updateTimer !== undefined) root.clearTimeout(updateTimer);
    updateTimer = root.setTimeout(
      () =>
        failUpdate(
          sanitize({ kind: "hmr_timeout", message: "HMR update timed out" }),
        ),
      options.hmrTimeoutMs,
    );
  };

  const runtimeError = (value: unknown, kind: string): void => {
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
    let origin: URL;
    try {
      origin = new URL(event.origin);
    } catch {
      return;
    }
    if (
      event.source !== root.parent ||
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.origin !== event.origin ||
      (parentOrigin !== "" && event.origin !== parentOrigin) ||
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
    if (lastNavigationEvent)
      lastNavigationEvent = replayToParent(lastNavigationEvent);
  });

  emit("bridge.ready", { url: root.location.href });

  if (options.navigationNotifier) {
    let lastURL = "";
    const publishURL = (): void => {
      const url = root.location.href;
      if (url === lastURL) return;
      lastURL = url;
      lastNavigationEvent = emit("navigation.changed", { url });
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
    if (options.hmrNotifier) emit("hmr.connected", {});
  });
  hot.on("vite:ws:disconnect", () => {
    if (options.hmrNotifier) emit("hmr.disconnected", {});
  });
  hot.on("vite:beforeUpdate", beginUpdate);
  hot.on("vite:beforeFullReload", beginUpdate);
  hot.on("vite:afterUpdate", () => {
    clearUpdate();
    if (options.hmrNotifier) emit("hmr.ready", {});
  });
  hot.on("vite:error", (payload) => {
    const error = sanitize(payload.err, "compile");
    failUpdate({ ...error, kind: "compile" });
  });
}
