/**
 * chat 前端 store：会话/消息/流式生成的客户端状态机。
 *
 * 服务端契约（server/utils/chat/sendCore.ts 与三个端点）：
 * - REST 均为 `{c, m, d}` 包装（c=200 成功），鉴权走裸 Authorization 头
 *   （app/utils/api.ts 的惯例：useCookie("Authorization").value 搬进头）。
 * - send/retry 响应是 SSE 文本流：`data: {单行JSON}\n\n` 帧，t =
 *   delta{d 增量文本} | flows{flows: DraftFlow[]} | done{messageId} |
 *   fail{m} —— 服务端剥了 think、done 在 flows 之后（先落库再发 done），
 *   UI 保持「生成中」直到 done/fail，不把 flows 帧当结束信号。
 * - save 是普通 JSON 端点（multipart，非 SSE），d = {flowId}。
 *
 * 接线注意（给后续任务）：
 * - 页面/组件一律显式 `import { useChatStore } from "~/utils/chatStore"`；
 * - 流式中的行 = currentMessages 里 streaming=true 的 assistant 行，
 *   delta 增量拼在该行 content 上（渲染打字光标用）；
 * - 卡片渲染用行上 flowCards（DraftFlow[]），card.flowId>0（cardBooked）
 *   表已入账；saveCard(messageId, index, card) 直接吃编辑后的 DraftFlow；
 * - send(text, files) 的 files 为 File[]（input FileList 借 Array.from）。
 */
import { defineStore } from "pinia";
import { useCookie } from "#imports";
import { doApi } from "./api";
import { Alert } from "./alert";

/** 会话列表行（GET /chat/sessions，updateDate 倒序） */
export interface ChatSessionItem {
  id: number;
  title: string | null; // 未起名时为 null（UI 兜底「未命名会话」）
  updateDate: string | Date;
}

/** 流水草稿卡片（AI 产出 → 可编辑 → 入账回写 flowId；与 server/utils/chat/flows.ts 同构） */
export interface DraftFlow {
  day: string;
  flowType: string;
  industryType: string;
  payType: string;
  money: number;
  name: string;
  description: string;
  attribution: string;
  invoices: string[]; // 卡片挂的小票文件名（用户在卡片上增删的最终结果）
  flowId?: number; // 入账成功后回写的 Flow.id；>0 即已入账
}

/** 消息行：服务端行字段 + 本地渲染扩展（imageList/flowCards/streaming/pending） */
export interface ChatMessageItem {
  id: number; // 服务端行 id；本地临时行（未固化）为 0
  sessionId: number;
  role: "user" | "assistant";
  content: string | null;
  images: string | null; // 逗号分隔的文件名（服务端原样）
  imageList: string[]; // images 拆开后的数组（渲染缩略图用）
  flows: string | null; // 卡片 JSON 串（服务端原样）
  flowCards: DraftFlow[] | null; // flows 解析后的卡片（渲染/编辑用）
  status: number | null; // assistant：0 正常 / 1 已全部入账 / -1 失败（content 为错误文案）
  createDate: string | Date;
  streaming?: boolean; // 当前正在流式生成的本地行
  pending?: boolean; // 本地临时行（done 后由 loadMessages 的服务端行替换）
  pendingImages?: string[]; // 刚本地选中的文件的 blob URL（尚未有服务端文件名）
}

/** SSE 帧四型（与 sendCore.ts 的 push 一一对应） */
export type ChatSseFrame =
  | { t: "delta"; d: string }
  | { t: "flows"; flows: DraftFlow[] }
  | { t: "done"; messageId: number }
  | { t: "fail"; m: string };

interface ChatState {
  sessions: ChatSessionItem[];
  currentId: number | null;
  messages: ChatMessageItem[];
  streaming: boolean;
}

/** 卡片已入账判定（与 server/utils/chat/history.ts 的 cardBooked 同口径） */
export const cardBooked = (c: DraftFlow): boolean =>
  typeof c.flowId === "number" && c.flowId > 0;

/** 小票图片直显地址（GET /api/entry/flow/invoice/show，浏览器直接显示） */
export const chatImageSrc = (name: string): string =>
  "/api/entry/flow/invoice/show?invoice=" + encodeURIComponent(name);

/** auth 头：与 doApi.getHeaders 同款（cookie → 裸 Authorization 头） */
const authHeader = (): Record<string, string> => ({
  Authorization: useCookie("Authorization").value || "",
});

/** `Result` 校验 + 文案兜底（供不走 doApi 的 fetch 封装统一解析） */
const unwrapResult = async (res: Response): Promise<{ c: number; m: string; d: any } | null> => {
  const data = (await res.json().catch(() => null)) as
    | { c?: number; m?: string; d?: any }
    | null;
  if (!data) {
    if (!res.ok) {
      Alert.error(`请求失败（${res.status}）`);
    }
    return null;
  }
  return { c: Number(data.c ?? 0), m: data.m || "", d: data.d };
};

/** DELETE 请求：doApi 没有 delete 封装，这里按其同款约定补一个（query 长在 URL 上） */
const removeApi = async (path: string, query: Record<string, string | number | undefined>): Promise<void> => {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const res = await fetch(`${path}${qs ? "?" + qs : ""}`, {
    method: "DELETE",
    headers: authHeader(),
    credentials: "include",
  });
  const data = await unwrapResult(res);
  if (!data || data.c !== 200) {
    const m = data?.m || `请求失败（${res.status}）`;
    Alert.error(m);
    throw new Error(m);
  }
};

/** 解析一行 `data: ...` 为帧；残包/脏行按契约丢弃 */
const readFrameLine = (line: string): ChatSseFrame | null => {
  if (!line.startsWith("data:")) {
    return null;
  }
  const payload = line.slice(5).trim();
  if (!payload) {
    return null;
  }
  try {
    return JSON.parse(payload) as ChatSseFrame;
  } catch {
    return null;
  }
};

/**
 * 消费一条 SSE 流（fetch ReadableStream）：按整行切帧解析 —— 行缓冲的
 * 流可能把一帧劈成两片，不完整的行留在 buffer 里等下一片续上，流结束后
 * 再冲一次尾巴；每个完整帧回 onFrame。
 */
const consumeSse = async (res: Response, onFrame: (f: ChatSseFrame) => void): Promise<void> => {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("当前环境不支持流式读取");
  }
  try {
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        const frame = readFrameLine(line);
        if (frame) {
          onFrame(frame);
        }
        nl = buffer.indexOf("\n");
      }
    }
    // 没有结尾换行的最后一帧（服务端不收尾行即断流的兜底）
    const tail = (buffer + decoder.decode()).trim();
    if (tail) {
      const frame = readFrameLine(tail);
      if (frame) {
        onFrame(frame);
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // 流已结束/已断开，忽略
    }
  }
};

/** 一轮生成共享的帧写入：delta 拼行、flows 挂行、done/fail 收尾 */
const applyFrame = (
  row: ChatMessageItem,
  frame: ChatSseFrame,
  ctx: { flowCards: DraftFlow[] | null }
): "done" | "fail" | null => {
  switch (frame.t) {
    case "delta":
      row.content = (row.content ?? "") + frame.d;
      return null;
    case "flows":
      ctx.flowCards = Array.isArray(frame.flows) ? frame.flows : null;
      row.flowCards = ctx.flowCards;
      return null;
    case "done":
      row.id = Number(frame.messageId) || 0;
      row.flows = ctx.flowCards ? JSON.stringify(ctx.flowCards) : row.flows;
      row.status = 0;
      return "done";
    case "fail":
      row.status = -1;
      row.content = frame.m || "生成失败";
      row.flows = null;
      row.flowCards = null;
      return "fail";
    default:
      return null;
  }
};

/** bookId 直接读 localStorage（项目惯例：当前账本不进 pinia） */
const bookIdOf = (): string =>
  typeof localStorage === "undefined" ? "" : localStorage.getItem("bookId") || "";

/** 服务端消息行 → 本地渲染行（flows JSON 串同步拆成 flowCards） */
const normalizeRow = (
  row: {
    id: number;
    role: string;
    content?: string | null;
    images?: string | null;
    flows?: string | null;
    status?: number | null;
    createDate?: string | Date;
  },
  sessionId: number
): ChatMessageItem => {
  let parsedCards: unknown = null;
  try {
    parsedCards = row.flows ? JSON.parse(row.flows) : null;
  } catch {
    parsedCards = null;
  }
  return {
    id: Number(row.id) || 0,
    sessionId,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content ?? null,
    images: row.images ?? null,
    imageList: (row.images ?? "").split(",").filter(Boolean),
    flows: row.flows ?? null,
    flowCards: Array.isArray(parsedCards) ? (parsedCards as DraftFlow[]) : null,
    status: row.status === null || row.status === undefined ? null : Number(row.status),
    createDate: row.createDate ?? "",
    pending: false,
  };
};

export const useChatStore = defineStore("chat", {
  state: (): ChatState => ({
    sessions: [],
    currentId: null,
    messages: [],
    streaming: false,
  }),

  getters: {
    /** 当前会话的消息（currentId 过滤，含本地流式与 pending 行） */
    currentMessages(state): ChatMessageItem[] {
      return state.messages.filter((m) => m.sessionId === state.currentId);
    },
    /** 当前会话对象；未选中为 null */
    currentSession(state): ChatSessionItem | null {
      return state.sessions.find((s) => s.id === state.currentId) ?? null;
    },
  },

  actions: {
    /** 会话列表（updateDate 倒序）；失败已由 toast 提示，store 不重复弹 */
    async loadSessions(): Promise<void> {
      try {
        const list = await doApi.get<
          Array<{ id: number; title: string | null; updateDate: string }>
        >("api/entry/chat/sessions");
        this.sessions = (list || []).map((s) => ({
          id: Number(s.id) || 0,
          title: s.title ?? null,
          updateDate: s.updateDate,
        }));
      } catch {
        // toast 已提示；保留现有列表
      }
    },

    /** 新建会话并选中新会话（清空消息区，等第一条消息） */
    async createSession(): Promise<number | null> {
      const d = await doApi.post<{ id: number }>("api/entry/chat/sessions");
      const id = Number(d?.id) || 0;
      if (!id) {
        throw new Error("创建会话失败");
      }
      // 本地先挂（标题等首条回复的服务端 ensureTitle 到来后再刷新）
      this.sessions.unshift({ id, title: null, updateDate: new Date().toISOString() });
      this.currentId = id;
      this.messages = [];
      return id;
    },

    /**
     * 删除会话；删的是当前会话则清 currentId/messages，剩余列表已按
     * updateDate 倒序、转选第一个并加载其消息。
     */
    async deleteSession(id: number): Promise<void> {
      await removeApi("/api/entry/chat/sessions", { id: Number(id) || 0 });
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.currentId === id) {
        const next = this.sessions[0] ?? null;
        if (next) {
          await this.loadMessages(next.id);
        } else {
          this.currentId = null;
          this.messages = [];
        }
      }
    },

    /** 会话消息（行 id 升序）；同时把它置为当前会话（点击选中 → loadMessages） */
    async loadMessages(sessionId: number): Promise<void> {
      const sid = Number(sessionId) || 0;
      if (!sid) {
        return;
      }
      this.currentId = sid;
      try {
        const rows = await doApi.get<
          Array<{
            id: number;
            role: string;
            content?: string | null;
            images?: string | null;
            flows?: string | null;
            status?: number | null;
            createDate?: string | Date;
          }>
        >("api/entry/chat/messages", { sessionId: sid });
        if (this.currentId !== sid) {
          return; // 中途切走了，过期回包丢弃
        }
        this.messages = (rows || []).map((r) => normalizeRow(r, sid));
      } catch {
        if (this.currentId !== sid) {
          return;
        }
        this.messages = []; // toast 已提示，消息区回空
      }
    },

    /**
     * 发消息（multipart POST + fetch ReadableStream 解析 data: 帧）。
     * 本地先挂 user 行与流式 assistant 行：delta 增量拼进流式行、flows
     * 帧挂上卡片、done 固化该行（真实 messageId/id）并回读服务端事实；
     * fail 落一条 status=-1 行。全程 streaming 状态锁输入。
     */
    async send(text: string, files?: File[] | null): Promise<void> {
      if (this.streaming) {
        return; // 锁输入：并发发送会造成 done 帧的 id 竞态（V1 已知限制）
      }
      const sessionId = Number(this.currentId) || 0;
      if (!sessionId) {
        Alert.error("请先新建会话");
        return;
      }
      const bookId = bookIdOf();
      if (!bookId) {
        Alert.error("请先选择账本");
        return;
      }
      const textStr = String(text ?? "").trim();
      const imgs = (Array.isArray(files) ? files : []).filter(
        (f): f is File => f instanceof File && !!String(f.name || "").trim()
      );
      if (!textStr && imgs.length === 0) {
        Alert.error("消息不能为空");
        return;
      }

      const fd = new FormData();
      fd.append("sessionId", String(sessionId));
      fd.append("text", textStr);
      fd.append("bookId", bookId);
      for (const f of imgs) {
        fd.append("images", f, f.name);
      }

      // 本地即刻回显：user 行（pending，blob 图）+ 流式 assistant 行
      this.messages.push(
        {
          id: 0,
          sessionId,
          role: "user",
          content: textStr,
          images: null,
          imageList: [],
          flows: null,
          flowCards: null,
          status: null,
          createDate: new Date().toISOString(),
          pending: true, // blob 图暂存 pendingImages（见下）
          pendingImages: imgs.map((f) => URL.createObjectURL(f)),
        },
        {
          id: 0,
          sessionId,
          role: "assistant",
          content: "",
          images: null,
          imageList: [],
          flows: null,
          flowCards: null,
          status: null,
          createDate: new Date().toISOString(),
          streaming: true,
        }
      );
      // push 后从数组取回 reactive 代理：后续按代理逐帧修改才能触发视图更新
      const streamRow = this.messages[this.messages.length - 1];
      this.streaming = true;
      const ctx = { flowCards: null as DraftFlow[] | null };
      let finished = false;

      try {
        const res = await fetch("/api/entry/chat/send", {
          method: "POST",
          headers: authHeader(),
          body: fd,
          credentials: "include",
        });
        // 校验类失败（请先选择账本/会话不存在/文件名异常等）是普通 JSON 而非 SSE
        if (!String(res.headers.get("content-type") || "").includes("text/event-stream")) {
          const data = await unwrapResult(res);
          Alert.error(data?.m || `发送失败（${res.status}）`);
        } else {
          await consumeSse(res, (frame) => {
            if (finished) {
              return; // done/fail 之后的帧丢弃
            }
            const end = applyFrame(streamRow, frame, ctx);
            if (end) {
              finished = true;
            }
          });
        }
      } catch (e) {
        console.warn("[chat] 本次发送的生成流中断", e);
      } finally {
        this.streaming = false;
        streamRow.streaming = false;
        if (streamRow.status === null) {
          // 未走到 done/fail（JSON 校验错误/网络中断/流被断开）——本地按
          // 失败行处理，随后 loadMessages 以服务端事实替换
          streamRow.status = -1;
          if (!streamRow.content) {
            streamRow.content = "生成失败";
          }
        }
        if (this.currentId === sessionId) {
          await this.loadMessages(sessionId);
        }
        await this.loadSessions();
      }
    },

    /**
     * 重试失败的 assistant 消息（同 send 的帧处理，但把本地失败消息行
     * 原地清空复用为流式行——服务端也只回写该行自身，不重复 user 行）。
     */
    async retry(messageId: number): Promise<void> {
      if (this.streaming) {
        return;
      }
      const sessionId = Number(this.currentId) || 0;
      if (!sessionId) {
        Alert.error("请先新建会话");
        return;
      }
      const target = this.currentMessages.find(
        (m) => m.id === Number(messageId) && m.role === "assistant"
      );
      if (!target || target.status !== -1) {
        Alert.error("只有失败的消息可以重试");
        return;
      }
      const bookId = bookIdOf();
      if (!bookId) {
        Alert.error("请先选择账本");
        return;
      }
      const fd = new FormData();
      fd.append("messageId", String(target.id));
      fd.append("sessionId", String(sessionId));
      fd.append("bookId", bookId);

      const streamRow = target; // 替换本地失败行：原地清空后开始流式
      streamRow.content = "";
      streamRow.flowCards = null;
      streamRow.flows = null;
      streamRow.status = null;
      streamRow.streaming = true;
      this.streaming = true;
      const ctx = { flowCards: null as DraftFlow[] | null };
      let finished = false;

      try {
        const res = await fetch("/api/entry/chat/retry", {
          method: "POST",
          headers: authHeader(),
          body: fd,
          credentials: "include",
        });
        if (!String(res.headers.get("content-type") || "").includes("text/event-stream")) {
          const data = await unwrapResult(res);
          Alert.error(data?.m || `重试失败（${res.status}）`);
        } else {
          await consumeSse(res, (frame) => {
            if (finished) {
              return;
            }
            const end = applyFrame(streamRow, frame, ctx);
            if (end) {
              finished = true;
            }
          });
        }
      } catch (e) {
        console.warn("[chat] 本次重试的生成流中断", e);
      } finally {
        this.streaming = false;
        streamRow.streaming = false;
        if (streamRow.status === null) {
          streamRow.status = -1;
          if (!streamRow.content) {
            streamRow.content = "生成失败";
          }
        }
        if (this.currentId === sessionId) {
          await this.loadMessages(sessionId);
        }
        await this.loadSessions();
      }
    },

    /**
     * 卡片入账：POST /chat/save（multipart；服务端契约是 FormData，
     * 读的是 readFormData）→ 成功把回传 flowId 写回该卡，并按「全部卡
     * 已入账 → 1，否则 0」派生消息 status（与服务端 saveCard 同口径）。
     * 返回 flowId（失败已弹 toast 并抛出，返回值为 null 不会发生——doApi 抛）。
     */
    async saveCard(messageId: number, index: number, card: DraftFlow): Promise<number | null> {
      const mid = Number(messageId) || 0;
      const idx = Number(index);
      if (!mid || !Number.isInteger(idx) || idx < 0) {
        Alert.error("卡片数据无效");
        throw new Error("卡片数据无效");
      }
      const bookId = bookIdOf();
      if (!bookId) {
        Alert.error("请先选择账本");
        throw new Error("请先选择账本");
      }
      const fd = new FormData();
      fd.append("messageId", String(mid));
      fd.append("index", String(idx));
      fd.append("card", JSON.stringify(card));
      fd.append("bookId", bookId);
      const d = await doApi.postform<{ flowId: number }>("api/entry/chat/save", fd);
      const flowId = Number(d?.flowId) || 0;

      // 本地同步：flowId 写回 + status 派生（服务端行已同值落库）
      const msg = this.messages.find((m) => m.id === mid);
      if (msg && msg.flowCards && msg.flowCards[idx]) {
        msg.flowCards[idx] = { ...msg.flowCards[idx], flowId };
        msg.flows = JSON.stringify(msg.flowCards);
        msg.status = msg.flowCards.every(cardBooked) ? 1 : 0;
      }
      return flowId || null;
    },
  },
});