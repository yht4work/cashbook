/**
 * ollama 客户端契约测试：本地 node http 起一个迷你 ollama 吐 NDJSON。
 *
 * 钉死的契约：
 * - 请求体 = {model, messages, stream, think: false}，messages 原样透传
 * - content 累积 → 最终正文，且与逐条 onDelta 拼接完全一致（delta 顺序）
 * - message.thinking 一律丢弃：不进 delta、不进正文（含 inline think 块、
 *   标签被行切断、流结束时未闭合的前缀尾部）
 * - 错误面：不可达 → 无法连接；非 200 → 错误状态；对端断流 → 中断；
 *   NDJSON 里的错误行文案透传成 OllamaError
 */
import { describe, expect, it } from "vitest";
import http, { type AddressInfo, type Server, type ServerResponse } from "node:http";
import { chatOnce, chatStream, OllamaError } from "~~/server/utils/chat/ollama";

const MODEL = "test-model";
const MESSAGES = [{ role: "user", content: "午饭 35 元" }];

// 用拼接组出标签字面量，避开转义歧义：开 7 字符 / 闭 8 字符
const TAG_OPEN = "<" + "think" + ">";
const TAG_CLOSE = "<" + "/think" + ">";

/** 每次请求的 JSON 正文 */
const ndjson = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

const expectOllamaError = (err: unknown, message: string): void => {
  expect(err instanceof OllamaError).toBe(true);
  expect((err as OllamaError).message).toBe(message);
};

/** 抓住 rejection（成功反而失败） */
const errOf = (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

type Responder = (body: unknown, res: ServerResponse) => void;

/** 迷你 ollama：只认 POST /api/chat，bodies 按请求序收集解析后的 JSON 正文 */
const startOllama = (respond: Responder) =>
  new Promise<{ baseUrl: string; bodies: unknown[]; done: () => Promise<void> }>((ok) => {
    const bodies: unknown[] = [];
    const server: Server = http.createServer((req, res) => {
      if (req.method !== "POST" || (req.url ?? "") !== "/api/chat") {
        res.writeHead(404).end();
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => {
        raw += c;
      });
      req.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {
          /* 收不到 JSON 就保持 null，由断言暴露 */
        }
        bodies.push(body);
        respond(body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      ok({
        baseUrl: `http://127.0.0.1:${port}`,
        bodies,
        done: () => new Promise<void>((close) => server.close(() => close())),
      });
    });
  });

/** 找一个当前没人监听的死端口（ listen(0) 抢到再立刻还回去） */
const deadPort = (): Promise<number> =>
  new Promise((ok) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => ok(p));
    });
  });

describe("chatStream 正常面", () => {
  it("请求体契约 + content 累积为最终正文，且与逐条 onDelta 拼接一致", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { model: MODEL, message: { role: "assistant", content: "好" }, done: false },
          { model: MODEL, message: { role: "assistant", content: "的，记了。" }, done: false },
          { model: MODEL, message: { role: "assistant", content: "" }, done: true },
          { message: { role: "assistant", content: "尾巴没带换行也要收到" }, done: true },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const result = await chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(result).toEqual({ content: "好的，记了。尾巴没带换行也要收到" });
      expect(deltas.join("")).toBe(result.content);
      // 请求契约：think:false + stream:true + messages 原样透传
      expect(m.bodies[0]).toEqual({
        model: MODEL,
        messages: MESSAGES,
        stream: true,
        think: false,
      });
    } finally {
      await m.done();
    }
  });

  it("坏行 / 空行容忍：不解析的行跳过，不打崩整条流", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(`\n不是 JSON 的行\n${JSON.stringify({ message: { content: "在的" } })}\n\n`);
    });
    try {
      const { content } = await chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, () => {});
      expect(content).toBe("在的");
    } finally {
      await m.done();
    }
  });
});

describe("chatStream thinking 过滤", () => {
  it("thinking 帧与 inline think 块全剥（标签被切断跨行也不漏），正文与 delta 都干净", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { message: { role: "assistant", thinking: "用户报了午饭 35 元", content: "" }, done: false },
          // 开标签被切在两行之间：<thi | nk>…
          { message: { role: "assistant", content: TAG_OPEN.slice(0, 4) }, done: false },
          {
            message: {
              role: "assistant",
              // 闭标签前半 </thi 也切在行尾
              content: TAG_OPEN.slice(4) + "先算金额" + TAG_CLOSE.slice(0, 5),
              thinking: "金额 35 元",
            },
            done: false,
          },
          { message: { role: "assistant", content: TAG_CLOSE.slice(5) + "已记午饭" }, done: false },
          { message: { role: "assistant", content: " 35 元。" }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const { content } = await chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(content).toBe("已记午饭 35 元。");
      expect(deltas).toEqual(["已记午饭", " 35 元。"]);
      expect(deltas.join("")).toBe(content);
    } finally {
      await m.done();
    }
  });

  it("正文中间的 think 块剥除：可见文本前后拼接，推理一个字不外发", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { message: { role: "assistant", content: "好的，" }, done: false },
          { message: { role: "assistant", content: TAG_OPEN + "核对一下 35 元" }, done: false },
          { message: { role: "assistant", content: TAG_CLOSE + "记上 35 元。" }, done: false },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const { content } = await chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(content).toBe("好的，记上 35 元。");
      expect(deltas.join("")).toBe(content);
    } finally {
      await m.done();
    }
  });

  it("未闭合 think：自最后一个开标签到流 EOF 的尾部一律按推理丢弃", async () => {
    // 开标签前已有可见文本：前缀保留、尾部整段砍掉
    const m1 = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { message: { role: "assistant", content: "记上" }, done: false },
          { message: { role: "assistant", content: TAG_OPEN + "这段推理没有闭合" }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const { content } = await chatStream({ baseUrl: m1.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(content).toBe("记上");
      expect(deltas).toEqual(["记上"]);
    } finally {
      await m1.done();
    }

    // 整条都是未闭合推理 → 交付正文为空（空字符串，不是抛错）
    const m2 = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { message: { role: "assistant", content: TAG_OPEN + "只想了想，没结论" }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const { content } = await chatStream({ baseUrl: m2.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(content).toBe("");
      expect(deltas).toEqual([]);
    } finally {
      await m2.done();
    }
  });

  it("流末尾扣住的半个标签（不是真的标签）按原文吐出", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(
        ndjson([
          { message: { role: "assistant", content: "记好了" }, done: false },
          { message: { role: "assistant", content: TAG_OPEN.slice(0, 4) }, done: false },
          { message: { role: "assistant", content: "" }, done: true },
        ])
      );
    });
    try {
      const deltas: string[] = [];
      const { content } = await chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, (d) =>
        deltas.push(d)
      );
      expect(content).toBe("记好了" + TAG_OPEN.slice(0, 4));
      expect(deltas).toEqual(["记好了", TAG_OPEN.slice(0, 4)]);
    } finally {
      await m.done();
    }
  });
});

describe("chatStream 错误面", () => {
  it("不可达 baseUrl（死端口）→ 无法连接 ollama 服务", async () => {
    const port = await deadPort();
    const err = await errOf(
      chatStream({ baseUrl: `http://127.0.0.1:${port}`, model: MODEL }, MESSAGES, () => {})
    );
    expectOllamaError(err, "无法连接 ollama 服务");
  });

  it("非 200 状态 → ollama 返回错误状态 500", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"boom"}');
    });
    try {
      const err = await errOf(
        chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, () => {})
      );
      expectOllamaError(err, "ollama 返回错误状态 500");
    } finally {
      await m.done();
    }
  });

  it("对端中途断开（写了半条流就断）→ ollama 流中断", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(ndjson([{ message: { role: "assistant", content: "好" }, done: false }]), () => {
        // 已写出一段后故意掐断，模拟正文中途断流
        setTimeout(() => res.socket?.destroy(), 50);
      });
    });
    try {
      const err = await errOf(
        chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, () => {})
      );
      expectOllamaError(err, "ollama 流中断");
    } finally {
      await m.done();
    }
  });

  it("NDJSON 里的错误行文案透传成 OllamaError", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.end(ndjson([{ error: "model nope 不存在" }]));
    });
    try {
      const err = await errOf(
        chatStream({ baseUrl: m.baseUrl, model: MODEL }, MESSAGES, () => {})
      );
      expectOllamaError(err, "ollama 返回错误：model nope 不存在");
    } finally {
      await m.done();
    }
  });

  it("OllamaError 是普通 Error 子类，可直接被调用方 instanceof", () => {
    const e = new OllamaError("任意消息");
    expect(e instanceof Error).toBe(true);
    expect(e.name).toBe("OllamaError");
  });
});

describe("chatOnce", () => {
  it("单发契约：stream=false + 单条 user 消息；返回正文同样剥掉 think 块", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: MODEL,
          message: {
            role: "assistant",
            thinking: "标题要短",
            content: TAG_OPEN + "想个短的" + TAG_CLOSE + "午饭记账",
          },
          done: true,
        })
      );
    });
    try {
      const out = await chatOnce({ baseUrl: m.baseUrl, model: MODEL }, "为这笔记录起个标题");
      expect(out).toBe("午饭记账");
      expect(m.bodies[0]).toEqual({
        model: MODEL,
        messages: [{ role: "user", content: "为这笔记录起个标题" }],
        stream: false,
        think: false,
      });
    } finally {
      await m.done();
    }
  });

  it("非 200 与错误行同样抛 OllamaError", async () => {
    const m = await startOllama((_body, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end('{"error":"model nope 不存在"}');
    });
    try {
      const err = await errOf(chatOnce({ baseUrl: m.baseUrl, model: MODEL }, "标题"));
      expectOllamaError(err, "ollama 返回错误状态 404");
    } finally {
      await m.done();
    }
  });
});