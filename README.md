# @wzhooh/vite-plugin

Vite integration for Wzhooh live previews in a sandboxed iframe.

## Install

```bash
npm install -D @wzhooh/vite-plugin@0.0.3
```

## Configure

Add the plugin to the Vite config used by the Wzhooh preview:

```ts
import { defineConfig } from "vite";
import wzhooh from "@wzhooh/vite-plugin";

export default defineConfig({
  plugins: [
    wzhooh({
      hmrNotifier: true,
      navigationNotifier: true,
      errorNotifier: true,
      buildStatus: true,
      forwardConsole: true,
    }),
  ],
});
```

The plugin reports HMR updates, navigation and runtime errors to the parent
preview. `buildStatus` lets the backend read the latest build state.

## Test

```bash
npm test
```
