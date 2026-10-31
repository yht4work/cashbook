<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

/**
 * chat 大图预览蒙版（V1.2 反馈：缩略图点击不再用 blob: 新开标签页——show
 * 接口要裸 Authorization 头，外链带不上，此前只能给出 blob URL，拷出去就
 * 成了死链。改为页内全屏浏览，与 FlowsTable 的全屏小票同款交互：黑蒙版 +
 * 大图 + × 关闭 + Esc 关闭 + 点蒙版空白处关闭）。
 * 显式 import（Nuxt dev 自动导入不收编新组件）——父组件一律写全。
 */
interface Props {
  src: string; // 大图地址（就绪的 blob URL / pending 本地预览 URL）
  open: boolean;
}
const props = withDefaults(defineProps<Props>(), { open: false });
const emit = defineEmits<{ close: [] }>();

const onKey = (e: KeyboardEvent): void => {
  if (e.key === "Escape" && props.open) {
    emit("close");
  }
};
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div
    v-if="open && src"
    data-chat-image-viewer="true"
    class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/90"
    @click.self="emit('close')"
  >
    <img :src="src" alt="小票大图" class="max-h-[95vh] max-w-[95vw] object-contain" />
    <button
      type="button"
      data-chat-image-viewer-close
      aria-label="关闭大图"
      class="absolute right-4 top-5 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-3xl font-bold leading-none text-white transition-colors hover:bg-white/30"
      @click="emit('close')"
    >
      ×
    </button>
  </div>
</template>