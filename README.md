## Install

```bash
pnpm add -D @wzhooh/vite-plugin
# or: npm install -D @wzhooh/vite-plugin
```

Vite is a peer dependency and must be installed by the application.

## Configure

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

All options default to `false`. The plugin is for Vite development preview; it
does not inject a bridge into production builds.

## Verify

```bash
npm test
npm run test:coverage
```

Unit and integration tests run on Vitest. The coverage command requires 100%
per file for statements, branches, functions, and lines.
