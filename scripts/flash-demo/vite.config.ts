// scripts/flash-demo/vite.config.ts — dev-only demo of the flash ladder's
// triggers and 自動停損停利 (#216), for design screenshots without a sidecar:
//   pnpm exec vite --config scripts/flash-demo/vite.config.ts --port 5297
// then open /?theme=dark (or light). Same idea as the panel's ?condDemo: the
// panel's quote, account and conditional-order hooks are swapped for fixed
// sample data; nothing can be sent (orders and triggers resolve to nothing).
// Never part of a build.

import path from 'node:path';
import { vanillaExtractPlugin } from '@vanilla-extract/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = path.resolve(__dirname, '../..');
const src = (p: string) => path.resolve(root, 'src', p);
const stub = (p: string) => path.resolve(__dirname, 'stubs', p);
const REDIRECT: Record<string, string> = {
    [src('hooks/use-stream.ts')]: stub('use-stream.ts'),
    [src('hooks/use-display-book.ts')]: stub('use-display-book.ts'),
    [src('hooks/use-flash-ladder.ts')]: stub('use-flash-ladder.ts'),
    [src('lib/account-store.ts')]: stub('account-store.ts'),
    [src('lib/flash-conditional.ts')]: stub('flash-conditional.ts'),
    [src('lib/trade.ts')]: stub('trade.ts'),
};

function demoStubs(): Plugin {
    return {
        name: 'flash-demo-stubs',
        enforce: 'pre',
        async resolveId(source, importer, options) {
            if (!importer || importer.startsWith(path.resolve(__dirname, 'stubs'))) return null;
            const r = await this.resolve(source, importer, { ...options, skipSelf: true });
            return r && REDIRECT[r.id] ? REDIRECT[r.id] : null;
        },
    };
}

export default defineConfig({
    root: __dirname,
    plugins: [demoStubs(), react(), vanillaExtractPlugin()],
    resolve: { alias: { '@modules': src('modules-stub/index.ts') } },
    define: {
        'process.env': {},
        __STATSIG_CLIENT_KEY__: JSON.stringify(''),
        __SHIOAJI_APP_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_BUILD_VERSION__: JSON.stringify('demo'),
        __SHIOAJI_SERVER_VERSION__: JSON.stringify('demo'),
    },
    server: { fs: { allow: [root] } },
});
