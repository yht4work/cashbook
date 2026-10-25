import { chatRetry, type ChatWiring } from "~~/server/utils/chat/sendCore";

/**
 * @swagger
 * /api/entry/chat/retry:
 *   post:
 *     summary: 重试失败消息（流式）
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
 *               messageId:
 *                 type: number
 *                 description: 失败的 assistant 消息ID（status=-1）
 *               sessionId:
 *                 type: number
 *                 description: 该消息所属会话ID
 *               bookId:
 *                 type: string
 *                 description: 当前账本ID
 *     responses:
 *       200:
 *         description: SSE 流（text/event-stream），契约同 /chat/send；不重传图、不重复 user 消息，成功后更新失败行（done 帧即该行 id）
 */
export default defineEventHandler(async (event) => {
  try {
    const cfg = useRuntimeConfig(event);
    const wiring: ChatWiring = { dataDir: cfg.dataPath || process.cwd(), cfg: { baseUrl: cfg.ollamaBaseUrl, model: cfg.ollamaModel } };
    return await chatRetry(event, wiring.dataDir, wiring.cfg);
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
});