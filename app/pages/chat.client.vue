<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import {
  ChatBubbleLeftRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@heroicons/vue/24/outline";
import ChatSessionsPanel from "~/components/chat/ChatSessionsPanel.vue";
import ChatMsgList from "~/components/chat/ChatMsgList.vue";
import ChatComposer from "~/components/chat/ChatComposer.vue";
import { useChatStore } from "~/utils/chatStore";

/**
 * AI 记账页（Task 7 壳 + Task 8 消息流/输入区）：桌面双栏（左会话栏可收起 +
 * 右消息区），移动会话栏为抽屉。消息区 = ChatMsgList（滚动流）+ ChatComposer
 * （输入区）+ 空态引导；卡片（ChatDraftCard）由 Task 9 挂进 ChatMsgItem。
 * 注：layout 的 main 为 relative 且 slotted 包裹层无固定高，页面根用
 * absolute inset-0 撑满（h-full 链在自动高度父级上会断）。
 */
definePageMeta({
  layout: "public",
  middleware: ["auth"],
});

const store = useChatStore();

// 响应式：与 layouts/public.vue 同断点（<1024 视为移动，走抽屉）
const isMobile = ref(false);
const sessionDrawer = ref(false); // 移动端会话抽屉
const sessionsCollapsed = ref(false); // 桌面端收起左栏

const updateResponsive = () => {
  if (typeof window === "undefined") {
    return;
  }
  isMobile.value = window.innerWidth < 1024;
  if (!isMobile.value) {
    sessionDrawer.value = false; // 回桌面不残留抽屉态
  }
};

onMounted(() => {
  updateResponsive();
  window.addEventListener("resize", updateResponsive);
});

onUnmounted(() => {
  if (typeof window !== "undefined") {
    window.removeEventListener("resize", updateResponsive);
  }
});

const closeSessionsPanel = () => {
  sessionDrawer.value = false;
};

const toCreate = async () => {
  try {
    await store.createSession();
  } catch {
    // toast 已提示（多为 未登录/网络 错误）
  }
  if (isMobile.value) {
    sessionDrawer.value = false; // 新建后回消息区
  }
};

const titleOf = (): string => {
  if (store.currentId) {
    return store.currentSession?.title || "未命名会话";
  }
  return "AI 记账";
};
</script>

<template>
  <div
    class="absolute inset-0 flex overflow-hidden bg-surface-muted pb-4 lg:pb-0 dark:bg-surface-dark"
  >
    <!-- 桌面：左会话栏（可收起） -->
    <div
      v-if="!isMobile"
      :class="[
        'h-full flex-shrink-0 border-r border-frame dark:border-frame-dark overflow-hidden transition-all duration-200',
        sessionsCollapsed ? 'w-0 border-r-0' : 'w-64 lg:w-72',
      ]"
    >
      <div class="w-64 lg:w-72 h-full">
        <ChatSessionsPanel />
      </div>
    </div>

    <!-- 移动：会话抽屉（仿 AppSidebar 的 backdrop + translate 滑入） -->
    <div v-if="isMobile">
      <div
        v-if="sessionDrawer"
        class="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
        @click="closeSessionsPanel"
      ></div>
      <aside
        :class="[
          'fixed inset-y-0 left-0 z-50 w-72 max-w-[85vw] border-r border-frame dark:border-frame-dark transform transition-transform duration-200 ease-in-out',
          sessionDrawer ? 'translate-x-0' : '-translate-x-full',
        ]"
      >
        <ChatSessionsPanel :mobile="true" @close="closeSessionsPanel" />
      </aside>
    </div>

    <!-- 右列：顶栏 + 消息区 -->
    <section class="flex-1 min-w-0 h-full flex flex-col">
      <!-- 顶栏：会话标题 + 新建会话 -->
      <div
        class="flex items-center justify-between gap-2 px-3 md:px-4 h-12 md:h-14 flex-shrink-0 border-b border-frame dark:border-frame-dark bg-surface dark:bg-surface-dark"
      >
        <div class="flex items-center gap-1 min-w-0">
          <button
            v-if="isMobile"
            aria-label="打开会话栏"
            title="会话列表"
            class="p-2 rounded-lg text-ink-secondary dark:text-ink-onDark hover:bg-surface-soft dark:hover:bg-surface-darkMuted transition-colors"
            @click="sessionDrawer = true"
          >
            <ChatBubbleLeftRightIcon class="h-5 w-5" />
          </button>
          <button
            v-else
            :aria-label="sessionsCollapsed ? '展开会话栏' : '收起会话栏'"
            :title="sessionsCollapsed ? '展开会话栏' : '收起会话栏'"
            class="p-2 rounded-lg text-ink-secondary dark:text-ink-onDark hover:bg-surface-soft dark:hover:bg-surface-darkMuted transition-colors"
            @click="sessionsCollapsed = !sessionsCollapsed"
          >
            <ChevronLeftIcon v-if="!sessionsCollapsed" class="h-5 w-5" />
            <ChevronRightIcon v-else class="h-5 w-5" />
          </button>
          <h1
            class="truncate text-sm md:text-base font-semibold text-ink-primary dark:text-ink-onDark min-w-0"
          >
            {{ titleOf() }}
          </h1>
          <span
            v-if="store.streaming"
            class="ml-1 flex-shrink-0 text-xs text-brand-600 dark:text-brand-300"
          >
            生成中…
          </span>
        </div>
        <button
          class="flex-shrink-0 px-3 py-1.5 md:px-4 md:py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-md text-xs md:text-sm font-medium transition-colors"
          @click="toCreate"
        >
          新建会话
        </button>
      </div>

      <!-- 消息区：消息流（Task 8）+ 输入区（Task 8）+ 空态引导；卡片 Task 9 挂进 ChatMsgItem -->
      <section id="chat-msg-area" class="flex flex-1 min-h-0 flex-col overflow-hidden">
        <!-- 空态引导（未选会话 / 空会话仍显示） -->
        <div
          v-if="!store.currentId || store.currentMessages.length === 0"
          class="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-10 text-center"
        >
          <div
            class="w-16 h-16 rounded-full bg-brand-100 dark:bg-brand-900 flex items-center justify-center mb-4"
          >
            <ChatBubbleLeftRightIcon class="h-8 w-8 text-brand-500" />
          </div>
          <p class="text-ink-primary dark:text-ink-onDark font-medium mb-2">
            {{ store.currentId ? "发一句话试试" : "先新建一个会话" }}
          </p>
          <p
            class="text-sm text-ink-muted dark:text-ink-onDark/70 max-w-md leading-relaxed"
          >
            拍张小票扔进来，或直接说：昨天午饭 35
          </p>
          <button
            v-if="!store.currentId"
            class="mt-6 px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-md text-sm font-medium transition-colors"
            @click="toCreate"
          >
            新建会话
          </button>
        </div>
        <!-- 消息流（滚动 + 自动跟随，见组件注释） -->
        <ChatMsgList v-else />
        <!-- 输入区（Enter 发送 / 选图预览 / streaming 锁定） -->
        <ChatComposer />
      </section>
    </section>
  </div>
</template>
