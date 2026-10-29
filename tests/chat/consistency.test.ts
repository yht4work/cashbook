/**
 * 三件套的接线一致性测试（防「各数各的图编号」漂移）：
 * 同一份 turns 喂给 history / prompt / flows 时三边必须用同一张编号表 ——
 * - prompt 的 imageCount ← buildImageNumbering(turns).length
 * - buildOllamaMessages 写在消息里的 [图N] 标记 ← 表的下标 1..N（无缺口）
 * - normalizeFlows 的 byIndex ← 表自身（AI 给的 imageIdx 按全局编号解析）
 * Task 4/6 组装上下文时照这里的方式接线。
 */
import { describe, expect, it } from "vitest";
import { buildImageNumbering, buildOllamaMessages, type ChatTurn } from "~~/server/utils/chat/history";
import { buildSystemPrompt } from "~~/server/utils/chat/prompt";
import { normalizeFlows, type ImageLookup } from "~~/server/utils/chat/flows";

const SYS = "SYS";
const opts = { imageTurnLimit: 3, imageTotalLimit: 6 };
const cand = { industry: ["餐饮"], pay: ["微信"], attribution: ["家里"] };

const ut = (content: string, images: string[] = []): ChatTurn => ({ role: "user", content, images });
const at = (content: string, flows?: string): ChatTurn => ({
  role: "assistant",
  content,
  images: [],
  ...(flows !== undefined ? { flows } : {}),
});

// 4 条含图 user 轮：最旧一条超窗口占位；中间夹已入账/纯文字 assistant 轮
const turns: ChatTurn[] = [
  ut("最早的小票", ["z1.png"]), // 图1 → 占位
  ut("早上的小票", ["a1.png", "a2.png"]), // 图2、3
  at("好的，已入账", JSON.stringify([{ flowId: 3 }])), // 折叠轮，不占号（无图）
  ut("中午的小票", ["c1.png"]), // 图4
  at("又一段回复"),
  ut("最新的小票", ["d1.png", "d2.png"]), // 图5、6
];

describe("三件套用同一张编号表", () => {
  it("编号表=全部图按出现顺序占号；prompt 的 imageCount 就该传表长", () => {
    const numbered = buildImageNumbering(turns, opts);
    expect(numbered).toEqual(["z1.png", "a1.png", "a2.png", "c1.png", "d1.png", "d2.png"]);
    // 消费方接线：imageCount: numbered.length
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: numbered.length });
    expect(p).toContain(`图1…图${numbered.length}`);
  });

  it("消息里的 [图N] 标记恰好覆盖编号表 1..N 无缺口，且每个号都能反查到文件名", () => {
    const numbered = buildImageNumbering(turns, opts);
    const out = buildOllamaMessages(SYS, turns, (n) => `b64(${n})`, opts);
    const used = out
      .flatMap((m) => [...m.content.matchAll(/\[图(\d+)/g)].map((x) => Number(x[1])))
      .sort((a, b) => a - b);
    expect(used).toEqual(numbered.map((_, i) => i + 1));
    expect(used.every((n) => numbered[n - 1])).toBe(true);
  });

  it("normalizeFlows 接线：imageIdx 用全局表解析；缺省 → 本次消息的图", () => {
    const numbered = buildImageNumbering(turns, opts);
    const current = turns[turns.length - 1].images; // send 场景：最新 user 轮=本次消息
    const lookup: ImageLookup = {
      default: () => current,
      byIndex: (i) => numbered[i - 1] ?? null,
    };
    const out = normalizeFlows(
      [
        { name: "没标来源的卡" },
        { name: "引窗口内的旧图", imageIdx: [4] },
        { name: "引最新的两张", imageIdx: [5, 6] },
        { name: "引被占位的历史图", imageIdx: [1] },
      ],
      cand,
      "2026-10-25",
      lookup
    );
    expect(out[0].invoices).toEqual(["d1.png", "d2.png"]); // default=本次消息的图
    expect(out[1].invoices).toEqual(["c1.png"]);
    expect(out[2].invoices).toEqual(["d1.png", "d2.png"]);
    expect(out[3].invoices).toEqual(["z1.png"]); // 占位图也在表里，编号都能反查
  });

  it("账本同源接线：prompt 候选与 normalizeFlows 的 bookId 映射吃同一份账本列表", () => {
    const books = [{ bookId: "b1", bookName: "现金" }, { bookId: "b2", bookName: "医保" }];
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 0, books, currentBookId: "b1" });
    expect(p).toContain("现金、医保"); // 名字列表与 normalize 吃的同一份
    const lookup: ImageLookup = { default: () => [], byIndex: () => null };
    const out = normalizeFlows(
      [{ name: "自付", bookName: "现金" }, { name: "统筹", bookName: "医保" }, { name: "没点名" }],
      cand,
      "2026-10-25",
      lookup,
      { books, currentBookId: "b1" }
    );
    expect(out.map((f) => f.bookId)).toEqual(["b1", "b2", "b1"]);
  });
});
