import prisma from "~~/server/lib/prisma";

/**
 * @swagger
 * /api/entry/analytics/common:
 *   post:
 *     summary: 获取通用图表分析数据
 *     tags: ["Analytics"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             bookId: string 账本ID
 *             groupBy: string 分组字段（payType/industryType/attribution）
 *             flowType: string 流水类型（可选）
 *             startDay: string 开始日期（可选）
 *             endDay: string 结束日期（可选）
 *     responses:
 *       200:
 *         description: 通用图表分析数据获取成功
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d: [] #[CommonChartData图表通用数据结构：分析数据数组]
 *       400:
 *         description: 获取失败
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: "请先选择账本" | "不支持的分组字段"
 *               }
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event); // 获取查询参数
  if (!body.bookId) {
    return error("请先选择账本");
  }

  // 验证分组字段
  const allowedGroupFields = ["payType", "industryType", "attribution"];
  if (!body.groupBy || !allowedGroupFields.includes(body.groupBy)) {
    return error("不支持的分组字段");
  }

  const where: any = {
    bookId: {
      equals: body.bookId,
    },
  };

  if (body.flowType) {
    where.flowType = {
      equals: body.flowType,
    };
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

  // 动态分组查询
  const dayGroups = await prisma.flow.groupBy({
    by: [body.groupBy, "flowType"],
    _sum: {
      money: true,
    },
    orderBy: [
      {
        [body.groupBy]: "asc",
      },
      {
        flowType: "asc",
      },
    ],
    where, // 使用条件查询
  });

  // 初始化结果格式
  const datas = [];
  // 用 Map 而不是普通对象：类目名是用户输入的，
  // 普通对象的话「constructor」「toString」这类名字会撞上
  // Object.prototype 上的属性，导致该类目被静默丢弃
  const groupedByField = new Map<
    string,
    {
      type: string;
      isEmpty: boolean;
      inSum: number;
      outSum: number;
      zeroSum: number;
    }
  >();

  // 按指定字段分组，合并数据到目标格式
  // groupBy 是运行时才确定的字符串，Prisma 无法静态推断 groupBy 的元素类型，
  // 这里显式声明需要的字段
  dayGroups.forEach((item: any) => {
    const rawValue = item[body.groupBy] as string;
    // 空值（NULL 或空字符串）归为同一组。
    // 这里用原始值当 key，所以真实存在的「未知」不会和空值这一组撞车；
    // 「未知」只是图上的展示名，下钻时靠 isEmpty 还原成「该字段为空」。
    const isEmpty = !rawValue;
    const groupKey = rawValue || "";
    const fieldValue = isEmpty ? "未知" : rawValue;
    const flowType = item.flowType;
    const moneySum = item._sum.money || 0; // 如果 money 为 null，默认值为 0

    // 如果当前字段值不存在，则初始化
    let group = groupedByField.get(groupKey);
    if (!group) {
      group = {
        type: fieldValue,
        isEmpty,
        inSum: 0,
        outSum: 0,
        zeroSum: 0,
      };
      groupedByField.set(groupKey, group);
    }

    // 根据 flowType 填充对应的 sum
    if (flowType === "收入") {
      group.inSum += moneySum;
    } else if (flowType === "支出") {
      group.outSum += moneySum;
    } else if (flowType === "不计收支") {
      group.zeroSum += moneySum;
    }
  });

  // 转换为数组格式
  for (const group of groupedByField.values()) {
    datas.push(group);
  }

  return success(datas);
});
