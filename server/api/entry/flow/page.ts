import prisma from "~~/server/lib/prisma";
import { buildFlowWhere } from "~~/server/utils/flowFilters";

/**
 * @swagger
 * /api/entry/flow/page:
 *   post:
 *     summary: 分页获取流水记录列表
 *     tags: ["Flow"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             bookId: string 账本ID
 *             id: number 流水ID（可选）
 *             flowType: string 流水类型（可选）
 *             industryType: string 行业分类（可选）
 *             payType: string 支付方式（可选）
 *             startDay: string 开始日期（可选）
 *             endDay: string 结束日期（可选）
 *             name: string 流水名称（可选，支持模糊查询）
 *             attribution: string 归属（可选，支持模糊查询）
 *             attributionList: string[] 归属列表（可选，图表「其他」合并柱下钻）
 *             attributionEmpty: boolean 归属为空（可选，图表「未知」下钻）
 *             industryTypeList/payTypeList: string[] 分类列表（可选，同上）
 *             description: string 描述（可选，支持模糊查询）
 *             pageNum: number 页码（默认为1）
 *             pageSize: number 每页大小（默认为15，-1表示查询全部）
 *             moneySort: string 金额排序（asc/desc）
 *             daySort: string 日期排序（asc/desc，不传默认倒序）
 *             minMoney: number 最小金额（可选）
 *             maxMoney: number 最大金额（可选）
 *     responses:
 *       200:
 *         description: 分页数据获取成功
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d: PagePack<Flow> 流水分页数据
 *       400:
 *         description: 获取失败
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: "请先选择账本"
 *               }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event); // 获取查询参数

  if (!body.bookId) {
    return error("请先选择账本");
  }

  // 筛选语义统一由 flowFilters 提供（明细分页与按日聚合共用，
  // 图表下钻时弹窗里的趋势线和列表数字才对得上）
  const where = buildFlowWhere(body);

  // 分页条件
  const pageNum = Number(body.pageNum ? body.pageNum : 1);
  const pageSize = Number(body.pageSize ? body.pageSize : 15);
  const skip = (pageNum - 1) * pageSize; // 计算跳过的条目数

  // 排序条件
  const orderBy: any = [
    {
      day: "desc",
    },
    {
      id: "desc", // 添加ID排序确保排序稳定性
    },
  ];
  // 日期排序切换（列表表头可点，asc/desc 覆盖默认的 day desc）
  if (body.daySort === "asc" || body.daySort === "desc") {
    orderBy[0] = { day: body.daySort };
  }
  if (body.moneySort) {
    // console.log(body.moneySort)
    // 将金额排序设置到第一个
    orderBy.unshift({ money: String(body.moneySort) });
  }
  let flows;
  if (pageSize == -1) {
    // 查询全部
    flows = await prisma.flow.findMany({ where, orderBy });
    // return success(books);
  } else {
    // 【条件、排序、分页】 组合查询
    flows = await prisma.flow.findMany({
      where,
      orderBy,
      skip,
      take: pageSize,
    });
  }
  // 计算总页数
  const totalFlows = await prisma.flow.count({ where });
  const sumMoney = await prisma.flow.groupBy({
    by: ["flowType"],
    where,
    _sum: {
      money: true,
    },
  });
  const totalPages = Math.ceil(totalFlows / pageSize);
  // const sum = sumMoney[0];
  // console.log(sumMoney);
  let totalIn = 0;
  let totalOut = 0;
  let notInOut = 0;
  sumMoney.forEach((t: any) => {
    if (t.flowType == "收入") {
      totalIn = Number(t._sum.money);
    } else if (t.flowType == "支出") {
      totalOut = Number(t._sum.money);
    } else if (t.flowType == "不计收支") {
      notInOut = Number(t._sum.money);
    }
  });

  return success({
    total: totalFlows,
    data: flows,
    pages: totalPages,
    totalIn,
    totalOut,
    notInOut,
  });
});
