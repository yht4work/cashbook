/**
 * AI 回复 → 可编辑的流水草稿卡片：提取 + 归一（纯函数，无 prisma / fs / h3 依赖）。
 *
 * - extractFlowArray：从模型回复正文里挖出 JSON 数组（容忍 markdown 围栏
 *   与前后闲话），取不到返回 null 由调用方按「解析失败」落库。
 * - normalizeFlows：把数组里每个元素归一成 DraftFlow —— 类型不落在账本
 *   候选里就置 ""；day 必须 YYYY-MM-DD 否则用 dayFallback；图片由调用方
 *   给的 ImageLookup 注入：imageIdx 缺省 → default()（本次消息的图），
 *   AI 标了 imageIdx → byIndex() 按 buildImageNumbering 的全局编号解析成
 *   小票文件名（AI 的编号只是预填用）。
 */

export type DraftFlow = {
  day: string;
  flowType: string;
  industryType: string;
  payType: string;
  money: number;
  name: string;
  description: string;
  attribution: string;
  invoices: string[];
  flowId?: number;
};

/** 流水卡片的图片来源注入（send 场景由组装上下文的一方接线） */
export type ImageLookup = {
  /** 没标 imageIdx 的卡片默认挂的图 = 本次消息的图（文件名，直接给） */
  default: () => string[];
  /** 图编号 → 文件名；编号必须来自 buildImageNumbering 的全局连续表 */
  byIndex: (i: number) => string | null;
};

/**
 * 从回复正文里取第一个能完整解析成 JSON 数组的片段：
 * 遇到 JSON.parse 失败的括号段就跳过继续找下一个 `[`；
 * 字符串内部的 [ ] 不干扰配对。没有数组或括号没闭合 → null。
 *
 * 注意：这里不做记账语义判断，「首个能解析的数组」就是结果——闲话里
 * 若先出现一个可解析的短数组会抢位；这由 prompt 兜住（已要求模型
 * 只输出数组本身），出现双数组时按先后取首个是既定口径。
 */
export const extractFlowArray = (text: string): unknown[] | null => {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "[") {
        depth += 1;
      } else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) {
      continue; // 没闭合的括号，换个起点再试
    }
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // 闲话里的非 JSON 括号段，继续找
    }
  }
  return null;
};

// ==================== 归一 ====================

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 校验真实存在的日期（Date.parse 会放行 2026-02-30，这里按月天数挡掉） */
const isRealDay = (v: string): boolean => {
  const m = v.match(DAY_RE);
  if (!m) {
    return false;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) {
    return false;
  }
  // Date.UTC 的 day=0 回到上个月最后一天 → 当月实际天数（含闰年）
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
};

const dayOf = (v: unknown, fallback: string): string =>
  typeof v === "string" && isRealDay(v) ? v : fallback;

/** 金额归一：数字且 ≥0 收下，否则 0（导出给 chat/service.saveCard 同口径） */
export const moneyOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const textOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 候选必须精确命中（trim 后）才通过，否则置 ""——AI 编造的类型名绝不入库 */
const pickFrom = (list: string[], v: unknown): string => {
  const t = textOf(v);
  return t && list.includes(t) ? t : "";
};

const FLOW_TYPES = ["支出", "收入"];

/** imageIdx 归一：数组或单个数字 → 正整数数组；缺失 → null（表「缺省」） */
const imageIdxOf = (v: unknown): number[] | null => {
  const src = Array.isArray(v)
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? [v]
      : null;
  if (!src) {
    return null;
  }
  return [...new Set(src.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
};

export const normalizeFlows = (
  raw: unknown[],
  cand: { industry: string[]; pay: string[]; attribution: string[] },
  dayFallback: string,
  img: ImageLookup
): DraftFlow[] => {
  const out: DraftFlow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue; // 非对象项跳过，不产出垃圾卡
    }
    const c = item as Record<string, unknown>;
    const idxs = imageIdxOf(c.imageIdx);
    // AI 标了编号：逐张映射，映射不上的那张缺省；一张都对不上时不再
    // 回落 default（编造编号不可信，留空由用户自己挂）。缺省 → 本次
    // 消息的图（default 注入，别的轮的小票不搭便车）。
    const invoices = idxs
      ? [...new Set(idxs.map((i) => img.byIndex(i)).filter((f): f is string => !!f))]
      : img.default();
    out.push({
      day: dayOf(c.day, dayFallback),
      flowType: FLOW_TYPES.includes(textOf(c.flowType)) ? (textOf(c.flowType) as string) : "支出",
      industryType: pickFrom(cand.industry, c.industryType),
      payType: pickFrom(cand.pay, c.payType),
      money: moneyOf(c.money),
      name: textOf(c.name) || "未命名流水",
      description: textOf(c.description),
      attribution: pickFrom(cand.attribution, c.attribution),
      invoices,
    });
  }
  return out;
};
