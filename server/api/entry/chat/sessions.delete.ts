import * as service from "~~/server/utils/chat/service";

/**
 * @swagger
 * /api/entry/chat/sessions:
 *   delete:
 *     summary: 删除会话
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     parameters:
 *       - in: query
 *         name: id
 *         required: true
 *         schema:
 *           type: number
 *         description: 会话ID
 *     responses:
 *       200:
 *         description: 会话及其消息删除成功（未引用的小票文件一并清理）
 *         content:
 *           application/json:
 *             schema:
 *               Result: {
 *                 d: 操作结果
 *               }
 *       500:
 *         description: 会话不存在
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: "会话不存在"
 *               }
 */
export default defineEventHandler(async (event) => {
  try {
    const dataPath = String(useRuntimeConfig(event).dataPath || "") || process.cwd();
    const id = Number(getQuery(event).id) || 0;
    await service.deleteSession(await getUserId(event), id, dataPath);
    return success();
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
});