# @wzhooh/vite-plugin

Host-owned Vite 8 plugin for Wzhooh live preview.

## Install

```bash
pnpm add -D @wzhooh/vite-plugin
# or: npm install -D @wzhooh/vite-plugin
```

Vite is a peer dependency and must be installed by the application.

## Configure

```ts
import { defineConfig } from 'vite';
import wzhooh from '@wzhooh/vite-plugin';

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

## Publish

From this directory:

```bash
npm run build
npm pack --dry-run
npm publish --access public
```

The package is scoped to the `wzhooh` npm organization. Every release needs a
new version; never publish the same version twice.
