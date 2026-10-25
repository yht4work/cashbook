<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import ChatMsgItem from "~/components/chat/ChatMsgItem.vue";
import { useChatStore } from "~/utils/chatStore";

/**
 * 消息流（Task 8）：滚动容器 + 行渲染。ChatMsgItem 显式 import
 * （Nuxt dev 自动导入不收编新组件）。
 *
 * 自动跟随策略（简单实现）：
 * - 「吸底」= 距底 ≤ 48px；scroll 时更新（用户上翻即脱离吸底，不再抢滚动）；
 * - 新内容（新行 / 流式 delta 增长 / 卡片挂回 / 会话切换）在吸底态滚到底；
 * - 切换会话强制恢复吸底；
 * - 首次挂载（空态切出消息流、首条消息乐观行进来的路径）滚到底——这些路径
 *   不触发 watch（挂载时初始值已被记录为「当前值」），必须有 onMounted。
 */
const store = useChatStore();

const listEl = ref<HTMLElement | null>(null);
const stick = ref(true);
const STICK_GAP = 48; // 距底多少 px 内视为吸底

const onScroll = (): void => {
  const el = listEl.value;
  if (!el) {
    return;
  }
  stick.value = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_GAP;
};

const toBottom = (): void => {
  const el = listEl.value;
  if (el) {
    el.scrollTop = el.scrollHeight;
  }
};

onMounted(toBottom);

let prevId = store.currentId;

// 渲染帧后按「内容签名」判定跟随：行数 / 末行文本长度 / 末行卡片数 / 末行图数
watch(
  () => {
    const list = store.currentMessages;
    const last = list[list.length - 1];
    return [store.currentId, list.length, (last?.content ?? "").length, last?.flowCards?.length ?? 0, last?.imageList.length ?? 0];
  },
  () => {
    if (store.currentId !== prevId) {
      prevId = store.currentId;
      stick.value = true; // 换会话：强制回到底部
    }
    if (stick.value) {
      toBottom();
    }
  },
  { flush: "post" }
);
</script>

<template>
  <div
    id="chat-msg-list"
    ref="listEl"
    class="chat-msg-list flex-1 min-h-0 overflow-y-auto overscroll-contain bg-surface-muted dark:bg-surface-dark"
    @scroll.passive="onScroll"
  >
    <!-- 少行时贴底（justify-end），多行自然撑开滚动 -->
    <div class="min-h-full flex flex-col justify-end gap-3 px-1 py-3 md:gap-4">
      <ChatMsgItem
        v-for="(m, i) in store.currentMessages"
        :key="`${m.id}-${m.role}-${i}`"
        :msg="m"
      />
    </div>
  </div>
</template>
