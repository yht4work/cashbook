/**
 * chat service 契约测试：prisma 连真实 docker 库，文件走 mkdtemp 临时目录。
 * - userId 固定 999999（测试专用账号），bookId 一律 test-chat-* 抛弃式账本，
 *   测试后 deleteMany 自建行；绝不碰既有用户/数据。
 * - ensureTitle 用本地 node http 起迷你 ollama mock（chatOnce 的请求契约
 *   已由 ollama.test.ts 钉死，这里只钉 service 侧的接线）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http, { type AddressInfo } from "node:http";
import prisma from "~~/server/lib/prisma";
import {
  CHAT_IMAGE_WINDOW,
  appendAssistantMessage,
  appendUserMessage,
  createSession,
  deleteSession,
  ensureTitle,
  getContext,
  getMessage,
  getMessages,
  finalizeFailedRetry,
  lastMessageId,
  listSessions,
  loadImages,
  saveCard,
  saveImages,
  todayOf,
  updateFailedMessage,
} from "~~/server/utils/chat/service";
import { buildImageNumbering } from "~~/server/utils/chat/history";
import { buildTitlePrompt } from "~~/server/utils/chat/prompt";
import type { DraftFlow } from "~~/server/utils/chat/flows";

const UID = 999999;
const UID_OTHER = 999998;
const BOOK_DEL = "test-chat-del";
const BOOK_CTX = "test-chat-ctx";
const BOOK_SAVE = "test-chat-save";
const BOOK_CAND = "test-chat-cand";
const BOOK_SHARED = "test-chat-shared";

let tmpDir: string;

const wipe = async (): Promise<void> => {
  // FK RESTRICT：先删消息再删会话；流水独立
  await prisma.chatMessage.deleteMany({ where: { userId: { in: [UID, UID_OTHER] } } });
  await prisma.chatSession.deleteMany({ where: { userId: { in: [UID, UID_OTHER] } } });
  await prisma.flow.deleteMany({ where: { userId: { in: [UID, UID_OTHER] } } });
};

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cb-chat-svc-"));
  await wipe(); // 上次失败运行可能残留
});

afterAll(async () => {
  await wipe();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

/** 自建测试流水：返回创建后的 id（显式传 null 的字段会真的存 null） */
const mkFlow = async (
  bookId: string,
  o: {
    day?: string;
    flowType?: string | null;
    industryType?: string | null;
    payType?: string | null;
    attribution?: string | null;
    money?: number;
    name?: string;
    invoice?: string;
  },
  /** 共享账本口径（C1）：可为别的成员 userId 种行（userId 与 bookId 相互独立） */
  userId: number = UID
): Promise<number> => {
  const row = await prisma.flow.create({
    data: {
      userId,
      bookId,
      day: o.day ?? "2026-10-25",
      flowType: o.flowType !== undefined ? o.flowType : "支出",
      industryType: o.industryType !== undefined ? o.industryType : "",
      payType: o.payType !== undefined ? o.payType : "",
      money: o.money ?? 0,
      name: o.name ?? "",
      description: "",
      attribution: o.attribution !== undefined ? o.attribution : "",
      invoice: o.invoice ?? "",
    },
  });
  return row.id;
};

/** 把会话 updateDate 拨回十分钟前（让「append 刷 updateDate」可严格断言） */
const backdate = async (sessionId: number): Promise<Date> => {
  const past = new Date(Date.now() - 600000);
  await prisma.chatSession.update({ where: { id: sessionId }, data: { updateDate: past } });
  return past;
};

const sessionOf = async (id: number) =>
  (await prisma.chatSession.findUnique({ where: { id } })) as NonNullable<Awaited<ReturnType<typeof prisma.chatSession.findUnique>>>;

describe("sessions：列表 / 新建", () => {
  it("createSession 空标题起步；listSessions 按 updateDate 倒序且只含本用户会话", async () => {
    const a = await createSession(UID);
    const b = await createSession(UID);
    await prisma.chatSession.update({
      where: { id: a.id },
      data: { updateDate: new Date(Date.now() - 600000) },
    });
    const foreign = await createSession(UID_OTHER);

    const list = await listSessions(UID);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
    expect(list.some((s) => s.id === foreign.id)).toBe(false);
    expect(list[0].title).toBeNull(); // 新建即为空标题
    expect(list[0].updateDate).toBeInstanceOf(Date);
  });
});

describe("deleteSession", () => {
  it("删消息后会话一并删掉（FK RESTRICT 下必须先删消息，否则会报错）", async () => {
    const { id } = await createSession(UID);
    await appendUserMessage(UID, id, "带图", ["x.png"]);
    await appendAssistantMessage(UID, id, "回复", null, 0);

    await deleteSession(UID, id, tmpDir);

    expect(await prisma.chatMessage.count({ where: { sessionId: id } })).toBe(0);
    expect(await prisma.chatSession.findUnique({ where: { id } })).toBeNull();
  });

  it("清理矩阵：被本用户 Flow.invoice 引用的留下，未引用的 chat-* 删掉；非 chat-* 与别的会话的文件不动", async () => {
    const session = await createSession(UID);
    const kept = await createSession(UID); // 不删的会话
    const dir = path.join(tmpDir, "images");
    const imgX = `chat-${session.id}-100-1-x.png`; // 被引用
    const imgY = `chat-${session.id}-100-2-y.png`; // 未引用
    const imgZ = `chat-${kept.id}-100-3-z.png`; // 别的会话的文件
    const raw = "upload-2026.png"; // 非 chat- 前缀，绝不清理
    await fsp.mkdir(dir, { recursive: true });
    await Promise.all(
      [imgX, imgY, imgZ, raw].map((n) => fsp.writeFile(path.join(dir, n), Buffer.from(n)))
    );
    await appendUserMessage(UID, session.id, "第一条", [imgX, raw]);
    await appendUserMessage(UID, session.id, "第二条", [imgY]);
    await appendUserMessage(UID, kept.id, "别删我的图", [imgZ]);
    await mkFlow(BOOK_DEL, { name: "已挂小票的流水", invoice: imgX });

    await deleteSession(UID, session.id, tmpDir);

    const exists = (n: string) => fs.existsSync(path.join(dir, n));
    expect(exists(imgX)).toBe(true); // 被 Flow.invoice 引用 → 保留（凭证继续可用）
    expect(exists(raw)).toBe(true); // 非 chat- 前缀 → 保留
    expect(exists(imgZ)).toBe(true); // 只清本会话消息里的文件
    expect(exists(imgY)).toBe(false); // 未引用的 chat-* → 删除
    expect((await listSessions(UID)).some((s) => s.id === session.id)).toBe(false);
  });

  it("文件清理失败不影响已提交的删除：记日志吞掉，行照删", async () => {
    const { id } = await createSession(UID);
    const dir = path.join(tmpDir, "images");
    const dirName = `chat-${id}-200-1-bad.png`; // 同名候选其实是目录 → unlink 报非 ENOENT
    await fsp.mkdir(path.join(dir, dirName), { recursive: true });
    await appendUserMessage(UID, id, "清理会失败", [dirName]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await deleteSession(UID, id, tmpDir); // 正常 resolve（DB 已提交的删除不能反着报 500）
      expect(errSpy).toHaveBeenCalled(); // 非ENOENT 的清理事后可见（日志）
    } finally {
      errSpy.mockRestore();
    }
    expect(await prisma.chatMessage.count({ where: { sessionId: id } })).toBe(0);
    expect(await prisma.chatSession.findUnique({ where: { id } })).toBeNull();
    expect(fs.existsSync(path.join(dir, dirName))).toBe(true); // 混账文件原地留待人工
  });

  it("会话不存在 / 不是自己的 → 抛错；什么都不动", async () => {
    const foreign = await createSession(UID_OTHER);
    try {
      await expect(deleteSession(UID, 999999001, tmpDir)).rejects.toThrow("会话不存在");
      await expect(deleteSession(UID, foreign.id, tmpDir)).rejects.toThrow("会话不存在");
      expect(await prisma.chatSession.findUnique({ where: { id: foreign.id } })).not.toBeNull();
    } finally {
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });
});

describe("消息追加与读取", () => {
  it("appendUserMessage/appendAssistantMessage 落库并刷新 updateDate；getMessages 升序、按用户过滤", async () => {
    const { id } = await createSession(UID);
    const pastUser = await backdate(id);
    await appendUserMessage(UID, id, "小票给你", ["u1.png", "u2.png"]);
    const afterUser = (await sessionOf(id)).updateDate;
    const pastAssistant = await backdate(id);
    await appendAssistantMessage(UID, id, "已提取 1 条", JSON.stringify([{ name: "奶茶", money: 15 }]), 0);
    const afterAssistant = (await sessionOf(id)).updateDate;

    expect(afterUser.getTime()).toBeGreaterThan(pastUser.getTime()); // append 刷 updateDate
    expect(afterAssistant.getTime()).toBeGreaterThan(pastAssistant.getTime());

    const rows = await getMessages(UID, id);
    expect(rows.length).toBe(2);
    expect(rows[0]).toEqual({
      id: expect.any(Number),
      role: "user",
      content: "小票给你",
      images: "u1.png,u2.png", // 存储原样（逗号串）
      flows: null,
      status: null,
      createDate: expect.any(Date),
    });
    expect(rows[1]).toEqual({
      id: expect.any(Number),
      role: "assistant",
      content: "已提取 1 条",
      images: null,
      flows: JSON.stringify([{ name: "奶茶", money: 15 }]),
      status: 0,
      createDate: expect.any(Date),
    });
    expect(new Date(rows[0].createDate).getTime())
      .toBeLessThanOrEqual(new Date(rows[1].createDate).getTime());
  });

  it("getMessages 无图消息 images 为空串原样返回；别人的会话返回空数组", async () => {
    const mine = await createSession(UID);
    const others = await createSession(UID_OTHER);
    await appendUserMessage(UID, mine.id, "纯文字");
    await appendAssistantMessage(UID, mine.id, "回复", null, 0);
    await appendUserMessage(UID_OTHER, others.id, "乙的消息");

    const rows = await getMessages(UID, mine.id);
    expect(rows.map((r) => r.content)).toEqual(["纯文字", "回复"]);
    expect(rows[0].images).toBe(""); // images="" 是存储原样
    expect(await getMessages(UID, others.id)).toEqual([]); // 拿不到别人的消息
  });
});

describe("getMessage / lastMessageId / finalizeFailedRetry（终审 M4/M5：findFirst + 单条收尾）", () => {
  it("getMessage：本人本会话取到行；跨会话/别人的/不存在 → null", async () => {
    const a = await createSession(UID);
    const b = await createSession(UID);
    await appendUserMessage(UID, a.id, "在会话a", ["u1.png"]);
    const row = (await getMessages(UID, a.id))[0];
    expect(await getMessage(UID, a.id, row.id)).toEqual(row); // 行原样返回
    expect(await getMessage(UID, b.id, row.id)).toBeNull(); // 行不属于会话 b

    const foreign = await createSession(UID_OTHER);
    try {
      await appendUserMessage(UID_OTHER, foreign.id, "别人的");
      const frow = (await getMessages(UID_OTHER, foreign.id))[0];
      expect(await getMessage(UID, foreign.id, frow.id)).toBeNull();
      expect(await getMessage(UID, a.id, 999999005)).toBeNull(); // 不存在
    } finally {
      await prisma.chatMessage.deleteMany({ where: { sessionId: foreign.id } });
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });

  it("lastMessageId：会话内最新一条的 id；空会话/别人的会话 → 0", async () => {
    const { id } = await createSession(UID);
    expect(await lastMessageId(UID, id)).toBe(0); // 空会话
    await appendUserMessage(UID, id, "第一");
    await appendAssistantMessage(UID, id, "回复", null, 0);
    const rows = await getMessages(UID, id);
    expect(await lastMessageId(UID, id)).toBe(rows.at(-1)!.id);
    expect(await lastMessageId(UID, id)).not.toBe(rows[0].id);

    const foreign = await createSession(UID_OTHER);
    try {
      await appendUserMessage(UID_OTHER, foreign.id, "别人的");
      expect(await lastMessageId(UID, foreign.id)).toBe(0); // 别人数据拿不到
    } finally {
      await prisma.chatMessage.deleteMany({ where: { sessionId: foreign.id } });
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });

  it("finalizeFailedRetry：-1 行一次落齐 content/flows/status=0；重复收尾/别人的 → false 且内容不动", async () => {
    const { id } = await createSession(UID);
    await appendUserMessage(UID, id, "小票给你", ["u1.png"]);
    const fail = await prisma.chatMessage.create({
      data: { sessionId: id, userId: UID, role: "assistant", content: "生成失败", status: -1 },
    });
    const flows = JSON.stringify([{ name: "奶茶", money: 15 }]);

    expect(await finalizeFailedRetry(UID, fail.id, "已记好 1 条", flows)).toBe(true);
    const row = await prisma.chatMessage.findUnique({ where: { id: fail.id } });
    expect(row!.content).toBe("已记好 1 条");
    expect(row!.flows).toBe(flows);
    expect(row!.status).toBe(0);

    // 已收尾（status 非 -1）→ false，内容不再被第二次写动（单条语义）
    expect(await finalizeFailedRetry(UID, fail.id, "不该覆盖", "[]")).toBe(false);
    const again = await prisma.chatMessage.findUnique({ where: { id: fail.id } });
    expect(again!.content).toBe("已记好 1 条");
    expect(again!.status).toBe(0);

    // 别人的失败行 → false 且原样
    const foreign = await createSession(UID_OTHER);
    try {
      const ofail = await prisma.chatMessage.create({
        data: { sessionId: foreign.id, userId: UID_OTHER, role: "assistant", content: "失败", status: -1 },
      });
      expect(await finalizeFailedRetry(UID, ofail.id, "x", "[]")).toBe(false);
      const orow = await prisma.chatMessage.findUnique({ where: { id: ofail.id } });
      expect(orow!.content).toBe("失败");
      expect(orow!.status).toBe(-1);
    } finally {
      await prisma.chatMessage.deleteMany({ where: { sessionId: foreign.id } });
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });
});

describe("getContext", () => {
  /** 造一批消息：12 组 user/assistant + 已入账轮 + 三条含图 user 轮（共 28 条） */
  const seedMessages = async (sessionId: number): Promise<string> => {
    for (let k = 0; k <= 10; k++) {
      await appendUserMessage(UID, sessionId, `话${k}`);
      await appendAssistantMessage(UID, sessionId, `复${k}`, null, 0);
    }
    await appendUserMessage(UID, sessionId, "已入账那轮", ["s.png"]);
    await appendAssistantMessage(UID, sessionId, "已记", JSON.stringify([{ flowId: 5, name: "奶茶" }]), 1);
    await appendUserMessage(UID, sessionId, "话12", ["old1.png"]);
    await appendAssistantMessage(UID, sessionId, "复12", null, 0);
    await appendUserMessage(UID, sessionId, "最新一句话", ["i1.png", "i2.png"]);
    return { role: "assistant", content: "复3" }; // 27 条里的第一条（27-20=7 下标 → 复3）
  };

  it("候选值 / 最近 5 条流水 / 编号表一致的 imageCount / turns 截最近 20 条且透传 flows", async () => {
    // 候选值来源：同一批流水兼任「最近 5 条」素材；各条 day 故意拉开，
    // 让「按 day 倒序取最近 5 条」的口径也被钉死（早饭补录在 10-26 也在列）
    const names = ["早饭", "薯片", "晚饭", "地铁", "瓜子", "奶茶", "打车", "无名"];
    await mkFlow(BOOK_CTX, { day: "2026-10-26", industryType: "餐饮", payType: "微信", attribution: "家里", name: names[0], money: 35 });
    await mkFlow(BOOK_CTX, { day: "2026-01-01", industryType: "零食", payType: "支付宝", attribution: "公司", name: names[1], money: 12.5 });
    await mkFlow(BOOK_CTX, { industryType: "餐饮", payType: "现金", attribution: "家里", name: names[2], money: 40 });
    await mkFlow(BOOK_CTX, { industryType: "交通", payType: "其他", attribution: "我", name: names[3], money: 4 });
    await mkFlow(BOOK_CTX, { industryType: "零食", payType: "微信", attribution: "伴侣", name: names[4], money: 9.9 });
    await mkFlow(BOOK_CTX, { industryType: "餐饮", payType: "微信", attribution: "家里", name: names[5], money: 15 });
    await mkFlow(BOOK_CTX, { industryType: "交通", payType: "支付宝", attribution: "我家", name: names[6], money: 22 });
    await mkFlow(BOOK_CTX, { flowType: null, industryType: null, payType: null, attribution: " ", name: names[7], money: 1 });

    const { id } = await createSession(UID);
    const expectedFirst = await seedMessages(id);

    const ctx = await getContext(UID, id, BOOK_CTX);

    // turns：长度 20、时间正序、第一/最后一条正确
    expect(ctx.turns.length).toBe(20);
    expect(ctx.turns[0]).toEqual({ ...expectedFirst, images: [] });
    expect(ctx.turns.at(-1)).toEqual({ role: "user", content: "最新一句话", images: ["i1.png", "i2.png"] });
    // flows 原样透传（折叠语义属于 history.buildOllamaMessages，这里不重复实现）
    const settled = ctx.turns.find((t) => t.content === "已记");
    expect(JSON.parse(settled!.flows!)).toEqual([{ flowId: 5, name: "奶茶" }]);
    expect(ctx.turns.every((t) => t.role === "user" || "flows" in t === false || typeof t.flows === "string")).toBe(true);

    // 图片编号单一事实源：prompt 的 imageCount ← 编号表 ← getContext 返回的 turns
    const numbered = buildImageNumbering(ctx.turns, CHAT_IMAGE_WINDOW);
    expect(numbered).toEqual(["s.png", "old1.png", "i1.png", "i2.png"]);
    expect(ctx.system).toContain(`本对话共提供 ${numbered.length} 张图`);
    expect(ctx.system).toContain(`图1…图${numbered.length}`);

    // 候选值：distinct 取值注入（null/空白过滤）
    const candOf = (system: string, label: string): string[] =>
      (system.match(new RegExp(`${label}：(.*)`))?.[1] ?? "").split("、").filter(Boolean);
    expect(new Set(candOf(ctx.system, "industryType"))).toEqual(new Set(["餐饮", "零食", "交通"]));
    expect(new Set(candOf(ctx.system, "payType"))).toEqual(new Set(["微信", "支付宝", "现金", "其他"]));
    expect(new Set(candOf(ctx.system, "attribution"))).toEqual(new Set(["家里", "公司", "我", "伴侣", "我家"]));
    expect(ctx.system).toContain(todayOf()); // system prompt 里的今天

    // 最近 5 条摘要：按 day 倒序取（10-26 早饭在列，1-01 薯片落窗），
    // 且空 flowType 渲染成「未分类」而非编造的收入/支出
    expect(ctx.system).toContain("最近 5 条");
    for (const n of ["早饭", "无名", "打车", "奶茶", "瓜子"]) {
      expect(ctx.system).toContain(n);
    }
    expect(ctx.system).toContain("未分类");
    for (const n of ["薯片", "晚饭", "地铁"]) {
      expect(ctx.system).not.toContain(n);
    }
  });

  it("无图会话走「本对话没有图片」分支", async () => {
    const { id } = await createSession(UID);
    await appendUserMessage(UID, id, "昨天午饭 35");

    const ctx = await getContext(UID, id, BOOK_CTX);
    expect(ctx.system).toContain("本对话没有图片");
    expect(ctx.turns.length).toBe(1);
    expect(ctx.turns[0]).toEqual({ role: "user", content: "昨天午饭 35", images: [] });
  });

  it("别人的会话 → 抛错", async () => {
    const foreign = await createSession(UID_OTHER);
    try {
      await expect(getContext(UID, foreign.id, BOOK_CTX)).rejects.toThrow("会话不存在");
    } finally {
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });

  it("getContext 加法（Task 6）：cand/today 与 system 同源；beforeId 把失败轮截出 turns", async () => {
    // 专用账本让 cand 可做全量断言（不依赖别的用例留下的候选值）
    await mkFlow(BOOK_CAND, { industryType: "外卖", payType: "微信", attribution: "我" });
    await mkFlow(BOOK_CAND, { industryType: "外卖", payType: "卡券", attribution: "家里", money: 3 });

    const { id } = await createSession(UID);
    await appendUserMessage(UID, id, "第一问");
    await appendAssistantMessage(UID, id, "第一条回复", null, 0);
    await appendUserMessage(UID, id, "第二问", ["p1.png"]); // 触发失败轮的 user 消息
    const failed = await prisma.chatMessage.create({
      data: { sessionId: id, userId: UID, role: "assistant", content: "生成失败", status: -1 },
    });

    const ctx = await getContext(UID, id, BOOK_CAND, { beforeId: failed.id });

    // cand / today 全量相等且就是这次查询算出的那一份（distinct 去重 + 空白过滤）
    expect(new Set(ctx.cand.industry)).toEqual(new Set(["外卖"]));
    expect(new Set(ctx.cand.pay)).toEqual(new Set(["微信", "卡券"]));
    expect(new Set(ctx.cand.attribution)).toEqual(new Set(["我", "家里"]));
    expect(Object.keys(ctx.cand)).toEqual(["industry", "pay", "attribution"]);
    expect(ctx.today).toBe(todayOf());
    expect(ctx.system).toContain(ctx.today); // system 里的「今天」同源
    expect(ctx.system).toContain("外卖"); // 候选也注入了 system

    // beforeId 截轮：失败行（id 不小于 retryId）整体不在 turns 里；
    // 最后一轮恰好是触发失败的 user 轮（sendCore 的 default() 图片来源）
    expect(ctx.turns.map((t) => t.content)).toEqual(["第一问", "第一条回复", "第二问"]);
    expect(ctx.turns.at(-1)).toEqual({ role: "user", content: "第二问", images: ["p1.png"] });
    expect(buildImageNumbering(ctx.turns, CHAT_IMAGE_WINDOW)).toEqual(["p1.png"]);

    // 不传 opts：失败行照常在 turns 里（原行为不变）
    const full = await getContext(UID, id, BOOK_CAND);
    expect(full.turns.map((t) => t.content)).toContain("生成失败");
    expect(full.cand).toEqual(ctx.cand);
    expect(full.today).toBe(ctx.today);
  });

  it("候选值与最近摘要按 bookId 全域共享口径：另一个 userId 录入的取值也在列", async () => {
    // 共享账本的真实数据形态：Flow.userId 与 bookId 相互独立——同一本账里，
    // 999999 自己的取值和另一个成员（999998）录入的取值并存
    await mkFlow(BOOK_SHARED, { day: "2026-10-20", industryType: "公交", payType: "公交卡", attribution: "我", name: "我的班车", money: 2 });
    await mkFlow(BOOK_SHARED, { day: "2026-10-28", industryType: "差旅", payType: "里程兑换", attribution: "合伙人", name: "合伙人的机票", money: 880 }, UID_OTHER);

    const { id } = await createSession(UID);
    const ctx = await getContext(UID, id, BOOK_SHARED);

    // cand 含共享账本其他成员的取值（bookId 全域 distinct，不是「本 userId 专属」）
    expect(ctx.cand.industry).toContain("差旅");
    expect(ctx.cand.pay).toContain("里程兑换");
    expect(ctx.cand.attribution).toContain("合伙人");
    // 最近流水摘要同为全账本口径：day 最新的「合伙人的机票」落在摘要里
    expect(ctx.system).toContain("该账本最近 2 条流水");
    expect(ctx.system).toContain("合伙人的机票");
    expect(ctx.system).toContain("我的班车");
  });
});

describe("todayOf", () => {
  it("Asia/Shanghai 时区的 YYYY-MM-DD（跨日边界落在上海日历）", () => {
    expect(todayOf(Date.UTC(2026, 0, 1, 15, 0))).toBe("2026-01-01"); // 北京时间 23:00
    expect(todayOf(Date.UTC(2026, 0, 1, 16, 0))).toBe("2026-01-02"); // 北京时间 00:30 次日
  });
});

describe("saveCard", () => {
  /** 造一条有两张卡的 assistant 消息（status 0，第 0 张带 imageIdx 预填） */
  const seedCards = async (sessionId: number, status = 0): Promise<number> => {
    const msg = await prisma.chatMessage.create({
      data: {
        sessionId,
        userId: UID,
        role: "assistant",
        content: "识别到 2 条流水",
        status,
        flows: JSON.stringify([
          {
            day: "2026-10-24",
            flowType: "支出",
            industryType: "餐饮",
            payType: "微信",
            money: 35,
            name: "午饭",
            description: "",
            attribution: "家里",
            invoices: [],
            imageIdx: [1],
          },
          { day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [] },
        ]),
      },
    });
    return msg.id;
  };

  it("编辑后的卡建 Flow 行、flows 回写 flowId、剩卡未齐时 status 仍 0", async () => {
    const { id } = await createSession(UID);
    // 凭证池来源（M1）：前置 user 行的 images 就是这两张卡片的挂票来源
    await appendUserMessage(UID, id, "拍的小票", ["chat-a.png", "chat-b.png"]);
    const msgId = await seedCards(id);
    const edited: DraftFlow = {
      day: "2026-10-23",
      flowType: "收入",
      industryType: "交通",
      payType: "支付宝",
      money: 12.5,
      name: "薯片",
      description: "改过的描述",
      attribution: "本人",
      invoices: ["chat-a.png", "chat-b.png"],
    };

    const res = await saveCard(UID, msgId, 0, edited, BOOK_SAVE);

    const flow = await prisma.flow.findUnique({ where: { id: res.flowId } });
    expect(flow).toEqual({
      id: res.flowId,
      userId: UID,
      bookId: BOOK_SAVE,
      day: "2026-10-23",
      flowType: "收入",
      industryType: "交通",
      payType: "支付宝",
      money: 12.5,
      name: "薯片",
      description: "改过的描述",
      invoice: "chat-a.png,chat-b.png",
      origin: null,
      attribution: "本人",
      eliminate: 0,
    });

    const stored = JSON.parse((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.flows!);
    expect(Object.keys(stored[0]).sort()).toEqual([
      "attribution", "day", "description", "flowId", "flowType", "industryType", "invoices", "money", "name", "payType",
    ]); // 白名单字段（AI 的 imageIdx 预填不残留）
    expect(stored[0].flowId).toBe(res.flowId);
    expect(stored[1]).toEqual({ day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [] });
    expect((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.status).toBe(0); // 卡片未齐 → 保持 0

    await prisma.flow.deleteMany({ where: { id: res.flowId } });
  });

  it("最后一张卡入账后 status 派生为 1", async () => {
    const { id } = await createSession(UID);
    const msgId = await seedCards(id);
    const first = await saveCard(UID, msgId, 0, {
      day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 35, name: "午饭", description: "", attribution: "", invoices: [],
    }, BOOK_SAVE);
    expect((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.status).toBe(0);

    const second = await saveCard(UID, msgId, 1, {
      day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [],
    }, BOOK_SAVE);

    const msg = await prisma.chatMessage.findUnique({ where: { id: msgId } });
    expect(msg!.status).toBe(1);
    expect(JSON.parse(msg!.flows!)).toEqual([
      { day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 35, name: "午饭", description: "", attribution: "", invoices: [], flowId: first.flowId },
      { day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [], flowId: second.flowId },
    ]);
    expect(second.flowId).not.toBe(first.flowId);
    await prisma.flow.deleteMany({ where: { id: { in: [first.flowId, second.flowId] } } });
  });

  it("并发保存不丢账：事务先 SELECT FOR UPDATE 行锁排队，锁后重读看到别人已提交的 flowId", async () => {
    const { id } = await createSession(UID);
    const msgId = await seedCards(id);
    const card: DraftFlow = {
      day: "2026-10-24", flowType: "支出", industryType: "", payType: "",
      money: 15, name: "奶茶", description: "", attribution: "", invoices: [],
    };

    // 模拟「先点的那次入账」：独立事务先建 Flow、把卡 1 写回 flowId，但持锁不提交
    let t1FlowId = 0;
    let t1Ready!: () => void;
    const ready = new Promise<void>((r) => (t1Ready = r));
    let unblockT1!: () => void;
    const blocker = new Promise<void>((r) => (unblockT1 = r));
    const firstSave = prisma.$transaction(async (tx) => {
      const flow = await tx.flow.create({
        data: { userId: UID, bookId: BOOK_SAVE, day: "2026-10-24", flowType: "支出", name: "奶茶(先点)" },
      });
      t1FlowId = flow.id;
      const cards = JSON.parse((await tx.chatMessage.findUnique({ where: { id: msgId } }))!.flows!);
      cards[1] = { ...cards[1], flowId: flow.id };
      await tx.chatMessage.update({ where: { id: msgId }, data: { flows: JSON.stringify(cards) } });
      t1Ready(); // 已写入并持住行锁
      await blocker;
    });
    await ready;

    // 双击同卡：saveCard 必须在锁上排队，拿到锁后重读到 flowId 并拒绝（而不是
    // 基于旧快照重复建 Flow 并覆盖掉 T1 的 flowId）
    const secondSave = saveCard(UID, msgId, 1, card, BOOK_SAVE).then(
      (v) => ({ ok: true as const, ...v }),
      (e: Error) => ({ ok: false as const, msg: e.message })
    );
    await new Promise((r) => setTimeout(r, 100)); // 留出排队时机（结果断言不依赖此时长）
    unblockT1(); // 提交 T1 → saveCard 的 FOR UPDATE 放行
    await firstSave;
    expect(await secondSave).toEqual({ ok: false, msg: "该卡片已入账" });

    expect(await prisma.flow.count({ where: { bookId: BOOK_SAVE, userId: UID } })).toBe(1); // 不重复建卡
    const stored = JSON.parse((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.flows!);
    expect(stored[1].flowId).toBe(t1FlowId); // 先点的那次入账没被覆盖
    expect(stored[0]).not.toHaveProperty("flowId"); // 卡 0 原样
    await prisma.flow.deleteMany({ where: { bookId: BOOK_SAVE, userId: UID } });
  });

  it("已入账的卡重复入账 / 越界下标 / 别人的消息 → 抛错", async () => {
    const { id } = await createSession(UID);
    const msgId = await seedCards(id);
    const card: DraftFlow = { day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 1, name: "x", description: "", attribution: "", invoices: [] };

    await saveCard(UID, msgId, 0, card, BOOK_SAVE);
    await expect(saveCard(UID, msgId, 0, card, BOOK_SAVE)).rejects.toThrow("已入账");
    await expect(saveCard(UID, msgId, 2, card, BOOK_SAVE)).rejects.toThrow("卡片不存在");
    await expect(saveCard(UID, msgId, -1, card, BOOK_SAVE)).rejects.toThrow("卡片不存在");
    await expect(saveCard(UID, 999999002, 0, card, BOOK_SAVE)).rejects.toThrow("消息不存在");
    await prisma.flow.deleteMany({ where: { id: { in: (await prisma.flow.findMany({ where: { bookId: BOOK_SAVE } })).map((f) => f.id) } } });
  });

  /** 造一条「凭证齐全」的消息：前置 user 行拍了两张图，卡 0 自身也挂了一张（池=三份并集） */
  const seedPoolCards = async (sessionId: number): Promise<number> => {
    await appendUserMessage(UID, sessionId, "拍的小票", ["chat-100-1-u.png", "chat-100-2-u.png"]);
    const msg = await prisma.chatMessage.create({
      data: {
        sessionId,
        userId: UID,
        role: "assistant",
        content: "识别到 2 条流水",
        status: 0,
        flows: JSON.stringify([
          { day: "2026-10-24", flowType: "支出", industryType: "餐饮", payType: "微信", money: 35, name: "午饭", description: "", attribution: "家里", invoices: ["chat-100-3-a.png"] },
          { day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [] },
        ]),
      },
    });
    return msg.id;
  };

  it("凭证池：本消息各卡 invoices ∪ 前置 user 行 images（与前端 ChatDraftCard 同池），池内文件带前后空白放行且落库已 trim", async () => {
    const { id } = await createSession(UID);
    const card = (): DraftFlow => ({
      day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices: [],
    });

    const msgId = await seedPoolCards(id);
    // (a) 来自前置 user 行 images 的文件名
    const fromUser = await saveCard(UID, msgId, 1, { ...card(), invoices: ["chat-100-2-u.png"] }, BOOK_SAVE);
    expect((await prisma.flow.findUnique({ where: { id: fromUser.flowId } }))!.invoice).toBe("chat-100-2-u.png");

    // (d) 来自另一张卡的 invoices，带前后空格 → 放行，落库值已 trim（顺手洗前后空白）
    const msg2 = await seedPoolCards(id);
    const fromCard = await saveCard(UID, msg2, 1, { ...card(), invoices: [" chat-100-3-a.png "] }, BOOK_SAVE);
    expect((await prisma.flow.findUnique({ where: { id: fromCard.flowId } }))!.invoice).toBe("chat-100-3-a.png");

    await prisma.flow.deleteMany({ where: { id: { in: [fromUser.flowId, fromCard.flowId] } } });
  });

  it("凭证池外文件/纯空白 invoices → 拒绝，整套不落 Flow、flows 回写原样", async () => {
    const { id } = await createSession(UID);
    const msgId = await seedPoolCards(id);
    const card = (invoices: string[]): DraftFlow => ({
      day: "2026-10-24", flowType: "支出", industryType: "", payType: "", money: 15, name: "奶茶", description: "", attribution: "", invoices,
    });

    // (b) 混入一张池外文件（借 API 把别处 chat-* 挂名）→ 中文报错
    await expect(
      saveCard(UID, msgId, 1, card(["chat-999-伪造.png"]), BOOK_SAVE)
    ).rejects.toThrow("小票凭证不在本消息的图集内，请刷新后重试");
    await expect(
      saveCard(UID, msgId, 1, card(["chat-100-1-u.png", "chat-999-伪造.png"]), BOOK_SAVE)
    ).rejects.toThrow("小票凭证不在本消息的图集内");
    // (c) 纯空白项同样拒
    await expect(saveCard(UID, msgId, 1, card(["  "]), BOOK_SAVE)).rejects.toThrow("小票凭证不在本消息的图集内");

    expect(await prisma.flow.count({ where: { userId: UID, bookId: BOOK_SAVE } })).toBe(0);
    const stored = JSON.parse((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.flows!);
    expect(stored[1]).not.toHaveProperty("flowId");
    expect((await prisma.chatMessage.findUnique({ where: { id: msgId } }))!.status).toBe(0);
  });
});

describe("updateFailedMessage", () => {
  it("失败消息只改 content；返回值收敛为 void（重试取图走 getContext，不再回传 images）", async () => {
    const { id } = await createSession(UID);
    await appendUserMessage(UID, id, "小票给你", ["u1.png", "u2.png"]);
    const fail = await prisma.chatMessage.create({
      data: { sessionId: id, userId: UID, role: "assistant", content: "生成失败", status: -1 },
    });

    await expect(updateFailedMessage(UID, fail.id, "重新生成的文案")).resolves.toBeUndefined();

    const row = await prisma.chatMessage.findUnique({ where: { id: fail.id } });
    expect(row!.content).toBe("重新生成的文案");
    expect(row!.status).toBe(-1); // 只改 content，状态不动
  });

  it("status≠-1 / 别人的消息 → 抛错；前置没有 user 行也照样只改 content（不再查前置行取图）", async () => {
    const { id } = await createSession(UID);
    await appendAssistantMessage(UID, id, "正常回复", null, 0);
    const okMsg = await prisma.chatMessage.create({
      data: { sessionId: id, userId: UID, role: "assistant", content: "也是正常的", status: 0 },
    });
    await expect(updateFailedMessage(UID, okMsg.id, "不该改")).rejects.toThrow();
    await expect(updateFailedMessage(UID, 999999003, "不该改")).rejects.toThrow("消息不存在");

    const orphanFail = await prisma.chatMessage.create({
      data: { sessionId: id, userId: UID, role: "assistant", content: "失败", status: -1 },
    });
    expect(await updateFailedMessage(UID, orphanFail.id, "改一下")).toBeUndefined();
  });
});

describe("ensureTitle", () => {
  /** 迷你 ollama：固定回 content，收集请求正文（用 bodies.length 钉「有没有发请求」） */
  const startTitleMock = (content: string) => {
    type S = { baseUrl: string; bodies: string[]; done: () => Promise<void> };
    return new Promise<S>((ok) => {
      const bodies: string[] = [];
      const server = http.createServer((req, res) => {
        let raw = "";
        req.setEncoding("utf8");
        req.on("data", (c: string) => {
          raw += c;
        });
        req.on("end", () => {
          bodies.push(raw);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: { content }, done: true }));
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
  };

  it("首次生成：请求体=chatOnce 契约 + buildTitlePrompt；标题清洗后入库并返回", async () => {
    const m = await startTitleMock('"好的，午饭 记账。"');
    try {
      const { id } = await createSession(UID);
      const title = await ensureTitle(UID, id, "午饭 35 元", "已记好 1 条", { baseUrl: m.baseUrl, model: "test-model" });

      expect(title).toBe("好的午饭记账"); // 引号/空格/句号剥掉
      expect((await sessionOf(id)).title).toBe("好的午饭记账");
      const body = JSON.parse(m.bodies[0]);
      expect(body).toMatchObject({ stream: false, model: "test-model" });
      expect(body.messages).toEqual([
        { role: "user", content: buildTitlePrompt("午饭 35 元", "已记好 1 条") },
      ]);
    } finally {
      await m.done();
    }
  });

  it("标题超过 12 字截断", async () => {
    const m = await startTitleMock('一二三四五六七八九十甲乙丙丁'); // 14 个字
    try {
      const { id } = await createSession(UID);
      const title = await ensureTitle(UID, id, "很长很长的一句", "回复", { baseUrl: m.baseUrl, model: "test-model" });
      expect(title).toBe("一二三四五六七八九十甲乙"); // 12 字
      expect((await sessionOf(id)).title).toBe("一二三四五六七八九十甲乙");
    } finally {
      await m.done();
    }
  });

  it("已有标题（非 null）→ 不再生成：不调 ollama，返回 null，标题保持", async () => {
    const m = await startTitleMock("不该被用到");
    try {
      const { id } = await createSession(UID);
      await prisma.chatSession.update({ where: { id }, data: { title: "已有标题" } });

      const out = await ensureTitle(UID, id, "新的对话", "新的回复", { baseUrl: m.baseUrl, model: "test-model" });

      expect(out).toBeNull();
      expect(m.bodies.length).toBe(0); // 一次请求都没发
      expect((await sessionOf(id)).title).toBe("已有标题");
    } finally {
      await m.done();
    }
  });

  it("ollama 不可用 → 静默回退为 userText 前 20 字", async () => {
    const port = await new Promise<number>((ok) => {
      const s = http.createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => ok(p));
      });
    });
    const { id } = await createSession(UID);
    const userText = "请把这张小票里的零食记到账本里顺便把昨天的午饭补上一下";
    const title = await ensureTitle(UID, id, userText, "回复", {
      baseUrl: `http://127.0.0.1:${port}`,
      model: "test-model",
    });
    expect(title).toBe(userText.slice(0, 20));
    expect((await sessionOf(id)).title).toBe(userText.slice(0, 20));
  });

  it("没给 cfg（调用方没有 ollama 配置）→ 同样静默回退；会话不存在 → null", async () => {
    const { id } = await createSession(UID);
    const userText = "只有文字没有配置的一句话";
    expect(await ensureTitle(UID, id, userText, "回复")).toBe(userText.slice(0, 20));
    expect((await sessionOf(id)).title).toBe(userText.slice(0, 20));
    expect(await ensureTitle(UID, 999999004, "x", "y")).toBeNull();
  });

  it("兜底链走完仍为空（无 cfg + 首条纯图 userText=\"\"）→ 不落库空标题：返回 null、title 保持 null", async () => {
    const { id } = await createSession(UID);
    expect(await ensureTitle(UID, id, "", "回复")).toBeNull();
    expect((await sessionOf(id)).title).toBeNull(); // title 保持 null，后续轮次还有机会再起名
  });
});

describe("saveImages / loadImages", () => {
  it("存图命名 chat-{sessionId}-{ts}-{n}.{ext}（同一批同 ts），readable 为 base64", async () => {
    const { id } = await createSession(UID);
    const b1 = Buffer.from("AAA-A");
    const b2 = Buffer.from("BBB-B");

    const names = await saveImages(UID, id, [
      { ext: ".png", data: b1 },
      { ext: "jpg", data: b2 }, // 不带点也能补上
    ], tmpDir);

    expect(names[0]).toMatch(new RegExp(`^chat-${id}-\\d+-1\\.png$`));
    expect(names[1]).toMatch(new RegExp(`^chat-${id}-\\d+-2\\.jpg$`));
    expect(names[1].split("-")[2]).toBe(names[0].split("-")[2]); // 同一批同 ts
    expect(await fsp.readFile(path.join(tmpDir, "images", names[0]))).toEqual(b1);
    expect(await fsp.readFile(path.join(tmpDir, "images", names[1]))).toEqual(b2);

    const map = await loadImages(tmpDir, names);
    expect(map.get(names[0])).toBe(b1.toString("base64"));
    expect(map.get(names[1])).toBe(b2.toString("base64"));
  });

  it("半写回滚：第 2 张写盘失败 → 本次已落盘的第 1 张删掉、目录无残留，原始错误重抛", async () => {
    const { id } = await createSession(UID);
    const dir = path.join(tmpDir, "images");
    await fsp.mkdir(dir, { recursive: true });
    const residue = async (): Promise<string[]> => (await fsp.readdir(dir)).filter((n) => n.startsWith(`chat-${id}-`));
    expect(await residue()).toEqual([]);

    // service.ts 以默认导入拿 node:fs/promises 的默认导出对象，spyOn 即可截获
    const real = fsp.writeFile.bind(fsp) as unknown as (p: string, data: Buffer | string) => Promise<void>;
    let calls = 0;
    const spy = vi
      .spyOn(fsp, "writeFile")
      .mockImplementation((async (p: unknown, data: unknown) => {
        calls += 1;
        if (calls === 1) {
          return real(p as string, data as Buffer); // 第 1 张放行，真写
        }
        throw Object.assign(new Error("EACCES"), { code: "EACCES" }); // 第 2 张起失败
      }) as unknown as typeof fsp.writeFile);
    try {
      await expect(
        saveImages(UID, id, [
          { ext: ".png", data: Buffer.from("第一张") },
          { ext: ".png", data: Buffer.from("第二张") },
        ], tmpDir)
      ).rejects.toThrow("EACCES");
    } finally {
      spy.mockRestore();
    }

    expect(calls).toBe(2);
    expect(await residue()).toEqual([]); // 第 1 张被回滚删掉，目录无半写孤儿
  });

  it(" hostile 入参整体拒绝（白名单外 ext / 无效 data）：一个文件都不写", async () => {
    const { id } = await createSession(UID);
    const dir = path.join(tmpDir, "images");
    await fsp.mkdir(dir, { recursive: true });
    const before = (await fsp.readdir(dir)).length;

    for (const bad of [
      { ext: "x/../../evil", data: Buffer.from("穿越") },
      { ext: ".p.g", data: Buffer.from("中点不止一个") },
      { ext: ".", data: Buffer.from("光杆句点") },
      { ext: "", data: Buffer.from("无扩展名") },
    ]) {
      await expect(saveImages(UID, id, [bad], tmpDir)).rejects.toThrow("图片扩展名不合法");
    }
    await expect(
      saveImages(UID, id, [{ ext: ".png", data: Buffer.alloc(0) }], tmpDir)
    ).rejects.toThrow("图片数据无效");
    // 合法与非法混着来也一样整体拒（先全量校验再写盘）
    await expect(
      saveImages(UID, id, [
        { ext: ".png", data: Buffer.from("合法的") },
        { ext: ".p.g", data: Buffer.from("非法的") },
      ], tmpDir)
    ).rejects.toThrow("图片扩展名不合法");

    expect((await fsp.readdir(dir)).length).toBe(before);
  });

  it("别人的 sessionId 存图 → 抛错", async () => {
    const foreign = await createSession(UID_OTHER);
    try {
      await expect(
        saveImages(UID, foreign.id, [{ ext: ".png", data: Buffer.from("x") }], tmpDir)
      ).rejects.toThrow("会话不存在");
    } finally {
      await prisma.chatSession.deleteMany({ where: { id: foreign.id } });
    }
  });
});
