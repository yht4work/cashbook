import { chatSend, failRowOf, type ChatWiring } from "~~/server/utils/chat/sendCore";

/**
 * @swagger
 * /api/entry/chat/send:
 *   post:
 *     summary: 发送消息（流式）
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               sessionId:
 *                 type: number
 *                 description: 会话ID
 *               text:
 *                 type: string
 *                 description: 文本（与 images 至少有一）
 *               bookId:
 *                 type: string
 *                 description: 当前账本ID（类型候选与「今天」口径来源）
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 *                 description: 小票图片（可选，多张）
 *     responses:
 *       200:
 *         description: SSE 流（text/event-stream）——data: {"t":"delta","d":"逐步正文"}…→ {"t":"flows","flows":DraftFlow[]} → {"t":"done","messageId":number}；任何一步失败发 {"t":"fail","m":"错误文案"} 并落一条 status=-1 的失败行
 */
export default defineEventHandler(async (event) => {
  try {
    const cfg = useRuntimeConfig(event);
    // stallMs（轮2#3）：NUXT_OLLAMA_STALL_MS 可按机放宽首 token/挂起阈值；
    // 未配或 ≤0 视为未配（ollama.ts 内回落内置默认 180s，守卫不可被关死）
    const stallNum = Number(cfg.ollamaStallMs);
    const wiring: ChatWiring = {
      dataDir: cfg.dataPath || process.cwd(),
      cfg: { baseUrl: cfg.ollamaBaseUrl, model: cfg.ollamaModel, stallMs: stallNum > 0 ? stallNum : undefined },
    };
    return await chatSend(event, wiring.dataDir, wiring.cfg);
  } catch (err: any) {
    console.error(err);
    return error(failRowOf(err, "发送失败，请稍后重试")); // 评审轮3#2：壳层 catch 同样不透传原始错误
  }
});
