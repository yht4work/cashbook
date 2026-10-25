/**
 * 聊天轮次 → ollama messages 数组（纯函数，无 IO / prisma / h3 依赖）。
 *
 * 图片窗口（设计文档「history/图片窗口」节）：
 * - 只把最近 imageTurnLimit 条含图 user 轮的图片真传，base64 由调用方给的
 *   readImg 现读磁盘；单次调用合计不超过 imageTotalLimit 张，额度按
 *   「最新轮优先」分配，同轮内按出现顺序用到额度用完为止。
 * - 图编号的单一事实源 = buildImageNumbering：全部图按出现顺序占全局连续
 *   号（真传与占位都占号）。真传的图在文本里标 `[图N]`，占位的标
 *   `[图N已省略]`。prompt 的 imageCount、消息里的 [图N] 标记、
 *   normalizeFlows 的 byIndex 都必须从这张表派生，不允许各自再数一遍
 *  — tests/chat/consistency.test.ts 把这条接死。
 * - 已入账的 assistant 轮（flows 里每张卡都有 flowId）折叠成一行短摘要，
 *   防上下文膨胀；未入账 / flows 解析不了的轮保持原文。
 */

export type ChatTurn = { role: string; content: string; images: string[]; flows?: string };

export type OllamaMsg = { role: string; content: string; images?: string[] };

export type ImageWindowOpts = { imageTurnLimit: number; imageTotalLimit: number };

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

/** 一次调用的图片计划：numbered=全局编号表，attached=其中要真传的 1-based 编号 */
type ImagePlan = { numbered: string[]; attached: Set<number> };

/** 同一趟顺序里既占号又定真传集——两件事共享一个下标序，不可能各数各的 */
const planImages = (turns: ChatTurn[], o: ImageWindowOpts): ImagePlan => {
  // 真传额度：从最新含图 user 轮往旧，受限「轮数上限」与「张数上限」
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

  const numbered: string[] = [];
  const attached = new Set<number>();
  turns.forEach((t, i) => {
    const max = t.role === "user" ? (allow.get(i) ?? 0) : 0;
    t.images.forEach((name, j) => {
      numbered.push(name);
      if (j < max) {
        attached.add(numbered.length); // 1-based
      }
    });
  });
  return { numbered, attached };
};

/**
 * 全局连续图编号表（单一事实源）：`numbered[i-1]` = 「图i」的文件名；
 * 占位（未真传）的历史图同样占号，表长即本对话全部图数。
 * prompt 的 imageCount 一律传 `numbered.length`。
 */
export const buildImageNumbering = (turns: ChatTurn[], o: ImageWindowOpts): string[] =>
  planImages(turns, o).numbered;

export const buildOllamaMessages = (
  system: string,
  turns: ChatTurn[],
  readImg: (n: string) => string,
  o: ImageWindowOpts
): OllamaMsg[] => {
  // 编号与真传集合同出一个 plan，不可能分开错（consistency 测试另加护栏）
  const { numbered, attached } = planImages(turns, o);

  const out: OllamaMsg[] = [{ role: "system", content: system }];
  let seq = 0; // 与 numbered 的下标同序推进（护栏测试钉死 1..numbered.length）
  turns.forEach((t) => {
    const images: string[] = [];
    const markers: string[] = [];
    t.images.forEach((name) => {
      seq += 1;
      if (t.role === "user" && attached.has(seq)) {
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