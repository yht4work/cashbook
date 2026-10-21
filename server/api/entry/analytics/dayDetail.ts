import prisma from "~~/server/lib/prisma";

/**
 * @swagger
 * /api/entry/analytics/dayDetail:
 *   post:
 *     summary: 获取某一天的流水明细（按金额倒序的排行榜）
 *     tags: ["Analytics"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             bookId: string 账本ID
 *             day: string 日期（YYYY-MM-DD）
 *             flowType: string 流水类型（可选，不传则返回全部类型）
 *             limit: number 返回条数上限（可选，默认 50）
 *     responses:
 *       200:
 *         description: 获取成功
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d: {
 *                   rows: [] #[DayDetail流水明细排行榜，最多 limit 条]
 *                   count: number 当天该类型的总笔数（不受 limit 影响）
 *                   sum: number 当天该类型的总金额（不受 limit 影响）
 *                 }
 *       400:
 *         description: 获取失败
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: "请先选择账本" | "请选择日期"
 *               }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event);
  if (!body.bookId) {
    return error("请先选择账本");
  }
  if (!body.day) {
    return error("请选择日期");
  }

  const where: any = {
    bookId: body.bookId,
    day: body.day,
  };
  if (body.flowType) {
    where.flowType = body.flowType;
  }

  // 明细按金额倒序，即为当天的排行榜；金额相同的按 id 倒序保证顺序稳定
  const flows = await prisma.flow.findMany({
    where,
    orderBy: [{ money: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    take: Math.min(Number(body.limit) || 50, 200),
    select: {
      id: true,
      name: true,
      money: true,
      industryType: true,
      payType: true,
      flowType: true,
      attribution: true,
      description: true,
    },
  });

  // 明细只返回前 limit 条，但「共几笔」「合计多少」要按当天全部记录算，
  // 否则流水超过 limit 时，tooltip 里的合计会和折线图上那天的总额对不上。
  const agg = await prisma.flow.aggregate({
    where,
    _count: { _all: true },
    _sum: { money: true },
  });

  return success({
    rows: flows,
    count: agg._count._all,
    sum: agg._sum.money || 0,
  });
});
