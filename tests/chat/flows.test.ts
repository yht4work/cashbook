import { describe, expect, it } from "vitest";
import { extractFlowArray, normalizeFlows, type ImageLookup } from "~~/server/utils/chat/flows";

const cand = {
  industry: ["餐饮", "零食"],
  pay: ["微信", "支付宝"],
  attribution: ["家里", "公司"],
};
const FALLBACK = "2026-10-25";

/** 测试接线：byIndex 给编号→文件名映射；current=「本次消息的图」（default） */
const imgOf = (byIndex: (i: number) => string | null, current: string[] = []): ImageLookup => ({
  default: () => current,
  byIndex,
});

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
      imgOf((i) => `图${i}号文件.png`)
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

  it("flowType 缺省/非法 → 支出；合法「收入」保留（前后空白 trim 后可匹配）", () => {
    const out = normalizeFlows(
      [{ name: "a" }, { name: "b", flowType: "伙食" }, { name: "c", flowType: "收入" }, { name: "d", flowType: " 收入 " }],
      cand,
      FALLBACK,
      imgOf(() => null)
    );
    expect(out.map((f) => f.flowType)).toEqual(["支出", "支出", "收入", "收入"]);
  });

  it("name 缺失 / 空白 → 未命名流水", () => {
    const out = normalizeFlows([{}, { name: "   " }], cand, FALLBACK, imgOf(() => null));
    expect(out.map((f) => f.name)).toEqual(["未命名流水", "未命名流水"]);
  });

  it("day 不是 YYYY-MM-DD（含不可能的日期）→ 用 dayFallback", () => {
    const out = normalizeFlows(
      [{ name: "a", day: "昨天" }, { name: "b", day: "2026-02-30" }, { name: "c", day: FALLBACK }],
      cand,
      FALLBACK,
      imgOf(() => null)
    );
    expect(out.map((f) => f.day)).toEqual([FALLBACK, FALLBACK, FALLBACK]);
  });

  it("money 归一成数字：字符串可转、坏值与负数归 0", () => {
    const out = normalizeFlows(
      [{ name: "a", money: "35" }, { name: "b", money: "abc" }, { name: "c" }, { name: "d", money: -3 }],
      cand,
      FALLBACK,
      imgOf(() => null)
    );
    expect(out.map((f) => f.money)).toEqual([35, 0, 0, 0]);
  });

  it("类型候选不匹配 / 缺失 → 置空串；前后空白的合法值可匹配", () => {
    const out = normalizeFlows(
      [{ name: "a", industryType: "编造出来的", payType: " 微信 ", attribution: "公司" }],
      cand,
      FALLBACK,
      imgOf(() => null)
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
      imgOf((i) => (i === 2 ? "b.png" : null))
    );
    expect(out[0].invoices).toEqual(["b.png"]);
  });

  it("imageIdx 给单个数字也能用，重复编号去重", () => {
    const out = normalizeFlows(
      [{ name: "a", imageIdx: 2 }, { name: "b", imageIdx: [2, 2] }],
      cand,
      FALLBACK,
      imgOf((i) => (i === 2 ? "b.png" : null))
    );
    expect(out[0].invoices).toEqual(["b.png"]);
    expect(out[1].invoices).toEqual(["b.png"]);
  });

  it("imageIdx 缺省 → invoices=本次消息的图（default 注入，不再探查别的轮的图）", () => {
    const out = normalizeFlows([{}], cand, FALLBACK, imgOf(() => null, ["f1.png", "f2.png"]));
    expect(out[0].invoices).toEqual(["f1.png", "f2.png"]);
  });

  it("imageIdx 缺省且本次消息无图 → invoices 空", () => {
    const out = normalizeFlows([{}], cand, FALLBACK, imgOf(() => null));
    expect(out[0].invoices).toEqual([]);
  });

  it("imageIdx 引用了不存在的编号且整卡无一张能映射 → invoices 空，不回落 default", () => {
    const out = normalizeFlows([{ name: "a", imageIdx: [9] }], cand, FALLBACK, imgOf(() => null, ["cur.png"]));
    expect(out[0].invoices).toEqual([]);
  });

  it("非对象项跳过，不产出垃圾卡；坏 shape 之外的正常输出", () => {
    const out = normalizeFlows(
      [null, "foo", 42, { name: "午饭", money: 35 }],
      cand,
      FALLBACK,
      imgOf(() => null)
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

  // 账本归一（V1.2 反馈：卡片要能分账本）——模型只输出 bookName（名字），
  // 归一负责映射成 bookId：精确命中 / 没写·编造·重名 → 当前账本兜底
  describe("normalizeFlows 账本归一", () => {
    const books = [
      { bookId: "book-cash", bookName: "现金" },
      { bookId: "book-yibao", bookName: "医保" },
    ];

    it("bookName 精确命中 → 对应 bookId；没写/编造 → 兜底当前账本", () => {
      const out = normalizeFlows(
        [
          { name: "统筹报账", bookName: "医保" },
          { name: "自付现金", bookName: "现金" },
          { name: "没点名" },
          { name: "乱写", bookName: "股票账户" },
        ],
        cand,
        FALLBACK,
        imgOf(() => null),
        { books, currentBookId: "book-cash" }
      );
      expect(out.map((f) => f.bookId)).toEqual(["book-yibao", "book-cash", "book-cash", "book-cash"]);
    });

    it("bookName 首尾空白可容忍；重名账本优先当前账本那条", () => {
      const out = normalizeFlows(
        [{ name: "x", bookName: " 现金 " }],
        cand,
        FALLBACK,
        imgOf(() => null),
        { books: [{ bookId: "a", bookName: "现金" }, { bookId: "b", bookName: "现金" }], currentBookId: "b" }
      );
      expect(out[0].bookId).toBe("b");
    });

    it("books 为空 → 全部落当前账本；不传注入时 bookId 缺省（既有调用方行为不变）", () => {
      const empty = normalizeFlows([{ name: "x", bookName: "医保" }], cand, FALLBACK, imgOf(() => null), { books: [], currentBookId: "cur" });
      expect(empty[0].bookId).toBe("cur");
      const noinj = normalizeFlows([{ name: "x", bookName: "医保" }], cand, FALLBACK, imgOf(() => null));
      expect(noinj[0].bookId).toBeUndefined();
    });

    it("AI 塞进来的 bookId 键不吃进来（只认 bookName，防越权账本直通) ", () => {
      const out = normalizeFlows(
        [{ name: "x", bookId: "book-yibao" }],
        cand,
        FALLBACK,
        imgOf(() => null),
        { books, currentBookId: "book-cash" }
      );
      expect(out[0].bookId).toBe("book-cash");
    });
  });
});
