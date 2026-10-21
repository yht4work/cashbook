<template>
  <div class="w-full">
    <!-- 标题栏：标题 + 收支切换 -->
    <div
      class="flex items-center justify-between gap-2 border-b border-frame dark:border-frame-dark pb-2 mb-3"
    >
      <h4
        class="text-base md:text-lg font-semibold text-ink-primary dark:text-ink-onDark"
      >
        {{ title }}
      </h4>
      <div
        class="flex items-center gap-0.5 p-0.5 bg-surface-muted dark:bg-surface-darkMuted rounded-md shrink-0"
        role="group"
        aria-label="每日流水收支切换"
      >
        <button
          v-for="opt in flowTypeOptions"
          :key="opt.value"
          type="button"
          :aria-pressed="flowType === opt.value"
          @click="flowType = opt.value"
          :class="[
            'px-2.5 py-1 text-xs md:text-sm font-medium rounded transition-colors whitespace-nowrap',
            flowType === opt.value
              ? 'bg-surface dark:bg-surface-dark text-ink-primary dark:text-ink-onDark shadow-sm'
              : 'text-ink-muted hover:text-ink-secondary dark:hover:text-ink-onDark',
          ]"
        >
          {{ opt.label }}
        </button>
      </div>
    </div>

    <div v-show="noData" :style="`width: ${width}; height: ${height};`">
      <h3 class="w-full text-center text-state-danger font-medium">暂无数据</h3>
    </div>
    <div
      v-show="!noData"
      :id="chartId"
      class="chart-content"
      :style="`width: ${width}; height: ${height};`"
    ></div>
  </div>
</template>

<script setup lang="ts">
import * as echarts from "echarts";
import { onMounted, onUnmounted, ref, watch } from "vue";
import { dateFormater } from "@/utils/common";
import { daily, dayDetail } from "~/utils/apis";
import type { DayDetailResult } from "~/utils/model";

// 使用 props 来接收外部传入的参数
interface Props {
  title?: string;
  width?: string;
  height?: string;
  startDay?: string; // 开始日期（可选），不传则查询全部
  endDay?: string; // 结束日期（可选），不传则查询全部
}

const props = withDefaults(defineProps<Props>(), {
  title: "",
  width: "100%",
  height: "300px",
  startDay: undefined,
  endDay: undefined,
});

const { title, width, height } = props;

// 收支切换，默认显示支出
type FlowType = "支出" | "收入";
const flowType = ref<FlowType>("支出");
const flowTypeOptions: { value: FlowType; label: string }[] = [
  { value: "支出", label: "支出" },
  { value: "收入", label: "收入" },
];

// 生成唯一ID避免冲突
const chartId = ref(`lineDiv-${Math.random().toString(36).substr(2, 9)}`);

// 横轴数据
const xAxisList: string[] = [];
// 支出数据
const dataListOut: string[] = [];
// 收入数据
const dataListIn: string[] = [];
// 不计收支数据
const notInOut: string[] = [];
const noData = ref(false);

const COLOR_OUT = "#d99f08";
const COLOR_IN = "#4c9870";
const COLOR_ZERO = "#6b7280";

// ---------- 悬浮明细 ----------
// 明细按「日期 + 收支类型」缓存，避免重复请求
const detailCache = new Map<string, DayDetailResult>();
// 正在请求中的 promise，同一天的并发请求共用同一次
const detailPromise = new Map<string, Promise<DayDetailResult>>();
// 明细加载中时，tooltip 里显示的占位内容
const detailLoading = ref(false);
// tooltip 当前展示的日期，用来判断异步返回是否已过期
const lastTooltipDay = ref("");

const formatMoney = (money?: number | null) => {
  const num = Number(money ?? 0);
  return num.toFixed(2);
};

// 拉取某天的流水明细（按金额倒序，即当天的排行榜）
const loadDetail = (day: string, type: FlowType): Promise<DayDetailResult> => {
  const key = `${day}|${type}`;
  const cached = detailCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  // 已经有请求在跑，直接复用，避免重复打接口
  const pending = detailPromise.get(key);
  if (pending) {
    return pending;
  }
  detailLoading.value = true;
  const task = dayDetail({ day, flowType: type, limit: 50 })
    .then((res) => {
      const result: DayDetailResult = res || { rows: [], count: 0, sum: 0 };
      detailCache.set(key, result);
      return result;
    })
    .catch((e) => {
      console.error("获取当日流水明细失败:", e);
      // 失败也缓存空结果，避免鼠标每动一下就打一次接口
      const empty: DayDetailResult = { rows: [], count: 0, sum: 0 };
      detailCache.set(key, empty);
      return empty;
    })
    .finally(() => {
      detailPromise.delete(key);
      detailLoading.value = detailPromise.size > 0;
    });
  detailPromise.set(key, task);
  return task;
};

// 明细加载完成后，重新触发一次 tooltip，让排行榜显示出来
const refreshTooltip = (seriesIndex?: number, dataIndex?: number) => {
  if (!lineChart) return;
  if (seriesIndex != null && dataIndex != null) {
    // 精确重绘当前悬浮的数据点
    lineChart.dispatchAction({
      type: "showTip",
      seriesIndex: seriesIndex,
      dataIndex: dataIndex,
    });
    return;
  }
  lineChart.setOption({
    tooltip: { formatter: optionRef.value.tooltip.formatter },
  });
};

const optionRef = ref({
  tooltip: {
    trigger: "axis",
    axisPointer: {
      type: "line",
      lineStyle: { color: "#9ca3af", type: "dashed" },
    },
    // 自定义内容：先显示当天合计，明细懒加载后再补上排行榜
    formatter: (params: any) => {
      const list = Array.isArray(params) ? params : [params];
      if (list.length === 0) return "";
      const first = list[0];
      const day = first?.axisValue as string;
      if (!day) return "";
      lastTooltipDay.value = day;

      const type = flowType.value;
      const key = `${day}|${type}`;
      let detail = detailCache.get(key);

      // 还没取过：发起懒加载，取回后刷新 tooltip
      if (!detail) {
        loadDetail(day, type).then(() => {
          // 用户可能已经移到别的一天了，这时不要把 tooltip 拽回来
          if (lastTooltipDay.value !== day) return;
          refreshTooltip(first?.seriesIndex, first?.dataIndex);
        });
        detail = { rows: [], count: 0, sum: 0 };
      }

      const head = `<div style="font-weight:600;margin-bottom:4px">${day}</div>`;
      const summary = list
        .map((p: any) => {
          const color = p.color;
          const name = p.seriesName;
          const value = Array.isArray(p.value) ? p.value[1] : p.value;
          return `<div style="display:flex;align-items:center;gap:6px">
            <span style="width:8px;height:8px;border-radius:50%;background:${color}"></span>
            <span>${name}</span>
            <span style="margin-left:auto;font-weight:600">${Number(value).toFixed(2)}</span>
          </div>`;
        })
        .join("");

      const rows = detail.rows;
      if (rows.length === 0) {
        const tip = detailLoading.value
          ? "明细加载中…"
          : `当天无${type}记录`;
        return `${head}${summary}<div style="margin-top:4px;color:#6b7280">${tip}</div>`;
      }

      const rank = rows
        .map(
          (r, i) =>
            `<div style="display:flex;align-items:center;gap:6px;line-height:1.7">
              <span style="width:14px;color:#9ca3af">${i + 1}</span>
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px">${r.name || "未命名"}</span>
              <span style="color:#6b7280;font-size:11px">${r.industryType || ""}</span>
              <span style="font-weight:600">${formatMoney(r.money)}</span>
            </div>`
        )
        .join("");

      // 笔数和合计用服务端返回的当天总量，不用 rows 累加：
      // rows 最多只有 limit 条，笔数超过时两者会不一致
      const total = detail.sum;
      return `${head}${summary}<div style="margin-top:4px;border-top:1px solid #e5e7eb;padding-top:4px">${rank}</div>
        <div style="margin-top:4px;color:#6b7280;font-size:11px">共 ${detail.count} 笔，合计 ${formatMoney(total)}</div>`;
    },
  },
  legend: {
    // 固定在最底部，与横轴日期、缩放滑块各占一条独立的带
    bottom: 0,
    selected: {
      支出: true,
      收入: false,
      不计收支: false,
    },
    data: [
      { name: "支出", textStyle: { color: COLOR_OUT } },
      { name: "收入", textStyle: { color: COLOR_IN } },
      { name: "不计收支", textStyle: { color: COLOR_ZERO } },
    ],
  },
  grid: {
    left: 8,
    right: 16,
    top: 32,
    // 底部留出「缩放滑块 + 图例」两条带，避免压住横轴日期
    bottom: 64,
    containLabel: true,
  },
  dataZoom: [
    {
      type: "inside",
      start: 0,
      end: 100,
    },
    {
      start: 0,
      end: 100,
      bottom: 30,
      height: 30,
    },
  ],
  xAxis: {
    name: "日期",
    nameLocation: "end",
    nameGap: 8,
    type: "category",
    boundaryGap: false,
    data: xAxisList,
    axisLine: { lineStyle: { color: "#d1d5db" } },
    axisLabel: { color: "#6b7280", hideOverlap: true },
  },
  yAxis: {
    name: "金额(元)",
    nameTextStyle: { color: "#6b7280" },
    show: true,
    type: "value",
    min: "0.00",
    splitLine: { lineStyle: { color: "#e5e7eb", type: "dashed" } },
    axisLabel: { color: "#6b7280" },
  },
  series: [
    {
      name: "支出",
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      areaStyle: { opacity: 0.15 },
      itemStyle: {
        color: COLOR_OUT,
      },
      emphasis: {
        focus: "series",
      },
      data: dataListOut,
    },
    {
      name: "收入",
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      areaStyle: { opacity: 0.15 },
      itemStyle: {
        color: COLOR_IN,
      },
      emphasis: {
        focus: "series",
      },
      data: dataListIn,
    },
    {
      name: "不计收支",
      type: "line",
      smooth: true,
      symbol: "circle",
      symbolSize: 6,
      areaStyle: { opacity: 0.1 },
      itemStyle: {
        color: COLOR_ZERO,
      },
      emphasis: {
        focus: "series",
      },
      data: notInOut,
    },
  ],
});

let lineDiv: any;
let lineChart: echarts.ECharts;

// 根据当前收支切换，更新图例选中状态
const applyFlowType = () => {
  optionRef.value.legend.selected = {
    支出: flowType.value === "支出",
    收入: flowType.value === "收入",
    不计收支: false,
  };
};

onMounted(() => {
  lineDiv = document.getElementById(chartId.value);
  const oldInstance = echarts.getInstanceByDom(lineDiv);
  if (oldInstance) {
    oldInstance.dispose();
  }
  lineChart = echarts.init(lineDiv);
  applyFlowType();
  doQuery();
});

onUnmounted(() => {
  detailCache.clear();
  detailPromise.clear();
});

const doQuery = async () => {
  const res = await daily({
    startDay: props.startDay,
    endDay: props.endDay,
  });
  // console.log(res);
  if (!res) {
    return;
  }
  if (res.length == 0) {
    // console.log("DailyLineChart未查询到数据！");
    noData.value = true;
    xAxisList.length = 0;
    dataListOut.length = 0;
    dataListIn.length = 0;
    notInOut.length = 0;
    return;
  }
  noData.value = false;
  xAxisList.length = 0;
  dataListOut.length = 0;
  dataListIn.length = 0;
  notInOut.length = 0;
  res.forEach((data) => {
    xAxisList.push(dateFormater("YYYY-MM-dd", data.type));
    dataListOut.push(Number(data.outSum).toFixed(2));
    dataListIn.push(Number(data.inSum).toFixed(2));
    notInOut.push(Number(data.zeroSum).toFixed(2));
  });
  optionRef.value.xAxis.data = xAxisList;
  optionRef.value.series[0].data = dataListOut;
  optionRef.value.series[1].data = dataListIn;
  optionRef.value.series[2].data = notInOut;
  // 缩放保持 0~100：横轴范围完全由顶部时间总控栏决定，
  // 这里再自动裁掉一段的话，切到「本年」时开头几个月会被藏起来。
  // option 里 dataZoom 的 start 本来就是 0，setOption 又用 notMerge，
  // 所以下面每次都是重置成同一个值，不用每次再赋一遍。

  lineChart.setOption(optionRef.value, { notMerge: true });
};

// 日期区间变化时重新查询
watch(
  () => [props.startDay, props.endDay],
  () => {
    // 区间变了，明细缓存也失效
    detailCache.clear();
    detailPromise.clear();
    lastTooltipDay.value = "";
    if (lineChart) {
      doQuery();
    }
  }
);

// 收支切换时更新图例选中状态；明细类型变了，缓存按新类型重新取
watch(flowType, () => {
  if (lineChart) {
    applyFlowType();
    lineChart.setOption(optionRef.value, { notMerge: true });
  }
});
</script>

<style scoped>
.chart-content {
  padding: 4px 4px 0;
}

@media screen and (max-width: 480px) {
  .chart-content {
    font-size: small;
  }
}
</style>
