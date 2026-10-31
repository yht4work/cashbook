import { chatSave, failRowOf } from "~~/server/utils/chat/sendCore";

/**
 * @swagger
 * /api/entry/chat/save:
 *   post:
 *     summary: 卡片入账
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
 *                 description: 卡片所在 assistant 消息ID
 *               index:
 *                 type: number
 *                 description: 卡片在 flows 数组里的下标
 *               card:
 *                 type: string
 *                 description: 编辑后的完整 DraftFlow JSON 串（含用户最终勾选的 invoices）
 *               bookId:
 *                 type: string
 *                 description: 账本ID（Flow 落到该账本）
 *     responses:
 *       200:
 *         description: 入账成功（d.flowId = 新流水ID）；同卡重复入账 → m: "该卡片已入账"，越界下标 → "卡片不存在"
 */
export default defineEventHandler(async (event) => {
  try {
    return await chatSave(await readFormData(event), await getUserId(event));
  } catch (err: any) {
    console.error(err);
    return error(failRowOf(err, "入账失败，请稍后重试")); // 评审轮4#1：壳层 catch 不透传原始错误（readFormData 失败等）
  }
});
