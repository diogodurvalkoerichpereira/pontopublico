// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
// @cloudflare/vite-plugin builds from this — wrangler.jsonc main alone is insufficient.
//
// nitro explícito porque o plugin do Lovable só ativa o Nitro dentro do sandbox
// dele (shouldRunNitro = explicitNitro || isSandbox). Sem isto, `vite build`
// fora do Lovable não emite servidor algum e não há o que subir em container.
// Preset node-server: o deploy é Docker/Coolify, não Cloudflare Worker.
//
// allowedHosts por ambiente para não fixar domínio no código.
const previewHosts = (process.env.PREVIEW_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  nitro: {
    preset: "node-server",
  },
  vite: {
    preview: {
      allowedHosts: previewHosts,
    },
  },
});
