import { describe, expect, it } from "vitest";
import { extractFlowArray, normalizeFlows } from "~~/server/utils/chat/flows";

const cand = {
  industry: ["餐饮", "零食"],
  pay: ["微信", "支付宝"],
  attribution: ["家里", "公司"],
};
const FALLBACK = "2026-10-25";

describe("extractFlowArray", () => {
  it("裸 JSON 数组直接取出", () => {
    expect(extractFlowArray('[{"name":"午饭","money":35}]')).toEqual([{ name: "午饭", money: 35 }]);
  });

  it("容忍 markdown 围栏与前后闲话", () => {
    expect(extractFlowArray('好的，解析如下：\n```json\n[{"name":"a"}]\n```\n祝好'))
      .toEqual([{ name: "a" }]);
  });

  it("闲话里解析失败的括号被跳过，取第一个能解析的数组", () => {
    expect(extractFlowArray('说明（[参考这条]）：\n[{"money":1}]')).toEqual([{ money: 1 }]);
  });

  it("字符串里的括号不干扰配对", () => {
    expect(extractFlowArray('[{"name":"a[备注]b"}]')).toEqual([{ name: "a[备注]b" }]);
  });

  it("没有数组 / 括号没闭合 → null（让调用方走失败落库）", () => {
    expect(extractFlowArray("今天没有要记的流水")).toBeNull();
    expect(extractFlowArray('[{"name":"没结尾"')).toBeNull();
  });

  it("空数组也是有效结果，不是失败", () => {
    expect(extractFlowArray("```json\n[]\n```")).toEqual([]);
  });
});

describe("normalizeFlows", () => {
  it("字段齐全的卡原样通过，imageIdx 映射成文件名，多余字段不透传", () => {
    const out = normalizeFlows(
      [{
        day: "2026-10-24",
        flowType: "支出",
        industryType: "零食",
        payType: "微信",
        money: 12.5,
        name: "薯片",
        description: "詹记买的",
        attribution: "家里",
        imageIdx: [1],
        bookId: 3, // AI 不会带，但也要保证被剥掉
      }],
      cand,
      FALLBACK,
      (i) => `图${i}号文件.png`
    );
    expect(out).toEqual([{
      day: "2026-10-24",
      flowType: "支出",
      industryType: "零食",
      payType: "微信",
      money: 12.5,
      name: "薯片",
      description: "詹记买的",
      attribution: "家里",
      invoices: ["图1号文件.png"],
    }]);
    expect(Object.keys(out[0]).sort()).toEqual([
      "attribution", "day", "description", "flowType", "industryType",
      "invoices", "money", "name", "payType",
    ]);
  });

  it("flowType 缺省/非法 → 支出；合法的「收入」保留", () => {
    const out = normalizeFlows(
      [{ name: "a" }, { name: "b", flowType: "伙食" }, { name: "c", flowType: "收入" }],
      cand,
      FALLBACK,
      () => null
    );
    expect(out.map((f) => f.flowType)).toEqual(["支出", "支出", "收入"]);
  });

  it("name 缺失 / 空白 → 未命名流水", () => {
    const out = normalizeFlows([{}, { name: "   " }], cand, FALLBACK, () => null);
    expect(out.map((f) => f.name)).toEqual(["未命名流水", "未命名流水"]);
  });

  it("day 不是 YYYY-MM-DD（含不可能的日期）→ 用 dayFallback", () => {
    const out = normalizeFlows(
      [{ name: "a", day: "昨天" }, { name: "b", day: "2026-02-30" }, { name: "c", day: FALLBACK }],
      cand,
      FALLBACK,
      () => null
    );
    expect(out.map((f) => f.day)).toEqual([FALLBACK, FALLBACK, FALLBACK]);
  });

  it("money 归一成数字：字符串可转、坏值归 0", () => {
    const out = normalizeFlows(
      [{ name: "a", money: "35" }, { name: "b", money: "abc" }, { name: "c" }],
      cand,
      FALLBACK,
      () => null
    );
    expect(out.map((f) => f.money)).toEqual([35, 0, 0]);
  });

  it("类型候选不匹配 / 缺失 → 置空串；前后空白的合法值可匹配", () => {
    const out = normalizeFlows(
      [{ name: "a", industryType: "编造出来的", payType: " 微信 ", attribution: "公司" }],
      cand,
      FALLBACK,
      () => null
    );
    expect(out[0].industryType).toBe("");
    expect(out[0].payType).toBe("微信");
    expect(out[0].attribution).toBe("公司");
  });

  it("imageIdx 逐张映射，映射不上的那张缺省（能映射到的保留）", () => {
    const out = normalizeFlows(
      [{ name: "a", imageIdx: [1, 2, 3] }],
      cand,
      FALLBACK,
      (i) => (i === 2 ? "b.png" : null)
    );
    expect(out[0].invoices).toEqual(["b.png"]);
  });

  it("imageIdx 给单个数字也能用，重复编号去重", () => {
    const out = normalizeFlows(
      [{ name: "a", imageIdx: 2 }, { name: "b", imageIdx: [2, 2] }],
      cand,
      FALLBACK,
      (i) => (i === 2 ? "b.png" : null)
    );
    expect(out[0].invoices).toEqual(["b.png"]);
    expect(out[1].invoices).toEqual(["b.png"]);
  });

  it("imageIdx 缺省 → invoices 是该消息全部图（对回调从 1 连续查到 null 为止）", () => {
    const out = normalizeFlows([{}], cand, FALLBACK, (i) => (i <= 3 ? `f${i}.png` : null));
    expect(out[0].invoices).toEqual(["f1.png", "f2.png", "f3.png"]);
  });

  it("imageIdx 引用了不存在的编号且整张卡无一张能映射 → invoices 空，不再兜底全部图", () => {
    const out = normalizeFlows([{ name: "a", imageIdx: [9] }], cand, FALLBACK, (i) => (i <= 3 ? `f${i}.png` : null));
    expect(out[0].invoices).toEqual([]);
  });

  it("非对象项跳过，不产出垃圾卡；坏 shape 之外的正常输出", () => {
    const out = normalizeFlows(
      [null, "foo", 42, { name: "午饭", money: 35 }],
      cand,
      FALLBACK,
      () => null
    );
    expect(out).toEqual([{
      day: FALLBACK,
      flowType: "支出",
      industryType: "",
      payType: "",
      money: 35,
      name: "午饭",
      description: "",
      attribution: "",
      invoices: [],
    }]);
  });
});