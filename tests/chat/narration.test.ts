/**
 * chatNarrationText 气泡正文清洗测试（渲染侧纯函数，node 级）。
 *
 * 用户 2026-10-30 反馈钉死的契约：气泡里可以是叙述、可以是卡片，但裸 JSON
 * 一律不展示。落库正文仍是全文（模型历史上下文/重试要用），剥 JSON 只发生在
 * 显示层；与 server extractFlowArray 同一括号配对语义——隐藏的就是服务端
 * 收走做成卡片的那一段（卡片即该数组的可视表达）。
 */
import { describe, expect, it } from "vitest";
import { chatNarrationText } from "~/utils/chatNarration";

/** 报修原样（ChatMessage id=3533：叙述在前、JSON 在后——此前整段可见的缺陷形态） */
const REPORTED =
  '挂号费已记入医保账本。\n\n[{"day":"2026-10-30","flowType":"支出","industryType":"医药/健康","payType":"微信","money":9,"name":"普通内科挂号费","description":"芜湖市繁昌区人民医院，移动医保支付","attribution":"芜湖市繁昌区人民医院","imageIdx":[1],"bookName":"医保"}]';

describe("chatNarrationText", () => {
  it("叙述在前的混排（报修形态）→ 只留叙述", () => {
    expect(chatNarrationText(REPORTED, { hasCards: true })).toBe("挂号费已记入医保账本。");
  });

  it("正文整段就是数组（既有已修形态）→ 空串（气泡只挂卡片）", () => {
    expect(chatNarrationText('[{"name":"午饭","money":35}]', { hasCards: true })).toBe("");
  });

  it("数组后面还有叙述 → 前后叙述都保留", () => {
    expect(chatNarrationText('已核对：[{"money":9}] 你看下', { hasCards: true })).toBe("已核对： 你看下");
  });

  it("成文但未成卡（解析失败/归一全弃）→ 原样不动（边界信息不吞）", () => {
    const raw = '说明如下：[{"money":9}]';
    expect(chatNarrationText(raw, {})).toBe(raw);
  });

  it("流式中：叙述在前、数组未闭合 → 数组前缀不闪出", () => {
    expect(chatNarrationText('挂号费已记入。[{"day":"202', { streaming: true })).toBe("挂号费已记入。");
  });

  it("流式中：纯 JSON 未闭合 → 空串（走待机点）", () => {
    expect(chatNarrationText('[{"name":"午饭"', { streaming: true })).toBe("");
  });

  it("流式中：未闭合数组内的字符串再含 [ → 迭代剥到不动点", () => {
    expect(chatNarrationText('[{"name":"a[备注]b', { streaming: true })).toBe("");
  });

  it("流式中：数组闭合后由剥段接管，后半截叙述保留", () => {
    expect(chatNarrationText('好的 [{"money":9}] 请核对', { streaming: true })).toBe("好的 请核对");
  });

  it("叙述里中文括号段不是 JSON → 不剥", () => {
    const raw = "说明（[参考这条]）：这笔记好了";
    expect(chatNarrationText(raw, { hasCards: true })).toBe(raw);
  });

  it("非数组的 JSON（对象字面量）不剥 ", () => {
    const raw = '配置是 {"payType":"微信"} 这样的';
    expect(chatNarrationText(raw, { hasCards: true })).toBe(raw);
  });

  it("可解析数组不止一段 → 全剥（裸 JSON 一律不展示）", () => {
    expect(chatNarrationText('已记：[{"money":9}] 另：[{"money":1}]', { hasCards: true })).toBe("已记： 另：");
  });

  it("无括号 / 空串 / null → 原样", () => {
    expect(chatNarrationText("昨天午饭 35", { hasCards: true })).toBe("昨天午饭 35");
    expect(chatNarrationText("", {})).toBe("");
    expect(chatNarrationText(null, { hasCards: true })).toBe("");
  });
});