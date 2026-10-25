/**
 * 聊天轮次 → ollama messages 数组（纯函数，无 IO / prisma / h3 依赖）。
 *
 * 图片窗口（设计文档「history/图片窗口」节）：
 * - 只把最近 imageTurnLimit 条含图 user 轮的图片真传，base64 由调用方给的
 *   readImg 现读磁盘；单次调用合计不超过 imageTotalLimit 张，额度按
 *   「最新轮优先」分配，同轮内按出现顺序用到额度用完为止。
 * - 图片编号在整次调用里连续（图1、图2…按出现顺序，真传与否都占号）：
 *   真传的图在文本里标 `[图N]`，超窗口/超上限的图标 `[图N已省略]`。
 *   编号全场唯一，AI 在卡片上用 imageIdx 引用任意一图（服务端随后把
 *   imageIdx 映射回文件名）。
 * - 已入账的 assistant 轮（flows 里每张卡都有 flowId）折叠成一行短摘要，
 *   防上下文膨胀；未入账 / flows 解析不了的轮保持原文。
 */

export type ChatTurn = { role: string; content: string; images: string[]; flows?: string };

export type OllamaMsg = { role: string; content: string; images?: string[] };

/** assistant 轮「已入账」（所有卡都有 flowId）时返回流水张数，否则 null */
const settledCountOf = (flows?: string): number | null => {
  if (!flows) {
    return null;
  }
  try {
    const cards = JSON.parse(flows);
    if (!Array.isArray(cards) || cards.length === 0) {
      return null;
    }
    const all = cards.every((c: any) => typeof c?.flowId === "number" && c.flowId > 0);
    return all ? cards.length : null;
  } catch {
    return null;
  }
};

export const buildOllamaMessages = (
  system: string,
  turns: ChatTurn[],
  readImg: (n: string) => string,
  o: { imageTurnLimit: number; imageTotalLimit: number }
): OllamaMsg[] => {
  // 1. 划真传额度：从最新含图 user 轮往旧，受限「轮数上限」与「张数上限」
  const allow = new Map<number, number>(); // 轮下标 → 该轮允许真传的张数
  const imgTurnIdxs: number[] = [];
  turns.forEach((t, i) => {
    if (t.role === "user" && t.images.length > 0) {
      imgTurnIdxs.push(i);
    }
  });
  let quota = o.imageTotalLimit;
  let windowed = 0;
  for (let k = imgTurnIdxs.length - 1; k >= 0; k--) {
    if (windowed >= o.imageTurnLimit) {
      break;
    }
    const n = Math.min(quota, turns[imgTurnIdxs[k]].images.length);
    if (n <= 0) {
      break; // 张数额度用完了，更旧的轮全部占位
    }
    allow.set(imgTurnIdxs[k], n);
    windowed += 1;
    quota -= n;
  }

  // 2. 按时间顺序组装，图片占全局连续编号
  const out: OllamaMsg[] = [{ role: "system", content: system }];
  let seq = 0;
  turns.forEach((t, i) => {
    const maxAttach = allow.get(i) ?? 0;
    const images: string[] = [];
    const markers: string[] = [];
    t.images.forEach((name, j) => {
      seq += 1;
      if (t.role === "user" && j < maxAttach) {
        images.push(readImg(name));
        markers.push(`[图${seq}]`);
      } else {
        markers.push(`[图${seq}已省略]`);
      }
    });
    let content = t.content;
    if (markers.length > 0) {
      // 编号标记统一换行排到正文后面，正文为空时就只剩标记
      content = [content, ...markers].filter(Boolean).join("\n");
    }
    // 已入账的 assistant 轮折叠为短摘要
    const settled = t.role === "assistant" ? settledCountOf(t.flows) : null;
    const msg: OllamaMsg = {
      role: t.role,
      content: settled !== null ? `[已入账 ${settled} 条流水]` : content,
    };
    if (images.length > 0) {
      msg.images = images;
    }
    out.push(msg);
  });
  return out;
};