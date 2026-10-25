/**
 * AI 回复 → 可编辑的流水草稿卡片：提取 + 归一（纯函数，无 prisma / fs / h3 依赖）。
 *
 * - extractFlowArray：从模型回复正文里挖出 JSON 数组（容忍 markdown 围栏
 *   与前后闲话），取不到返回 null 由调用方按「解析失败」落库。
 * - normalizeFlows：把数组里每个元素归一成 DraftFlow —— 类型不落在账本
 *   候选里就置 ""；day 必须 YYYY-MM-DD 否则用 dayFallback；imageIdx 由
 *   调用方给的 imageNameOf 回调映射成小票文件名（AI 的编号只是预填用）。
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

/**
 * 从回复正文里取第一个能完整解析成 JSON 数组的片段：
 * 遇到 JSON.parse 失败的括号段就跳过继续找下一个 `[`；
 * 字符串内部的 [ ] 不干扰配对。没有数组或括号没闭合 → null。
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

const moneyOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

const textOf = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 候选必须精确命中才通过，否则置 ""——AI 编造的类型名绝不入库 */
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
  imageNameOf: (idx: number) => string | null
): DraftFlow[] => {
  // 「该消息全部图」兜底：对编号从 1 连续查到第一个 null 为止。
  // 调用方（send 场景）必须保证编号从 1 开始连续——buildOllamaMessages
  // 的占号规则即如此。
  const allImages = (): string[] => {
    const got: string[] = [];
    for (let i = 1; i <= 64; i++) {
      const f = imageNameOf(i);
      if (!f) {
        break;
      }
      got.push(f);
    }
    return got;
  };

  const out: DraftFlow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue; // 非对象项跳过，不产出垃圾卡
    }
    const c = item as Record<string, unknown>;
    const idxs = imageIdxOf(c.imageIdx);
    // 逐张映射，映射不上的那张缺省；AI 明确引了编号但没有一张能
    // 映射上时不兜底全部图（说明这卡的图不可信，留空由用户自己挂）
    const invoices = idxs
      ? [...new Set(idxs.map((i) => imageNameOf(i)).filter((f): f is string => !!f))]
      : allImages();
    out.push({
      day: dayOf(c.day, dayFallback),
      flowType: FLOW_TYPES.includes(c.flowType as string) ? (c.flowType as string) : "支出",
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