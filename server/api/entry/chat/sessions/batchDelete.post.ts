import * as service from "~~/server/utils/chat/service";

/**
 * @swagger
 * /api/entry/chat/sessions/batchDelete:
 *   post:
 *     summary: 批量删除会话
 *     tags: ["Chat"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items:
 *                   type: number
 *                 description: 会话ID列表（去重后最多取前 100 个）
 *     responses:
 *       200:
 *         description: 批量删除完成（别人的/不存在的 id 逐个跳过，不中断整批）
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d:
 *                   deleted: number 实际删除数
 */
export default defineEventHandler(async (event) => {
  try {
    const userId = await getUserId(event);
    const body = (await readBody(event).catch(() => null)) as { ids?: unknown } | null;
    // 壳只做形状整备：非整数（串型数字/小数/其它）全丢、Set 去重、上限 100
    //（超了也只取前 100）；真正的归属校验/消息级联/文件清理都在已测的
    // service.deleteSession 里，这里不复写。
    const ids = [
      ...new Set(
        (Array.isArray(body?.ids) ? body.ids : []).filter(
          (v): v is number => Number.isInteger(v)
        )
      ),
    ].slice(0, 100);
    // 空输入提前返回（轮2#7）：不白跑一次全量 Flow 预扫
    if (ids.length === 0) {
      return success({ deleted: 0 });
    }
    const dataPath = String(useRuntimeConfig(event).dataPath || "") || process.cwd();
    // 被引用小票名单预扫一次（评审轮1#6）：旧实现逐会话调 deleteSession 会
    // 重复扫全量 Flow，批量 100 个会话 × 大账户流水就是 100 次全表查
    const referenced = await service.referencedInvoiceNames(userId);
    let deleted = 0;
    for (const id of ids) {
      // 单个失败（别人的/不存在的 id）只跳过该 id，不中断整批
      try {
        await service.deleteSession(userId, id, dataPath, referenced);
        deleted += 1;
      } catch (skip) {
        console.warn(`[chat] batchDelete 跳过会话 ${id}`, (skip as Error)?.message ?? skip);
      }
    }
    return success({ deleted });
  } catch (err: any) {
    console.error(err);
    return error(err?.message ?? String(err));
  }
});