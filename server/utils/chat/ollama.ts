/**
 * ollama 客户端：全工程唯一与 ollama 说 HTTP 的地方（无 env / runtimeConfig
 * / prisma 依赖，cfg 由调用方（任务 6）从运行时配置现拼）。
 *
 * - chatStream：POST {baseUrl}/api/chat 以 stream:true 请求 NDJSON，逐行取
 *   message.content，剥掉 inline think 块后即时回调 onDelta（调用方拿去产
 *   SSE 帧），promise 解析为最终正文；message.thinking 拿到也不读——模型的
 *   推理过程一步都不外发。
 * - chatOnce：stream:false 的单发便捷封装（会话起标题这类小活），正文同样
 *   剥 think 块。
 * - 错误面统一抛 OllamaError（简短中文 message）：连不上 / 连接兜底超时 /
 *   非 200 / 正文中途断流 / NDJSON 错误行。坏行（不可解析的 NDJSON 行）按
 *   防御性容忍跳过，不打崩整条流。
 */

export type OllamaCfg = { baseUrl: string; model: string };

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

/** 连上之后等响应头的兜底时限；读完头就撤（流式读不设总时限，长正文不该被掐） */
const CONNECT_TIMEOUT_MS = 30_000;

// 模型偶尔把推理直接吐在正文里（inline 标签或裸叙述），这里对标签自己剥
// （独立 thinking 字段则按上文整体不读）。标签用拼接写出（7 / 8 字符），
// 字面量含尖括号与斜杠，拼接比直接写清楚
const THINK_OPEN = "<" + "think" + ">"; // 共 7 字符
const THINK_CLOSE = "<" + "/think" + ">"; // 共 8 字符

/** 增量剥离正文里的 inline think 块：push 吃新增正文，吐出其中能外发的可见文本 */
const makeThinkFilter = () => {
  let inThink = false;
  let pending = ""; // 已收但还没定性的正文（可能含半个标签，先扣住）

  /** 尾部扣住的最长后缀长度 = 半个 tag 的最长前缀（防标签被切断） */
  const holdLen = (tag: string): number => {
    for (let len = Math.min(tag.length - 1, pending.length); len > 0; len--) {
      if (pending.slice(-len) === tag.slice(0, len)) {
        return len;
      }
    }
    return 0;
  };

  const push = (text: string): string => {
    pending += text;
    let out = "";
    for (;;) {
      if (inThink) {
        const close = pending.indexOf(THINK_CLOSE);
        if (close === -1) {
          // 仍是推理：只留结尾半个闭标签防切断，其余整体丢（不外发）
          const keep = holdLen(THINK_CLOSE);
          pending = pending.slice(pending.length - keep);
          break;
        }
        // 块内文字全是推理，跳过一个字不外发
        inThink = false;
        pending = pending.slice(close + THINK_CLOSE.length);
        continue;
      }
      const open = pending.indexOf(THINK_OPEN);
      if (open === -1) {
        // 没碰到新块：放行到结尾「半个开标签」之前
        const keep = holdLen(THINK_OPEN);
        out += pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
        break;
      }
      out += pending.slice(0, open);
      inThink = true;
      pending = pending.slice(open + THINK_OPEN.length);
    }
    return out;
  };

  /** 流收尾：还没走出块 → 自最后一个开标签到 EOF 一律按推理丢弃 */
  const finish = (): string => {
    const out = inThink ? "" : pending;
    pending = "";
    inThink = false;
    return out;
  };

  return { push, finish };
};

/**
 * 共用的 POST /api/chat：think:true + messages 原样透传。
 * think 放开（Task 10 修订裁决）：Think 通道（message.thinking 独立字段）本来
 * 就被服务端整体丢弃（见 header 注释），推理一行都不外发；而 think:false 会把
 * 模型的英文叙述赶进 content（正文 "The user says…"、标题 "Theuserwants"）。
 * 推理在独立通道时正文/标题都干净——质量优先，如需提速可回退 think:false。
 * 连不上（含 baseUrl 写坏解析失败）与连接兜底超时分两条中文 message；
 * 非 200 一律按错误状态抛。
 */
const ollamaRequest = async (cfg: OllamaCfg, messages: unknown[], stream: boolean) => {
  const killer = new AbortController();
  const timer = setTimeout(() => killer.abort(), CONNECT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(new URL("/api/chat", cfg.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, messages, stream, think: true }),
      signal: killer.signal,
    });
  } catch {
    // 拿到响应头前断掉 = 没连上 / 兜底超时到了
    if (killer.signal.aborted) {
      throw new OllamaError("ollama 响应超时");
    }
    throw new OllamaError("无法连接 ollama 服务");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new OllamaError(`ollama 返回错误状态 ${res.status}`);
  }
  return res;
};

/** 错误行的文案透传（ollama 200 响应流里也可能带 error 对象） */
const rejectIfErrorLine = (chunk: { error?: unknown }): void => {
  const errText = chunk?.error;
  if (typeof errText === "string" && errText) {
    throw new OllamaError(`ollama 返回错误：${errText}`);
  }
};

/** 流式对话：边到边回调 onDelta（可见文本），resolve 最终剥净的正文 */
export const chatStream = async (
  cfg: OllamaCfg,
  messages: unknown[],
  onDelta: (d: string) => void
): Promise<{ content: string }> => {
  const res = await ollamaRequest(cfg, messages, true);
  const reader = res.body?.getReader();
  if (!reader) {
    throw new OllamaError("ollama 返回空响应");
  }
  const filter = makeThinkFilter();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  // 可见文本即时回调（给调用方转 SSE），同时落进结果正文，两份永远同源
  const add = (text: string): void => {
    if (text) {
      onDelta(text);
      content += text;
    }
  };
  /** 处理一行 NDJSON：取 message.content 过滤后外发（坏行跳过、错误行抛） */
  const line = (raw: string): void => {
    if (!raw.trim()) {
      return; // 尾随换行与空行
    }
    let chunk: { error?: unknown; message?: { content?: unknown } };
    try {
      chunk = JSON.parse(raw);
    } catch {
      return; // ollama 正常不出坏行；出现了也别让整条流崩掉
    }
    rejectIfErrorLine(chunk);
    // message.thinking 刻意不读，推理不过手
    const c = chunk?.message?.content;
    if (typeof c === "string") {
      add(filter.push(c));
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        line(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    buf += decoder.decode(); // 刷出 UTF-8 尾字节
    if (buf.trim()) {
      line(buf); // 兜住最后一行没带换行的情况
    }
  } catch (err) {
    void reader.cancel().catch(() => {}); // 残局收掉，不留挂死连接
    if (err instanceof OllamaError) {
      throw err; // 行内业务错误（如 error 行）原样透传，不换文案
    }
    throw new OllamaError("ollama 流中断");
  }
  add(filter.finish());
  return { content };
};

/** 非流式单发（会话起标题这类小活）：返回剥净的正文 */
export const chatOnce = async (cfg: OllamaCfg, prompt: string): Promise<string> => {
  const res = await ollamaRequest(cfg, [{ role: "user", content: prompt }], false);
  let json: { error?: unknown; message?: { content?: unknown } };
  try {
    json = await res.json();
  } catch {
    throw new OllamaError("ollama 响应不是 JSON");
  }
  rejectIfErrorLine(json);
  const c = json?.message?.content;
  if (typeof c !== "string") {
    throw new OllamaError("ollama 响应缺 message.content");
  }
  const filter = makeThinkFilter();
  return filter.push(c) + filter.finish();
};
