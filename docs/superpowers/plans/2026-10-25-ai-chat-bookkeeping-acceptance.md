# AI 记账助手（Chat）最终验收清单

> 生成：Task 10（2026-10-26）。逐项核对设计文档 `docs/superpowers/specs/2026-10-25-ai-chat-bookkeeping-design.md` 的 `## 验收`（L234-249）。
> 判定口径：**✅** = 已验证（附证据指针）；**待环境** = 环境修复后代跑（脚本/思路已就绪）；**用户可自测** = 需用户配合操作。未验过的项不打钩。
> 分支 `feat/ai-chat-bookkeeping`；证据路径：`.superpowers/sdd/2026-10-25-ai-chat-bookkeeping/task-{N}-report.md`（下称 T{N}）、截图 `/tmp/cb-shot/*.png`、日志 `verify*.log`（/tmp，不入库）、Task 10 验证脚本 `t10-verify.cjs` + `t10-verify.log`（21/21 PASS，console 全程 0 error）。Task 10 截图：`t10-retry-streaming.png`（重试流式中另钮禁用）、`t10-retry-done.png`（失败行原地替换为卡片行）、`t10-title.png`（面板标题刷新）、`t10-rendergate.png`（纯 JSON 正文隐藏 / 叙述可见双形态）。真实上传端到端（2026-10-26 权限修复后补跑）：`t9-upload-e2e.cjs` + `t9-upload-e2e.log`（16/16 PASS、console 0）。

## 验收清单（设计文档逐项）

| # | 项目 | 判定 | 证据 |
|---|------|------|------|
| 1 | 上传多张小票 + 一句话 | ✅（2026-10-26 权限修复后补验） | `data/images` 属主修复（root→yh.tao）后 controller 代跑 `/tmp/cb-shot/t9-upload-e2e.cjs`：**16/16 PASS、console 0**（`t9-upload-e2e.log`）——canvas 生成 3 件商品小票 → 真实上传（user 行带服务端文件名 `chat-1013-*.png`）→ 模型拆 3 卡（名称/单价×数量全对）→ 每卡同挂本票 → 前两卡入账成功；999998 清场归零 |
| 1 | 逐字流式回复 | ✅ | T6 帧时间戳实测逐字（34 帧 ~10-16ms 递进）；T8 截图 `t8-stream-1/2/3.png` 中间帧 |
| 1 | N 张卡片 → 改类型/账本 → 入账 | ✅ | T9（41 playwright 断言 + psql 双向核对：改类型入账落编辑值、候选下拉真值、再入账拒绝）；截图 `t9-card-edit.png` / `t9-card-booked.png` / `t9-cards-all-booked.png` |
| 1 | 流水管理页可见新流水且 invoice 图可显示；消息状态已入账 | ✅（完整） | 流水落 `ChatMessage.flows` + Flow 行（T9 psql：`DB flow1/flow2 照录`、`ChatMessage.status=1`）；e2e 补验（2026-10-26，`t9-upload-e2e.log` 16/16）：`Flow#2.invoice` 挂上传小票、文件在盘、show 直显经 blob 正常；流水管理页/编辑弹窗与 chat 同走 `doApi.download("api/entry/flow/invoice/show")` 路径（`FlowsTable.vue:563` / `FlowTable.vue:792` / `FlowEditInvoiceDialog.vue:217`），既有机制未变 |
| 2 | 一张小票拆多项（2 条流水挂同一张小票；卡片去票→该条 invoice 空） | ✅（完整：真拆+UI 双向） | 真实拆分（2026-10-26，`t9-upload-e2e.log` 16/16）：3 件商品→3 条流水且均挂同一张小票；去票方向（`Flow#1 invoice` 空）与留票方向（`Flow#2 invoice`=该票）同轮验证；卡片上增删小票双向可逆 + 入账落库语义：T9（勾选池补挂/取消、`DB flow1 invoice 为空、flow2 不受影响`） |
| 3 | 刷新页面重进会话：历史与卡片状态（含已入卡跳转）完整保留 | ✅ | T8 `t8-desktop-reload.png`（刷新持久性）；T9「刷新回读」（两卡仍 marked booked，`t9-cards-all-booked.png`） |
| 4 | 删除会话：确认后消失；已入账流水的 invoice 图仍能打开 | ✅ | T9 `t9-session-del.cjs`（ChatSession/ChatMessage 归 0；真收据 md5 删前删后一致 `/tmp/cb-shot/t9-receipt-md5-*.txt`，文件未被清理故 show 接口仍可打开）；截图 `desktop-chat-confirm.png` / `desktop-chat-deleted.png` |
| 5 | 纯文字「昨天午饭 35」→ 一张卡片，day 自动昨天，bookId 默认当前账本 | ✅ | T6 ①②（smoke）；T10 `t10-verify.cjs`（重试再生成的卡 `day=2026-10-25`、money 35、name 午饭，psql 照录）；入账落所选账本：T9 psql（两 Flow 均 bookId=t9-card） |
| 6 | ollama 停服：user 消息保留、assistant 落失败行 + 重试按钮、点重试恢复、不白屏不假死 | 用户可自测（部分佐证已有） | 真停服 e2e 需用户停 11434 配合；既有部分证据：T3 单测 ECONNREFUSED→「无法连接 ollama 服务」（死端口法，13 例）；T6 ④ 真实 fail 帧端到端（ghost 图 ENOENT：`data: {"t":"fail",…}` + status=-1 行落库 + 行数不变）；T10 `t10-retry-done.png`（失败行点重试 → 原地恢复生成 → 卡片渲染，无新行） |
| 7 | 失败后刷新页面：历史连续（无悬空 user 轮），重试仍可用 | ✅ | user 行先于生成落库、失败行独立落库（T6 ①④ psql 照录：805 user + 804 失败行连续）；T10 `t10-verify.cjs`：新开页面载入含失败行的会话 → 失败气泡 + 重试钮在 → 点重试成功（psql 行 id 不变、status 0） |
| 8 | 直连 9092 与反代域名下流式逐字 | ✅（直连）/ 非目标（反代） | 直连：T6/T8/T9/T10 全部验证即走 9092；反代：SSE 头由 h3 `stream.send()` 一次成型（含 no-buffering，T6 报告），标准 pass-through 即可，属部署侧配置说明（设计文档非目标） |
| 9 | 移动端 <1024px 底栏五项（预算/分析/日历/流水/AI 记账）、无「账本」；头部账本切换可用；汉堡侧栏有账本管理 | ✅ | T7 报告（AppBottomNav 第 5 项 账本→AI 记账）+ 截图 `mobile-chat-bottomnav.png` / `mobile-chat-drawer.png` / `mobile-chat-final.png`；T10 `t10-*.png` 同页面再证 |
| 10 | 不产生 AI 静默写入的流水（无未经人工确认的记录） | ✅ | 设计即「AI 产出只是卡片草稿」：唯一写 Flow 的路径是卡片「入账」钮（`api/entry/chat/save`，T9）；T10 seeded 会话全程（生成/重试/起名）Flow 表 0 新增——psql 清场前后核对（`t9-clean-db.cjs` 同款，t10 亦复用） |

## 起（会话名）UI：面板标题刷新 — 已验证（Task 10）

新会话发「昨天午饭35」→ 完成后（含 ensureTitle 的首条 ~2s 延迟，设计如此）会话面板首列标题由「未命名会话」刷新为服务端标题，面板 DOM 与 psql 标题一致；console 全程 0 error（`t10-verify.log` 18/18 PASS、`t10-title.png`）。

## 尾注：已知 V1 限制（不阻塞验收，均有记录）

- 设计文档 L251-271 已记录：done 帧 messageId 并发竞态（前端锁输入防）；历史窗口内小票文件缺失→该会话后续 send/retry 以明确文案失败直至滚出 20 条窗口；`chatOnce` 无读超时（仅连接兜底 30s）；首条消息 done 帧延迟 ~2s（先起名再发 done）。
- **指令回声/标题垃圾：已解于 think 放开**（Task 10 修订裁决，`server/utils/chat/ollama.ts` `think:false`→`think:true`）：回声与孤立 `</think>` 曾多次实证（`t10-retry-done.png` 等），根因是 think 通道被关后 glm-5.3-flash:cloud 把英文叙述直接写进 `message.content`；放开后实测两连发 content 均为纯 JSON（无叙述/无孤立标签）、标题干净（「昨日午饭支出35元」，`t10b-*.png` / `t10b-verify.log` 15/15 PASS）。prompt 的反回声指令行保留作纵深防御；**如需提速可回退 `think:false`，回声随之回归**。
- 小票 blob 缓存页生不 revoke：`chatStore.imageBlobCache` 按文件名缓存 blob URL，页面生命周期持有（不逐卡 revoke，换页回收靠浏览器）。
- `/flows?highlight=<flowId>` 链接暂无消费者：`flows.client.vue` 未读该参数（已入卡跳转链接存在、落地页不滚动定位，V1 收）。
- 并发同名小票双下载孤儿 URL：`chatImageBlob` 首次并发未命中缓存时各自下载，后写者胜出、先者的 URL 泄漏（不 revoke，仅浏览器侧）。
- save 响应丢失不自愈窗：入账请求发出后响应丢失/网络中断时，服务端已落 Flow 而本地卡仍「待确认」，刷新才对齐（无自动重试/对账）。
- 既有全站口径（非本功能引入，仅记录，见 T9/design 附录）：流水写入不校验 bookId 归属；`getMessages` 对不存在/他人会话返回空数组；手动 fetch 路径 c==400 不触发登录跳转（仅 toast）。
