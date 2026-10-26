<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import {
  CheckCircleIcon,
  CheckIcon,
  ChatBubbleLeftRightIcon,
  PlusIcon,
  TrashIcon,
  XMarkIcon,
} from "@heroicons/vue/24/outline";
import { useChatStore, type ChatSessionItem } from "~/utils/chatStore";
import { Confirm } from "~/utils/confirm";
import { Alert } from "~/utils/alert";

/**
 * 会话面板：列表（title || 未命名会话）、新建、删除（GlobalConfirm）、
 * 多选批量清理（T12：勾选后一次走 batchDelete 端点）。
 * 点击选中 → store.loadMessages（选中即加载消息）；多选态下点行=反选。
 * 「新建」（T13 懒创建）：只进草稿态，不落库。
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

// T12 多选态：勾选集用数组（模板里 length/includes 直读，免上 Set）
const selecting = ref(false);
const checked = ref<number[]>([]);
const checkedCount = computed(() => checked.value.length);

const enterSelect = (): void => {
  selecting.value = true;
  checked.value = [];
};

const exitSelect = (): void => {
  selecting.value = false;
  checked.value = [];
};

const toggleSelect = (): void => {
  if (selecting.value) {
    exitSelect();
  } else {
    enterSelect();
  }
};

const toggleChecked = (id: number): void => {
  const at = checked.value.indexOf(id);
  if (at >= 0) {
    checked.value.splice(at, 1);
  } else {
    checked.value.push(id);
  }
};

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
  // 多选态：点行=反选，不进会话（checkbox 本身就是这行的行首元素）
  if (selecting.value) {
    toggleChecked(item.id);
    return;
  }
  if (!item.id || item.id === store.currentId) {
    return;
  }
  store.loadMessages(item.id);
  // 移动抽屉里点选后收起，回到消息区
  if (props.mobile) {
    emit("close");
  }
};

/** 「新建」按钮（T13 懒创建语义）：只进草稿态，不落库、没有可失败的请求 */
const toCreate = () => {
  store.startDraft();
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
        // 多选态下顺手把同一 id 从勾选集拿掉，避免清理计数虚大
        checked.value = checked.value.filter((c) => c !== item.id);
        Alert.success("删除成功");
      } catch {
        // toast 已提示
      }
    },
  });
};

/** 批量清理（T12）：文案带 n 与一并清理警示 → 走批量端点 → 退多选态 */
const toBatchClean = () => {
  const ids = [...checked.value];
  if (ids.length === 0) {
    return;
  }
  Confirm.open({
    title: "批量清理确认",
    content: `确定清理所选的 ${ids.length} 个会话吗？各会话内的消息与小票一并清理。`,
    confirmText: "清理",
    cancelText: "取消",
    confirm: async () => {
      try {
        const n = await store.batchDeleteSessions(ids);
        Alert.success(`已清理 ${n} 个会话`);
        exitSelect();
      } catch {
        // toast 已提示；留在多选态便于重试
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
        <!-- 多选 toggle（T12）：多选态高亮，再点退出（底部「取消」同效） -->
        <button
          aria-label="多选"
          :title="selecting ? '退出多选' : '多选'"
          @click="toggleSelect"
          :class="[
            'p-2 rounded-lg border transition-colors',
            selecting
              ? 'bg-brand-600 border-brand-600 text-white dark:text-ink-primary hover:bg-brand-700'
              : 'text-ink-secondary dark:text-ink-onDark hover:bg-surface-soft dark:hover:bg-surface-dark border-frame dark:border-frame-dark',
          ]"
        >
          <CheckCircleIcon class="h-5 w-5" />
        </button>
        <button
          v-if="!selecting"
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
        还没有会话，直接说一句话或点「新建会话」开始记账
      </div>

      <!-- 会话项 -->
      <ul v-else class="space-y-1">
        <li
          v-for="item in store.sessions"
          :key="item.id"
          role="button"
          tabindex="0"
          :aria-checked="selecting ? checked.includes(item.id) : undefined"
          @click="select(item)"
          @keydown.enter="select(item)"
          :class="[
            'group flex items-center justify-between gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-200 outline-none border',
            selecting && checked.includes(item.id)
              ? 'bg-brand-100 dark:bg-brand-900 text-brand-700 dark:text-brand-300 border-brand-300 dark:border-brand-700'
              : item.id === store.currentId
                ? 'bg-surface-soft dark:bg-surface-dark text-brand-700 dark:text-brand-300 border-frame dark:border-frame-dark'
                : 'text-ink-secondary dark:text-ink-onDark border-transparent hover:bg-surface-soft dark:hover:bg-surface-darkMuted',
          ]"
        >
          <!-- 多选态行首勾选框：自绘 span（不引组件库）；点行反选见 select -->
          <span
            v-if="selecting"
            aria-hidden="true"
            class="flex-shrink-0 flex h-4 w-4 items-center justify-center rounded border transition-colors"
            :class="
              checked.includes(item.id)
                ? 'bg-brand-600 border-brand-600'
                : 'bg-surface dark:bg-surface-darkMuted border-ink-muted dark:border-ink-onDark/50'
            "
          >
            <CheckIcon v-if="checked.includes(item.id)" class="h-3 w-3 text-white" />
          </span>
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

    <!-- 多选操作栏（T12）：批量清理 / 取消 -->
    <div
      v-if="selecting"
      class="flex items-center gap-2 px-3 py-2.5 border-t border-frame-light dark:border-frame-dark flex-shrink-0"
    >
      <button
        aria-label="清理所选会话"
        :disabled="checkedCount === 0"
        class="flex-1 px-3 py-1.5 bg-state-danger text-white rounded-md text-xs font-medium transition-colors hover:bg-state-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
        @click="toBatchClean"
      >
        清理所选 ({{ checkedCount }})
      </button>
      <button
        aria-label="退出多选"
        class="px-3 py-1.5 rounded-md text-xs font-medium text-ink-secondary dark:text-ink-onDark border border-frame dark:border-frame-dark hover:bg-surface-soft dark:hover:bg-surface-dark transition-colors"
        @click="exitSelect"
      >
        取消
      </button>
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
