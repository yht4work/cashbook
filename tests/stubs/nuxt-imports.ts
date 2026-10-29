/**
 * 测试专用 #imports 桩：app 侧前端模块（chatStore 等）在 node 环境跑契约
 * 测试时拿不到真实 nuxt 运行时，这里给最小签名。经 vitest.config.ts 的
 * "#imports" 别名接入，真实 nuxt 由别名替换，不出现在任何运行路径里。
 */
export const useCookie = (_name?: string): { value?: string | null } => ({ value: "test-jwt" });

export const useRoute = (): { fullPath: string } => ({ fullPath: "/chat" });

export const navigateTo = (): unknown => undefined;