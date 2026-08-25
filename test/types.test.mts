import type { InferCustomEventPayload } from "vite";
import wzhooh, {
  type BuildStatusSignalV1,
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

const status: InferCustomEventPayload<"wzhooh:build-status"> = {
  protocol: 1,
  session_id: "12345678-1234-1234-1234-123456789012",
  sequence: 1,
  state: "error",
  error: { kind: "compile", message: "broken" },
};
status satisfies BuildStatusSignalV1;

const event: WzhoohPreviewEventV1 = {
  source: "wzhooh-preview",
  protocol: 1,
  sequence: 1,
  timestamp: Date.now(),
  type: "navigation.changed",
  data: { url: "https://preview.test/" },
};
if (event.type === "navigation.changed") event.data.url.toUpperCase();

// @ts-expect-error compile errors require a sanitized error payload
const invalidStatus: BuildStatusSignalV1 = {
  protocol: 1,
  session_id: "12345678-1234-1234-1234-123456789012",
  sequence: 1,
  state: "error",
};
void invalidStatus;

// @ts-expect-error navigation payloads never contain error messages
event.data.message;
