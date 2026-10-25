<script setup lang="ts">
import { computed, ref } from "vue";
import { ExclamationTriangleIcon } from "@heroicons/vue/24/outline";
import { chatImageSrc, type ChatMessageItem } from "~/utils/chatStore";

/**
 * 单条消息气泡（Task 8 渲染层）：
 * - user：右对齐，文字 + 小票缩略行（点击锚点开大图 /api/entry/flow/invoice/show）；
 *   待发行（pending）缩略图用 blob 预览，落地后由 loadMessages 的服务端行接管。
 * - assistant：左对齐，叙述文本简单换行渲染（whitespace-pre-wrap，不解析 markdown）；
 *   首部 trim 一次（旧数据可能残留前导空行）。
 * - 流式行（msg.streaming）显示打字光标；内容未到时显示三点待机。
 * - status=-1：失败态（警示样式 + 服务端错误文案）；重试按钮留给 Task 10（store.retry）。
 * - flows 非空：仅渲染空容器占位（Task 9 在挂点接 ChatDraftCard），不渲染 JSON 原文。
 */
interface Props {
  msg: ChatMessageItem;
}

const props = defineProps<Props>();

const isUser = computed(() => props.msg.role === "user");

/** content 首部 trim：历史行可能带残留前导空行/空格；流式行同口径 */
const textOf = computed<string>(() => (props.msg.content ?? "").replace(/^\s+/, ""));

/** 加载失败的小票文件名（隐藏该缩略图，不给裂图占满气泡） */
const broken = ref<string[]>([]);

interface Thumb {
  key: string; // 去重/失败标记的键：待发行用 blob URL，落地行用文件名
  src: string; // 缩略图地址
  full: string; // 大图地址
  live: boolean; // 是否还在发送中（blob 预览）
}

const thumbs = computed<Thumb[]>(() => {
  const m = props.msg;
  if (m.pending) {
    return (m.pendingImages ?? []).map((u) => ({ key: u, src: u, full: u, live: true }));
  }
  return m.imageList
    .filter((n) => !broken.value.includes(n))
    .map((n) => ({ key: n, src: chatImageSrc(n), full: chatImageSrc(n), live: false }));
});

const onThumbError = (key: string): void => {
  if (!broken.value.includes(key)) {
    broken.value.push(key);
  }
};
</script>

<template>
  <div
    class="flex w-full min-w-0"
    :class="isUser ? 'justify-end' : 'justify-start'"
    :data-chat-role="props.msg.role"
  >
    <!-- user 气泡 -->
    <div v-if="isUser" class="w-fit max-w-[88%] md:max-w-[72%] min-w-0">
      <!-- 小票缩略行（待发行 blob / 落地行 show 接口；点击开大图） -->
      <div
        v-if="thumbs.length"
        class="mb-1 flex flex-wrap justify-end gap-1.5"
      >
        <a
          v-for="t in thumbs"
          :key="t.key"
          :href="t.full"
          target="_blank"
          rel="noopener"
          class="block h-16 w-16 md:h-20 md:w-20 flex-shrink-0 overflow-hidden rounded-lg border border-frame dark:border-frame-dark bg-surface-soft dark:bg-surface-darkMuted"
          :title="t.live ? '小票（发送中）' : '查看小票大图'"
        >
          <img
            :src="t.src"
            alt="小票"
            class="h-full w-full object-cover"
            loading="lazy"
            @error="onThumbError(t.key)"
          />
        </a>
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
      <!-- 失败态（status=-1）：警示样式 + 错误文案；重试按钮留给 Task 10 -->
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
          <!-- Task 10 挂点：重试按钮 → store.retry(msg.id)（仅 status=-1 可重试） -->
        </div>
      </div>

      <!-- 正常 / 流式态（flows 非空但无叙述文本的行也渲染——挂点要能展示卡片） -->
      <div
        v-else-if="textOf || msg.streaming || (msg.flowCards && msg.flowCards.length)"
        class="rounded-2xl rounded-bl-md border border-frame bg-surface px-3.5 py-2 md:px-4 md:py-2.5 shadow-sm dark:border-frame-dark dark:bg-surface-darkMuted"
      >
        <p
          v-if="textOf"
          class="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-secondary dark:text-ink-onDark"
        >
          <span>{{ textOf }}</span><span v-if="msg.streaming" class="chat-caret" data-chat-caret="true" aria-hidden="true"></span>
        </p>
        <!-- 流式开始但内容未到：三点待机 -->
        <div v-else-if="msg.streaming" class="chat-typing" aria-label="生成中">
          <i></i><i></i><i></i>
        </div>
        <!-- flows 卡片挂点：Task 9 在此接 ChatDraftCard（本任务仅空容器，不渲染 JSON 原文） -->
        <div
          v-if="msg.flowCards && msg.flowCards.length"
          class="chat-cards-slot"
          data-chat-cards-slot="true"
        ></div>
      </div>
    </div>
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
