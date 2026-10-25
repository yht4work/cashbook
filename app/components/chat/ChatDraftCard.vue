<script setup lang="ts">
import { computed, ref, watch } from "vue";
/* ⚠ 显式 import（Nuxt dev 自动导入不收编新组件——本组件自身的依赖与被
 * ChatMsgItem 引用一样，都要写全）：UiDatePicker、doApi、候选 API、store。 */
import { CheckBadgeIcon, PencilSquareIcon } from "@heroicons/vue/24/solid";
import { TagIcon } from "@heroicons/vue/24/outline";
import { Alert } from "~/utils/alert";
import { doApi } from "~/utils/api";
import { getIndustryType, getPayType } from "~/utils/apis";
import type { Book } from "~/utils/table";
import { cardBooked, chatImageBlob, useChatStore, type DraftFlow } from "~/utils/chatStore";
import UiDatePicker from "~/components/ui/DatePicker.vue";

/**
 * 流水草稿确认卡（Task 9）：AI 产出的一条 DraftFlow → 概览 → 编辑 → 入账。
 *
 * - 概览态：徽标（已入账=绿角标 + 「查看流水」链接 /flows?highlight=<flowId>；
 *   未入账=灰「待确认」）+ 字段摘要 + 小票缩略图；未入账有「编辑」（进表单）
 *   与「入账」（直接入账）。
 * - 编辑态：day 用 UiDatePicker（显式 import）；flowType 下拉（FlowEditDialog
 *   同口：支出/收入/不计收支，可留空）；industryType/payType/attribution 是
 *   「候选下拉 + 自由文本」组合框——候选一律来自当前账本（localStorage.bookId 的
 *   实际取值：getIndustryType/getPayType/getAttributions，flowType 变则重拉）；
 *   money 数字输入；name/description 文本；账本下拉来自 book/list，默认当前
 *   账本，仅 V1 允许改到别的账本——入账以最终选择为准。
 * - 小票勾选：缩略图带勾选态，点击 = card.invoices 增删（仅未入账可改）；
 *   图挂了留「加载失败」占位仍可取消勾选，不让死文件悄悄留在卡上。
 * - 入账：规范化（day 缺省/非法补今天、money 与服务端 moneyOf 同口径、名称
 *   兜底「未命名流水」）→ store.saveCard(messageId, index, card, bookId)；
 *   成功后 store 把 flowId 与本次编辑值合并回卡片，卡片转只读。
 * - 已入卡锁定：不渲染编辑/入账/勾选控件；再入账服务端也以「该卡片已入账」拒绝。
 *
 * props.editing：外部初始/驱动的编辑态（默认收起）；开关由卡片自持。
 */
interface Props {
  card: DraftFlow;
  index: number;
  messageId: number;
  editing?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  editing: false,
});

const store = useChatStore();

// ---------- 派生状态 ----------

const booked = computed(() => cardBooked(props.card));

/** 编辑开关（prop.editing 变化可驱动打开——父级/e2e 用；卡片本体自持开关） */
const editing = ref(props.editing && !cardBooked(props.card));
watch(
  () => props.editing,
  (v) => {
    if (v && !booked.value) {
      openEdit();
    }
  }
);

/** 草稿（表单数据源；进编辑态从 card 拷贝，取消/收起则丢弃） */
const draft = ref<DraftFlow>({
  ...props.card,
  invoices: [...props.card.invoices],
});

/** 父级替换 card（入账回写 flowId / 消息刷新）→ 草稿对齐新值；已入则收起编辑 */
watch(
  () => props.card,
  () => {
    if (booked.value) {
      editing.value = false;
    }
    draft.value = { ...props.card, invoices: [...props.card.invoices] };
  }
);

// ---------- 小票图（blob 直显）与勾选（编辑态） ----------

/**
 * show 接口要求裸 Authorization 头，<img> 带不上 —— 缩略/勾选一律走
 * chatImageBlob（doApi.download → blob → objectURL，参照 FlowEditInvoiceDialog）：
 * 名称 → 已就绪的 blob URL / 未就绪（占位）/ 失败（占位，仍可操作勾选）。
 */
const thumbs = ref<Record<string, string>>({});
const loadFailed = ref<string[]>([]);

const thumbOf = (name: string): string => thumbs.value[name] ?? "";

const loadOne = (name: string): void => {
  if (thumbs.value[name] || loadFailed.value.includes(name)) {
    return;
  }
  chatImageBlob(name).then((url) => {
    if (url && !thumbs.value[name]) {
      thumbs.value[name] = url;
    } else if (!url && !loadFailed.value.includes(name)) {
      loadFailed.value.push(name);
    }
  });
};

/** 编辑态可勾选的小票全集：进入编辑时以卡上现有文件名为准，勾掉也不消失 */
const pool = ref<string[]>([]);

watch(editing, (v) => {
  if (v) {
    pool.value = [...new Set([...draft.value.invoices])];
    for (const n of pool.value) {
      loadOne(n);
    }
  }
});

// 概览缩略（含已入卡回显的入账小票）随 card.invoices 变化装载
watch(
  () => props.card.invoices.join("|"),
  (v, old) => {
    if (v !== old) {
      for (const n of props.card.invoices) {
        loadOne(n);
      }
    }
  },
  { immediate: true }
);

const invoiceOn = (name: string): boolean => draft.value.invoices.includes(name);

/** 勾选/取消 = card.invoices 增删（写回 draft，入账时随卡片提交） */
const toggleInvoice = (name: string): void => {
  const next = new Set(draft.value.invoices);
  if (invoiceOn(name)) {
    next.delete(name);
  } else {
    next.add(name);
  }
  draft.value.invoices = [...next];
};

const markFailed = (name: string): void => {
  if (!loadFailed.value.includes(name)) {
    loadFailed.value.push(name);
  }
};

// ---------- 类型候选（FlowEditDialog 同法：候选下拉 + 自由文本，留空允许） ----------

const flowTypeOptions = ["支出", "收入", "不计收支"];

const industryTypeLabel = computed(() => {
  const t = draft.value.flowType;
  if (t === "支出") {
    return "支出类型";
  }
  if (t === "收入") {
    return "收入类型";
  }
  return "支出类型/收入类型";
});

const payTypeLabel = computed(() => {
  const t = draft.value.flowType;
  if (t === "支出") {
    return "支付方式";
  }
  if (t === "收入") {
    return "收款方式";
  }
  return "支付方式/收款方式";
});

const industryOptions = ref<string[]>([]);
const payOptions = ref<string[]>([]);
const attributionOptions = ref<string[]>([]);

/** getIndustryType/getPayType 返回 {industryType|payType} 行，这里拉平为字符串数组 */
const loadIndustry = async (): Promise<void> => {
  try {
    const rows = await getIndustryType(draft.value.flowType || "");
    industryOptions.value = (rows || []).map((r) => String(r?.industryType ?? "")).filter(Boolean);
  } catch {
    // 失败保旧候选（toast 已提示）
  }
};
const loadPay = async (): Promise<void> => {
  try {
    const rows = await getPayType(draft.value.flowType || "");
    payOptions.value = (rows || []).map((r) => String(r?.payType ?? "")).filter(Boolean);
  } catch {
    // 失败保旧候选（toast 已提示）
  }
};
const loadAttribution = async (): Promise<void> => {
  try {
    const res = await doApi.post<string[]>("api/entry/flow/getAttributions", {
      bookId: localStorage.getItem("bookId"),
    });
    attributionOptions.value = res || [];
  } catch {
    // 失败保旧候选（toast 已提示）
  }
};

/** 流水类型切换 → industry/pay 候选按类型重拉（FlowEditDialog 的 changeFlowTypes 同法） */
const onFlowTypeChange = (): void => {
  loadIndustry();
  loadPay();
};

// ---------- 组合框：候选过滤下拉（mousedown 选中，避免 blur 抢先关掉） ----------

const openCand = ref<"" | "industry" | "pay" | "attribution">("");

const candItems = computed<string[]>(() => {
  const f = openCand.value;
  if (!f || !editing.value) {
    return [];
  }
  const opts =
    f === "industry"
      ? industryOptions.value
      : f === "pay"
        ? payOptions.value
        : attributionOptions.value;
  const text = String(
    draft.value[f === "industry" ? "industryType" : f === "pay" ? "payType" : "attribution"] ?? ""
  ).trim();
  if (!text) {
    return opts; // 空文本给全量候选
  }
  return opts.filter((o) => o.toLowerCase().includes(text.toLowerCase()));
});

const setCandField = (f: "" | "industry" | "pay" | "attribution"): void => {
  openCand.value = f;
};

const pickCand = (f: "industry" | "pay" | "attribution", v: string): void => {
  if (f === "industry") {
    draft.value.industryType = v;
  } else if (f === "pay") {
    draft.value.payType = v;
  } else {
    draft.value.attribution = v;
  }
  openCand.value = "";
};

// ---------- 账本选择（入账以最终选择为准） ----------

const books = ref<Book[]>([]);
const selectedBook = ref("");

const loadBooks = async (): Promise<void> => {
  try {
    books.value = (await doApi.post<Book[]>("api/entry/book/list", {})) || [];
  } catch {
    // toast 已提示；下拉仍显示当前账本
  }
  const cur = localStorage.getItem("bookId") || "";
  // 当前账本不在列表（已被删等边缘）：前面补一条占位项，避免表单悄悄丢选择
  if (cur && !books.value.some((b) => b.bookId === cur)) {
    books.value = [{ ...books.value[0], bookId: cur, bookName: `${cur}（当前账本）` }, ...books.value] as Book[];
  }
  if (!selectedBook.value) {
    selectedBook.value = cur;
  }
};

// ---------- 入账 ----------

const saving = ref(false);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 上海时区的今天：与服务端 todayOf 同口径（day 缺省兜底用） */
const todayOf = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

/** day 兜底：非法/缺省 → 今天（与 normalizeFlows 的 dayFallback 同口径，别把空串写进流水） */
const dayOf = (v: string): string => {
  const s = String(v ?? "").trim();
  if (s && DAY_RE.test(s) && !Number.isNaN(Date.parse(s))) {
    return s;
  }
  return todayOf();
};

/** money 同服务端 moneyOf：非数字/负数 → 0 */
const moneyOf = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** 编辑值 → 入账载荷（键集与 DraftFlow 同构；bookId 走独立参数，不混进卡片） */
const payload = (): DraftFlow => ({
  day: dayOf(draft.value.day),
  flowType: String(draft.value.flowType ?? "").trim(),
  industryType: String(draft.value.industryType ?? "").trim(),
  payType: String(draft.value.payType ?? "").trim(),
  money: moneyOf(draft.value.money),
  name: String(draft.value.name ?? "").trim() || "未命名流水",
  description: String(draft.value.description ?? "").trim(),
  attribution: String(draft.value.attribution ?? "").trim(),
  invoices: [...new Set(draft.value.invoices.map(String).filter(Boolean))],
});

const onBook = async (): Promise<void> => {
  if (booked.value || saving.value) {
    return; // 已入卡/进行中不再发请求（服务端同样以「该卡片已入账」闭环）
  }
  // 入账目标账本 = 卡片上最终选择；没进过编辑（概览直接入账）时回退当前账本
  const book = selectedBook.value || localStorage.getItem("bookId") || "";
  if (!book) {
    Alert.error("请先选择账本");
    return;
  }
  saving.value = true;
  try {
    const flowId = await store.saveCard(props.messageId, props.index, payload(), book);
    editing.value = false;
    if (flowId) {
      Alert.success(`已入账（流水 #${flowId}）`);
    }
  } catch {
    // toast 已提示（卡片数据无效/请先选择账本/服务端拒绝）
  } finally {
    saving.value = false;
  }
};

const openEdit = (): void => {
  if (booked.value) {
    return; // 已入卡锁定：不进编辑
  }
  draft.value = { ...props.card, invoices: [...props.card.invoices] };
  editing.value = true;
  selectedBook.value = selectedBook.value || localStorage.getItem("bookId") || "";
  loadCandidates();
  loadBooks();
};

const cancelEdit = (): void => {
  draft.value = { ...props.card, invoices: [...props.card.invoices] };
  editing.value = false;
};

const loadCandidates = (): void => {
  loadIndustry();
  loadPay();
  loadAttribution();
};

// ---------- 概览摘要 ----------

const moneyText = computed(() => {
  const n = Number(props.card.money);
  return Number.isFinite(n) ? n.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "0";
});

const flowLink = computed(() =>
  cardBooked(props.card) ? `/flows?highlight=${Number(props.card.flowId)}` : ""
);
</script>

<template>
  <div
    class="w-full min-w-0 rounded-xl border border-frame bg-surface-soft p-3 shadow-sm dark:border-frame-dark dark:bg-surface-dark"
    data-chat-card
    :data-chat-card-index="index"
    :data-chat-card-booked="booked ? 'true' : 'false'"
  >
    <!-- 概览头：徽标 + 名称 + 金额 -->
    <div class="flex items-center gap-2">
      <span
        data-chat-card-badge
        class="inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium"
        :class="
          booked
            ? 'bg-brand-100 text-brand-700 dark:bg-brand-700 dark:text-brand-100'
            : 'bg-surface-muted text-ink-muted dark:bg-surface-darkMuted dark:text-ink-muted'
        "
      >
        <CheckBadgeIcon v-if="booked" class="h-3.5 w-3.5" />
        {{ booked ? "已入账" : "待确认" }}
      </span>
      <span
        class="min-w-0 flex-1 truncate text-sm font-semibold text-ink-primary dark:text-ink-onDark"
        :title="card.name || '未命名流水'"
      >
        {{ card.name || "未命名流水" }}
      </span>
      <span
        class="flex-shrink-0 text-sm font-semibold"
        :class="card.flowType === '收入' ? 'text-brand-600 dark:text-brand-300' : 'text-ink-secondary dark:text-ink-onDark'"
      >
        ¥{{ moneyText }}
      </span>
    </div>

    <!-- 概览摘要行 -->
    <div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-ink-muted">
      <span data-chat-card-day>{{ card.day }}</span>
      <span v-if="card.flowType" data-chat-card-flow-type>{{ card.flowType }}</span>
      <span v-if="card.industryType" data-chat-card-industry>{{ card.industryType }}</span>
      <span v-if="card.payType" data-chat-card-pay-type>{{ card.payType }}</span>
      <span v-if="card.attribution" data-chat-card-attribution>{{ card.attribution }}</span>
      <span data-chat-card-invoice-count>小票 {{ card.invoices.length }} 张</span>
    </div>
    <p
      v-if="card.description"
      class="mt-1 truncate text-xs leading-relaxed text-ink-muted"
      :title="card.description"
    >
      {{ card.description }}
    </p>

    <!-- 概览小票缩略（blob 直显；点击开大图；已入卡展示的就是入账时挂在流水上的小票） -->
    <div v-if="!editing && card.invoices.length" class="mt-2 flex flex-wrap gap-1.5" data-chat-card-thumb-list="true">
      <template v-for="n in card.invoices" :key="n">
        <a
          v-if="thumbOf(n)"
          :href="thumbOf(n)"
          target="_blank"
          rel="noopener"
          class="block h-14 w-14 overflow-hidden rounded-md border border-frame bg-surface dark:border-frame-dark dark:bg-surface-darkMuted"
          :title="n"
        >
          <img
            :src="thumbOf(n)"
            alt="小票"
            class="h-full w-full object-cover"
            loading="lazy"
            @error="markFailed(n)"
          />
        </a>
        <span
          v-else
          class="flex h-14 w-14 items-center justify-center rounded-md border border-frame bg-surface-muted text-center text-[10px] leading-tight text-ink-muted dark:border-frame-dark dark:bg-surface-darkMuted"
          :title="n"
        >
          {{ loadFailed.includes(n) ? "加载失败" : "小票" }}
        </span>
      </template>
    </div>

    <!-- 编辑表单 -->
    <div v-if="editing" class="mt-3 space-y-2" data-chat-card-form="true">
      <!-- 日期（UiDatePicker 显式 import） -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">日期</label>
        <UiDatePicker v-model="draft.day" class="w-full" placeholder="记账日期" position="left" />
      </div>

      <!-- 流水类型 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">流水类型</label>
        <select
          v-model="draft.flowType"
          data-chat-card-field="flowType"
          class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
          @change="onFlowTypeChange"
        >
          <option value="">请选择流水类型</option>
          <option v-for="t in flowTypeOptions" :key="t" :value="t">{{ t }}</option>
        </select>
      </div>

      <!-- 支出/收入类型（候选下拉 + 自由文本，可留空） -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">{{ industryTypeLabel }}</label>
        <div class="relative">
          <input
            v-model="draft.industryType"
            data-chat-card-field="industryType"
            :placeholder="`${industryTypeLabel}（可留空）`"
            class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
            @input="setCandField('industry')"
            @focus="setCandField('industry')"
            @blur="setCandField('')"
          />
          <div
            v-if="openCand === 'industry' && candItems.length"
            class="absolute z-30 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-frame bg-surface text-sm shadow-lg dark:border-frame-dark dark:bg-surface-dark"
            data-chat-card-cand="industryType"
          >
            <div
              v-for="o in candItems"
              :key="o"
              class="flex cursor-pointer items-center gap-2 px-3 py-2 text-ink-secondary hover:bg-surface-muted dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
              @mousedown.prevent="pickCand('industry', o)"
            >
              <TagIcon class="h-3.5 w-3.5 flex-shrink-0 text-ink-muted" />
              {{ o }}
            </div>
          </div>
        </div>
      </div>

      <!-- 支付/收款方式 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">{{ payTypeLabel }}</label>
        <div class="relative">
          <input
            v-model="draft.payType"
            data-chat-card-field="payType"
            :placeholder="`${payTypeLabel}（可留空）`"
            class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
            @input="setCandField('pay')"
            @focus="setCandField('pay')"
            @blur="setCandField('')"
          />
          <div
            v-if="openCand === 'pay' && candItems.length"
            class="absolute z-30 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-frame bg-surface text-sm shadow-lg dark:border-frame-dark dark:bg-surface-dark"
            data-chat-card-cand="payType"
          >
            <div
              v-for="o in candItems"
              :key="o"
              class="cursor-pointer px-3 py-2 text-ink-secondary hover:bg-surface-muted dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
              @mousedown.prevent="pickCand('pay', o)"
            >
              {{ o }}
            </div>
          </div>
        </div>
      </div>

      <!-- 金额 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">金额</label>
        <input
          v-model.number="draft.money"
          data-chat-card-field="money"
          type="number"
          step="0.01"
          min="0"
          placeholder="请输入金额"
          class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
        />
      </div>

      <!-- 流水归属 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">流水归属</label>
        <div class="relative">
          <input
            v-model="draft.attribution"
            data-chat-card-field="attribution"
            placeholder="输入或选择归属（可留空）"
            class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
            @input="setCandField('attribution')"
            @focus="setCandField('attribution')"
            @blur="setCandField('')"
          />
          <div
            v-if="openCand === 'attribution' && candItems.length"
            class="absolute z-30 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-frame bg-surface text-sm shadow-lg dark:border-frame-dark dark:bg-surface-dark"
            data-chat-card-cand="attribution"
          >
            <div
              v-for="o in candItems"
              :key="o"
              class="cursor-pointer px-3 py-2 text-ink-secondary hover:bg-surface-muted dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
              @mousedown.prevent="pickCand('attribution', o)"
            >
              {{ o }}
            </div>
          </div>
        </div>
      </div>

      <!-- 流水名称 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">流水名称</label>
        <input
          v-model="draft.name"
          data-chat-card-field="name"
          placeholder="流水名称"
          class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
        />
      </div>

      <!-- 说明 -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">说明</label>
        <input
          v-model="draft.description"
          data-chat-card-field="description"
          placeholder="备注说明（可留空）"
          class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
        />
      </div>

      <!-- 账本（V1 允许改；入账以最终选择为准） -->
      <div>
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">记入账本</label>
        <select
          v-model="selectedBook"
          data-chat-card-field="book"
          class="w-full rounded-md border border-frame bg-surface px-3 py-2 text-sm text-ink-secondary shadow-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 dark:border-frame-dark dark:bg-surface-dark dark:text-ink-onDark"
        >
          <option value="">请选择账本</option>
          <option v-for="b in books" :key="b.bookId" :value="b.bookId">{{ b.bookName }}</option>
        </select>
      </div>

      <!-- 小票勾选（blob 直显；编辑态增删；加载失败留占位仍可取消勾选） -->
      <div v-if="pool.length">
        <label class="mb-1 block text-xs font-semibold text-ink-secondary dark:text-ink-onDark">关联小票（点击勾选/取消）</label>
        <div class="flex flex-wrap gap-1.5" data-chat-card-invoice-list="true">
          <button
            v-for="n in pool"
            :key="n"
            type="button"
            data-chat-card-invoice
            :data-chat-card-invoice-file="n"
            :data-checked="invoiceOn(n) ? 'true' : 'false'"
            :title="n"
            class="relative h-16 w-16 overflow-hidden rounded-md border-2 transition-colors"
            :class="invoiceOn(n) ? 'border-brand-500' : 'border-frame dark:border-frame-dark'"
            @click="toggleInvoice(n)"
          >
            <img
              v-if="thumbOf(n)"
              :src="thumbOf(n)"
              alt="小票"
              class="h-full w-full object-cover"
              loading="lazy"
              @error="markFailed(n)"
            />
            <span
              v-else
              class="flex h-full w-full items-center bg-surface-muted px-1 text-center text-[10px] leading-tight text-ink-muted dark:bg-surface-darkMuted"
            >
              {{ loadFailed.includes(n) ? "加载失败" : "加载中…" }}
            </span>
            <span
              class="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full border"
              :class="invoiceOn(n) ? 'bg-brand-500 text-white' : 'bg-surface/80 text-transparent dark:bg-surface-dark/80'"
            >
              <CheckBadgeIcon class="h-3 w-3" />
            </span>
          </button>
        </div>
      </div>

      <!-- 操作：收起 / 入账 -->
      <div class="flex items-center justify-end gap-2 pt-1">
        <button
          type="button"
          data-chat-card-collapse
          class="rounded-md border border-frame px-3 py-1.5 text-xs font-medium text-ink-secondary hover:bg-surface-muted dark:border-frame-dark dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
          @click="cancelEdit"
        >
          收起
        </button>
        <button
          type="button"
          data-chat-card-save
          :disabled="saving || booked"
          class="rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-brand-600/50"
          @click="onBook"
        >
          {{ saving ? "入账中…" : "入账" }}
        </button>
      </div>
    </div>

    <!-- 概览操作（未入账：编辑 + 入账；已入账：查看流水链接） -->
    <div v-else class="mt-2 flex items-center justify-between gap-2">
      <button
        v-if="!booked"
        type="button"
        data-chat-card-edit
        class="inline-flex items-center gap-1 rounded-md border border-frame px-2.5 py-1 text-xs font-medium text-ink-secondary hover:bg-surface-muted dark:border-frame-dark dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
        @click="openEdit"
      >
        <PencilSquareIcon class="h-3.5 w-3.5" />
        编辑
      </button>
      <span v-else class="min-w-0 truncate text-xs text-ink-muted">流水已生成，可在流水页查看或修改</span>
      <a
        v-if="booked"
        data-chat-card-flow-link
        :href="flowLink"
        data-chat-card-booked-link="true"
        class="inline-flex flex-shrink-0 items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-500"
      >
        查看流水
      </a>
      <button
        v-else
        type="button"
        data-chat-card-save
        :disabled="saving"
        class="flex-shrink-0 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-500 disabled:cursor-not-allowed disabled:bg-brand-600/50"
        @click="onBook"
      >
        {{ saving ? "入账中…" : "入账" }}
      </button>
    </div>
  </div>
</template>