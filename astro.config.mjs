import { defineConfig } from "astro/config";
import { localEdge } from "./scripts/local-edge.mjs";
export default defineConfig({
  devToolbar: { enabled: false },
  output: "static",
  build: { format: "directory" },
  trailingSlash: "never",
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
    routing: { prefixDefaultLocale: false },
  },
  integrations: [localEdge()],
});
