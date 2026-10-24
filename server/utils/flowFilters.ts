/**
 * 流水筛选条件的统一翻译层：把前端查询体里的筛选字段
 * 翻译成 Prisma 的 where 条件。
 *
 * 明细分页（flow/page）和按日聚合（analytics/daily）共用这一套语义，
 * 保证「图中趋势线的合计」和「列表的合计」永远对得上：
 * 图表柱子/折线点开下钻时，弹窗里嵌的趋势图和流水列表带着同一组
 * 筛选字段（filter / *List / *Empty），两边各自请求不同的聚合端点。
 */

/**
 * 「该字段为一组值」：图表把 topN 之外的类目折成「其他」后下钻时用，
 * 逐个精确匹配（in），可与「该字段为空」并用，空值组的明细才会一起查出来。
 * 空包含两种情况：NULL 和空字符串。Prisma 的 in 里不能放 null，
 * 所以要放进 OR 把两种情况并起来。
 */
const orCondsOf = (body: any): any[] => {
  const orConds: any[] = [];
  if (Array.isArray(body.industryTypeList) && body.industryTypeList.length) {
    orConds.push({ industryType: { in: body.industryTypeList } });
  }
  if (body.industryTypeEmpty) {
    orConds.push({ industryType: null }, { industryType: "" });
  }
  if (Array.isArray(body.payTypeList) && body.payTypeList.length) {
    orConds.push({ payType: { in: body.payTypeList } });
  }
  if (body.payTypeEmpty) {
    orConds.push({ payType: null }, { payType: "" });
  }
  if (Array.isArray(body.attributionList) && body.attributionList.length) {
    orConds.push({ attribution: { in: body.attributionList } });
  }
  if (body.attributionEmpty) {
    orConds.push({ attribution: null }, { attribution: "" });
  }
  return orConds;
};

/** 日期区间条件（startDay/endDay 任意给一头也生效） */
const whereDayOf = (body: any): any => {
  if (body.startDay && body.endDay) {
    return {
      day: {
        gte: body.startDay,
        lte: body.endDay,
      },
    };
  } else if (body.startDay) {
    return { day: { gte: body.startDay } };
  } else if (body.endDay) {
    return { day: { lte: body.endDay } };
  }
  return {};
};

export const buildFlowWhere = (body: any): any => {
  const where: any = {
    bookId: {
      equals: body.bookId,
    },
  };

  // equals 等于查询
  if (body.id) {
    where.id = {
      equals: Number(body.id),
    };
  }
  if (body.flowType) {
    where.flowType = {
      equals: body.flowType,
    };
  }

  const orConds = orCondsOf(body);
  // 单值字段与「为空」互斥：Empty 优先，否则 equal 会把它覆盖掉
  if (!body.industryTypeEmpty && body.industryType) {
    where.industryType = {
      equals: body.industryType,
    };
  }
  if (!body.payTypeEmpty && body.payType) {
    where.payType = {
      equals: body.payType,
    };
  }
  // 图表下钻要求精确匹配（attributionEmpty 已进 orConds），
  // 这样明细的合计才等于图上的汇总值。搜索框里手动输入的
  // 部分文字则用模糊匹配。
  if (!body.attributionEmpty && body.attribution) {
    where.attribution = body.attributionExact
      ? { equals: body.attribution }
      : { contains: body.attribution };
  }
  if (orConds.length > 0) {
    where.OR = orConds;
  }

  Object.assign(where, whereDayOf(body));

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

  return where;
};