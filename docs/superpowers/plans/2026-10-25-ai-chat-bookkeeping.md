# AI 记账助手（Chat）V1 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 cashbook 内嵌 AI 对话页：文字/小票图片输入 → 本机 ollama（`glm-5.3-flash:cloud`）解析 → 可编辑确认卡片 → 人工确认后写入 Flow，支持多会话（AI 起名）与失败重试。

**Architecture:** server 端「service（DB/文件逻辑，纯函数可测）+ 薄 handler（SSE 流式中转 ollama）」；前端 Pinia chat store + `chat.client.vue` 页面 + 5 个显式 import 的组件；小票文件复用 `dataPath/images` 与 invoice show 接口。

**Tech Stack:** Nuxt 4.4.2 / h3 / Prisma 7.8 + PostgreSQL(docker 容器 cashbook_db) / Tailwind / Pinia / ollama NDJSON `/api/chat` / vitest（新增，仅测试用）

**Spec:** `docs/superpowers/specs/2026-10-25-ai-chat-bookkeeping-design.md`

## Global Constraints

- 响应包装 `{c,m,d}`（`server/utils/common.ts` 的 `success`/`error`）；鉴权一律 `await getUserId(event)`，归属校验按 userId 过滤。
- 9092 dev server（npm run dev）**归用户所有：绝不 kill/重启**，只发请求。psql 统一 `docker exec cashbook_db psql`（连接串 postgresql→postgres、去 `?schema=public`、标识符加双引号）。
- `.env` 含 `NUXT_AUTH_SECRET` — 签测试 JWT 时绝不打印其值。
- 新组件必须在使用处**显式 import**（dev 自动导入注册表可能不刷新）。
- ollama 配置走 runtimeConfig（nuxt.config.ts）：`ollamaBaseUrl` 默认 `http://localhost:11434`、`ollamaModel` 默认 `glm-5.3-flash:cloud`；**不改 .env**（键可覆盖，默认值生效即可）。
- chat 图片文件名一律 `chat-{sessionId}-{ts}-{n}.{ext}`，落在 `runtimeConfig.dataPath/images`。
- 类型候选（industryType/payType/attribution）一律取自当前 bookId 的 distinct 实际值，AI 编造的类型名一律置空。
- SSE 帧格式：`data: {JSON}\n\n`；JSON 含 `t` 字段：`delta|flows|done|fail`。
- 卡片类型（全项目唯一来源，server/api 前端各处一致）：`\n  day: string; flowType: string; industryType: string; payType: string;\n  money: number; name: string; description: string; attribution: string;\n  invoices: string[]; flowId?: number;`（见 `server/utils/chat/flows.test.ts`）。
- 每个任务结束 `git add <本任务文件> && git commit`（feat/test 前缀 + 结尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`）；只提交本任务文件。
- 工作目录均为 `/mnt/20250209/dev/cashbook/cashbook`。

## Review Focus

按最可能先咬人的排：

1. **ollama 不可达/首包极慢（cloud 模型可 >10s）**——期望：send 先落 user 消息，失败时仍落一条 `status=-1` 的 assistant 消息（错误文案），重试端点不重传图片不重复 user 轮。→ Task 3 不可达抛错测试、Task 5 send 失败路径 curl 验证 + 慢 stream curl `--max-time` 验证断线不丢落库。
2. **图片窗口超限（多轮含图、单次 >6 张）**——期望：只真传最近 3 条含图 user 消息、每次调用 ≤6 张，更早只占位。→ Task 2 history 测试钉死上限。
3. **AI 产出坏 JSON / 编造账本中不存在的类型名**——期望：容忍围栏取首个数组、类型不匹配置空、money/day 归一。→ Task 2 flows 测试钉死。
4. **反代缓冲把流式憋成一大段**——期望：SSE 直连与反代域名都逐字出。→ Task 6 的 curl -N 逐字观察步骤（若用户走域名则按域名验）。
5. **会话删除误删已挂流水的小票文件 / 漏删孤儿**——期望：只删未被该用户任一 `Flow.invoice` 引用的 `chat-*` 文件。→ Task 4 cleanup 测试钉死。

---

### Task 1: Prisma 模型 + migration

**Files:**
- Modify: `prisma/schema.prisma`（追加 ChatSession/ChatMessage，字段与设计文档完全一致）
- Create: `prisma/migrations/20261025*_add_chat_tables/migration.sql`（由 migrate dev 生成）

**Interfaces:** 产出 Prisma client：`prisma.chatSession.create/findMany/findFirst/deleteMany`、`prisma.chatMessage.create/findMany/update`。

- [ ] **Step 1: schema 追加两个 model**（按设计文档 `## 数据模型` 原文，含 status 注释）
- [ ] **Step 2: 生成并应用 migration**

```bash
npx prisma migrate dev --name add_chat_tables
```

预期：新建 `prisma/migrations/*_add_chat_tables/migration.sql`、client 重生成到 `prisma/generated`。

- [ ] **Step 3: 验证表已在库里**

```bash
docker exec cashbook_db psql -c '\dt' | grep -E 'ChatSession|ChatMessage'
```

- [ ] **Step 4: Commit** — `git add prisma/schema.prisma "prisma/migrations" && git commit -m "feat(chat): 新增 ChatSession/ChatMessage 表"`

### Task 2: 纯函数三件套 prompt/history/flows（TDD，折叠 vitest 引入）

**Files:**
- Create: `vitest.config.ts`（devDep `npm i -D vitest`；alias：`~`→`./app`、`~~`→`.`、`@`→`./app`、`@@`→`.`；environment node）
- Create: `server/utils/chat/prompt.ts`、`server/utils/chat/history.ts`、`server/utils/chat/flows.ts`
- Test: `tests/chat/prompt.test.ts`、`tests/chat/history.test.ts`、`tests/chat/flows.test.ts`

**Interfaces:** 产出（后续所有任务依赖）：

```ts
// prompt.ts
buildSystemPrompt(c: { industry: string[]; pay: string[]; attribution: string[]; today: string; imageCount: number }): string
buildTitlePrompt(userText: string, replyText: string): string   // 要求 ≤12 字标题
// history.ts
type ChatTurn = { role: string; content: string; images: string[]; flows?: string }
buildOllamaMessages(system: string, turns: ChatTurn[], readImg: (n: string) => string,
  o: { imageTurnLimit: number; imageTotalLimit: number }): Array<{ role: string; content: string; images?: string[] }>
// flows.ts
type DraftFlow = { day: string; flowType: string; industryType: string; payType: string;
  money: number; name: string; description: string; attribution: string;
  invoices: string[]; flowId?: number }
extractFlowArray(text: string): unknown[] | null
normalizeFlows(raw: unknown[], cand: { industry: string[]; pay: string[]; attribution: string[] },
  dayFallback: string, imageNameOf: (idx: number) => string | null): DraftFlow[]
```

- [ ] **Step 1: 写失败测试**

`flowType` 缺失时 normalize 默认 `"支出"`，`name` 为空则用 "未命名流水"，`imageIdx` 缺省时 `invoices`=该消息全部图，类型候选不匹配时置 `""`。history 钉死：3 轮窗口 / 6 张上限 / 超限占位 `[图x已省略]` / assistant 已入账轮折叠为短摘要。prompt 断言包含拆分规则句与候选列表、today。

- [ ] **Step 2: `npx vitest run tests/chat` → 全部 FAIL（模块不存在）**
- [ ] **Step 3: 实现三模块（body 见本步签名+测试钉死的取值；无既有算法可抄）**
- [ ] **Step 4: `npx vitest run tests/chat` → PASS**
- [ ] **Step 5: Commit** — `git add vitest.config.ts tests/chat server/utils/chat/prompt.ts server/utils/chat/history.ts server/utils/chat/flows.ts package.json package-lock.json && git commit -m "feat(chat): prompt/history/flows 纯函数与 vitest"`

### Task 3: ollama 客户端（流式解析 + thinking 过滤 + 不可达）

**Files:**
- Create: `server/utils/chat/ollama.ts`
- Test: `tests/chat/ollama.test.ts`（起本地 node http mock 服务吐 NDJSON）

**Interfaces:**

```ts
chatStream(cfg: { baseUrl: string; model: string }, messages: unknown[], onDelta: (d: string) => void): Promise<{ content: string }>
chatOnce(cfg: { baseUrl: string; model: string }, prompt: string): Promise<string>
```

请求体 `POST {baseUrl}/api/chat`，`{model, messages, stream, think: false}`；NDJSON 逐行 `message.content` 累积、`message.thinking` 丢弃；正文中的 `// <think>…</think>` 块（含未闭合前缀）从交付文本剔除。不可达/非 200/超时抛 `OllamaError`（带简短中文 message）。

- [ ] **Step 1: 失败测试**（mock 正常流/含 thinking 流/不可达 baseUrl 三例）
- [ ] **Step 2: `npx vitest run tests/chat/ollama.test.ts` → FAIL**
- [ ] **Step 3: 实现 chatStream/chatOnce（fetch + reader 循环）**
- [ ] **Step 4: `npx vitest run tests/chat` → PASS**
- [ ] **Step 5: Commit**

### Task 4: chat service（全部 DB+文件逻辑）

**Files:**
- Create: `server/utils/chat/service.ts`
- Test: `tests/chat/service.test.ts`（prisma 连真实 docker 库，用 `userId=999999`、临时 bookId、测试后 deleteMany 清理；dataPath 指向 `mkdtemp` 目录造图片文件）

**Interfaces (produces)：**

```ts
listSessions(userId: number): Promise<{ id: number; title: string | null; updateDate: Date }[]>  // updateDate 倒序
createSession(userId: number): Promise<{ id: number }>
deleteSession(userId: number, sessionId: number): Promise<void>   // 删消息后清理未引用的 chat-* 文件
getMessages(userId: number, sessionId: number): Promise<Row[]>    // Row: {id,role,content,images,flows,status,createDate}
getContext(userId: number, sessionId: number, bookId: string): Promise<{ system: string; turns: ChatTurn[] }>
appendUserMessage / appendAssistantMessage(...): Promise<void>
updateFailedMessage(userId: number, messageId: number, content: string): Promise<string>  // 返回该轮 user 消息的 images，重试用
saveCard(userId, messageId, index, card: DraftFlow, bookId: string): Promise<{ flowId: number }>
ensureTitle(userId: number, sessionId: number, userText: string, replyText: string): Promise<string | null>
```

- [ ] **Step 1: 失败测试**：sessions 排序/删除含消息；updateDate 在 append 后刷新；清理规则——造 `chat-1-x.png`（被测试 Flow.invoice 引用）与 `chat-2-y.png`（未引用），deleteSession 后 y 无、x 在；saveCard：建 Flow、写回 flowId、全卡齐后 status=1。
- [ ] **Step 2: run → FAIL**
- [ ] **Step 3: 实现（prisma + fs，候选值查询：distinct industryType/payType + getAttributions 同法 + 最近 5 条 Flow 摘要注入）**
- [ ] **Step 4: run → PASS**
- [ ] **Step 5: Commit**

### Task 5: 只读写端点（sessions/messages）+ 鉴权烟测

**Files:**
- Create: `server/api/entry/chat/sessions.get.ts`、`sessions.post.ts`、`sessions.delete.ts`（query `?id=`）、`messages.get.ts`（query `?sessionId=`）

每个 handler ≤10 行：getUserId → service.* → success()。写一条 swagger jsdoc（照 add.ts 风格，简短）。

**Interfaces:** `success(error)` 包装已定；service 已定。

- [ ] **Step 1: curl 烟测**（签 JWT：`/tmp` 下临时 node 脚本，用 `jsonwebtoken` + `dotenv` 读 .env，cookie `Authorization=<JWT>`; `curl -b` 调四个端点：空列表 success、建/删往返一致；未带 token 返回空数据不崩）
- [ ] **Step 2: Commit**

### Task 6: send/retry/save 端点（SSE 中转核心）

**Files:**
- Modify: `nuxt.config.ts`（runtimeConfig 增 `ollamaBaseUrl: "http://localhost:11434"`、`ollamaModel: "glm-5.3-flash:cloud"`，NUXT_* 环境变量可覆盖）
- Create: `server/api/entry/chat/send.post.ts`、`retry.post.ts`、`save.post.ts`、`server/utils/chat/sendCore.ts`

**Interfaces:** SSE 帧 `data: {"t":"delta","d":"…"}` / `{"t":"flows","flows":DraftFlow[]}` / `{"t":"done","messageId":number}` / `{"t":"fail","m":"错误文案"}`；send 与 retry 共享 sendCore 的主循环（组装上下文→chatStream→解析→落库→起名）。

- [ ] **Step 1: sendCore + send.post.ts**：readFormData → 校验归属 → service 存图/appendUserMessage → `createEventStream(event)`（h3 API；若导出缺失则手写 SSE 头 + ReadableStream，一行注释即可）→ delta 逐帧 → 完整 content 后 extractFlowArray+normalize → `flows` 帧 → 落库 assistant 消息 → ensureTitle（静默）→ `done` 帧；任何异常走 `fail` 帧 + `updateFailedMessage`。
- [ ] **Step 2: retry.post.ts**：查 status=-1 的消息 → `updateFailedMessage` 取回 user 轮 images → 走同一 sendCore 再生成（不存图、不重复 user 消息）。
- [ ] **Step 3: save.post.ts**：service.saveCard → success。
- [ ] **Step 4: curl 流式烟测**：签 JWT（同 Task 5 脚本），`curl -N -F sessionId=<id> -F 'text=昨天午饭35' ... /api/entry/chat/send`，观察 delta 帧逐条到达、末帧 done；messages.get 可见回复。
- [ ] **Step 5: retry 冒烟**：对不存在/已成功的 messageId 调 retry 返回 error；真实停服场景的端到端留给 Task 10（需用户配合停 ollama）。
- [ ] **Step 6: Commit**

### Task 7: 前端壳：入口 + store + 会话面板

**Files:**
- Modify: `app/components/layout/AppSidebar.vue`（items 增「AI 记账」path `chat`，`ChatBubbleLeftRightIcon`）
- Modify: `app/components/layout/AppBottomNav.vue`（「账本」项替换为「AI 记账」）——注意底栏是移动端主入口，验收含此
- Create: `app/utils/chatStore.ts`（pinia；state: sessions/currentId/messages/streaming；actions: loadSessions/create/delete/loadMessages/send/saveCard —— send 用 `fetch` + ReadableStream 解析 `data:` 帧；不引新依赖）
- Create: `app/pages/chat.client.vue`（`definePageMeta({ layout: "public" })`，与其它 *.client.vue 一致）+ 骨架：左会话栏（桌面）/抽屉（移动）、空态引导「拍张小票扔进来，或直接说：昨天午饭 35」
- Create: `app/components/chat/ChatSessionsPanel.vue`（列表/新建/删除走 GlobalConfirm；样式语言照 FlowEditDialog/侧栏的 surface-token）
- Test: playwright 截图对照（见 Step 3）

**Interfaces:** store actions 与 Task 6 SSE 帧类型一致；页面 `useChatStore()` 显式 import。

- [ ] **Step 1: 写组件 + store（显式 import；样式遵循 surface/ink/brand token，暗色齐备）**
- [ ] **Step 2: dev server 9092 上，用 playwright 验证**（工具：`/tmp/cb-shot/` playwright-core + chrome `~/.cache/ms-playwright/chromium-1208/...` --no-sandbox；JWT cookie `Authorization` + localStorage `bookId/bookName`）截图：桌面双栏、移动（640px）汉堡+底栏五项含「AI 记账」且无「账本」、新建/删除会话闭环。
- [ ] **Step 3: Commit**

### Task 8: 消息流 + 输入区 + 流式渲染

**Files:**
- Create: `app/components/chat/ChatMsgList.vue`、`ChatMsgItem.vue`、`ChatComposer.vue`
- Modify: `app/pages/chat.client.vue`

**Interfaces:** user 气泡（图缩略，点击开 show 大图）、assistant 流式打字光标；`send(text, files)` 锁输入；SSE delta 追加 `streaming.content`。

- [ ] **Step 1: 实现三组件（显式 import 进 page/parent）**
- [ ] **Step 2: playwright**：发「昨天午饭35」→ delta 逐字出现 → 回复落库 → 刷新仍可见 → 无 console 报错。
- [ ] **Step 3: Commit**

### Task 9: 确认卡片（编辑、小票勾选、入账）

**Files:**
- Create: `app/components/chat/ChatDraftCard.vue`
- Modify: `app/components/chat/ChatMsgItem.vue`、`app/utils/chatStore.ts`（saveCard 实现）

**Interfaces:** prop `card: DraftFlow`、`editing: boolean`；day 用 `UiDatePicker`（显式 import from `~/components/ui/DatePicker.vue`）；类型 `industryType/payType` 走 `getIndustryType/getPayType` 候选 + 自由文本留空；attribution 同法（getAttributions API）；账本切换用 `doApi.post<Book[]>("api/entry/book/list", {})`（参照 `app/components/dialog/BookDialog.vue:269` 的写法）。入账成功 → 卡片角标「已入账」+ 链接 `/flows`；小票缩略图勾选=card.invoices 增删。

- [ ] **Step 1: 实现**
- [ ] **Step 2: playwright 端到端**：建测试账本（借 BookDialog）→ 发含 2 商品小票（PIL 生成图）→ 2 卡 → 各自改类型/删一张小票 → 双双入账 → psql 确认 2 条 Flow、invoice 挂对 → 删测试账本、删会话（确认 chat 未引用图片被清、被引图残留）。
- [ ] **Step 3: Commit**

### Task 10: AI 起名 + 重试 UI + 最终验收清单

**Files:**
- Modify: `app/components/chat/ChatSessionsPanel.vue`（标题实时更新）
- Modify: `app/pages/chat.client.vue`（失败消息重试按钮挂 `retry`）
- Create: `docs/superpowers/plans/2026-10-25-ai-chat-bookkeeping-acceptance.md`(最终验收记录清单)

- [ ] **Step 1: ensureTitle 接线**：send 完成后 `chatOnce(buildTitlePrompt(...))`（已含在 Task 4 service + Task 6 handler —— 本步补 UI 实时刷新与「失败回退截断」）
- [ ] **Step 2: 重试按钮**：status=-1 消息渲染重试 → `chatStore.retry(messageId)` → 流式重生成替换
- [ ] **Step 3: 按设计文档 `## 验收` 全清单过一遍**（ollama 真停服场景需用户配合时，标注「用户可自测」；其余全部自动化/半自动化完成并打钩）
- [ ] **Step 4: Commit**

## 提交纪律

- 每任务一提交；提交消息中文 + `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 结束前运行 superpowers:verification-before-completion。