import prisma from "~~/server/lib/prisma";

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
 *             description: string 描述（可选，支持模糊查询）
 *             pageNum: number 页码（默认为1）
 *             pageSize: number 每页大小（默认为15，-1表示查询全部）
 *             moneySort: string 金额排序（asc/desc）
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

  const where: any = {
    bookId: {
      equals: body.bookId,
    },
  }; // 条件查询

  // 普通查询条件
  if (body.id) {
    // equals 等于查询
    // contains 模糊查询（pgsql和mongo中，可以增加额外参数限制忽略大小写 mode: 'insensitive'）
    where.id = {
      equals: Number(body.id),
    };
  }
  if (body.flowType) {
    where.flowType = {
      equals: body.flowType,
    };
  }
  // 「该字段为空」：图表把空值归并成一组后下钻时用。
  // 空包含两种情况：NULL 和空字符串。Prisma 的 in 里不能放 null，
  // 所以要用 OR 把两种情况并起来。
  const orConds: any[] = [];
  if (body.industryTypeEmpty) {
    orConds.push({ industryType: null }, { industryType: "" });
  } else if (body.industryType) {
    where.industryType = {
      equals: body.industryType,
    };
  }
  if (body.payTypeEmpty) {
    orConds.push({ payType: null }, { payType: "" });
  } else if (body.payType) {
    where.payType = {
      equals: body.payType,
    };
  }
  // 图表下钻要求精确匹配（见 attribution 的注释）
  if (body.attributionEmpty) {
    orConds.push({ attribution: null }, { attribution: "" });
  } else if (body.attribution) {
    // 图表下钻时要求精确匹配，这样明细的合计才等于图上的汇总值。
    // 搜索框里手动输入的部分文字则用模糊匹配。
    where.attribution = body.attributionExact
      ? { equals: body.attribution }
      : { contains: body.attribution };
  }
  if (orConds.length > 0) {
    where.OR = orConds;
  }
  if (body.startDay && body.endDay) {
    where.day = {
      gte: body.startDay,
      lte: body.endDay,
    };
  } else if (body.startDay) {
    where.day = {
      gte: body.startDay,
    };
  } else if (body.endDay) {
    where.day = {
      lte: body.endDay,
    };
  }
  if (body.name) {
    where.name = {
      contains: body.name,
    };
  }
  // 注意：attribution 的筛选统一在上面处理（精确/模糊/为空三种），
  // 这里不要再写一次 contains，否则会把上面的精确匹配覆盖成模糊匹配。
  if (body.description) {
    where.description = {
      contains: body.description,
    };
  }

  // 金额范围过滤
  if (
    body.minMoney !== undefined &&
    body.minMoney !== null &&
    body.minMoney !== ""
  ) {
    const min = Number(body.minMoney);
    if (!Number.isNaN(min)) {
      where.money = { ...(where.money || {}), gte: min };
    }
  }
  if (
    body.maxMoney !== undefined &&
    body.maxMoney !== null &&
    body.maxMoney !== ""
  ) {
    const max = Number(body.maxMoney);
    if (!Number.isNaN(max)) {
      where.money = { ...(where.money || {}), lte: max };
    }
  }

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
