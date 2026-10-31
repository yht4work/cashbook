import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 与 nuxt 的路径别名保持一致：tests 里可以用 ~ / ~~ / @ / @@ 引用 app 与根目录
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    // server 侧纯函数测试，不需要 DOM
    environment: "node",
    // Task 4 起 prisma 测试需要数据库地址：统一在这里预载 .env（dotenv 已在 devDependencies）
    setupFiles: ["./tests/setup.ts"],
  },
  resolve: {
    alias: {
      "~": path.join(root, "app"),
      "~~": root,
      "@": path.join(root, "app"),
      "@@": root,
      // store 级前端契约测试用：app 模块 import 的 #imports 在 node 测试环境
      // 无真实 nuxt 运行时，指到最小桩（tests/stubs/nuxt-imports.ts）
      "#imports": path.join(root, "tests/stubs/nuxt-imports.ts"),
    },
  },
});
