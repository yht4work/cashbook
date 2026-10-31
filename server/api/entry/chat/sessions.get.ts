import * as service from "~~/server/utils/chat/service";
import { failRowOf } from "~~/server/utils/chat/sendCore";

/**
 * @swagger
 * /api/entry/chat/sessions:
 *   get:
 *     summary: 会话列表
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     responses:
 *       200:
 *         description: 会话列表（updateDate 倒序，只含当前用户的）
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d:
 *                   - id: number 会话ID
 *                     title: string 会话标题（未起名时为 null）
 *                     updateDate: date 最近更新时间
 */
export default defineEventHandler(async (event) => {
  try {
    return success(await service.listSessions(await getUserId(event)));
  } catch (err: any) {
    console.error(err);
    return error(failRowOf(err, "会话列表获取失败，请稍后重试")); // 评审轮4#1 同类统一：壳层 catch 脱敏
  }
});
