import prisma from "~~/server/lib/prisma";

/**
 * @swagger
 * /api/entry/flow/condidate/autos:
 *   post:
 *     summary: 自动查找候选平账记录
 *     tags: ["Candidate"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             bookId: string 账本ID
 *     responses:
 *       200:
 *         description: 候选记录获取成功
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d: [] #{ out: Flow 支出记录, in: Flow 收入记录}
 *       400:
 *         description: 获取失败
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: "No Find bookid"
 *               }
 */
// 此处的相似性判断示例：金额完全相等（你可根据业务需要添加金额误差、日期范围等条件）
export default defineEventHandler(async (event) => {
  const body = await readBody(event); // 获取请求体
  if (!body.bookId) {
    return error("No Find bookid");
  }
  // const userId = await getUserId(event);
  // 获取所有未平账的支出数据
  const expenditures = await prisma.flow.findMany({
    where: { flowType: "支出", eliminate: 0, bookId: String(body.bookId) },
    orderBy: [
      {
        day: "desc",
      },
    ],
  });

  // 一次性取回所有可能的候选记录，按金额建索引。
  // 原来是对每笔支出串行 await 一次 findFirst（N+1，1 万多笔就是 1 万多次查询）。
  const incomes = await prisma.flow.findMany({
    where: {
      flowType: { in: ["收入", "不计收支"] },
      bookId: String(body.bookId),
    },
  });

  // 按金额分组，保留原始顺序，
  // 这样每组的第一条就等价于原先 findFirst 找到的那一条
  const incomeByMoney = new Map<number, any[]>();
  for (const income of incomes) {
    if (income.money === null || income.money === undefined) continue;
    const bucket = incomeByMoney.get(income.money);
    if (bucket) {
      bucket.push(income);
    } else {
      incomeByMoney.set(income.money, [income]);
    }
  }

  const candidatePairs = [];

  // 对每笔支出查找候选记录
  for (const expense of expenditures) {
    if (expense.money === null || expense.money === undefined) continue;
    const candidate = incomeByMoney.get(expense.money)?.[0];
    if (candidate) {
      candidatePairs.push({
        out: expense,
        in: candidate,
      });
    }
  }

  return success(candidatePairs);
});
