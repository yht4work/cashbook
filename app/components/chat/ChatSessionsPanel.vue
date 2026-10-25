<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import {
  ChatBubbleLeftRightIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/vue/24/outline";
import { useChatStore, type ChatSessionItem } from "~/utils/chatStore";
import { Confirm } from "~/utils/confirm";
import { Alert } from "~/utils/alert";

/**
 * 会话面板：列表（title || 未命名会话）、新建、删除（GlobalConfirm）。
 * 点击选中 → store.loadMessages（选中即加载消息）。
 * 桌面直接嵌在 /chat 左栏；移动端由父级套抽屉壳，mobile=true 时多渲染关闭钮。
 */

interface Props {
  /** 移动抽屉模式：头部加关闭钮，选中/新建后请父级收抽屉 */
  mobile?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  close: [];
}>();

const store = useChatStore();
const loading = ref(false); // 注意：模板里也用于列表骨架
const firstSession = computed(() => store.sessions[0] ?? null);

// 首次挂载拉列表并自动选中最近一个会话；桌面常驻、移动抽屉打开时都会触发
const init = async () => {
  if (loading.value) {
    return;
  }
  loading.value = true;
  await store.loadSessions();
  loading.value = false;
  if (!store.currentId && firstSession.value) {
    store.loadMessages(firstSession.value.id);
  }
};

onMounted(init);

const titleOf = (item: ChatSessionItem): string => item.title || "未命名会话";

const select = (item: ChatSessionItem) => {
  if (!item.id || item.id === store.currentId) {
    return;
  }
  store.loadMessages(item.id);
  // 移动抽屉里点选后收起，回到消息区
  if (props.mobile) {
    emit("close");
  }
};

const toCreate = async () => {
  try {
    await store.createSession();
  } catch {
    // toast 已提示
  }
  if (props.mobile) {
    emit("close");
  }
};

const toDelete = (item: ChatSessionItem) => {
  Confirm.open({
    title: "删除确认",
    content: `确定删除会话【${titleOf(item)}】吗？会话内的消息与小票一并清理。`,
    confirmText: "删除",
    confirm: async () => {
      try {
        await store.deleteSession(item.id);
        Alert.success("删除成功");
      } catch {
        // toast 已提示
      }
    },
  });
};
</script>

<template>
  <div
    class="flex flex-col h-full w-full bg-surface-muted dark:bg-surface-darkMuted text-ink-secondary dark:text-ink-onDark"
  >
    <!-- 头部（含移动端关闭钮） -->
    <div
      class="flex items-center justify-between gap-2 px-3 py-3 border-b border-frame-light dark:border-frame-dark flex-shrink-0"
    >
      <div class="flex items-center gap-2 min-w-0">
        <ChatBubbleLeftRightIcon class="h-5 w-5 text-brand-600 dark:text-brand-400 flex-shrink-0" />
        <span class="font-semibold text-ink-primary dark:text-ink-onDark">AI 记账</span>
      </div>
      <div class="flex items-center gap-1 flex-shrink-0">
        <button
          aria-label="新建会话"
          title="新建会话"
          @click="toCreate"
          class="p-2 rounded-lg text-ink-secondary dark:text-ink-onDark hover:bg-surface-soft dark:hover:bg-surface-dark border border-frame dark:border-frame-dark transition-colors"
        >
          <PlusIcon class="h-5 w-5" />
        </button>
        <button
          v-if="mobile"
          aria-label="收起会话栏"
          title="收起"
          @click="emit('close')"
          class="p-2 rounded-lg text-ink-muted dark:text-ink-onDark hover:bg-surface-soft dark:hover:bg-surface-dark transition-colors"
        >
          <XMarkIcon class="h-5 w-5" />
        </button>
      </div>
    </div>

    <!-- 列表 -->
    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <!-- 骨架 -->
      <template v-if="loading && store.sessions.length === 0">
        <div
          v-for="i in 3"
          :key="i"
          class="h-9 rounded-lg bg-surface-soft dark:bg-surface-dark animate-pulse"
        ></div>
      </template>

      <div
        v-else-if="store.sessions.length === 0"
        class="px-3 py-8 text-center text-xs text-ink-muted dark:text-ink-onDark/60"
      >
        还没有会话<br />点上方「新建会话」开始记账
      </div>

      <!-- 会话项 -->
      <ul v-else class="space-y-1">
        <li
          v-for="item in store.sessions"
          :key="item.id"
          role="button"
          tabindex="0"
          @click="select(item)"
          @keydown.enter="select(item)"
          :class="[
            'group flex items-center justify-between gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-200 outline-none border',
            item.id === store.currentId
              ? 'bg-surface-soft dark:bg-surface-dark text-brand-700 dark:text-brand-300 border-frame dark:border-frame-dark'
              : 'text-ink-secondary dark:text-ink-onDark border-transparent hover:bg-surface-soft dark:hover:bg-surface-darkMuted',
          ]"
        >
          <span class="truncate text-sm font-medium min-w-0 flex-1">
            {{ titleOf(item) }}
          </span>
          <button
            aria-label="删除会话"
            title="删除会话"
            class="flex-shrink-0 p-1 rounded text-ink-muted dark:text-ink-onDark/70 hover:text-state-danger dark:hover:text-state-danger hover:bg-surface dark:hover:bg-surface-darkMuted transition-all"
            :class="item.id === store.currentId ? 'opacity-60' : 'opacity-0'"
            @click.stop="toDelete(item)"
            @keydown.stop
          >
            <TrashIcon class="h-4 w-4" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* 删除钮在触屏设备没有 hover，桌面才渐显 */
@media (hover: none) {
  .group .opacity-0:not(:focus):not(:focus-within) {
    opacity: 0.4;
  }
}
</style>