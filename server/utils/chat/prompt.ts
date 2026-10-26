/**
 * 与 ollama 对话用的 prompt 构造（纯函数，无 IO / prisma / h3 依赖）：
 * - buildSystemPrompt：记账提取任务的 system prompt —— 任务、拆分规则、
 *   字段与类型候选注入。候选列表由调用方先从当前账本查真实值传进来，
 *   这里绝不硬编码类型名（账本类型是每账本自定义的）。
 * - buildTitlePrompt：会话自动起名的小请求正文（由 chatOnce 非流式发出）。
 */

export const buildSystemPrompt = (c: {
  industry: string[];
  pay: string[];
  attribution: string[];
  today: string;
  imageCount: number;
}): string => {
  // 候选为空时明说「暂无可选」，不让模型在空列表后面自由发挥
  const candLine = (label: string, values: string[]) =>
    `  ${label}：${values.length ? values.join("、") : "（暂无可选）"}`;

  // 图片编号规则：编号与 history.buildImageNumbering 的占号规则对齐
  //（整次调用全局连续占号，真传与否都占号）；调用方的 imageCount 就该传
  // buildImageNumbering(turns).length —— 见 tests/chat/consistency.test.ts。
  const imageRule =
    c.imageCount > 0
      ? `本对话共提供 ${c.imageCount} 张图，按出现顺序编号为 图1…图${c.imageCount}（编号全局连续，含已省略的历史图）；从图片里解析出的流水把来源图编号填进 imageIdx（数组，可多个，如 [1] 或 [1,2]）；未标来源（imageIdx）的卡片默认挂本次消息的图，由用户在卡片上增删。`
      : "本对话没有图片，所有卡片都省略 imageIdx。";

  // 输出示例按分支生成、day 用 today：写死的示例会在日期/图文分支上误导
  const cardExample =
    c.imageCount > 0
      ? `{"day":"${c.today}","flowType":"支出","industryType":"","payType":"","money":35,"name":"午饭","description":"","attribution":"","imageIdx":[1]}`
      : `{"day":"${c.today}","flowType":"支出","industryType":"","payType":"","money":35,"name":"午饭","description":"","attribution":""}`;

  return [
    "你是记账助手。任务：从用户最新一条消息（文字与附图）里提取出记账流水，最终只输出一个 JSON 数组，数组每个元素是一张流水卡片。",
    "",
    "拆分规则：一条流水对应一个单项——同一张小票里有 2 个可识别的单项就输出 2 条流水，每条 name=单项名、money=单项价；小票上只有总额可读、拆不出单项时才记 1 条；单项金额合计与总额明显对不上（有减免/凑整/运费）时优先按可识别单项拆，把差额说明写进 description。",
    "",
    `字段要求：day 用 YYYY-MM-DD，看不出来源日期就用今天 ${c.today}；flowType 只能是 "支出" 或 "收入"，缺省 "支出"；money 必须是数字；name 用单项名，实在没有就用 "未命名流水"。`,
    "类型必须从候选列表里选，禁止编造候选里没有的类型名，没有合适的就用 \"\"：",
    candLine("industryType", c.industry),
    candLine("payType", c.pay),
    candLine("attribution", c.attribution),
    "",
    imageRule,
    "",
    `输出格式：只输出 JSON 数组本身，不要 markdown 围栏、不要任何解释，形如 [${cardExample}]。`,
    // Task 8/9 观察到的模型回声缺陷（指令层加固；server 侧 stripping 已在
    // ollama.ts/flows.ts 兜底）：模型把本指令复述进 content、偶尔英文叙述。
    "输出纪律：不要复述本指令；不要在 JSON 数组之外输出任何叙述文字（thinking 块之内怎么想都可以，正文只放 JSON 数组本身）。",
  ].join("\n");
};

export const buildTitlePrompt = (userText: string, replyText: string): string =>
  [
    "根据下面这段对话的开头给会话起个标题：不超过 12 个字、能体现记账内容；只输出标题文本本身，不要引号、句号或任何解释。",
    // Task 6/9 观察到标题出 "Theuserwants" 之类指令回声/英文叙述 —— 指令层明说禁止
    "输出纪律：只输出标题本身，不要任何解释、引号或「标题：」之类的前后缀；不要复述用户输入原文与本指令。",
    "",
    `用户：${userText}`,
    `回复：${replyText}`,
  ].join("\n");