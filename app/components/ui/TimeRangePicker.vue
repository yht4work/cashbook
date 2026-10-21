<template>
  <div class="flex items-center gap-1.5 flex-wrap">
    <!-- 快捷区间 -->
    <div
      class="flex items-center gap-0.5 p-0.5 bg-surface-muted dark:bg-surface-darkMuted rounded-md"
      role="group"
      aria-label="快捷时间区间"
    >
      <button
        v-for="preset in presets"
        :key="preset.key"
        type="button"
        @click="applyPreset(preset.key)"
        :aria-pressed="activePreset === preset.key"
        :class="[
          'px-2.5 py-1 text-xs md:text-sm font-medium rounded transition-colors whitespace-nowrap',
          activePreset === preset.key
            ? 'bg-surface dark:bg-surface-dark text-ink-primary dark:text-ink-onDark shadow-sm'
            : 'text-ink-muted hover:text-ink-secondary dark:hover:text-ink-onDark',
        ]"
      >
        {{ preset.label }}
      </button>
    </div>

    <!-- 自定义区间 -->
    <div class="flex items-center gap-1.5">
      <UiDatePicker
        :modelValue="startDay"
        placeholder="开始日期"
        class="text-sm w-32 md:w-40"
        @update:modelValue="onStartChange"
      />
      <span class="text-ink-muted text-xs md:text-sm">至</span>
      <UiDatePicker
        :modelValue="endDay"
        placeholder="结束日期"
        class="text-sm w-32 md:w-40"
        position="right"
        @update:modelValue="onEndChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { dateFormater } from "@/utils/common";

interface Props {
  startDay?: string | null;
  endDay?: string | null;
}

const props = withDefaults(defineProps<Props>(), {
  startDay: null,
  endDay: null,
});

const emit = defineEmits<{
  "update:startDay": [value: string | null];
  "update:endDay": [value: string | null];
}>();

type PresetKey = "thisMonth" | "lastMonth" | "thisYear" | "all";

const presets: { key: PresetKey; label: string }[] = [
  { key: "thisMonth", label: "本月" },
  { key: "lastMonth", label: "上月" },
  { key: "thisYear", label: "本年" },
  { key: "all", label: "全部" },
];

const monthStart = (date: Date) =>
  dateFormater("YYYY-MM-dd", new Date(date.getFullYear(), date.getMonth(), 1));

const monthEnd = (date: Date) =>
  dateFormater(
    "YYYY-MM-dd",
    new Date(date.getFullYear(), date.getMonth() + 1, 0)
  );

const presetRange = (key: PresetKey): [string | null, string | null] => {
  const now = new Date();
  switch (key) {
    case "thisMonth":
      return [monthStart(now), dateFormater("YYYY-MM-dd", now)];
    case "lastMonth": {
      const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return [monthStart(last), monthEnd(last)];
    }
    case "thisYear":
      return [
        dateFormater("YYYY-MM-dd", new Date(now.getFullYear(), 0, 1)),
        dateFormater("YYYY-MM-dd", now),
      ];
    case "all":
      return [null, null];
  }
};

const applyPreset = (key: PresetKey) => {
  const [start, end] = presetRange(key);
  emit("update:startDay", start);
  emit("update:endDay", end);
};

const onStartChange = (value: string | null) => {
  emit("update:startDay", value);
};

const onEndChange = (value: string | null) => {
  emit("update:endDay", value);
};

// 当前选中的快捷区间：与实际日期区间吻合时才高亮
const activePreset = computed<PresetKey | "">(() => {
  for (const preset of presets) {
    const [start, end] = presetRange(preset.key);
    if (start === (props.startDay ?? null) && end === (props.endDay ?? null)) {
      return preset.key;
    }
  }
  return "";
});
</script>
