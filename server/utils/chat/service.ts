/**
 * chat 领域服务：整个 chat 功能里唯一摸 prisma / 文件系统的模块；HTTP 端点
 * （任务 5/6）只做鉴权与壳调用。职责：
 * - 会话 CRUD 与消息落库/读取/编辑（updateDate 驱动会话列表排序）
 * - 上下文组装（getContext：候选值查询 + 最近流水摘要 + 图编号接线）
 * - 卡片入账（saveCard：建 Flow + flows 回写 + status 派生，事务包裹）
 * - 图片文件：保存 / 读回 / 删除清理，文件名
 *   chat-{sessionId}-{ts}-{rand}-{n}.{ext}（rand 是防同毫秒并发的随机段）
 *   （只落 dataDir/images；dataDir 由 handlers 从 runtimeConfig.dataPath 接进来）
 *
 * 抛错统一为带中文 message 的普通 Error，由端点转 error()；不依赖任何
 * Nuxt auto-import，纯 import 保证 node/vitest 可直接跑。
 */

import prisma from "~~/server/lib/prisma";
import { buildSystemPrompt, buildTitlePrompt } from "~~/server/utils/chat/prompt";
import { buildImageNumbering, cardBooked, type ChatTurn, type ImageWindowOpts } from "~~/server/utils/chat/history";
import { moneyOf, type DraftFlow } from "~~/server/utils/chat/flows";
import { chatOnce, type OllamaCfg } from "~~/server/utils/chat/ollama";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** 与设计文档「图片窗口」一致的窗口参数：最近 3 条含图 user 轮、单次最多 6 张 */
export const CHAT_IMAGE_WINDOW: ImageWindowOpts = { imageTurnLimit: 3, imageTotalLimit: 6 };

/** 上下文带上的最近消息条数（设计文档：最近 20 条） */
export const CHAT_HISTORY_LIMIT = 20;

/** 本功能产生/清理的图片文件名前缀：清理时只碰 chat- 开头的文件 */
const CHAT_FILE_PREFIX = "chat-";

/** 注入 system prompt 的最近流水条数（摘要兜底，帮助模型参考记账口径） */
const RECENT_FLOW_COUNT = 5;

/** 空会话清扫保护窗：updateDate 落后该时长以上的空会话才清（见 listSessions 注释） */
export const SWEEP_EMPTY_AFTER_MS = 60_000;

// ==================== 小工具 ====================

/** images 目录 = <dataDir>/images（与 flow/invoice upload 的落点一致） */
const imagesDir = (dataDir: string): string => path.join(dataDir, "images");

/** 归属校验：不是该用户的会话一律按「会话不存在」处理 */
const ownSession = async (userId: number, sessionId: number) => {
  const s = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!s) {
    throw new Error("会话不存在");
  }
  return s;
};

/** 追加消息后统一刷新 updateDate——会话列表按它倒序 */
const touchSession = (sessionId: number) =>
  prisma.chatSession.update({ where: { id: sessionId }, data: { updateDate: new Date() } });

/** 上海时区的今天：YYYY-MM-DD（now 可注入，测试钉跨日边界） */
export const todayOf = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);

// ==================== 会话 ====================

export const listSessions = async (
  userId: number
): Promise<Array<{ id: number; title: string | null; updateDate: Date }>> => {
  // 空会话清扫（T13 懒创建的历史残留兜底）：懒创建后「正常」已不可能再出现
  // 非草稿的空会话——send 的第一件事就是写 user 行，所以这里清的全是升级前
  // 点过「新建」又没发言的存量行。60s 保护窗防跨标签页在途竞速：A 标签刚建
  // 完会话还没来得及落 user 行时，B 标签刷列表不至于把 A 的半途会话清掉。
  // 副作用是兜底行为：幂等（条件不命中即 0 行）、且只在本人的会话里清——
  // 没有任何内容可丢（无消息）。
  await prisma.chatSession.deleteMany({
    where: {
      userId,
      messages: { none: {} }, // 关系字段名是 messages（schema.prisma），不是表名
      updateDate: { lt: new Date(Date.now() - SWEEP_EMPTY_AFTER_MS) },
    },
  });
  return prisma.chatSession.findMany({
    where: { userId },
    orderBy: { updateDate: "desc" },
    select: { id: true, title: true, updateDate: true },
  });
};

export const createSession = async (userId: number): Promise<{ id: number }> => {
  const s = await prisma.chatSession.create({ data: { userId } }); // title 留 null（空标题起步）
  return { id: s.id };
};

/** 该用户全部流水的被引用小票名集合（会话清理的文件保护名单）；
 *  deleteSession 自扫，batchDelete 预扫一次复用（评审轮1#6） */
export const referencedInvoiceNames = async (userId: number): Promise<Set<string>> => {
  const flows = await prisma.flow.findMany({
    where: { userId, invoice: { not: null } },
    select: { invoice: true },
  });
  return new Set(flows.map((f) => f.invoice ?? "").flatMap((v) => v.split(",")));
};

export const deleteSession = async (
  userId: number,
  sessionId: number,
  dataDir: string,
  /** 预扫描的被引用小票名（batchDelete 复用一次扫描；不传则自扫） */
  referencedNames?: Set<string>
): Promise<void> => {
  const session = await ownSession(userId, sessionId);

  // 要清理的文件名得在删消息前取出来（消息没了就查不到了）
  const rows = await prisma.chatMessage.findMany({
    where: { sessionId: session.id, userId },
    select: { images: true },
  });
  const candidates = [
    ...new Set(rows.flatMap((r) => (r.images ?? "").split(",")).filter((n) => n.startsWith(CHAT_FILE_PREFIX))),
  ];

  await prisma.chatMessage.deleteMany({ where: { sessionId: session.id, userId } });
  await prisma.chatSession.deleteMany({ where: { id: session.id, userId } }); // FK RESTRICT：消息已先删

  // 只删未被该用户任一 Flow.invoice 引用的：invoice 按逗号拆开做精确匹配
  //（不能 contains——chat-1-1.png 是 chat-1-11.png 的子串）。
  // referencedNames（评审轮1#6）：batchDelete 预扫一次传入，循环里不再每
  // 会话重扫全量 Flow；单删路径不传，仍自扫（一次 findMany）。
  const referenced = referencedNames ?? (await referencedInvoiceNames(userId));

  // 删除（DB）已提交；文件清理是收尾活，失败绝不能让本该成功的删除反着报错
  //（ENOENT 直接忽略，其余记日志吞掉——残留文件的损失小于删除请求 500）
  for (const n of candidates) {
    if (referenced.has(n)) {
      continue;
    }
    try {
      await fs.unlink(path.join(imagesDir(dataDir), n));
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error(`[chat] 会话 ${sessionId} 的小票 ${n} 清理失败`, e);
      }
    }
  }
};

// ==================== 消息 ====================

/** getMessages 的行：字段按存储原样（images/flows 为逗号串与 JSON 串） */
export type ChatMessageRow = {
  id: number;
  role: string;
  content: string | null;
  images: string | null;
  flows: string | null;
  status: number | null;
  createDate: Date;
};

export const getMessages = (userId: number, sessionId: number): Promise<ChatMessageRow[]> =>
  prisma.chatMessage.findMany({
    where: { sessionId, userId },
    orderBy: { id: "asc" },
    select: { id: true, role: true, content: true, images: true, flows: true, status: true, createDate: true },
  });

/** 取单条消息（终审 M4）：findFirst 直取，不整表 load；跨会话/非本人 → null */
export const getMessage = async (
  userId: number,
  sessionId: number,
  messageId: number
): Promise<ChatMessageRow | null> =>
  (await prisma.chatMessage.findFirst({
    where: { id: messageId, sessionId, userId },
    select: { id: true, role: true, content: true, images: true, flows: true, status: true, createDate: true },
  })) ?? null;

/** 会话里最新一条消息的 id（终审 M4）：findFirst orderBy id desc，不整表 load */
export const lastMessageId = async (userId: number, sessionId: number): Promise<number> => {
  const row = await prisma.chatMessage.findFirst({
    where: { sessionId, userId },
    orderBy: { id: "desc" },
    select: { id: true },
  });
  return row?.id ?? 0;
};

export const appendUserMessage = async (
  userId: number,
  sessionId: number,
  content: string,
  images: string[] = []
): Promise<void> => {
  await ownSession(userId, sessionId);
  await prisma.chatMessage.create({
    data: { sessionId, userId, role: "user", content, images: images.join(",") },
  });
  await touchSession(sessionId);
};

export const appendAssistantMessage = async (
  userId: number,
  sessionId: number,
  content: string,
  flows: string | null,
  status: number
): Promise<void> => {
  await ownSession(userId, sessionId);
  await prisma.chatMessage.create({
    data: { sessionId, userId, role: "assistant", content, images: null, flows, status },
  });
  await touchSession(sessionId);
};

// ==================== 上下文组装 ====================

/**
 * 候选值查询：该 bookId 全域 distinct（与 getAttributions / flow/type/getAll 同法）。
 * 不带 userId 条件——共享账本（Book.shareKey）下还有其他成员录入的取值，
 * 候选值必须来自当前账本的全部实际取值；distinct 单列 + 非空过滤。
 */
const distinctFlowCol = async (bookId: string, col: "industryType" | "payType" | "attribution"): Promise<string[]> => {
  const rows: Array<Record<string, string | null>> = (await prisma.flow.findMany({
    distinct: [col],
    select: { [col]: true },
    orderBy: [{ [col]: "asc" }],
    where: { bookId },
  })) as Array<Record<string, string | null>>;
  return [
    ...new Set(rows.map((r) => String(r[col] ?? "").trim()).filter(Boolean)),
  ];
};

/** 最近几天流水摘要注入 system prompt（口径参考，也防模型把已记的流水再记一遍） */
const recentFlowSummary = (
  flows: Array<{ day: string; flowType: string | null; name: string | null; money: number | null }>
): string[] => {
  if (flows.length === 0) {
    return [];
  }
  const lines = flows.map((f) =>
    // 不编造方向：flowType 为空就写「未分类」，不替模型猜支出/收入
    [f.day, f.flowType || "未分类", f.name || "未命名流水", f.money !== null && f.money !== undefined ? `${f.money}元` : ""]
      .filter(Boolean)
      .join(" ")
  );
  return [`该账本最近 ${flows.length} 条流水（参考口径，不要重复记账）：`, ...lines];
};

export type ChatContext = {
  system: string;
  turns: ChatTurn[];
  /** 与 system 同源的类型候选集（normalizeFlows 直接用，不许再查第二遍） */
  cand: { industry: string[]; pay: string[]; attribution: string[] };
  /** 组装 system 时的「今天」（normalizeFlows 的 dayFallback 同源用） */
  today: string;
  /** 与 system 同源的账本候选（V1.2：卡片分账本；normalizeFlows/saveCard 同源） */
  books: Array<{ bookId: string; bookName: string }>;
};

export const getContext = async (
  userId: number,
  sessionId: number,
  bookId: string,
  /** retry 截轮：只把 id < beforeId 的消息算进 turns（失败轮自身被截出去） */
  opts?: { beforeId?: number }
): Promise<ChatContext> => {
  await ownSession(userId, sessionId);

  // 账本归属（评审轮1#2）：入参 bookId 必须在本人名下才可用——distinct 类型
  // 与最近流水此前只按 bookId 裸查，借 API 传他人 bookId 可把他人候选值与
  // 最近记录带进 system prompt（经模型回声即跨用户泄露）。共享账本在
  // inshare.ts 是「加入者 userId 的复制行」，findFirst 天然同覆盖。
  if (!(await prisma.book.findFirst({ where: { userId, bookId }, select: { id: true } }))) {
    throw new Error("账本不存在");
  }

  const [rows, industry, pay, attribution, recent, bookRows] = await Promise.all([
    prisma.chatMessage.findMany({
      where: {
        sessionId,
        userId,
        ...(Number.isInteger(opts?.beforeId) ? { id: { lt: opts!.beforeId! } } : {}),
      },
      orderBy: { id: "desc" },
      take: CHAT_HISTORY_LIMIT,
    }),
    distinctFlowCol(bookId, "industryType"),
    distinctFlowCol(bookId, "payType"),
    distinctFlowCol(bookId, "attribution"),
    prisma.flow.findMany({
      where: { bookId }, // 全账本口径（共享账本的其他成员录入的也在列）
      orderBy: [{ day: "desc" }, { id: "desc" }], // 「最近」按 day 读，回补旧流水不冒充最新
      take: RECENT_FLOW_COUNT,
    }),
    /* 账本候选（V1.2 反馈「自建共享不区分」）：按 userId 查全部——共享账本在
     * inshare.ts 是复制一条带加入者 userId 的行，这里天然一起出来。同一 bookId
     * 只可能因 inshare 复制而重名不重 id，按 bookId 去重。 */
    prisma.book.findMany({ where: { userId }, select: { bookId: true, bookName: true } }),
  ]);
  const books = [
    ...new Map(bookRows.map((b) => [b.bookId, { bookId: b.bookId, bookName: b.bookName }])).values(),
  ].sort((a, b) => a.bookId.localeCompare(b.bookId));

  const turns: ChatTurn[] = rows.reverse().map((r) => ({
    role: r.role,
    content: r.content ?? "",
    images: r.images ? r.images.split(",") : [],
    ...(r.flows !== null && r.flows !== undefined ? { flows: r.flows } : {}),
  }));

  // cand/today/system 同一次算出、同一个值往下传：normalizeFlows 直接消费，
  // 两头对账本的口径不再可能各取一份
  const cand = { industry, pay, attribution };
  const today = todayOf();

  // 图编号单一事实源：prompt 的 imageCount 就传编号表长（接线见 consistency.test.ts）
  const system = [
    buildSystemPrompt({
      ...cand,
      today,
      imageCount: buildImageNumbering(turns, CHAT_IMAGE_WINDOW).length,
      books,
      currentBookId: bookId,
    }),
    ...recentFlowSummary(recent),
  ].join("\n");

  return { system, turns, cand, today, books };
};

// ==================== 失败重试 ====================

export const updateFailedMessage = async (userId: number, messageId: number, content: string): Promise<void> => {
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, userId } });
  if (!msg) {
    throw new Error("消息不存在");
  }
  if (msg.status !== -1) {
    throw new Error("只有失败的消息可以重试");
  }
  await prisma.chatMessage.update({ where: { id: msg.id }, data: { content } });
};

/**
 * retry 生成成功后的收尾（终审 M5）：content + flows + status 单条带归属
 * updateMany 一次落齐，sendCore 不再直连 prisma。归属条件带 status=-1：
 * 行已被并发重试更新（status 已非 -1）时 count=0 → false，调用方记
 * warn 日志；谁先到谁生效。
 */
export const finalizeFailedRetry = async (
  userId: number,
  messageId: number,
  content: string,
  flows: string | null
): Promise<boolean> => {
  const upd = await prisma.chatMessage.updateMany({
    where: { id: messageId, userId, status: -1 },
    data: { content, flows, status: 0 }, // 新 flows 无 flowId → 未入账 → 0；纯文字回复落 null
  });
  return upd.count > 0;
};

// ==================== 卡片入账 ====================

const parseCards = (raw: string | null): Array<Record<string, unknown>> | null => {
  if (!raw) {
    return null;
  }
  try {
    const cards = JSON.parse(raw);
    return Array.isArray(cards) ? (cards as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
};

/** 编辑卡的写回白名单（AI 预填的 imageIdx 与请求里的杂键都不残留；bookId
 *  是 V1.2 的入账目标——缺省空串，回写时由入参 bookId 覆盖成真实落账本） */
const cardForJson = (c: DraftFlow): Record<string, unknown> => ({
  day: String(c.day ?? ""),
  flowType: String(c.flowType ?? ""),
  industryType: String(c.industryType ?? ""),
  payType: String(c.payType ?? ""),
  name: String(c.name ?? ""),
  description: String(c.description ?? ""),
  attribution: String(c.attribution ?? ""),
  invoices: Array.isArray(c.invoices) ? c.invoices.map(String) : [],
  bookId: String(c.bookId ?? ""),
  money: moneyOf(c.money),
});

export const saveCard = async (
  userId: number,
  messageId: number,
  index: number,
  card: DraftFlow,
  bookId: string
): Promise<{ flowId: number }> =>
  // 行锁 + 全部读/校验/回写都在同一事务里：flows 是「读快照-整体回写 JSON」，
  // 只在事务里才能挡住并发保存（双击、两卡并点）互相覆盖丢 flowId 或重复建卡。
  prisma.$transaction(async (tx) => {
    // 排他锁排队：并发的 save 卡在这等，等到的就是别人已提交的最新 flows
    await tx.$queryRaw`SELECT "id" FROM "ChatMessage" WHERE "id" = ${messageId} AND "userId" = ${userId} FOR UPDATE`;
    const msg = await tx.chatMessage.findFirst({ where: { id: messageId, userId } });
    if (!msg) {
      throw new Error("消息不存在");
    }
    const cards = parseCards(msg.flows);
    if (msg.role !== "assistant" || !cards) {
      throw new Error("该消息没有可入账的卡片");
    }
    if (!Number.isInteger(index) || index < 0 || index >= cards.length) {
      throw new Error("卡片不存在");
    }
    if (cardBooked(cards[index])) {
      throw new Error("该卡片已入账");
    }
    // 入账目标账本必须真实属于该用户（V1.2）：bookId 与 bookName 一样只认
    // 归属校验后的映射结果——防借 API 把卡记进别人的/不存在的账本
    const book = await tx.book.findFirst({ where: { userId, bookId } });
    if (!book) {
      throw new Error("入账账本不存在");
    }

    // 凭证池 = 本消息已存的全部卡的 invoices ∪ 该 assistant 消息的前置 user 行 images。
    // 这正是前端 ChatDraftCard 的 ctxInvoices 池（同消息各卡 invoices ∪ 来源 user 行
    // images），UI 正常路径不受影响；校验是端点契约面的加固——防「借 API 把别会话的
    // chat-* 文件挂名躲清理/造坏链」。
    const pool = new Set<string>();
    for (const c of cards) {
      for (const raw of (Array.isArray(c.invoices) ? c.invoices : []) as unknown[]) {
        const name = String(raw ?? "").trim();
        if (name) {
          pool.add(name);
        }
      }
    }
    const prior = await tx.chatMessage.findFirst({
      where: { sessionId: msg.sessionId, userId, role: "user", id: { lt: messageId } },
      orderBy: { id: "desc" },
    });
    for (const img of (prior?.images ?? "").split(",")) {
      const name = img.trim();
      if (name) {
        pool.add(name);
      }
    }

    // 待写的 card.invoices 逐个 trim（非数组视为 []，维持原降级），任何一项
    // trim 后不在池内或为空串 → 整个事务不落 Flow
    const invoices = Array.isArray(card.invoices) ? card.invoices.map((v) => String(v ?? "").trim()) : [];
    for (const name of invoices) {
      if (!name || !pool.has(name)) {
        throw new Error("小票凭证不在本消息的图集内，请刷新后重试");
      }
    }

    const flow = await tx.flow.create({
      data: {
        userId,
        bookId,
        day: String(card.day ?? ""),
        flowType: String(card.flowType ?? ""),
        industryType: String(card.industryType ?? ""),
        payType: String(card.payType ?? ""),
        money: moneyOf(card.money),
        name: String(card.name ?? ""),
        description: String(card.description ?? ""),
        attribution: String(card.attribution ?? ""),
        invoice: invoices.join(","), // 已校验、已 trim（请求里带的前后空白顺手洗掉）
      },
    });
    // 回写 bookId 用入参（已过归属校验的落账本），卡里 AI/前端带的原值覆盖掉
    cards[index] = { ...cardForJson(card), bookId, flowId: flow.id };

    // 状态派生：全部卡片都有 flowId → 1，否则 0（与 history 的折叠判定同口径）
    const allSaved = cards.every(cardBooked);
    await tx.chatMessage.update({
      where: { id: msg.id },
      data: { flows: JSON.stringify(cards), status: allSaved ? 1 : 0 },
    });
    return { flowId: flow.id };
  });

// ==================== 会话标题 ====================

/** 起名清洗：剥空白/引号/句读，截 12 字（buildTitlePrompt 承诺 ≤12 字） */
const sanitizeTitle = (raw: string): string =>
  [...raw.replace(/[\s"'`“”‘’「」『』。．.,，、:!！?？]/g, "")]
    .slice(0, 12)
    .join("");

export const ensureTitle = async (
  userId: number,
  sessionId: number,
  userText: string,
  replyText: string,
  cfg?: OllamaCfg
): Promise<string | null> => {
  const session = await prisma.chatSession.findFirst({ where: { id: sessionId, userId } });
  if (!session) {
    return null;
  }
  if (session.title !== null) {
    return null; // 已有标题（含失败回退写过的）——后续消息不再重命名（V1）
  }
  let title = "";
  try {
    if (cfg) {
      title = sanitizeTitle(await chatOnce(cfg, buildTitlePrompt(userText, replyText)));
    }
  } catch {
    // 起名失败静默回退，不打扰对话流
  }
  if (!title) {
    title = userText.slice(0, 20);
  }
  if (!title) {
    // 兜底链走完仍是空串（首条纯图消息 userText=""）：不落库空标题——title
    // 保持 null，后续轮次的 ensureTitle 还有机会再起名
    return null;
  }
  await prisma.chatSession.update({ where: { id: session.id }, data: { title } });
  return title;
};

// ==================== 图片文件 ====================

export type SaveImageFile = { ext: string; data: Buffer };

/** ext 白名单：最多 1 个前导点 + 1~5 位字母数字（防 ../ 之类的目录穿越写盘） */
const EXT_RE = /^\.?[a-zA-Z0-9]{1,5}$/;

/** 存小票图：文件名 chat-{sessionId}-{ts}-{rand}-{n}.{ext}（rand=随机 3 字节
 *  hex，评审轮1#4：同会话同毫秒的两批并发保存不再撞名静默互覆），返回落地
 *  的文件名列表（中途某张写盘失败 → 已落盘的本批文件回滚删掉再重抛，不留
 *  半写孤儿；终审 R1 M3） */
export const saveImages = async (
  userId: number,
  sessionId: number,
  files: SaveImageFile[],
  dataDir: string
): Promise<string[]> => {
  await ownSession(userId, sessionId);
  // 先全量校验再动盘：任何一项非法都整体不开写（返回的名单恒与入参等长）
  for (const f of files) {
    if (!f || !Buffer.isBuffer(f.data) || f.data.length === 0) {
      throw new Error("图片数据无效");
    }
    if (!EXT_RE.test(String(f.ext ?? ""))) {
      throw new Error("图片扩展名不合法");
    }
  }
  const dir = imagesDir(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const ts = Date.now();
  const rand = randomBytes(3).toString("hex"); // 批次随机段：同 ms 并发散名
  const names: string[] = [];
  try {
    for (let i = 0; i < files.length; i++) {
      let ext = String(files[i].ext ?? "").trim();
      if (ext && !ext.startsWith(".")) {
        ext = "." + ext;
      }
      const name = `chat-${sessionId}-${ts}-${rand}-${i + 1}${ext}`;
      await fs.writeFile(path.join(dir, name), files[i].data);
      names.push(name);
    }
  } catch (e) {
    // 半写回滚（best-effort）：单文件 unlink 失败 ENOENT 静默、其余 console.error
    // 后继续清剩下的；错误原始重抛——目录不残留只写了一半的批次
    for (const n of names) {
      try {
        await fs.unlink(path.join(dir, n));
      } catch (ue) {
        if ((ue as NodeJS.ErrnoException)?.code !== "ENOENT") {
          console.error(`[chat] 会话 ${sessionId} 的小票 ${n} 半写回滚失败`, ue);
        }
      }
    }
    throw e;
  }
  return names;
};

/** 读小票图为 base64（ollama images 字段要裸 base64；missing 文件让错误往上抛） */
export const loadImages = async (dataDir: string, names: string[]): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  await Promise.all(
    [...new Set(names.filter(Boolean))].map(async (n) => {
      const buf = await fs.readFile(path.join(imagesDir(dataDir), n));
      out.set(n, buf.toString("base64"));
    })
  );
  return out;
};
