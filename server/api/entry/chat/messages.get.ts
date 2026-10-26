import * as service from "~~/server/utils/chat/service";

/**
 * @swagger
 * /api/entry/chat/messages:
 *   get:
 *     summary: 会话消息列表
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     parameters:
 *       - in: query
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: number
 *         description: 会话ID
 *     responses:
 *       200:
 *         description: 该会话的消息（id 升序；无权限/无记录时为空数组）
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d:
 *                   - id: number 消息ID
 *                     role: string user | assistant
 *                     content: string 消息文本
 *                     images: string 小票文件名（逗号分隔）
 *                     flows: string 卡片JSON串
 *                     status: number 卡片入账状态
 *                     createDate: date 创建时间
 */
export default defineEventHandler(async (event) => {
  try {
    const sessionId = Number(getQuery(event).sessionId) || 0;
    return success(await service.getMessages(await getUserId(event), sessionId));
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
});
