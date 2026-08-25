import wzhooh, {
  type BuildStatusV1,
  type WzhoohPreviewEventV1,
  type WzhoohVitePluginOptions,
} from "../dist/index.mjs";

const options = {
  hmrNotifier: true,
  navigationNotifier: true,
  errorNotifier: true,
  buildStatus: true,
  forwardConsole: true,
} satisfies WzhoohVitePluginOptions;

wzhooh(options);

const status: BuildStatusV1 = {
  protocol: 1,
  ok: false,
  revision: 1,
  updated_at: new Date().toISOString(),
  error: { kind: "compile", message: "broken" },
};
void status;

const event: WzhoohPreviewEventV1 = {
  source: "wzhooh-preview",
  protocol: 1,
  sequence: 1,
  timestamp: Date.now(),
  type: "navigation.changed",
  data: { url: "https://preview.test/" },
};
if (event.type === "navigation.changed") event.data.url.toUpperCase();

// @ts-expect-error navigation payloads never contain error messages
event.data.message;
