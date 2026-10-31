import { beforeEach, describe, expect, it } from "vitest";
import { buildImageNumbering, buildOllamaMessages, planImages, type ChatTurn } from "../../server/utils/chat/history";

const SYS = "SYS PROMPT";
const opts = { imageTurnLimit: 3, imageTotalLimit: 6 };

// readImg 桩：把文件名变成可区分的 base64 假串，同时记录调用顺序
let called: string[] = [];
const readImg = (n: string): string => {
  called.push(n);
  return `b64(${n})`;
};

const ut = (content: string, images: string[] = []): ChatTurn => ({ role: "user", content, images });
const at = (content: string, flows?: string): ChatTurn => ({
  role: "assistant",
  content,
  images: [],
  ...(flows !== undefined ? { flows } : {}),
});

beforeEach(() => {
  called = [];
});

describe("buildOllamaMessages", () => {
  it("system 打头；最近 3 条含图 user 轮真传 base64，更早的以 [图N已省略] 占位；图片编号整次调用连续", () => {
    const turns: ChatTurn[] = [
      ut("买书", ["u1.png"]), // 最旧 → 占位
      at("嗯嗯 已帮你记好 1 条"),
      ut("奶茶", ["u2.png"]), // 次旧 → 占位
      ut("午饭小票", ["u3.png"]), // 窗口内
      ut("超市小票", ["u4.png"]), // 窗口内
      ut("油费小票", ["u5.png", "u5b.png"]), // 最新，两张
    ];
    const out = buildOllamaMessages(SYS, turns, readImg, opts);
    expect(out).toEqual([
      { role: "system", content: SYS },
      { role: "user", content: "买书\n[图1已省略]" },
      { role: "assistant", content: "嗯嗯 已帮你记好 1 条" },
      { role: "user", content: "奶茶\n[图2已省略]" },
      { role: "user", content: "午饭小票\n[图3]", images: ["b64(u3.png)"] },
      { role: "user", content: "超市小票\n[图4]", images: ["b64(u4.png)"] },
      { role: "user", content: "油费小票\n[图5]\n[图6]", images: ["b64(u5.png)", "b64(u5b.png)"] },
    ]);
    // readImg 只在真传时被调，且收到的是文件名本身
    expect(called.sort()).toEqual(["u3.png", "u4.png", "u5.png", "u5b.png"]);
  });

  it("总量上限 6 张：从最新的含图轮往前分配额度，装不下的轮整体占位", () => {
    const turns: ChatTurn[] = [
      ut("a", ["a1.png", "a2.png", "a3.png"]),
      ut("b", ["b1.png", "b2.png", "b3.png"]),
      ut("c", ["c1.png", "c2.png", "c3.png"]),
    ];
    const out = buildOllamaMessages(SYS, turns, readImg, opts);
    expect(out).toEqual([
      { role: "system", content: SYS },
      { role: "user", content: "a\n[图1已省略]\n[图2已省略]\n[图3已省略]" },
      {
        role: "user",
        content: "b\n[图4]\n[图5]\n[图6]",
        images: ["b64(b1.png)", "b64(b2.png)", "b64(b3.png)"],
      },
      {
        role: "user",
        content: "c\n[图7]\n[图8]\n[图9]",
        images: ["b64(c1.png)", "b64(c2.png)", "b64(c3.png)"],
      },
    ]);
    const total = out.reduce((n, m) => n + (m.images?.length ?? 0), 0);
    expect(total).toBe(6);
  });

  it("上限切进同一轮内：先到的图真传，剩余的占位", () => {
    const out = buildOllamaMessages(SYS, [ut("x", ["x1.png", "x2.png", "x3.png"])], readImg, {
      imageTurnLimit: 3,
      imageTotalLimit: 2,
    });
    expect(out).toEqual([
      { role: "system", content: SYS },
      {
        role: "user",
        content: "x\n[图1]\n[图2]\n[图3已省略]",
        images: ["b64(x1.png)", "b64(x2.png)"],
      },
    ]);
  });

  it("已入账 assistant 轮（每张卡都有 flowId）折叠为短摘要；未入账/坏 JSON/空数组的轮保持原文", () => {
    const turns: ChatTurn[] = [
      ut("小票发你", ["r.png"]),
      at("一段很长很长的解析回复，不要出现在历史里", JSON.stringify([{ flowId: 7, name: "午饭" }, { flowId: 8, name: "奶茶" }])),
      ut("再来一杯奶茶也记一下", []),
      at("还有一张卡没入账的回复", JSON.stringify([{ flowId: 7 }, { name: "b" }])),
      at("flows 是坏 JSON 的回复", "not json"),
      at("空 flows 的回复", "[]"),
    ];
    const out = buildOllamaMessages(SYS, turns, readImg, opts);
    expect(out).toEqual([
      { role: "system", content: SYS },
      { role: "user", content: "小票发你\n[图1]", images: ["b64(r.png)"] },
      { role: "assistant", content: "[已入账 2 条流水]" },
      { role: "user", content: "再来一杯奶茶也记一下" },
      { role: "assistant", content: "还有一张卡没入账的回复" },
      { role: "assistant", content: "flows 是坏 JSON 的回复" },
      { role: "assistant", content: "空 flows 的回复" },
    ]);
  });

  it("无图轮不输出 images 字段；空内容的轮只留编号标记", () => {
    const turns: ChatTurn[] = [
      at("纯文字回复"),
      ut("", ["p.png"]),
    ];
    const out = buildOllamaMessages(SYS, turns, readImg, opts);
    expect(out).toEqual([
      { role: "system", content: SYS },
      { role: "assistant", content: "纯文字回复" },
      { role: "user", content: "[图1]", images: ["b64(p.png)"] },
    ]);
    expect("images" in out[1]).toBe(false);
    expect("images" in out[0]).toBe(false);
  });
});

describe("buildImageNumbering", () => {
  it("编号表按出现顺序全量占号（占位图也占号），与真传窗口无关", () => {
    const turns: ChatTurn[] = [
      ut("a", ["a1.png", "a2.png"]),
      at("回复"),
      ut("b", ["b1.png"]),
    ];
    const wide = buildImageNumbering(turns, opts);
    const narrow = buildImageNumbering(turns, { imageTurnLimit: 1, imageTotalLimit: 1 });
    expect(wide).toEqual(["a1.png", "a2.png", "b1.png"]);
    expect(narrow).toEqual(wide); // 占号只按出现顺序，不随窗口变化
  });
});

describe("planImages（终审 M1：sendCore 读盘只读真传集，缺票半径=真传的图）", () => {
  it("numbered=全量编号表；attached=真传的 1-based 编号；读盘名单=attached 反查编号表", () => {
    const turns: ChatTurn[] = [
      ut("a", ["a1.png", "a2.png"]), // 最旧一轮，额度装不下 → 整体占位
      at("回复"),
      ut("b", ["b1.png"]),
      ut("c", ["c1.png", "c2.png", "c3.png"]), // 最新
    ];
    const plan = planImages(turns, { imageTurnLimit: 2, imageTotalLimit: 4 });

    expect(plan.numbered).toEqual(["a1.png", "a2.png", "b1.png", "c1.png", "c2.png", "c3.png"]);
    expect([...plan.attached].sort((x, y) => x - y)).toEqual([3, 4, 5, 6]); // b 轮 1 张 + c 轮 3 张
    // sendCore 的读盘口径与 buildOllamaMessages 的真传口径共享这张 plan
    expect([...plan.attached].map((i) => plan.numbered[i - 1]).filter(Boolean)).toEqual(
      ["b1.png", "c1.png", "c2.png", "c3.png"]
    );
    expect(buildImageNumbering(turns, { imageTurnLimit: 2, imageTotalLimit: 4 })).toEqual(plan.numbered);
  });

  it("无图/空会话：attached 为空 → 读盘名单为空数组（loadImages 不碰任何文件）", () => {
    expect(planImages([], opts)).toEqual({ numbered: [], attached: new Set() });
    const plan = planImages([ut("纯文字"), at("回复")], opts);
    expect(plan.numbered).toEqual([]);
    expect([...plan.attached]).toEqual([]);
  });
});
