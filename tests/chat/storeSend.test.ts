/**
 * chatStore.send 前端契约测试（node 级 store 测试，无 DOM/无真实 nuxt；
 * #imports 用最小桩，doApi/Alert 用 mock——只钉 store 自身行为）。
 *
 * 钉死的契约：
 * - send 的返回值语义 =「预检通过、请求已发出」：本地行挂上、流开走后立刻
 *   resolve true——不等整轮 SSE 读完（输入区据此清空，流式收尾在后台推进）。
 *   这是 V1.2 反馈的修复点：此前要等 done/fail 才回 true，移动端视觉生成
 *   期间待发图一直挂着、移除钮被 streaming 锁死。
 * - 预检不过（无账本/空消息）依旧 false：不发请求、不建会话（懒创建不前置）。
 * - fail 帧照样收尾：仍先回 true，流结束后 streaming 复位（锁语义不变）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useChatStore } from "~/utils/chatStore";
import { doApi } from "~/utils/api";
import { Alert } from "~/utils/alert";

// doApi/Alert 的 mock（vi.hoisted 先于 vi.mock 工厂求值，测试内可断言调用）
const h = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  alertError: vi.fn(),
}));
vi.mock("~/utils/api", () => ({
  doApi: {
    get: h.apiGet,
    post: h.apiPost,
    postform: vi.fn(),
    download: vi.fn(async () => null),
  },
}));
vi.mock("~/utils/alert", () => ({
  Alert: { error: h.alertError, warning: vi.fn() },
}));

const enc = new TextEncoder();
/** 一条合法 SSE 帧 */
const frame = (o: object): Uint8Array => enc.encode("data: " + JSON.stringify(o) + "\n\n");
/** 服务端行（loadMessages 的回包，sessionId 由 store 传入后归一） */
const serverRows = [
  { id: 3, role: "assistant", content: "好", images: null, flows: null, status: 0, createDate: "2026-10-29T00:00:00Z" },
];

/** 受控 SSE：start 里先执行 seed，控制器留在 ctrl 里供测试续推/关流 */
const sseResponse = (seed: (c: ReadableStreamDefaultController<Uint8Array>) => void): Response => {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | undefined;
  const res = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
        seed(c);
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
  (res as Response & { ctrl?: ReadableStreamDefaultController<Uint8Array> }).ctrl = () => ctrl;
  return res;
};
type SseResponse = Response & { ctrl: () => ReadableStreamDefaultController<Uint8Array> | undefined };

beforeEach(() => {
  setActivePinia(createPinia());
  h.apiPost.mockResolvedValue({ id: 11 }); // createSession 的建档回包
  h.apiGet.mockImplementation(async (path: string) =>
    String(path).includes("sessions") ? [] : serverRows
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("chatStore.send 请求已发出即返回", () => {
  it("send 在请求发出（本地行挂上）后即 resolve true，不等整轮 SSE 读完", async () => {
    const res = sseResponse((c) => c.enqueue(frame({ t: "delta", d: "好" }))); // 停在流中央，done 永不先到
    const fetchSpy = vi.fn(async () => res);
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubGlobal("localStorage", { getItem: () => "1" });

    const store = useChatStore();
    const p = store.send("午饭 35");

    // 契约：请求一发出就该回 true；旧行为（等 done 才回）会在 race 里超时失败
    let tid: ReturnType<typeof setTimeout> | undefined;
    try {
      const accepted = await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          tid = setTimeout(
            () => rej(new Error("send 在请求发出后没有立即返回（仍在等整轮 SSE 读完才 resolve）")),
            250
          );
        }),
      ]);
      expect(accepted).toBe(true);
    } finally {
      clearTimeout(tid);
    }

    // 请求已发出：fetch 恰好 1 次；本地已挂 user pending 行 + 流式 assistant 行；
    // streaming 仍 true（生成并没有结束）
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(store.streaming).toBe(true);
    expect(store.currentMessages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(store.currentMessages[0]?.pending).toBe(true);

    // 放行 done 帧 + 关流 → 后台收尾：streaming 复位、消息区被服务端行接管
    res.ctrl()!.enqueue(frame({ t: "done", messageId: 9 }));
    res.ctrl()!.close();
    await vi.waitFor(() => expect(store.streaming).toBe(false));
    expect(h.apiGet).toHaveBeenCalledWith("api/entry/chat/messages", { sessionId: 11 });
    expect(store.currentMessages.map((m) => m.id)).toEqual([3]);
  });

  it("预检不过（无账本/空消息）依旧 false：不发请求、不建会话", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = useChatStore();

    vi.stubGlobal("localStorage", { getItem: () => "" });
    expect(await store.send("午饭 35")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.apiPost).not.toHaveBeenCalled(); // 不前置建档
    expect(h.alertError).toHaveBeenCalledWith("请先选择账本");

    vi.stubGlobal("localStorage", { getItem: () => "1" });
    expect(await store.send("   ")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.alertError).toHaveBeenCalledWith("消息不能为空");
  });

  it("fail 帧照样收尾：流读着也先回 true，结束后 streaming 复位", async () => {
    const res = sseResponse((c) => c.enqueue(frame({ t: "fail", m: "生成失败（测试）" }))); // 不关流，测试放行
    vi.stubGlobal("fetch", vi.fn(async () => res));
    vi.stubGlobal("localStorage", { getItem: () => "1" });

    const store = useChatStore();
    await expect(store.send("x")).resolves.toBe(true); // 先回 true，不等 fail 帧
    expect(store.streaming).toBe(true); // 流还开着，仍在消费
    res.ctrl()!.close();
    await vi.waitFor(() => expect(store.streaming).toBe(false));
    expect(h.apiGet).toHaveBeenCalledWith("api/entry/chat/messages", { sessionId: 11 });
  });
});