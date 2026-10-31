import * as service from "~~/server/utils/chat/service";
import { failRowOf } from "~~/server/utils/chat/sendCore";

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
    // 文件清理收口式（评审轮1#6 优化保留、轮3#1 修 TOCTOU）：各会话先只删库
    // 并收集小票候选名（deleteSessionCollecting 不扫引用），整批删完后对最新
    // 的引用名单 fresh 扫一次、统一清——引用扫描必须发生在整批删除之后：
    // 预扫冻结集（旧实现）看不到批删窗口内并发 saveCard 刚入账的 Flow，会把
    // 它的小票误判"无引用"而 unlink；收口扫描让竞态窗口归零，且仍只 1 次
    // 全量 Flow 查询。扫引用之后才可能被并发 saveCard 新增引用吗？此时其
    // 所属会话已删、saveCard 因「消息不存在」建不了卡——窗口为真零。
    const candidates: string[] = [];
    let deleted = 0;
    for (const id of ids) {
      // 单个失败（别人的/不存在的 id）只跳过该 id，不中断整批
      try {
        candidates.push(...(await service.deleteSessionCollecting(userId, id, dataPath)));
        deleted += 1;
      } catch (skip) {
        console.warn(`[chat] batchDelete 跳过会话 ${id}`, (skip as Error)?.message ?? skip);
      }
    }
    if (candidates.length > 0) {
      await service.sweepUnreferencedChatImages(dataPath, candidates, await service.referencedInvoiceNames(userId));
    }
    return success({ deleted });
  } catch (err: any) {
    console.error(err);
    return error(failRowOf(err, "会话删除失败，请稍后重试")); // 评审轮4#1 同类统一：壳层 catch 脱敏
  }
});