<template>
  <div>
    <!-- 桌面端统计信息：标签和金额并排一行，整块压扁，减少垂直占用 -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-1 md:gap-4">
      <div
        class="bg-brand-50 dark:bg-brand-900/20 rounded-lg p-1.5 md:px-3 md:py-1.5 border border-frame-light dark:border-frame-dark"
      >
        <div class="flex items-center justify-between gap-2">
          <p
            class="text-xs md:text-sm font-base text-brand-700 dark:text-brand-300 shrink-0"
          >
            总收入
          </p>
          <div class="flex items-center gap-1.5 min-w-0">
            <p
              class="text-xs md:text-base font-medium text-brand-600 dark:text-brand-300 whitespace-nowrap"
            >
              {{ Number(statistics?.totalIn || 0).toFixed(2) }}
            </p>
            <PlusIcon class="w-4 h-4 md:w-5 md:h-5 shrink-0 text-green-500" />
          </div>
        </div>
      </div>

      <div
        class="bg-red-50 dark:bg-red-900/20 rounded-lg p-1.5 md:px-3 md:py-1.5 border border-red-200 dark:border-red-800"
      >
        <div class="flex items-center justify-between gap-2">
          <p
            class="text-xs md:text-sm font-base text-state-danger dark:text-state-danger shrink-0"
          >
            总支出
          </p>
          <div class="flex items-center gap-1.5 min-w-0">
            <p
              class="text-xs md:text-base font-medium text-state-danger dark:text-state-danger whitespace-nowrap"
            >
              {{ Number(statistics?.totalOut || 0).toFixed(2) }}
            </p>
            <MinusIcon class="w-4 h-4 md:w-5 md:h-5 shrink-0 text-red-500" />
          </div>
        </div>
      </div>

      <div
        class="bg-brand-50 dark:bg-brand-900/20 rounded-lg p-1.5 md:px-3 md:py-1.5 border border-frame-light dark:border-frame-dark"
      >
        <div class="flex items-center justify-between gap-2">
          <p
            class="text-xs md:text-sm font-base text-brand-700 dark:text-brand-300 shrink-0"
          >
            净收入
          </p>
          <div class="flex items-center gap-1.5 min-w-0">
            <p
              class="text-xs md:text-base font-medium text-brand-600 dark:text-brand-300 whitespace-nowrap"
            >
              {{
                Number(
                  (statistics?.totalIn || 0) - (statistics?.totalOut || 0)
                ).toFixed(2)
              }}
            </p>
            <ScaleIcon class="w-4 h-4 md:w-5 md:h-5 shrink-0 text-blue-500" />
          </div>
        </div>
      </div>

      <div
        class="bg-surface-soft dark:bg-surface-darkMuted rounded-lg p-1.5 md:px-3 md:py-1.5 border border-frame-light dark:border-frame-dark"
      >
        <div class="flex items-center justify-between gap-2">
          <p
            class="text-xs md:text-sm font-base text-ink-secondary dark:text-ink-onDark shrink-0"
          >
            不计收支
          </p>
          <div class="flex items-center gap-1.5 min-w-0">
            <p
              class="text-xs md:text-base font-medium text-ink-secondary dark:text-ink-onDark whitespace-nowrap"
            >
              {{ Number(statistics?.notInOut || 0).toFixed(2) }}
            </p>
            <MinusCircleIcon class="w-4 h-4 md:w-5 md:h-5 shrink-0 text-gray-500" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  PlusIcon,
  MinusIcon,
  ScaleIcon,
  MinusCircleIcon,
} from "@heroicons/vue/24/outline";

interface Statistics {
  totalIn?: number;
  totalOut?: number;
  notInOut?: number;
}

interface Props {
  statistics?: Statistics;
}

defineProps<Props>();
</script>
