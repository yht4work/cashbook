<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ExclamationTriangleIcon } from "@heroicons/vue/24/outline";
import { chatImageBlob, useChatStore, type ChatMessageItem } from "~/utils/chatStore";
import { chatNarrationText } from "~/utils/chatNarration";
/* 显式 import（Nuxt dev 自动导入不收编新组件） */
import ChatDraftCard from "~/components/chat/ChatDraftCard.vue";
import ChatImageViewer from "~/components/chat/ChatImageViewer.vue";

/**
 * 单条消息气泡（Task 8 渲染层）：
 * - user：右对齐，文字 + 小票缩略行（点击站内大图蒙版预览——V1.2 反馈不再
 *   blob: 新开标签页；show 接口要求裸 Authorization 头，<img>/<a> 带不上，
 *   缩略一律 chatImageBlob 直显）；待发行（pending）缩略图用 blob 预览，
 *   落地后由 loadMessages 的服务端行接管。
 * - assistant：左对齐，叙述文本简单换行渲染（whitespace-pre-wrap，不解析 markdown）；
 *   首部 trim 一次（旧数据可能残留前导空行）。
 * - 流式行（msg.streaming）显示打字光标；内容未到时显示三点待机。
 * - status=-1：失败态（警示样式 + 服务端错误文案 + 重试按钮，streaming 时禁用）。
 * - flows 非空：卡片挂点逐项渲染 ChatDraftCard（编辑/小票勾选/入账）。
 */
interface Props {
  msg: ChatMessageItem;
}

const props = defineProps<Props>();

const store = useChatStore();

const isUser = computed(() => props.msg.role === "user");

/**
 * 卡片勾选池上下文：本消息所有卡的小票 ∪ 源 user 行的图（产生本轮消息的上一行）。
 * AI 常把同一张小票只挂到部分卡上（或干脆不挂），spec 要求入账前用户可在卡片上
 * 增删小票——两个方向都要给到，所以池从整个消息上下文取全集。
 */
const ctxInvoices = computed<string[]>(() => {
  if (!props.msg.flowCards?.length) {
    return [];
  }
  const all = new Set<string>();
  for (const c of props.msg.flowCards) {
    for (const n of c.invoices || []) {
      if (n) {
        all.add(String(n));
      }
    }
  }
  const rows = store.currentMessages;
  const i = rows.indexOf(props.msg);
  const prev = i > 0 ? rows[i - 1] : null;
  if (prev && prev.role === "user") {
    for (const n of prev.imageList) {
      if (n) {
        all.add(n);
      }
    }
  }
  return [...all];
});

/** content 首部 trim：历史行可能带残留前导空行/空格；流式行同口径 */
const textOf = computed<string>(() => (props.msg.content ?? "").replace(/^\s+/, ""));

/** 卡片行：flows 非空 → 逐项渲染 ChatDraftCard，气泡改占满列宽（表单撑得开） */
const hasCards = computed<boolean>(() => !!(props.msg.flowCards && props.msg.flowCards.length));

/** 加载失败的小票文件名（隐藏该缩略图，不给裂图占满气泡） */
const broken = ref<string[]>([]);

/** show 接口要求裸 Authorization 头，<img> 带不上 —— 缩略一律 blob 直显
 *  （chatImageBlob = doApi.download → objectURL，与卡片/FlowEditInvoiceDialog 同源） */
const blobUrls = ref<Record<string, string>>({});

// 服务端行的缩略图按需取 blob（pending 行用 blob 预览，不走这里）
watch(
  () => (props.msg.pending ? "" : props.msg.imageList.join("|")),
  (v, old) => {
    if (v === old || props.msg.pending) {
      return;
    }
    for (const n of props.msg.imageList) {
      if (blobUrls.value[n]) {
        continue;
      }
      chatImageBlob(n).then((url) => {
        if (url && !blobUrls.value[n]) {
          blobUrls.value[n] = url;
        } else if (!url && !broken.value.includes(n)) {
          broken.value.push(n);
        }
      });
    }
  },
  { immediate: true }
);

interface Thumb {
  key: string; // 去重/失败标记的键：待发行用 blob URL，落地行用文件名
  src: string; // 缩略图地址（blob URL）
  full: string; // 大图地址（同一 blob，交给站内蒙版预览）
  live: boolean; // 是否还在发送中（blob 预览）
}

const thumbs = computed<Thumb[]>(() => {
  const m = props.msg;
  if (m.pending) {
    return (m.pendingImages ?? []).map((u) => ({ key: u, src: u, full: u, live: true }));
  }
  // 服务端行：show 要裸头，<img>/<a> 带不上——blob URL 就绪才渲染，失败仍隐藏
  return m.imageList
    .filter((n) => blobUrls.value[n] && !broken.value.includes(n))
    .map((n) => ({ key: n, src: blobUrls.value[n], full: blobUrls.value[n], live: false }));
});

/** 大图蒙版：点缩略图 → 页内全屏（V1.2 反馈，不再 blob: 新标签页） */
const viewerSrc = ref("");

const onThumbError = (key: string): void => {
  if (!broken.value.includes(key)) {
    broken.value.push(key);
  }
};

/**
 * 重试失败轮（Task 10）：仅 status=-1 的服务端行可重试（本地临时 id=0 行
 * 还没有服务端 id，服务端会答「消息不存在」）。store.streaming 全局锁：
 * 生成中一律禁用，避免并发重试抢流（store.retry 内部同款守卫）。
 * 成功后该失败行被流式内容原地替换（status→0，按钮随失败态消失）。
 */
const canRetry = computed<boolean>(
  () => props.msg.status === -1 && !!props.msg.id && !store.streaming
);

/**
 * 正文段显隐（2026-10-30 用户反馈，渲染侧 only——落库仍是全文，server 不动）：
 * 契约是「叙述、卡片都可以，裸 JSON 一律不展示」。prompt 允许模型把 JSON
 * 数组混进正文（它就是卡片的来源），落库内容保留全文（模型历史上下文/重试
 * 要回看自己的数组），所以气泡这一层把数组剥掉：已闭合的数组段不再渲染
 * （卡片即该段的可视表达），流式未闭合的尾段也剥（不让半截 JSON 闪出）。
 * 成文但没成卡的回复（解析失败/归一全弃）原样可见——那是仅存的事实信息。
 */
const narration = computed<string>(() =>
  chatNarrationText(props.msg.content, {
    hasCards: hasCards.value,
    streaming: !!props.msg.streaming,
  })
);
</script>

<template>
  <div
    class="flex w-full min-w-0"
    :class="isUser ? 'justify-end' : 'justify-start'"
    :data-chat-role="props.msg.role"
  >
    <!-- user 气泡 -->
    <div v-if="isUser" class="w-fit max-w-[88%] md:max-w-[72%] min-w-0">
      <!-- 小票缩略行（待发行 blob / 落地行 show 接口；点击站内大图蒙版） -->
      <div
        v-if="thumbs.length"
        class="mb-1 flex flex-wrap justify-end gap-1.5"
      >
        <button
          v-for="t in thumbs"
          :key="t.key"
          type="button"
          data-chat-thumb
          class="block h-16 w-16 md:h-20 md:w-20 flex-shrink-0 overflow-hidden rounded-lg border border-frame dark:border-frame-dark bg-surface-soft dark:bg-surface-darkMuted"
          :title="t.live ? '小票（发送中）' : '查看小票大图'"
          :aria-label="t.live ? '查看小票大图（发送中）' : '查看小票大图'"
          @click="viewerSrc = t.full"
        >
          <img
            :src="t.src"
            alt="小票"
            class="h-full w-full object-cover"
            loading="lazy"
            @error="onThumbError(t.key)"
          />
        </button>
      </div>
      <div
        v-if="textOf"
        class="w-fit rounded-2xl rounded-br-md bg-brand-600 px-3.5 py-2 md:px-4 md:py-2.5"
      >
        <p class="whitespace-pre-wrap break-words text-left text-sm leading-relaxed text-white">
          {{ textOf }}
        </p>
      </div>
    </div>

    <!-- assistant 气泡 -->
    <div v-else class="w-fit max-w-[92%] md:max-w-[80%] min-w-0">
      <!-- 失败态（status=-1）：警示样式 + 错误文案 + 重试按钮 -->
      <div
        v-if="msg.status === -1"
        data-chat-failed="true"
        class="flex items-start gap-2 rounded-2xl rounded-bl-md border border-state-danger/40 bg-state-danger/5 px-3.5 py-2.5 dark:border-state-danger/50 dark:bg-state-danger/10"
      >
        <ExclamationTriangleIcon class="h-5 w-5 flex-shrink-0 text-state-danger" />
        <div class="min-w-0">
          <p class="text-sm font-medium text-state-danger">生成失败</p>
          <p
            v-if="textOf"
            class="mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-muted dark:text-ink-onDark"
          >
            {{ textOf }}
          </p>
          <button
            type="button"
            data-chat-retry="true"
            class="mt-1.5 inline-flex items-center gap-1 rounded-lg border border-state-danger/40 px-2.5 py-1 text-xs font-medium text-state-danger transition-colors hover:bg-state-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="!canRetry"
            @click="canRetry && store.retry(props.msg.id)"
          >
            重试
          </button>
        </div>
      </div>

      <!-- 正常 / 流式态（flows 非空但无叙述文本的行也渲染——挂点要能展示卡片） -->
      <div
        v-else-if="textOf || msg.streaming || hasCards"
        :class="[
          'rounded-2xl rounded-bl-md border border-frame bg-surface px-3.5 py-2 md:px-4 md:py-2.5 shadow-sm dark:border-frame-dark dark:bg-surface-darkMuted',
          hasCards ? 'w-full md:w-[30rem] md:max-w-[85%]' : 'w-fit max-w-[92%] md:max-w-[80%]',
        ]"
      >
        <!-- 正文段：裸 JSON 已剥（已成卡数组由卡片表达，叙述留可见）；
             流式未闭合的 JSON 尾段剥空时走三点待机 -->
        <p
          v-if="narration"
          class="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary dark:text-ink-onDark"
        >
          <span>{{ narration }}</span><span v-if="msg.streaming" class="chat-caret" data-chat-caret="true" aria-hidden="true"></span>
        </p>
        <!-- 流式开始但内容未到：三点待机 -->
        <div v-else-if="msg.streaming" class="chat-typing" aria-label="生成中">
          <i></i><i></i><i></i>
        </div>
        <!-- flows 卡片挂点：ChatDraftCard 逐卡渲染（编辑/小票勾选/入账在卡片内闭环） -->
        <div
          v-if="hasCards"
          class="chat-cards-slot mt-2 flex flex-col gap-2"
          data-chat-cards-slot="true"
        >
          <ChatDraftCard
            v-for="(c, i) in msg.flowCards"
            :key="`${msg.id}-card-${i}`"
            :card="c"
            :index="i"
            :message-id="msg.id"
            :streaming="!!msg.streaming"
            :ctx-invoices="ctxInvoices"
          />
        </div>
      </div>
    </div>

    <!-- 大图蒙版（fixed 脱流，不影响气泡布局） -->
    <ChatImageViewer :src="viewerSrc" :open="!!viewerSrc" @close="viewerSrc = ''" />
  </div>
</template>

<style scoped>
/* 流式打字光标（闪烁竖线，跟随正文颜色） */
.chat-caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  border-radius: 1px;
  background-color: currentColor;
  animation: chat-blink 1s steps(1) infinite;
}

@keyframes chat-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0;
  }
}

/* 流式待机三点 */
.chat-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}

.chat-typing i {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background-color: currentColor;
  opacity: 0.35;
  animation: chat-typing 1.2s ease-in-out infinite;
}

.chat-typing i:nth-child(2) {
  animation-delay: 0.2s;
}

.chat-typing i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes chat-typing {
  0%,
  60%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  30% {
    transform: translateY(-3px);
    opacity: 0.8;
  }
}
</style>
