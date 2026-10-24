<template>
  <!-- 跨年月选择：Teleport 到 body，避免被父容器的 overflow-hidden 裁剪 -->
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-40" @click="close">
      <div
        class="w-72 bg-surface dark:bg-surface-darkMuted border border-frame dark:border-frame-dark rounded-xl shadow-xl p-3"
        style="position: fixed"
        :style="pickerStyle"
        @click.stop
      >
        <!-- 年份行：悬停在年份上滚动滚轮，像左轮手枪一样逐格换年 -->
        <div class="flex items-center justify-between mb-2">
          <button
            type="button"
            @click="spinYear(-1)"
            aria-label="上一年"
            class="w-7 h-7 rounded-md flex items-center justify-center text-ink-secondary dark:text-ink-onDark hover:bg-surface-muted dark:hover:bg-surface-darkMuted focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <ChevronLeftIcon class="w-4 h-4" />
          </button>
          <span
            class="text-sm font-semibold text-ink-primary dark:text-ink-onDark tabular-nums cursor-ns-resize select-none py-1 px-3"
            :title="'悬停滚动滚轮切换年份'"
            @wheel="onYearWheel"
          >
            <!-- key 换年时重建，触发滚动动画 -->
            <span
              :key="pickerYear"
              class="inline-block"
              :class="wheelDir >= 0 ? 'year-spin-up' : 'year-spin-down'"
            >
              {{ pickerYear }} 年
            </span>
          </span>
          <button
            type="button"
            @click="spinYear(1)"
            aria-label="下一年"
            class="w-7 h-7 rounded-md flex items-center justify-center text-ink-secondary dark:text-ink-onDark hover:bg-surface-muted dark:hover:bg-surface-darkMuted focus-visible:outline-2 focus-visible:outline-brand-500"
          >
            <ChevronRightIcon class="w-4 h-4" />
          </button>
        </div>

        <!-- 12 个月份：每块直接印上这个月的收支 -->
        <div class="grid grid-cols-4 gap-1.5">
          <button
            v-for="m in 12"
            :key="m"
            type="button"
            @click="selectMonth(m)"
            class="rounded-lg px-1 py-2 text-center border transition-colors focus-visible:outline-2 focus-visible:outline-brand-500"
            :class="
              isViewed(m)
                ? 'border-brand-500 dark:border-brand-300 bg-brand-50 dark:bg-brand-900/50'
                : 'border-frame-light dark:border-frame-dark hover:border-brand-500/60 dark:hover:border-brand-300/60 hover:bg-brand-50/60 dark:hover:bg-brand-900/30'
            "
          >
            <div
              class="text-xs font-semibold"
              :class="
                isViewed(m)
                  ? 'text-brand-500 dark:text-brand-300'
                  : 'text-ink-primary dark:text-ink-onDark'
              "
            >
              {{ m }}月
            </div>
            <div v-if="outSum(m) || inSum(m)" class="mt-1 space-y-px tabular-nums">
              <div
                v-if="outSum(m)"
                class="text-[10px] leading-tight text-state-danger font-medium"
              >
                ↑{{ short(outSum(m)) }}
              </div>
              <div
                v-if="inSum(m)"
                class="text-[10px] leading-tight text-brand-600 dark:text-brand-400 font-medium"
              >
                ↓{{ short(inSum(m)) }}
              </div>
            </div>
            <div v-else class="mt-1 text-[10px] text-ink-muted/50">—</div>
          </button>
        </div>

        <!-- 回到本月 -->
        <div class="mt-2 pt-2 border-t border-frame-light dark:border-frame-dark text-center">
          <button
            type="button"
            @click="backToToday"
            :disabled="viewingToday"
            class="text-xs font-medium px-3 py-1.5 rounded-md text-brand-600 dark:text-brand-300 hover:bg-brand-50 dark:hover:bg-brand-900/40 disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-brand-500 transition-colors"
          >
            回到本月
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/vue/24/outline";

interface Props {
  // 由父组件控制显隐
  open: boolean;
  // 锚点元素（标题按钮），弹层定位在它正下方
  anchor: HTMLElement | null;
  currentDate: Date;
  expenseMonths: Record<string, number>;
  incomeMonths: Record<string, number>;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [date: Date];
  close: [];
}>();

const pickerYear = ref(new Date(props.currentDate).getFullYear());
const pickerStyle = ref({});
let escHandler: ((e: KeyboardEvent) => void) | null = null;
let resizeHandler: (() => void) | null = null;

// 与页面的 dayToMonth 保持同一 key 格式（"YYYY 年 M 月"，月份不补零）
const monthKey = (year: number, month: number) => `${year} 年 ${month} 月`;

const isViewed = (m: number) =>
  pickerYear.value === props.currentDate.getFullYear() &&
  m === props.currentDate.getMonth() + 1;

const viewingToday = computed(() => {
  const now = new Date();
  return (
    props.currentDate.getFullYear() === now.getFullYear() &&
    props.currentDate.getMonth() === now.getMonth()
  );
});

const outSum = (m: number) => Number(props.expenseMonths[monthKey(pickerYear.value, m)] || 0);
const inSum = (m: number) => Number(props.incomeMonths[monthKey(pickerYear.value, m)] || 0);

/** 月份块空间有限，金额过万折成「万」 */
const short = (v: number) => {
  const n = Number(v) || 0;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.round(n)}`;
};

const close = () => emit("close");

// 滚轮切年：像左轮手枪一样逐格滚动，每次滚动触发一个小的翻转动画
const wheelDir = ref(1);
let lastWheelAt = 0;
const spinYear = (delta: number) => {
  if (!delta) return;
  wheelDir.value = delta;
  pickerYear.value += delta;
};
const onYearWheel = (e: WheelEvent) => {
  e.preventDefault();
  // 触控板惯性滚动是一长串小 tick，限频避免一年直接划过十几年
  const now = Date.now();
  if (now - lastWheelAt < 110) return;
  if (Math.abs(e.deltaY) < 2) return;
  lastWheelAt = now;
  spinYear(e.deltaY > 0 ? 1 : -1);
};

const selectMonth = (m: number) => {
  emit("select", new Date(pickerYear.value, m - 1, 1));
  close();
};

const backToToday = () => {
  const now = new Date();
  emit("select", new Date(now.getFullYear(), now.getMonth(), 1));
  close();
};

const updatePosition = () => {
  const el = props.anchor;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const cardW = 288;
  const left = Math.max(
    8,
    Math.min(r.left + r.width / 2 - cardW / 2, window.innerWidth - cardW - 8)
  );
  pickerStyle.value = { left: `${left}px`, top: `${r.bottom + 8}px` };
};

watch(
  () => props.open,
  (isOpen) => {
    const now = new Date();
    if (isOpen) {
      pickerYear.value = props.currentDate.getFullYear();
      updatePosition();
      escHandler = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
      };
      document.addEventListener("keydown", escHandler);
      // 窗口尺寸变化后锚点会移位，简单起见直接收起弹层
      resizeHandler = close;
      window.addEventListener("resize", resizeHandler);
    } else if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      window.removeEventListener("resize", resizeHandler!);
      escHandler = null;
      resizeHandler = null;
    }
  },
  { immediate: true }
);

// 弹层打开期间浏览月份变化（比如翻页后仍开着），年份行要跟上
watch(
  () => props.currentDate,
  (d) => {
    if (props.open) {
      pickerYear.value = d.getFullYear();
      updatePosition();
    }
  }
);

onBeforeUnmount(() => {
  if (escHandler) document.removeEventListener("keydown", escHandler);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
});
</script>

<style scoped>
.year-spin-up {
  animation: yearUp 0.18s ease-out;
}
.year-spin-down {
  animation: yearDown 0.18s ease-out;
}
@keyframes yearUp {
  from {
    transform: translateY(0.35em) scale(0.9);
    opacity: 0.3;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@keyframes yearDown {
  from {
    transform: translateY(-0.35em) scale(0.9);
    opacity: 0.3;
  }
  to {
    transform: none;
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .year-spin-up,
  .year-spin-down {
    animation: none;
  }
}
</style>