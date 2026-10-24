<template>
  <div class="w-full">
    <!-- Calendar Header：步进 | 标题(点开月份选择) | 当月分析 -->
    <div
      class="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 bg-gradient-to-r from-green-500 to-emerald-600 dark:from-green-950/80 dark:to-emerald-950/80 text-white"
    >
      <!-- Month Navigation -->
      <div class="flex items-center gap-1.5">
        <button
          @click="prevMonth"
          aria-label="上一个月"
          class="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors duration-200"
        >
          <ChevronLeftIcon class="w-5 h-5" />
        </button>
        <button
          @click="nextMonth"
          aria-label="下一个月"
          class="p-2 rounded-lg bg-white/10 hover:bg-white/20 transition-colors duration-200"
        >
          <ChevronRightIcon class="w-5 h-5" />
        </button>
      </div>

      <!-- Title：点它展开任意年月的选择器 -->
      <button
        ref="titleButton"
        @click="pickerOpen = !pickerOpen"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors duration-200"
        aria-haspopup="dialog"
        :aria-expanded="pickerOpen"
      >
        <h2 class="text-xl font-bold whitespace-nowrap tabular-nums">
          {{ currentMonthText }}
        </h2>
        <ChevronDownIcon
          class="w-4 h-4 shrink-0 transition-transform duration-200"
          :class="{ 'rotate-180': pickerOpen }"
        />
      </button>

      <!-- Analysis Button -->
      <button
        @click="showAnalysis"
        class="flex items-center gap-2 px-3 md:px-4 py-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors duration-200 font-medium"
      >
        <ChartBarIcon class="w-5 h-5" />
        当月分析
      </button>
    </div>

    <!-- 年月选择器（Teleport 到 body） -->
    <MonthPicker
      :open="pickerOpen"
      :anchor="titleButton"
      :current-date="currentDate"
      :expense-months="expenseMonths"
      :income-months="incomeMonths"
      @select="selectMonth"
      @close="pickerOpen = false"
    />

    <!-- Weekday Headers -->
    <div
      class="grid grid-cols-7 border-b border-frame dark:border-frame-dark"
    >
      <div
        v-for="day in weekdays"
        :key="day"
        class="py-3 text-center text-xs md:text-sm font-medium text-brand-600 dark:text-brand-300/60"
      >
        {{ day }}
      </div>
    </div>

    <!-- Calendar Grid：发丝线分隔，格子保持安静，金额本身做视觉重点 -->
    <div class="grid grid-cols-7 gap-px bg-frame-light dark:bg-emerald-950/60">
      <div
        v-for="date in calendarDates"
        :key="date.key"
        class="group min-h-32 md:min-h-36 p-2 md:p-3 flex flex-col relative bg-green-50/70 dark:bg-green-950/40 transition-colors duration-150 hover:bg-green-100 dark:hover:bg-green-900/40"
        :class="{
          'bg-surface-muted/60 dark:bg-white/[0.04] text-ink-muted': !date.isCurrentMonth,
          'ring-2 ring-inset ring-brand-500 dark:ring-brand-300':
            date.isToday,
        }"
      >
        <!-- Date and Add Button -->
        <div class="flex justify-between items-start mb-2">
          <span
            class="inline-flex items-center justify-center w-7 h-7 rounded-full text-sm tabular-nums"
            :class="{
              'bg-green-600 dark:bg-green-500 text-white font-semibold':
                date.isToday,
              'text-ink-primary dark:text-ink-onDark':
                date.isCurrentMonth && !date.isToday,
              'text-ink-muted/60 dark:text-ink-onDark/30':
                !date.isCurrentMonth,
            }"
          >
            {{ date.day }}
          </span>
          <button
            v-if="date.isCurrentMonth"
            @click="addFlow(date)"
            aria-label="记一笔"
            class="w-7 h-7 rounded-full flex items-center justify-center transition-all duration-150 text-green-700 dark:text-green-500 opacity-60 group-hover:opacity-100 group-hover:bg-green-100 dark:group-hover:bg-green-900/40 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-green-600"
          >
            <PlusIcon class="w-4 h-4" />
          </button>
        </div>

        <!-- Flow Data -->
        <div v-if="date.isCurrentMonth" class="flex flex-col gap-1.5 flex-1">
          <!-- Expense -->
          <button
            v-if="getDateExpense(date.dateString)"
            @click="clickDay(date.dateString, '支出')"
            class="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs md:text-sm font-semibold text-left tabular-nums cursor-pointer focus-visible:outline-2 focus-visible:outline-green-600 transition-colors duration-150"
            :class="getExpenseClass(getDateExpense(date.dateString))"
          >
            <ArrowUpIcon class="w-3.5 h-3.5 shrink-0 opacity-80" />
            <span class="truncate">{{
              getDateExpense(date.dateString).toFixed(2)
            }}</span>
          </button>
          <!-- Income -->
          <button
            v-if="getDateIncome(date.dateString)"
            @click="clickDay(date.dateString, '收入')"
            class="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs md:text-sm font-semibold text-left tabular-nums cursor-pointer focus-visible:outline-2 focus-visible:outline-green-600 transition-colors duration-150 bg-brand-100 dark:bg-brand-900/50 text-brand-700 dark:text-brand-300 hover:bg-brand-200 dark:hover:bg-brand-900"
          >
            <ArrowDownIcon class="w-3.5 h-3.5 shrink-0 opacity-80" />
            <span class="truncate">{{
              getDateIncome(date.dateString).toFixed(2)
            }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from "vue";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  PlusIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ChartBarIcon,
} from "@heroicons/vue/24/outline";

import MonthPicker from "~/components/ui/MonthPicker.vue";

interface CalendarDate {
  date: Date;
  dateString: string;
  day: number;
  isCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
  key: string;
}

interface Props {
  currentDate: Date;
  incomeData: Record<string, number>;
  expenseData: Record<string, number>;
  // 各月份汇总（key 与页面的 dayToMonth 一致："YYYY 年 M 月"），供年月选择器展示
  incomeMonths?: Record<string, number>;
  expenseMonths?: Record<string, number>;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  "add-flow": [date: CalendarDate];
  "click-day": [dateString: string, flowType: string];
  "month-change": [date: Date];
  "show-analysis": [month: string];
}>();

const currentDate = ref(new Date(props.currentDate));

const weekdays = ["日", "一", "二", "三", "四", "五", "六"];

const currentMonthText = computed(() => {
  const year = currentDate.value.getFullYear();
  const month = currentDate.value.getMonth() + 1;
  return `${year} 年 ${month} 月`;
});

const calendarDates = computed((): CalendarDate[] => {
  const dates: CalendarDate[] = [];
  const year = currentDate.value.getFullYear();
  const month = currentDate.value.getMonth();

  // Get first day of month and calculate start of calendar
  const firstDay = new Date(year, month, 1);
  const startDay = new Date(firstDay);
  startDay.setDate(startDay.getDate() - firstDay.getDay());

  // Generate 42 days (6 weeks)
  for (let i = 0; i < 42; i++) {
    const date = new Date(startDay);
    date.setDate(startDay.getDate() + i);

    const isCurrentMonth = date.getMonth() === month;
    const isToday = isSameDay(date, new Date());
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;

    dates.push({
      date: new Date(date),
      dateString: formatDate(date),
      day: date.getDate(),
      isCurrentMonth,
      isToday,
      isWeekend,
      key: `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`,
    });
  }

  return dates;
});

const formatDate = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
};

const getDateIncome = (dateString: string): number => {
  return props.incomeData[dateString] || 0;
};

const getDateExpense = (dateString: string): number => {
  return props.expenseData[dateString] || 0;
};

// 支出强度三档：实心色块 + 白字，一屏扫过去先看到颜色深浅
const getExpenseClass = (amount: number): string => {
  if (amount >= 1000) {
    return "bg-red-500 dark:bg-red-700 text-white hover:bg-red-600 dark:hover:bg-red-600 shadow-sm";
  } else if (amount >= 500) {
    return "bg-orange-500 dark:bg-orange-600 text-white hover:bg-orange-600 dark:hover:bg-orange-500 shadow-sm";
  } else {
    return "bg-yellow-500 dark:bg-yellow-600 text-white hover:bg-yellow-600 dark:hover:bg-yellow-500 shadow-sm";
  }
};

const prevMonth = () => {
  currentDate.value = new Date(
    currentDate.value.getFullYear(),
    currentDate.value.getMonth() - 1,
    1
  );
  emit("month-change", currentDate.value);
};

const nextMonth = () => {
  currentDate.value = new Date(
    currentDate.value.getFullYear(),
    currentDate.value.getMonth() + 1,
    1
  );
  emit("month-change", currentDate.value);
};

// 月份选择器选中：任意年月一步到位
const titleButton = ref<HTMLElement | null>(null);
const pickerOpen = ref(false);
const selectMonth = (date: Date) => {
  currentDate.value = date;
  emit("month-change", date);
};

const addFlow = (date: CalendarDate) => {
  emit("add-flow", date);
};

const clickDay = (dateString: string, flowType: string) => {
  emit("click-day", dateString, flowType);
};

const showAnalysis = () => {
  emit("show-analysis", currentMonthText.value);
};

// Watch for prop changes
watch(
  () => props.currentDate,
  (newDate) => {
    currentDate.value = new Date(newDate);
  }
);
</script>