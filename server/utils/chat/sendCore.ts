/**
 * chat 写端点的接线核心：HTTP 形参整形、基础校验与 SSE 主循环全部集中在
 * 这层，send/retry/save.post.ts 只剩 <10 行的 try/catch 壳。
 *
 * - service 不读 env/runtimeConfig，ollama cfg 与 dataDir 由 handler 从
 *   useRuntimeConfig 取出后接进来（本文件不再读配置）；
 * - SSE 帧：`data: {单行JSON}\n\n`，t = delta / flows / done / fail。
 *   h3 1.x 的用法是先 `stream.send()`（响应头与无缓冲管道就位、_handled=true，
 *   返回该对象本身不会被 h3 再序列化），生成循环从旁推进、逐帧 push、
 *   结束 close——不能像旧文档那样直接 return 事件流对象。
 * - 客户端断开不中断生成：onDelta 的写帧失败一律吞掉（ollama.ts 的
 *   onDelta 回调若上抛会被误标成 OllamaError，把客户端断开当模型错误，
 *   这是特意防住的接线契约）；生成 / 解析 / 落库照常走完，帧丢弃即可。
 * - 落库时序（别双写）：send = 存图 → user 行 → 生成 → append assistant 行；
 *   retry = 校验（本人 + status=-1）→ 截掉失败轮再生成 → 只更新失败行自身
 *   （成功走 finalizeFailedRetry 一次落齐 content/flows/status，失败走
 *   updateFailedMessage 替文案并保持 -1），不重复 user 消息、不重传图、
 *   不建新文件。
 *
 * prisma 分工说明：service 拥有全部数据面，本文件零 prisma 直连（终审
 * M5：retry 的 flows/status 收尾沉为 service.finalizeFailedRetry 的单条
 * 带归属 updateMany；取行也走 service 的 findFirst 函数，不整表 load）。
 */

import * as service from "~~/server/utils/chat/service";
import { buildOllamaMessages, planImages } from "~~/server/utils/chat/history";
import { extractFlowArray, normalizeFlows, type DraftFlow } from "~~/server/utils/chat/flows";
import { chatStream, OllamaError, type OllamaCfg } from "~~/server/utils/chat/ollama";
import { createEventStream, readFormData, type H3Event } from "h3";
import { error, getUserId, success } from "~~/server/utils/common";
import path from "node:path";

/** handler 从 useRuntimeConfig 接出的配置包 */
export type ChatWiring = { dataDir: string; cfg: OllamaCfg };

type TurnArgs = {
  userId: number;
  sessionId: number;
  bookId: string;
  dataDir: string;
  cfg: OllamaCfg;
} & (
  | { mode: "send"; userImages: string[]; userText: string }
  | { mode: "retry"; retryId: number }
);

/** SSE 通道：send() 先行（响应头一次成型），之后帧写入，写失败全吞 */
const makeStream = (event: H3Event) => {
  const stream = createEventStream(event);
  void stream.send().catch(() => {});
  const push = (frame: Record<string, unknown>): void => {
    try {
      void Promise.resolve(stream.push(JSON.stringify(frame))).catch(() => {});
    } catch {
      // 客户端已断开：帧丢弃，主循环照常
    }
  };
  return { stream, push };
};

/** 空回复占位文案（终审 M3）：模型只回了空数组时不让字面 "[]" 长驻气泡 */
const EMPTY_REPLY_TEXT = "未识别到记账内容，可以直接说金额，例如：昨天午饭 35";

/**
 * 失败文案（终审 M2）：气泡里只给短中文，原始系统错误（fs/网络栈）不外露，
 * 原文只进 console 日志。透传两类：OllamaError 的中文文案；本功能自己抛的
 * 中文 Error（如「入账账本不存在」）。其余按 code 分类映射兜底。
 */
const failRowOf = (err: unknown): string => {
  if (err instanceof OllamaError) {
    const m = (err as Error).message ?? "";
    return m || "生成失败";
  }
  const code = String((err as NodeJS.ErrnoException)?.code ?? "");
  if (code === "ENOENT") {
    return "小票文件缺失，无法生成该消息";
  }
  if (code === "EACCES" || code === "EISDIR" || code === "EMFILE") {
    return "小票文件无法读取，无法生成该消息";
  }
  const raw = String((err as Error)?.message ?? err ?? "");
  // 中文开头的 message 视为本功能的用户文案（直接透传）；英文开头的原始
  // 系统错误一律兜底，不给用户看栈内容
  if (raw && !/^[A-Za-z]/.test(raw)) {
    return raw;
  }
  return "生成失败，请稍后重试";
};

/**
 * 一轮生成的共享主循环：上下文 → 流式逐字 → 解析归一 → flows 帧 → 落库
 * → ensureTitle → done 帧；任何一步失败走 fail 帧并落失败行（send=新追
 * 一条，retry=替换失败行自身——绝不多写一份）。
 */
const runTurn = async (event: H3Event, a: TurnArgs): Promise<void> => {
  const { stream, push } = makeStream(event);
  try {
    // 1. 上下文：retry 把失败轮自身截出去（不重复 user 消息、不重传图）
    const ctx = await service.getContext(
      a.userId,
      a.sessionId,
      a.bookId,
      a.mode === "retry" ? { beforeId: a.retryId } : undefined
    );

    // 2. 图计划单一事实源（终审 M1）：与 buildOllamaMessages 共享同一个
    //    plan——只有真传集里的图才读盘，缺票半径收紧到真传的图（占位的
    //    历史图文件坏了不再拖死整轮）；编号表仍派生 byIndex 反查与 prompt
    //    的 imageCount（consistency 测试钉死的同源）。文件缺失走 fail 路径。
    const plan = planImages(ctx.turns, service.CHAT_IMAGE_WINDOW);
    const imgMap = await service.loadImages(
      a.dataDir,
      [...plan.attached].map((i) => plan.numbered[i - 1]).filter((n): n is string => !!n)
    );

    // 3. 逐字流式；首个可见帧前吞掉 think 剥离残留的前导空行
    let began = false;
    const onDelta = (d: string): void => {
      if (!began) {
        d = d.replace(/^\s+/, "");
        if (!d) {
          return;
        }
        began = true;
      }
      push({ t: "delta", d });
    };

    // 4. 生成（ollama.ts 剥 think；onDelta 写帧失败已在 push 内吞掉）
    const out = await chatStream(a.cfg, buildOllamaMessages(ctx.system, ctx.turns, (n) => imgMap.get(n) ?? "", service.CHAT_IMAGE_WINDOW), onDelta);
    const reply = (out.content ?? "").trim(); // 落库正文 trim（流式侧同源处理）

    // 5. 解析 + 归一 → flows 帧（无 flowId/imageIdx；invoices=最终文件名）。
    //    V1.2 反馈：回复不强制只有卡片——正文取不到 JSON 数组即纯文字回复
    //    （正常落一条无卡片的 status=0 行），不再判「解析失败」；取到数组
    //    则归一，卡片带上按账本名映射的 bookId（与 prompt 同源候选）。
    const raw = extractFlowArray(reply);
    const current = a.mode === "retry" ? (ctx.turns.at(-1)?.images ?? []) : a.userImages;
    let flows: DraftFlow[] = [];
    if (raw) {
      flows = normalizeFlows(
        raw,
        ctx.cand,
        ctx.today,
        {
          default: () => current, // 本次 user 消息的图（别的轮不搭便车）
          byIndex: (i) => plan.numbered[i - 1] ?? null, // 图i ← 全局编号表反查
        },
        { books: ctx.books, currentBookId: a.bookId }
      );
      push({ t: "flows", flows });
    }
    const flowsJson = raw ? JSON.stringify(flows) : null; // 纯文字回复 flows 落 null

    // 6. 落库 assistant 行（done 帧的 id）+ 起名（静默）→ done 帧。
    //    气泡文案：有卡片 → 模型原文；空数组/纯空且模型没说别的 → 占位
    //    文案（终审 M3：不让字面 "[]" 长驻气泡）。
    const stored = flows.length || reply.replace(/[\[\]\s]/g, "") ? reply : EMPTY_REPLY_TEXT;
    let messageId = a.mode === "retry" ? a.retryId : 0;
    if (a.mode === "send") {
      await service.appendAssistantMessage(a.userId, a.sessionId, stored, flowsJson, 0); // 新卡片未入账 → 0
      messageId = await service.lastMessageId(a.userId, a.sessionId); // 终审 M4：findFirst 取最新一行
    } else {
      // 收尾终审 M5：content+flows+status 单条带归属的 updateMany 一次落
      // 齐（原「content 一条 + flows/status 一条」的双语句竞态窗口就此消除）
      if (!(await service.finalizeFailedRetry(a.userId, a.retryId, stored, flowsJson))) {
        console.warn(`[chat] retry ${a.retryId} 的收尾落空（并发重试已先更新）`);
      }
    }
    push({ t: "done", messageId });

    const titleText = a.mode === "retry" ? (ctx.turns.at(-1)?.content ?? "") : a.userText;
    try {
      await service.ensureTitle(a.userId, a.sessionId, titleText, reply, a.cfg);
    } catch (titleErr) {
      console.error("[chat] 会话起名失败（已静默）", titleErr);
    }

    await stream.close();
  } catch (err: any) {
    console.error(err); // 终审微修：原始错误（气泡已兜底成短中文）必须留在服务端日志
    const m = failRowOf(err);
    // 失败落库：send=追一条 status=-1 失败行；retry=替换失败行自身（status 保持 -1）
    try {
      if (a.mode === "retry") {
        await service.updateFailedMessage(a.userId, a.retryId, m); // 行已被并发重试更新时会在此拦下
      } else {
        await service.appendAssistantMessage(a.userId, a.sessionId, m, null, -1);
      }
    } catch (writeErr) {
      console.error("[chat] 失败行落库失败", writeErr);
    }
    push({ t: "fail", m });
    await stream.close();
  }
};

// ==================== 三个端点的形参整形 ====================

/** POST /chat/send：multipart sessionId/text/bookId/images[] → SSE（delta…→flows→done|fail） */
export const chatSend = async (event: H3Event, dataDir: string, cfg: OllamaCfg) => {
  try {
    const f = await readFormData(event);
    const userId = await getUserId(event);
    const sessionId = Number(f.get("sessionId")) || 0;
    const bookId = String(f.get("bookId") ?? "").trim();
    const text = String(f.get("text") ?? "").trim();
    const files = f.getAll("images").filter((x): x is File => x instanceof File);
    // 空文件名在端点侧拒绝（扩展名白名单交给 service）
    for (const file of files) {
      if (!file.name.trim()) {
        return error("小票图片文件名异常，请重新选择");
      }
    }
    if (!bookId) {
      return error("请先选择账本");
    }
    if (!text && files.length === 0) {
      return error("消息不能为空");
    }

    // 图先落盘、user 行先落库，再碰 ollama（此后任何失败都不重复存文件）
    const images = files.length
      ? await service.saveImages(userId, sessionId, await Promise.all(files.map(async (file) => ({
          ext: path.extname(file.name),
          data: Buffer.from(await file.arrayBuffer()),
        }))), dataDir)
      : [];
    await service.appendUserMessage(userId, sessionId, text, images);

    await runTurn(event, { userId, sessionId, bookId, dataDir, cfg, mode: "send", userImages: images, userText: text });
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
};

/** POST /chat/retry：multipart messageId/messageId 所属 sessionId/bookId → 同一 sendCore 再生成流 */
export const chatRetry = async (event: H3Event, dataDir: string, cfg: OllamaCfg) => {
  try {
    const f = await readFormData(event);
    const userId = await getUserId(event);
    const sessionId = Number(f.get("sessionId")) || 0;
    const messageId = Number(f.get("messageId")) || 0;
    const bookId = String(f.get("bookId") ?? "").trim();
    if (!bookId) {
      return error("请先选择账本");
    }

    // 先校验后开流：属于本人 AND 在该会话里 AND status=-1（终审 M4：
    // findFirst 直取该行，不再整表 load 后 find；文案口径与 service 一致）
    const msg = await service.getMessage(userId, sessionId, messageId);
    if (!msg) {
      throw new Error("消息不存在");
    }
    if (msg.status !== -1) {
      throw new Error("只有失败的消息可以重试");
    }

    await runTurn(event, { userId, sessionId, bookId, dataDir, cfg, mode: "retry", retryId: messageId });
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
};

/** POST /chat/save：multipart messageId/index/card(编辑后的 DraftFlow JSON)/bookId → {flowId} */
export const chatSave = async (form: FormData, userId: number) => {
  try {
    const bookId = String(form.get("bookId") ?? "").trim();
    if (!bookId) {
      return error("请先选择账本");
    }
    // 终审 M6：card 必须是「单个普通对象」的合法 JSON——parse 失败 / 非对象
    // / 数组都在这层拦下（否则往下钻会在 saveCard 里炸出 TypeError）
    const raw = form.get("card");
    let card: unknown = null;
    if (raw) {
      try {
        card = JSON.parse(String(raw));
      } catch {
        // parse 失败保持 null → 下面统一按「卡片数据无效」拦截
      }
    }
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      return error("卡片数据无效");
    }
    const idxRaw = form.get("index");
    return success(await service.saveCard(
      userId,
      Number(form.get("messageId")) || 0,
      idxRaw === null ? Number.NaN : Number(idxRaw), // 缺省不许落到卡 0
      card as DraftFlow,
      bookId
    ));
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
};
