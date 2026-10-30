/**
 * assistant 气泡正文的显示清洗（渲染侧纯函数；落库全文、模型上下文、重试都不动）。
 *
 * 契约（用户 2026-10-30 反馈）：气泡里叙述、卡片都可以，裸 JSON 一律不展示。
 * prompt 允许模型把 JSON 数组混在正文里（它就是卡片的来源，经 server
 * extractFlowArray 单独走 flows 通道渲染成卡），落库 content 保留全文是既定
 * 设计（模型历史上下文要回看自己记的数组、失败重试也从原文起步），所以剥
 * JSON 只发生在气泡这一层：
 * - 成文行（非流式）：已成卡的可解析数组段剥掉；**成文但没成卡的不动**——
 *   解析失败/归一全弃的回复里那段 JSON 是仅存的事实，吞掉就什么都不剩了。
 * - 流式进行中：闭合成型的数组段剥掉，末尾还没闭合的数组前缀也剥（不让
 *   半截 JSON 一字一字闪出来，叙述照常打字）。done 后 loadMessages 会用
 *   服务端行替换流式行，剥到只剩空串时走「三点待机」。
 *
 * 括号配对语义与 server/utils/chat/flows.ts 的 extractFlowArray 完全同款
 * （字符串感知、解析失败跳过、首个可解析数组即结果）——气泡里隐藏的
 * 就是服务端收走做成卡片的那一段，卡片即正文中该数组的可视表达。
 */

/** 与 extractFlowArray 同款配对：从 start 的 [ 找到与之闭合的 ] 下标；
 *  字符串内部的 [ ] / 引号 / 转义不干扰配对；没闭合返回 -1（parse 由调用方验） */
const flowArrayEndAt = (text: string, start: number): number => {
  let depth = 0;
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
        return i;
      }
    }
  }
  return -1;
};

/** 两段叙述拼接：各自收边、非空才用单空格衔接（数组两侧的断行/空白不进气泡） */
const pushSeg = (acc: string, seg: string): string => {
  const a = acc.trimEnd();
  const b = seg.trim();
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return `${a} ${b}`;
};

/** 剥掉全部「可完整解析成 JSON 数组」的段（server 只拿首个做卡片，显示侧
 *  全剥——裸 JSON 一律不展示；解析失败的括号段是叙述的一部分，保留可见） */
const stripFlowArrays = (t: string): string => {
  let out = "";
  let pos = 0; // 已确认的保留边界：[0..pos) 之外的数组段都已剥掉
  let from = 0; // 配对扫描起点：失败的括号段并入叙述（继续从它之后找）
  for (;;) {
    const start = t.indexOf("[", from);
    if (start === -1) {
      break;
    }
    const end = flowArrayEndAt(t, start);
    if (end !== -1) {
      let ok = false;
      try {
        ok = Array.isArray(JSON.parse(t.slice(start, end + 1)));
      } catch {
        ok = false;
      }
      if (ok) {
        out = pushSeg(out, t.slice(pos, start));
        pos = end + 1;
        from = pos;
        continue;
      }
    }
    from = start + 1; // 没闭合/解析失败：整段算叙述的一部分，pos 不动，只往前找
  }
  return pushSeg(out, t.slice(pos));
};

/**
 * 从 [ 起到文末是「未闭合的合法 JSON 数组前缀」判定（流式打字中途用）：
 * 柱扫到末尾，[ ] { } 配对不许归零（成型的数组归 stripFlowArrays 管）、
 * 字符串内任意字符放行、字符串外只许结构性字符/数字/.-+eE/空白——
 * 出现叙述性字符（中文等）即判非 JSON。关键词 true/false/null 不放行
 * （记账卡片的字段值里用不上，宁可让这一小段照常可见也不吞叙述）。
 */
const typingArrayPrefixFrom = (t: string, start: number): boolean => {
  let depth = 1; // start 处已是 [
  let inStr = false;
  let esc = false;
  for (let i = start + 1; i < t.length; i++) {
    const ch = t[i];
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
    } else if ("[{".includes(ch)) {
      depth += 1;
    } else if ("]}".includes(ch)) {
      depth -= 1;
      if (depth <= 0) {
        return false;
      }
    } else if (!/^[\s,:.\-+eE0-9]$/.test(ch)) {
      return false;
    }
  }
  return true;
};

/** 流式尾部剥：从最后一个 [ 起试剥，不行就往前的 [ 再试（内层 [ 可能只是
 *  字符串内容，真正开着的是外层数组）；一个 [ 都不成立即停。 */
const stripTypingSuffix = (t: string): string => {
  let out = t;
  for (;;) {
    let start = out.lastIndexOf("[");
    while (start !== -1 && !typingArrayPrefixFrom(out, start)) {
      start = out.lastIndexOf("[", start - 1);
    }
    if (start === -1) {
      return out;
    }
    out = out.slice(0, start);
  }
};

/**
 * assistant 气泡正文（渲染用）：落库 content 原样不动，这里把裸 JSON 剥出去。
 * 非流式且未成卡 → 原样（成文但没成卡的回复不吞信息）；已成卡或流式中 → 剥。
 */
export const chatNarrationText = (
  content: string | null,
  opts: { streaming?: boolean; hasCards?: boolean } = {}
): string => {
  const t = (content ?? "").trim();
  if (!t || !t.includes("[")) {
    return t;
  }
  const hide = opts.hasCards || opts.streaming;
  if (!hide) {
    return t;
  }
  let out = stripFlowArrays(t);
  if (opts.streaming) {
    out = stripTypingSuffix(out);
  }
  return out.trim();
};