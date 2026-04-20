import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: [
      ".agents/**",
      ".tanstack/**",
      ".cursor/**",
      ".opencode/**",
      "apps/**/.git/**",
      "apps/**/.tanstack/**",
      "apps/**/.vscode/**",
      "apps/**/src/env.d.ts",
      "apps/dashboard/src/routeTree.gen.ts",
      "apps/dashboard/src/components/ui/icon.tsx",
      "**/dist/**",
      "**/*.tsbuildinfo",
      "node_modules/**",
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {
    ignorePatterns: [
      ".agents/**",
      ".tanstack/**",
      ".cursor/**",
      ".opencode/**",
      "apps/**/.git/**",
      "apps/**/.tanstack/**",
      "apps/**/.vscode/**",
      "apps/**/src/env.d.ts",
      "apps/dashboard/src/routeTree.gen.ts",
      "**/dist/**",
      "**/*.tsbuildinfo",
      "node_modules/**",
    ],
  },
});
