import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildTitlePrompt } from "../../server/utils/chat/prompt";

const cand = {
  industry: ["餐饮", "零食"],
  pay: ["微信", "支付宝"],
  attribution: ["家里", "公司"],
};

describe("buildSystemPrompt", () => {
  it("包含拆分规则：一条流水=一个单项，总额对不上按单项、总价进 description", () => {
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 2 });
    expect(p).toContain("一条流水对应一个单项");
    expect(p).toContain("description");
  });

  it("注入三个类型候选列表，并禁止编造候选之外的类型名", () => {
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 2 });
    expect(p).toContain("餐饮");
    expect(p).toContain("零食");
    expect(p).toContain("微信");
    expect(p).toContain("支付宝");
    expect(p).toContain("家里");
    expect(p).toContain("公司");
    expect(p).toContain("禁止");
  });

  it("注入 today、imageIdx 编号规则与图片总数；缺省挂图口径与 flows 一致", () => {
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 3 });
    expect(p).toContain("2026-10-25");
    expect(p).toContain("imageIdx");
    expect(p).toContain("3 张");
    expect(p).toContain("图1");
    expect(p).toContain("默认挂本次消息的图");
  });

  it("示例卡片按分支派生：day 用 today；0 图时示例不带 imageIdx 键", () => {
    const withImgs = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 3 });
    expect(withImgs).toContain('"day":"2026-10-25"');
    expect(withImgs).toContain('"imageIdx":[1]');

    const noImgs = buildSystemPrompt({ ...cand, today: "2099-01-01", imageCount: 0 });
    expect(noImgs).toContain('"day":"2099-01-01"');
    expect(noImgs).not.toContain('"imageIdx"');
  });

  it("候选为空时给出占位而不是空缺", () => {
    const p = buildSystemPrompt({ industry: [], pay: [], attribution: [], today: "2026-10-25", imageCount: 0 });
    expect(p).toContain("暂无");
  });
});

describe("buildTitlePrompt", () => {
  it("要求 ≤12 字标题并带上用户原话与回复摘要", () => {
    const p = buildTitlePrompt("昨天午饭 35 元", "已解析出 1 条流水");
    expect(p).toContain("12");
    expect(p).toContain("昨天午饭 35 元");
    expect(p).toContain("已解析出 1 条流水");
  });
});