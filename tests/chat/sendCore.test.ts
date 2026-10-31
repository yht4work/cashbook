/**
 * sendCore 纯函数层契约（failRowOf）：失败/错误文案脱敏映射。
 * 评审轮3#2 钉死：chatSend / chatRetry / chatSave 的外层 catch 与端点壳
 * 的 catch 统一走这里——原始 fs/DB 错误串（含绝对路径）不进给端响应，
 * OllamaError 与中文业务错误原样透传，其余按动作给兜底文案。
 */
import { describe, expect, it } from "vitest";
import { failRowOf } from "~~/server/utils/chat/sendCore";
import { OllamaError } from "~~/server/utils/chat/ollama";

describe("failRowOf", () => {
  it("OllamaError：文案原样透传（含 ollama 前缀串）", () => {
    expect(failRowOf(new OllamaError("ollama 返回错误：model nope 不存在"))).toBe(
      "ollama 返回错误：model nope 不存在"
    );
  });

  it("中文业务错误原样透传", () => {
    expect(failRowOf(new Error("入账账本不存在"))).toBe("入账账本不存在");
    expect(failRowOf(new Error("小票图片格式不支持"))).toBe("小票图片格式不支持");
  });

  it("fs 分类 code 有各自短文案，原始 message（含绝对路径）不外露", () => {
    const e = (code: string, message: string) =>
      ({ code, message } as unknown as NodeJS.ErrnoException);
    expect(failRowOf(e("ENOENT", "ENOENT: no such file, open '/srv/…/chat-1-1.png'"))).toBe(
      "小票文件缺失，无法生成该消息"
    );
    expect(failRowOf(e("EACCES", "EACCES: permission denied, open '/srv/…/chat-1-1.png'"))).toBe(
      "小票文件无法读取，无法生成该消息"
    );
  });

  it("无分类的原始系统错误（如 ENOSPC）→ 兜底文案按动作替换（生成/发送/重试/入账）", () => {
    const raw = "ENOSPC: no space left on device, open '/srv/cashbook/data/images/chat-1-100-1.png'";
    const err = { code: "ENOSPC", message: raw } as unknown as NodeJS.ErrnoException;
    expect(failRowOf(err)).toBe("生成失败，请稍后重试");
    expect(failRowOf(err, "发送失败，请稍后重试")).toBe("发送失败，请稍后重试");
    expect(failRowOf(err, "重试失败，请稍后重试")).toBe("重试失败，请稍后重试");
    expect(failRowOf(err, "入账失败，请稍后重试")).toBe("入账失败，请稍后重试");
  });

  it("无 message 的普通对象/空值 → 兜底，不抛", () => {
    expect(failRowOf({} as unknown)).toBe("生成失败，请稍后重试");
    expect(failRowOf(undefined)).toBe("生成失败，请稍后重试");
  });
});