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

  // 账本注入（V1.2 反馈：卡片分账本）——prompt 给名字列表，模型输出 bookName
  describe("账本注入", () => {
    const books = [
      { bookId: "book-cash", bookName: "现金" },
      { bookId: "book-yibao", bookName: "医保" },
    ];

    it("注入账本候选（只给名字）与当前账本，并给分账本拆卡指引", () => {
      const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 0, books, currentBookId: "book-cash" });
      expect(p).toContain("现金、医保");
      expect(p).toContain("当前账本");
      expect(p).toContain("bookName");
      expect(p).toContain("拆成多张卡");
      // 模型不需要（也不应该拿到）bookId —— 它只输出名字，归一负责映射
      expect(p).not.toContain("bookId");
    });

    it("示例卡片带 bookName 且默认当前账本名", () => {
      const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 0, books, currentBookId: "book-cash" });
      expect(p).toContain('"bookName":"现金"');
    });

    it("没有账本候选时降级：bookName 一律空串，示例不带 bookName 键", () => {
      const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 0, books: [], currentBookId: "book-cash" });
      expect(p).toContain("bookName 一律");
      expect(p).not.toContain('"bookName":');
    });
  });

  it("历史截图去重与指代回看规则入 prompt（V1.2 反馈）", () => {
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 0 });
    expect(p).toContain("去重规则");
    expect(p).toContain("已经记过的一条都不要再输出");
    expect(p).toContain("指代规则");
    expect(p).toContain("和之前一样");
    expect(p).toContain("所在单位");
  });

  it("输出纪律：不复述本指令；数组之外允许说明文字（Task 10 收紧 → V1.2 放开文字+卡片）", () => {
    const p = buildSystemPrompt({ ...cand, today: "2026-10-25", imageCount: 2 });
    // Task 8/9 观察：模型把指令复述进 content —— 指令层明说禁止
    expect(p).toContain("不要复述本指令");
    // V1.2 反馈：回复不强制只有卡片——文字叙述合法、纯文字也合法
    expect(p).toContain("没有可记账内容时可以只输出文字");
  });
});

describe("buildTitlePrompt", () => {
  it("要求 ≤12 字标题并带上用户原话与回复摘要", () => {
    const p = buildTitlePrompt("昨天午饭 35 元", "已解析出 1 条流水");
    expect(p).toContain("12");
    expect(p).toContain("昨天午饭 35 元");
    expect(p).toContain("已解析出 1 条流水");
  });

  it("输出纪律：只给标题本身，无解释/引号/前后缀，不复述用户原文——Task 10 加固", () => {
    // Task 6/9 观察：标题出 "Theuserwants" 之类指令回声垃圾 —— 指令层明说禁止
    const p = buildTitlePrompt("昨天午饭 35 元", "已解析出 1 条流水");
    expect(p).toContain("只输出标题本身");
    expect(p).toContain("不要任何解释、引号或「标题：」之类的前后缀");
    expect(p).toContain("不要复述用户输入原文");
  });
});
