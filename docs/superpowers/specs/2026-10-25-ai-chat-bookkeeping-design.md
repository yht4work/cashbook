# AI 记账助手（Chat）设计文档

日期：2026-10-25
状态：已与需求方对齐并经 builder check 澄清；等待人工批准后进入计划阶段

## 意图与背景

在 cashbook 中内嵌一个 AI 对话页：用户在对话中上传小票/发票图片或直接打字，
由 AI 解析出流水内容，弹出**可编辑确认卡片**，用户确认后写入账本（Flow 表）。
支持多会话（可新建/删除）。这是该功能的 **V1：只做「记账」（写流水）**，
「查账/查询分析」留作二期。

### 已验证的技术事实

- 本机 ollama 已安装且由 systemd 运行：`ollama 0.32.14`，服务地址
  `http://localhost:11434`。
- `glm-5.3-flash:cloud` 已拉取，capabilities：completion / thinking / tools /
  **vision**（`:cloud` 为 ollama 云托管模型，本地只需调用服务，不需 GPU）。
- 实测（2026-10-25）：向 `/api/chat` 发送带 base64 图片的消息，模型准确输出
  结构化 JSON（商户/明细/总额/日期）。不需要额外 OCR。
- 项目已有小票图片基础设施：`Flow.invoice`（逗号分隔文件名）、
  `POST /api/entry/flow/invoice/upload`（multipart 文件存 `dataPath/images`）、
  `GET /api/entry/flow/invoice/show?invoice=文件名`（浏览器直接显示）。

### 前端形态（拍板结果）

- 侧边栏新增「AI 记账」入口 → 路由 `/chat`，完整 chat 页面（不是对话框）。
- 多会话：会话列表、新建、删除（删除走现有 GlobalConfirm 确认）。
- 消息：用户气泡（文字+图片缩略图）、assistant 回复（流式逐字、
  简单 markdown 换行）。
- AI 解析完成的流水以**可编辑卡片**内嵌在 assistant 消息中：
  字段与 FlowEdit 对齐（day、flowType、industryType、payType、money、name、
  description、attribution、bookId），默认值按 AI 提取结果，用户可改，
  点「入账」保存；保存成功后卡片状态变为「已入账」，可回看。
- **纯文字记账**：直接说「昨天午饭 35」，同样出卡片。
- 一条 assistant 消息可包含 **多张卡片**（JSON 数组）。拆分规则（需求方原话
  定调）：**一条流水对应一个单项**——去一间店买了 2 种零食就是 2 条流水，
  每条 name=单项名、money=单项价；同一张小票图**默认挂到由它产生的所有
  卡片**（review 优先，允许先挂重复，入账前用户可在卡片上增删小票）。
- AI 不静默写库：所有写入都必须经人工点「入账」。
- 移动端：底部导航（AppBottomNav）把「账本」项**替换**为「AI 记账」——
  账本切换功能本就融入在头部账本弹窗等子页里，日常不需要单独一级入口；
  「账本管理」页仍保留在侧边栏（汉堡菜单）里可达。

## 约束（必须遵守的项目现状）

- 技术栈：Nuxt 3 + h3 server + Prisma（PostgreSQL）+ Tailwind + Pinia。
- API 响应统一 `{c, m, d}` 包装（`server/utils/common.ts` 的 success/error），
  鉴权为 `getUserId(event)`（`Authorization: JWT` header）。
- 前端统一走 `app/utils/api.ts` 的 `doApi.get/post/postform`；当前账本
  `bookId`/`bookName` 在 localStorage，卡片默认 bookId 取当前值。
- 页面均为 client-only（`.client.vue`），chat 页新建
  `app/pages/chat.client.vue`。
- **Nuxt dev 自动导入有坑：新组件必须在父组件显式 import**，否则
  "Failed to resolve component"。
- 组件命名习惯：`layout/*`、`dialog/*`、`flows/*`、`datas/*`；新增建议
  `app/components/chat/*`。
- 类型体系：`industryType`（收入/支出类型）、`payType`、`attribution`
  均为**每账本自定义**字符串（含 TypeRelation 转换规则）。AI 的候选值
  必须来自当前账本的实际取值，不能硬编码。
- **部署目标（需求方确认）**：本期只验证原生 `npm run dev`（9092）+
  本机 ollama；docker 部署与反代只留配置说明（见非目标），不做验收项。
  浏览器访问方式直连/反代域名**都可能**，SSE 流式必须两者都兼容。
- 运行机器为树莓派（arm64），ollama 模型走 `:cloud`，本地负载可忽略。

## 目标 / 非目标 / 反目标

**目标（V1 全部完成）**

1. 侧边栏「AI 记账」入口 + `/chat` 页面（桌面 & 移动响应式）。
2. 会话：列表、新建、删除、**AI 自动起名**（首条对话完成后生成；失败回退
   首条消息截断）。
3. 消息：发送文字、附多张图片；assistant 流式回复；历史持久化（刷新/换端可回看，
   含历史卡片状态）。
4. AI 解析：小票/发票图片（jpg/png）与纯文字 → 流水草稿 JSON（数组）。
5. 确认卡片：字段编辑、账本/类型切换、入账成功后卡片固化「已入账」+ 流水链接。
6. 入账时图片自动挂到该流水的 `invoice` 字段（复用 images 存储与 show 接口）。
7. 配置：`.env` 新增 `NUXT_OLLAMA_BASE_URL`（默认 `http://localhost:11434`）、
   `NUXT_OLLAMA_MODEL`（默认 `glm-5.3-flash:cloud`）。

**非目标（二期）**

- 查账（读流水/统计的读工具）。
- 对话内修改/删除已入账流水（回复里可给流水页面跳转，让用户去流水管理改）。
- 每用户自定义模型配置（本期用全局 .env）。
- Docker 部署的适配与实测：文档附两句配置说明（容器内
  `OLLAMA_BASE_URL=http://<宿主机IP>:11434`——ollama 已监听全部网卡；
  反代域名下 nginx 需 `proxy_buffering off` / Caddy 默认透传即可），
  不作实现与验收。
- 多模型/OpenAI SDK 兼容层等通用化设计。

**反目标（出现即算失败）**

- AI 绕过确认直接写库，或前端可直接调 ollama（服务端中转，密钥与内网地址不出后端）。
- AI 输出的类型/账本不校验就入库（必须落在账本实际拥有的类型里或留空）。
- 把消息历史整段丢弃、每次全量重发导致上下文爆炸（必须截断 + 只传文件名，
  图片由服务端从磁盘读，避免前端重复传 base64）。

## 数据模型（新增 Prisma models，需要 migration）

```prisma
model ChatSession {
  id         Int       @id @default(autoincrement())
  userId     Int
  title      String?
  createDate DateTime  @default(now())
  updateDate DateTime  @default(now())
  messages   ChatMessage[]
}

model ChatMessage {
  id         Int         @id @default(autoincrement())
  sessionId  Int
  userId     Int
  role       String      // "user" | "assistant"
  content    String?     // 文本部分
  images     String?     // 逗号分隔文件名（user 消息）
  flows      String?     // 序列化的流水草稿数组 JSON（assistant 消息），每项:
                         // {day,flowType,industryType,payType,money,name,
                         //  description,attribution,invoices:string[],
                         //  imageIdx?:int[], flowId?:int}
                         // invoices=小票文件名（最终以用户在卡片上的增删为准）；
                         // imageIdx=AI 对来源图的序号（仅预填用，服务端映射成文件名）；
                         // flowId=该卡入账后由 chat/save 写回的 Flow.id
  status     Int?        // assistant 消息状态：
                         //   0 = 正常（含纯文字回复、或卡片尚有未入账）
                         //  -1 = 生成/解析失败（content 为错误文案）
                         //   1 = 该消息所有卡片均已入账（派生：每卡均有 flowId）
  createDate DateTime    @default(now())

  @@index([sessionId, id])
}
```

> 草稿卡片本身不单独建表：它属于某条 assistant 消息的 `flows` 字段，
> 入账动作由 chat/save 端点原子地「创建 Flow + 回写消息状态」。

## 服务端（`server/api/entry/chat/*` 新目录）

统一 `getUserId` 鉴权，按 userId 过滤归属；返回走 success/error。

1. **会话 CRUD**
   - `GET  /api/entry/chat/sessions` — 列表（按 updateDate 倒序）。
   - `POST /api/entry/chat/sessions` — 新建（title 先空）。
   - `DELETE /api/entry/chat/sessions/:id` — 删除会话及其消息；
     同时清理磁盘上的 `chat-*` 文件：**只删未被该用户任一 `Flow.invoice`
     引用的**（已挂到流水上的小票图随流水保留，避免凭证失效）；
     未入账会话的图片则一并释放，不做孤儿图片的定期清扫端点（二期再说）。
   - `GET /api/entry/chat/messages/:sessionId` — 消息列表。

2. **发送消息（核心端点）** `POST /api/entry/chat/send`
   - multipart：`sessionId`、`text`、`images[]`（可选多张）、`bookId`
     （前端从 localStorage 带上，供类型候选与上下文注入）。
   - 存图片：复用 `dataPath/images`，文件名 `chat-{sessionId}-{ts}-{n}.{ext}`；
     把文件名存入新 user 消息。校验 sessionId 归属当前用户。
   - **持久化时序（builder check 定案）**：user 消息（含图片）**先落库，
     再调 ollama**；无论成功与否不重复存文件。任何情况下客户端断开
     （关页面/超时）都**不中断生成**：服务端继续生成并落库 assistant 消息。
   - 组装 ollama 请求：
     - system prompt：任务=从对话/图片提取流水；输出=严格 JSON 数组
       （字段见 flows 结构，`bookId` 不要求 AI 给——UI 已控制账本）；
       提供该账本的候选值列表（industryType/payType/attribution 由服务器
       用 prisma 取该 bookId 的 distinct 取值注入；缺类型就 `""`，
       禁止 AI 编造新类型名）。
     - **拆分规则（写进提示词）**：一张小票内多个可识别单项 → **每单项
       一条流水**（name=项名、money=单项价），该消息内对应卡片共享同一张
       小票图；只有总额可读时才记一条；金额明显对不上（减免/凑整）优先按
       可识别单项，总价放 description。
     - 图片编号：随消息注入时标「图1、图2…」，AI 在卡片上用
       `imageIdx` 引用来源（仅预填用）；无法对应时缺省。
     - history：最近 20 条消息；**图片窗口**：只把**最近 3 条含图 user
       消息**的图片真传（每次调用最多 6 张，服务端读 `dataPath/images`
       转 base64），更早轮次的图片只以 `[图x已省略]` 占位——防历史
       轮次重复携带 base64 撑爆上下文/延迟。
   - 调用 `POST {OLLAMA_BASE_URL}/api/chat`，`stream: true`；
     **SSE 流式转发**给前端（逐字），结束帧携带完整结果。
     （直连与反代域名都必须能逐字出：见反代注意事项。）
   - 解析：从完整回复中提取 JSON 数组（容忍 markdown 围栏）→
     校验（money 数字、day 格式 YYYY-MM-DD、候选类型匹配 else 置空）→
     存为 assistant 消息（flows=JSON, status=0）。
   - **失败落库（builder check 定案）**：ollama 不可达/超时/解析失败时，
     **也写入一条 assistant 消息**（content=错误文案，status=-1），
     不让历史留下悬空的 user 轮；前端在失败消息下面给「重试」。

3. **重试** `POST /api/entry/chat/retry`
   - body：`messageId`（失败的 assistant 消息）。
   - 校验归属后：**不重传图片、不新建文件、不重复 user 消息**——
     直接取该消息所属 user 轮（前一条），重新组装并再走一遍生成与解析，
     覆盖失败消息（或更新其 content/flows）。

4. **确认入账** `POST /api/entry/chat/save`
   - body：`messageId`、`index`（卡片在 flows 数组里的下标）、
     `card`（用户编辑后的完整流水字段，含用户最终勾选的 `invoices`）、
     `bookId`。
   - 逻辑：按 userId+messageId 取出原 flows，用编辑后的 card 替换该 index；
     `prisma.flow.create`（`invoice` = card.invoices 逗号拼接）；
     把返回的 `Flow.id` 写回该卡片的 `flowId`；全部卡片都有 flowId 时
     该消息 status=1，否则保持 0（**状态不再单独存 flowIds**，
     前端跳转链接直接读卡片内的 flowId）。
   - 一条消息里多张卡片各自独立 save。

5. **（builder 细节）**
   - SSE/NDJSON 转发的具体实现；ollama 不可达/超时（cloud 模型首包可能
     >10s）的展示口径（失败落库已定，剩前端样式与文案）。
   - 会话标题：**AI 起名**——首次生成成功落库后，后台追加一次小请求
     （非流式，带首条 user 消息 + 回复摘要，要求输出 ≤12 字短标题），
     更新会话 title；起名失败静默回退为「首条消息前 20 字」，不打扰
     对话流；后续消息不再重命名（V1）。会话列表实时反映新标题。
   - thinking 输出不发给前端（只取 content；若模型吐 `think` 标签则剔除；
     流式时直接丢弃对应帧）。

## 前端

1. **入口**：`AppSidebar.vue` items 增 `{"AI 记账", path: "chat"}`
   （heroicon `ChatBubbleLeftRightIcon`）；`AppBottomNav.vue` 的「账本」项
   **替换**为「AI 记账」（其余 4 项不动，账本切换走头部账本弹窗）。
2. **页面** `app/pages/chat.client.vue`：
   - 桌面：左侧会话栏（可收起）+ 右侧消息区；移动：会话栏为抽屉。
   - 顶部：当前会话标题 + 新建会话按钮；空会话显示引导示例（"拍张小票扔进来，
     或直接说：昨天午饭 35"）。
   - 消息流：user 右对齐气泡（含图片缩略图，点击看大图用 show 接口）；
     assistant 左对齐，流式打字中显示光标。
   - 确认卡片：内嵌 assistant 消息流中；字段布局复用/参照
     `FlowEdit`（流水编辑对话框）的表单控件与样式语言；「入账」确认前
     二次确认可选（复用 GlobalConfirm）。
   - 输入区：textarea + 图片选择按钮（`<input type=file multiple>`）+
     发送按钮；发送期间禁用；流式期间允许查看但输入锁定。
   - Pinia store（`app/utils/store.ts` 惯例）管会话/消息状态。
3. **组件清单**（每个都要在使用处显式 import，防 dev 自动导入坑）：
   `ChatSessionsPanel`、`ChatMessages`、`ChatMessageItem`、
   `ChatDraftCard`、`ChatComposer`。
4. 保存成功后可选择「去流水管理看看」（页面跳转 /flows），不强制。

## 验收

- 上传多张小票 + 一句话 → 回复逐字流式 → N 张卡片 → 改类型/账本 → 入账 →
  流水管理页可见新流水且 invoice 图片可显示；消息状态为已入账。
- **一张小票拆多项**：去詹记买 2 种零食的小票 → 2 条流水，两条都挂这同一张
  小票图；在卡片上手动去掉一条的小票 → 入账后该流水 invoice 为空，另一条不受影响。
- 刷新页面重进会话：历史与卡片状态（含已入账卡片的流水跳转）完整保留。
- 删除会话：确认后消失且不再出现在列表；已入账流水的 invoice 图片仍能打开。
- 纯文字「昨天午饭 35」→ 一张卡片，day 自动取昨天，bookId 默认当前账本。
- ollama 停服时：发送后 user 消息已保留，assistant 落一条失败消息 + 重试按钮，
  点重试能恢复生成，全程不白屏不假死。
- 失败后刷新页面：该会话历史依然连续（无悬空 user 轮），重试仍可用。
- 直连 9092 与（如经反代）域名访问下，流式都能逐字出现。
- 移动端（<1024px）：底部导航为 预算/分析/日历/流水/**AI 记账** 五项，
  「账本」不再出现在底栏；头部账本切换弹窗仍可用；汉堡侧栏里仍有账本管理。
- 不产生 AI 静默写入的流水（数据库无未经人工确认的记录）。