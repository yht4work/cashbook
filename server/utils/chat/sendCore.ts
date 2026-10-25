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
 *   （content 走 updateFailedMessage，flows/status 收尾），不重复 user 消息、
 *   不重传图、不建新文件。
 *
 * prisma 分工说明：service 拥有全部数据面；本文件唯一例外是 retry 成功后
 * 对「失败行自身」flows/status 的收尾——updateFailedMessage 只管 content，
 * service 没有「替换失败行」的函数；用带归属条件的 updateMany（userId +
 * status=-1）收尾，与 service 的校验口径一致，并发重试谁先到谁生效。
 */

import prisma from "~~/server/lib/prisma";
import * as service from "~~/server/utils/chat/service";
import { buildImageNumbering, buildOllamaMessages } from "~~/server/utils/chat/history";
import { extractFlowArray, normalizeFlows, type DraftFlow } from "~~/server/utils/chat/flows";
import { chatStream, type OllamaCfg } from "~~/server/utils/chat/ollama";
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

const failRowOf = (err: unknown): string => {
  const m = String((err as Error)?.message ?? err ?? "生成失败");
  return m || "生成失败";
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

    // 2. 图编号单一事实源（与 system 的 imageCount 同一张表）+ 读回 base64；
    //    文件缺失让 loadImages 抛错走红 fail 路径（坏图不静默变空文本）
    const numbered = buildImageNumbering(ctx.turns, service.CHAT_IMAGE_WINDOW);
    const imgMap = await service.loadImages(a.dataDir, numbered);

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

    // 5. 解析 + 归一 → flows 帧（无 flowId/imageIdx；invoices=最终文件名）
    const raw = extractFlowArray(reply);
    if (!raw) {
      throw new Error("AI 回复解析失败");
    }
    const current = a.mode === "retry" ? (ctx.turns.at(-1)?.images ?? []) : a.userImages;
    const flows: DraftFlow[] = normalizeFlows(raw, ctx.cand, ctx.today, {
      default: () => current, // 本次 user 消息的图（别的轮不搭便车）
      byIndex: (i) => numbered[i - 1] ?? null, // 图i ← 全局编号表反查
    });
    push({ t: "flows", flows });

    // 6. 落库 assistant 行（done 帧的 id）+ 起名（静默）→ done 帧
    let messageId = a.mode === "retry" ? a.retryId : 0;
    if (a.mode === "send") {
      await service.appendAssistantMessage(a.userId, a.sessionId, reply, JSON.stringify(flows), 0); // 新卡片未入账 → 0
      messageId = (await service.getMessages(a.userId, a.sessionId)).at(-1)?.id ?? 0;
    } else {
      await service.updateFailedMessage(a.userId, a.retryId, reply);
      const upd = await prisma.chatMessage.updateMany({
        where: { id: a.retryId, userId: a.userId, status: -1 },
        data: { flows: JSON.stringify(flows), status: 0 }, // 新 flows 无 flowId → 未入账 → 0
      });
      if (upd.count === 0) {
        console.warn(`[chat] retry ${a.retryId} 的 flows/status 回写落空（并发重试已先更新）`);
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

    // 先校验后开流：属于本人 AND 在该会话里 AND status=-1（文案与 service 一致）
    const msg = (await service.getMessages(userId, sessionId)).find((r) => r.id === messageId);
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
    const raw = form.get("card");
    if (!raw) {
      return error("卡片数据无效");
    }
    const idxRaw = form.get("index");
    return success(await service.saveCard(
      userId,
      Number(form.get("messageId")) || 0,
      idxRaw === null ? Number.NaN : Number(idxRaw), // 缺省不许落到卡 0
      JSON.parse(String(raw)),
      bookId
    ));
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
};