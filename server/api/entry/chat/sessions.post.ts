import * as service from "~~/server/utils/chat/service";

/**
 * @swagger
 * /api/entry/chat/sessions:
 *   post:
 *     summary: 新建会话
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     responses:
 *       200:
 *         description: 会话创建成功（标题为空，等首条回复再起名）
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d:
 *                   id: number 会话ID
 */
export default defineEventHandler(async (event) => {
  try {
    return success(await service.createSession(await getUserId(event)));
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
});