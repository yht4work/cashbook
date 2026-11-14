<template>
  <!-- 小票全屏预览蒙层：图片 <img>，PDF 内嵌浏览器原生查看器 -->
  <div v-if="open" class="overlay">
    <div class="flex justify-center items-center w-full h-full">
      <img
        v-if="!isPdf"
        :src="url"
        class="max-h-[95vh] max-w-[95vw] object-contains"
        alt="小票预览"
      />
      <iframe
        v-else
        :src="url"
        class="w-[92vw] max-w-[900px] h-[92vh] rounded-lg bg-white"
        title="小票预览"
      />
    </div>
    <!-- PDF 兜底：部分移动端浏览器不渲染内嵌 PDF，仍可交给新标签页 -->
    <a
      v-if="isPdf"
      :href="url"
      target="_blank"
      rel="noopener"
      class="fallback-button"
    >
      在新标签页打开 ↗
    </a>
    <span
      class="close-button bg-gray-500 hover:bg-gray-400"
      @click="emit('close')"
      >&times;</span
    >
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from "vue";
import { isPdfInvoice } from "~/utils/invoice";

const props = defineProps<{
  open: boolean;
  url: string;
  fileName?: string;
}>();
const emit = defineEmits(["close"]);

const isPdf = computed(() => !!props.fileName && isPdfInvoice(props.fileName));

// Esc 关闭（组件自管监听，父组件无需再绑 window）
const onKeydown = (event: KeyboardEvent) => {
  if (event.key === "Escape" && props.open) emit("close");
};
watch(
  () => props.open,
  (v) => {
    if (v) window.addEventListener("keydown", onKeydown);
    else window.removeEventListener("keydown", onKeydown);
  },
  { immediate: true }
);
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<style scoped>
.overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.9);
  /* 高于删除确认对话框（10000），从对话框里预览 PDF 时不会被压住 */
  z-index: 11000;
  display: flex;
  justify-content: center;
  align-items: center;
}

.close-button {
  position: absolute;
  top: 20px;
  right: 30px;
  color: white;
  font-size: 30px;
  font-weight: bold;
  cursor: pointer;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 0.3s;
}

.fallback-button {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  border-radius: 9999px;
  background-color: rgba(255, 255, 255, 0.9);
  color: #1f2937;
  font-size: 14px;
  cursor: pointer;
  box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.3);
  transition: background-color 0.3s;
}

.fallback-button:hover {
  background-color: white;
}
</style>
