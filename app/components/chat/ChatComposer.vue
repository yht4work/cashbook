<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { PaperAirplaneIcon, PhotoIcon, XMarkIcon } from "@heroicons/vue/24/outline";
import { useChatStore } from "~/utils/chatStore";
import { Alert } from "~/utils/alert";

/**
 * 输入区（Task 8）：textarea（Enter 发送 / Shift+Enter 换行，IME 组合输入时
 * Enter 不发送——桌面键盘习惯为准）+ 小票选图（可预览待发、可移除，blob
 * 预览 URL 在移除/发送后 revoke）+ 发送按钮。生成中（store.streaming）整体
 * 禁用；发送行为全部走 store.send（锁输入 / 校验 / 失败后重发都在 store）。
 */
const store = useChatStore();

const text = ref("");
const taEl = ref<HTMLTextAreaElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const composing = ref(false); // IME 组合输入中（Enter 用于选词，不发送）

interface PendingPreview {
  file: File;
  url: string; // 待发预览 blob URL
}
const pendings = ref<PendingPreview[]>([]);

/**
 * 是否可发送：非流式 + 文本/图片至少有一。T13 懒创建后草稿态（currentId=null）
 * 也能发——send 会先建档；不再以「有没有会话」为前置。
 */
const canSend = computed(
  () =>
    !store.streaming &&
    (text.value.trim().length > 0 || pendings.value.length > 0)
);

const placeholder = computed<string>(() => {
  if (store.streaming) {
    return "生成中…";
  }
  // 草稿态与正常态同一占位（懒创建后草稿态可以直接开口，不再提示「先新建会话」）
  return "拍张小票，或说：昨天午饭 35";
});

/**
 * 发送（终审 M8）：await store.send——通过预检（请求已发出）才清空输入，
 * 被拦下（无账本/无会话/空消息/锁输入）时输入原样保留，不打一次字就蒸发。
 * 生成期间输入处于禁用态，文案等本轮结束后再清，失败草稿不丢。
 */
const toSend = async (): Promise<void> => {
  if (!canSend.value) {
    return;
  }
  const files = pendings.value.map((p) => p.file);
  const t = text.value;
  const accepted = await store.send(t, files);
  if (accepted) {
    text.value = "";
    clearPendings();
  }
};

const clearPendings = (): void => {
  for (const p of pendings.value) {
    try {
      URL.revokeObjectURL(p.url);
    } catch {
      // 已失效，忽略
    }
  }
  pendings.value = [];
};

/** 图片判定：image/* MIME，或常见小票图片扩展名兜底（部分设备不给 MIME） */
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
const isImageFile = (f: File): boolean =>
  String(f.type || "").startsWith("image/") || IMG_EXT_RE.test(String(f.name || ""));

const addFiles = (fl: FileList | null): void => {
  const list = Array.from(fl ?? []).filter(isImageFile);
  const dropped = (fl ? fl.length : 0) - list.length;
  if (dropped > 0) {
    // 非图片（不满足 accept 意图）整批复核后丢弃，一次提示不刷屏
    Alert.warning(`已忽略 ${dropped} 个非图片文件`);
  }
  for (const f of list) {
    pendings.value.push({ file: f, url: URL.createObjectURL(f) });
  }
  if (fileInput.value) {
    fileInput.value.value = ""; // 允许再次选择同名文件
  }
};

const removePending = (index: number): void => {
  const p = pendings.value[index];
  if (!p) {
    return;
  }
  try {
    URL.revokeObjectURL(p.url);
  } catch {
    // 已失效，忽略
  }
  pendings.value = pendings.value.filter((_, i) => i !== index);
};

/** Enter 发送 / Shift+Enter 换行；IME 组合中的 Enter（ keyCode 229 ）不拦截 */
const onKeydown = (e: KeyboardEvent): void => {
  if (e.key !== "Enter") {
    return;
  }
  if (composing.value || e.isComposing || e.keyCode === 229) {
    return;
  }
  if (e.shiftKey) {
    return; // 换行
  }
  e.preventDefault();
  toSend();
};

/** 多行时 textarea 自增高（上限 168px），空/单行回弹 */
const grow = (): void => {
  const el = taEl.value;
  if (!el) {
    return;
  }
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 168) + "px";
};

watch(text, () => {
  void nextTick(grow);
});
</script>

<template>
  <div
    class="flex-shrink-0 border-t border-frame bg-surface px-3 pb-2 pt-2 md:px-4 md:pb-3 md:pt-3 dark:border-frame-dark dark:bg-surface-dark"
  >
    <!-- 待发图预览（可移除；blob 预览 URL 移除/发送后 revoke） -->
    <div v-if="pendings.length" class="mb-2 flex flex-wrap gap-2 px-1">
      <div
        v-for="(p, i) in pendings"
        :key="p.url"
        class="group/pending relative h-14 w-14 md:h-16 md:w-16"
      >
        <img
          :src="p.url"
          alt="待发小票预览"
          class="h-full w-full rounded-lg border border-frame object-cover dark:border-frame-dark"
        />
        <button
          type="button"
          aria-label="移除待发图片"
          title="移除"
          class="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink-secondary text-white shadow transition-colors hover:bg-state-danger dark:bg-ink-onDark dark:text-ink-primary dark:hover:bg-state-danger"
          :disabled="store.streaming"
          @click="removePending(i)"
        >
          <XMarkIcon class="h-3 w-3" />
        </button>
      </div>
    </div>

    <!-- 输入行 -->
    <div class="flex items-end gap-2">
      <button
        type="button"
        aria-label="选择小票图片"
        title="选择小票图片（可多选）"
        class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40 dark:text-ink-onDark dark:hover:bg-surface-darkMuted"
        :disabled="store.streaming"
        @click="fileInput?.click()"
      >
        <PhotoIcon class="h-6 w-6" />
      </button>
      <!-- 注意：file input 必须在按钮外（同级）——放进按钮内时 input 的合成
           click 会冒泡回按钮再触发一次点击处理器（重复弹 picker 的再入隐患） -->
      <input
        ref="fileInput"
        type="file"
        accept="image/*"
        multiple
        class="hidden"
        aria-hidden="true"
        tabindex="-1"
        @change="addFiles($event.target.files)"
      />

      <textarea
        ref="taEl"
        v-model="text"
        rows="1"
        class="max-h-[168px] min-h-[40px] w-full flex-1 resize-none rounded-2xl border border-frame bg-surface-soft px-3.5 py-2 text-sm leading-relaxed text-ink-primary outline-none transition-colors placeholder:text-ink-muted focus:border-brand-500 disabled:cursor-not-allowed disabled:opacity-60 dark:border-frame-dark dark:bg-surface-darkMuted dark:text-ink-onDark dark:placeholder:text-ink-onDark/50 dark:focus:border-brand-400 md:py-2.5"
        :placeholder="placeholder"
        :disabled="store.streaming"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      ></textarea>

      <button
        type="button"
        aria-label="发送消息"
        title="发送"
        class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand-600 text-white shadow-sm transition-colors hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-surface-soft disabled:text-ink-muted dark:disabled:bg-surface-darkMuted dark:disabled:text-ink-onDark/40"
        :disabled="!canSend"
        @click="toSend"
      >
        <PaperAirplaneIcon class="h-5 w-5" />
      </button>
    </div>
  </div>
</template>
