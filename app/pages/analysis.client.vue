<template>
  <div class="w-full">
    <div class="xl:max-w-[80vw] mx-auto w-full mt-2" v-if="!loading">
      <!-- 时间总控栏：全页唯一的时间来源 -->
      <div
        class="w-full bg-surface dark:bg-surface-dark rounded-lg shadow border border-frame dark:border-frame-dark px-3 md:px-4 py-3 mb-4 sticky top-0 z-20"
      >
        <div
          class="flex flex-col md:flex-row md:items-center justify-between gap-2 md:gap-4"
        >
          <div class="flex items-baseline gap-2 shrink-0">
            <h3
              class="text-base md:text-lg font-semibold text-ink-primary dark:text-ink-onDark"
            >
              数据分析
            </h3>
            <span class="text-xs md:text-sm text-ink-muted">
              {{ rangeLabel }}
            </span>
          </div>
          <div class="min-w-0">
            <UiTimeRangePicker
              :startDay="startDay"
              :endDay="endDay"
              @update:startDay="startDay = $event"
              @update:endDay="endDay = $event"
            />
          </div>
        </div>
      </div>

      <!-- 流水概览：每日曲线 + 每月统计 -->
      <div
        class="w-full bg-surface dark:bg-surface-dark rounded-lg shadow border border-frame dark:border-frame-dark p-3 md:p-4 mb-4"
      >
        <div
          class="w-full flex flex-col md:flex-row md:space-x-6 space-y-5 md:space-y-0"
        >
          <div class="w-full md:w-1/2 md:pr-6 md:border-r md:border-frame dark:md:border-frame-dark">
            <DailyLineChart
              title="每日流水"
              width="100%"
              height="300px"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
          <div class="w-full md:w-1/2">
            <MonthBar
              title="每月流水"
              width="100%"
              height="300px"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
        </div>
      </div>

      <!-- 支出分析 -->
      <div
        class="w-full bg-surface dark:bg-surface-dark rounded-lg shadow border border-frame dark:border-frame-dark p-3 md:p-4 mb-4"
      >
        <h3
          class="text-base md:text-lg font-semibold text-ink-primary dark:text-ink-onDark mb-4"
        >
          支出分析
        </h3>

        <div
          class="w-full flex flex-col md:flex-row md:space-x-4 space-y-4 md:space-y-0"
        >
          <div class="w-full md:border-r md:border-frame dark:md:border-frame-dark md:pr-4">
            <ChartsCommonBar
              title="支付方式"
              width="100%"
              height="300px"
              groupBy="payType"
              flowType="支出"
              seriesName="支付方式"
              queryField="payType"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
          <div class="w-full md:border-r md:border-frame dark:md:border-frame-dark md:pr-4">
            <ChartsCommonBar
              title="消费类型"
              width="100%"
              height="300px"
              groupBy="industryType"
              flowType="支出"
              seriesName="消费类型"
              queryField="industryType"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
          <div class="w-full">
            <ChartsCommonBar
              title="消费归属"
              width="100%"
              height="300px"
              groupBy="attribution"
              flowType="支出"
              seriesName="消费归属"
              queryField="attribution"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
        </div>
      </div>

      <!-- 收入分析 -->
      <div
        class="w-full bg-surface dark:bg-surface-dark rounded-lg shadow border border-frame dark:border-frame-dark p-3 md:p-4 mb-4"
      >
        <h3
          class="text-base md:text-lg font-semibold text-ink-primary dark:text-ink-onDark mb-4"
        >
          收入分析
        </h3>

        <div
          class="w-full flex flex-col md:flex-row md:space-x-4 space-y-4 md:space-y-0"
        >
          <div class="w-full md:border-r md:border-frame dark:md:border-frame-dark md:pr-4">
            <ChartsCommonBar
              title="收款方式"
              width="100%"
              height="300px"
              groupBy="payType"
              flowType="收入"
              seriesName="收款方式"
              queryField="payType"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
          <div class="w-full md:border-r md:border-frame dark:md:border-frame-dark md:pr-4">
            <ChartsCommonBar
              title="收入类型"
              width="100%"
              height="300px"
              groupBy="industryType"
              flowType="收入"
              seriesName="收入类型"
              queryField="industryType"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
          <div class="w-full">
            <ChartsCommonBar
              title="收入归属"
              width="100%"
              height="300px"
              groupBy="attribution"
              flowType="收入"
              seriesName="收入归属"
              queryField="attribution"
              :startDay="startDay || undefined"
              :endDay="endDay || undefined"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
definePageMeta({
  layout: "public",
  middleware: ["auth"],
});

import { ref, computed, onMounted, nextTick } from "vue";
import { dateFormater } from "@/utils/common";
import DailyLineChart from "~/components/charts/DailyLineChart.vue";
import MonthBar from "~/components/charts/MonthBar.vue";

// 全页统一的时间范围（总控栏控制，所有图表共用）
const defaultRange = (() => {
  const now = new Date();
  return {
    startDay: dateFormater(
      "YYYY-MM-dd",
      new Date(now.getFullYear(), now.getMonth(), 1)
    ),
    endDay: dateFormater("YYYY-MM-dd", now),
  };
})();

const startDay = ref<string | null>(defaultRange.startDay);
const endDay = ref<string | null>(defaultRange.endDay);

// 时间范围摘要
const rangeLabel = computed(() => {
  if (!startDay.value && !endDay.value) return "全部时间";
  if (startDay.value && endDay.value) {
    return `${startDay.value} 至 ${endDay.value}`;
  }
  return startDay.value
    ? `${startDay.value} 起`
    : `截至 ${endDay.value}`;
});

const loading = ref(true);
onMounted(async () => {
  // 等待DOM完全渲染
  await nextTick();
  loading.value = false;
});
</script>
