<template>
  <div class="chart-common-container">
    <!-- 标题栏：标题 + 收支切换（时间由顶部总控栏统一管理，此处不再重复） -->
    <div
      class="w-full flex items-center justify-between gap-2 border-b border-frame dark:border-frame-dark pb-2 mb-3"
    >
      <h4
        class="text-base md:text-lg font-semibold text-ink-primary dark:text-ink-onDark shrink-0"
      >
        {{ title }}
      </h4>

      <!-- 收支切换 -->
      <div
        class="flex items-center gap-0.5 p-0.5 bg-surface-muted dark:bg-surface-darkMuted rounded-md shrink-0"
        role="group"
        aria-label="每月流水收支切换"
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

  <!-- 流水详情（可直接编辑 / 删除） -->
  <DatasFlowTableDialog v-model:visible="showFlowTable" :query="query" />
</template>

<script setup lang="ts">
import * as echarts from "echarts";
import { onMounted, ref, watch } from "vue";
import type { CommonChartData } from "~/utils/model";
import DatasFlowTableDialog from "~/components/datas/FlowTableDialog.vue";
import { flowDataVersion } from "~/utils/flag";

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
  height: "320px",
  startDay: undefined,
  endDay: undefined,
});

const { title, width, height } = props;

// 生成唯一ID避免冲突
const chartId = ref(`chartDiv-${Math.random().toString(36).substr(2, 9)}`);

const dataListOut: any[] = [];
const dataListIn: any[] = [];
const notInOut: any[] = [];
const noData = ref(false);

const allData = ref<CommonChartData[]>([]);

// 收支切换，默认显示支出
type FlowType = "支出" | "收入";
const flowType = ref<FlowType>("支出");
const flowTypeOptions: { value: FlowType; label: string }[] = [
  { value: "支出", label: "支出" },
  { value: "收入", label: "收入" },
];

// 月份超过这个数量就启用缩放滑块，并隐藏柱子上的数值标签
const MANY_MONTHS = 24;

/** 生成 "YYYY-MM" */
const monthKey = (year: number, month: number) =>
  `${year}-${month < 10 ? "0" + month : month}`;

/** 生成 [fromYm, toYm] 之间连续的所有 "YYYY-MM" */
const monthRange = (fromYm: string, toYm: string): string[] => {
  const [fromYear, fromMonth] = fromYm.split("-").map(Number);
  const [toYear, toMonth] = toYm.split("-").map(Number);
  const months: string[] = [];
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    months.push(monthKey(year, month));
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
};

/** 默认只展示最近的一段时间，月份越多看的时间越短 */
const zoomStart = (total: number) =>
  total > MANY_MONTHS ? Math.max(0, 100 - (MANY_MONTHS / total) * 100) : 0;

// 当前横轴对应的月份（"YYYY-MM"），点击柱子时用来还原具体月份
const axisMonths = ref<string[]>([]);

/**
 * 把原始数据渲染到图表。
 * 横轴的月份范围完全由顶部时间总控栏决定：
 *   区间落在同一年  -> "1月".."12月"，缺失的月份补 0
 *   跨年 / 全部      -> 区间内连续的 "YYYY-MM"
 */
const renderChart = () => {
  dataListOut.length = 0;
  dataListIn.length = 0;
  notInOut.length = 0;

  const dataMap: Record<string, CommonChartData> = {};
  allData.value.forEach((d) => {
    dataMap[d.type] = d;
  });

  const startYm = props.startDay ? props.startDay.substring(0, 7) : "";
  const endYm = props.endDay ? props.endDay.substring(0, 7) : "";
  const dataMonths = Object.keys(dataMap).sort();
  const sameYear =
    !!startYm && !!endYm && startYm.substring(0, 4) === endYm.substring(0, 4);

  let months: string[] = [];
  let labels: string[] = [];
  if (sameYear) {
    // 同一年：横轴固定 1月..12月
    const year = startYm.substring(0, 4);
    months = monthRange(`${year}-01`, `${year}-12`);
    labels = months.map((m) => `${Number(m.substring(5))}月`);
  } else {
    // 跨年或全部：横轴为区间内连续的 "YYYY-MM"
    const from = startYm || dataMonths[0] || "";
    const to = endYm || dataMonths[dataMonths.length - 1] || "";
    months = from && to ? monthRange(from, to) : dataMonths;
    labels = months.slice();
  }

  axisMonths.value = months;

  months.forEach((ym) => {
    const data = dataMap[ym];
    dataListOut.push(data ? Number(data.outSum).toFixed(2) : "0.00");
    dataListIn.push(data ? Number(data.inSum).toFixed(2) : "0.00");
    notInOut.push(data ? Number(data.zeroSum).toFixed(2) : "0.00");
  });

  const many = months.length > MANY_MONTHS;

  optionRef.value.series[0].data = dataListOut;
  optionRef.value.series[1].data = dataListIn;
  optionRef.value.series[2].data = notInOut;
  optionRef.value.xAxis.data = labels;

  // 月份很多时不再逐柱显示数值，交由 tooltip 承载
  optionRef.value.series[0].label.show = !many;
  optionRef.value.series[1].label.show = !many;
  optionRef.value.series[2].label.show = !many;

  // 底部预留出图例（以及缩放滑块）的位置，避免压住横轴月份
  optionRef.value.grid.bottom = many ? 64 : 34;
  optionRef.value.dataZoom = many
    ? [
        { type: "inside", start: zoomStart(months.length), end: 100 },
        {
          start: zoomStart(months.length),
          end: 100,
          bottom: 30,
          height: 30,
        },
      ]
    : [];

  // 按当前收支切换，图例只高亮对应系列
  optionRef.value.legend.selected = {
    支出: flowType.value === "支出",
    收入: flowType.value === "收入",
    不计收支: false,
  };

  chart.setOption(optionRef.value, { notMerge: true });
};

const optionRef = ref({
  tooltip: {
    trigger: "axis",
    axisPointer: {
      type: "shadow",
    },
  },

  toolbox: {
    feature: {
      // 下载按钮
      // saveAsImage: {}
    },
  },
  xAxis: {
    type: "category",
    data: Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
    axisLine: { lineStyle: { color: "#d1d5db" } },
    axisLabel: { color: "#6b7280", hideOverlap: true },
  },
  yAxis: {
    name: "金额(元)",
    nameTextStyle: { color: "#6b7280" },
    type: "value",
    splitLine: { lineStyle: { color: "#e5e7eb", type: "dashed" } },
    axisLabel: { color: "#6b7280" },
  },

  grid: {
    left: 8,
    right: 16,
    top: 32,
    bottom: 34,
    containLabel: true,
  },

  legend: {
    // 固定在最底部，与横轴月份各占一条独立的带
    bottom: 0,
    selected: {
      支出: true,
      收入: false,
      不计收支: false,
    },
    data: [
      {
        name: "支出",
        textStyle: {
          color: "rgba(217,159,8, 0.9)",
        },
      },
      {
        name: "收入",
        textStyle: {
          color: "rgba(76, 152, 112, 0.9)",
        },
      },
      {
        name: "不计收支",
        textStyle: {
          color: "rgba(107, 114, 128, 0.9)",
        },
      },
    ], // 系列的名称，与 series 中的 name 对应
  },
  dataZoom: [],
  series: [
    {
      name: "支出",
      data: [],
      type: "bar",
      barMaxWidth: 28,
      itemStyle: {
        color: "rgba(217,159,8, 0.9)",
        borderRadius: [3, 3, 0, 0],
      },
      label: {
        show: true,
        position: "top",
        fontSize: 11,
        color: "rgba(217,159,8, 0.9)",
        formatter: (params: any) => {
          // 数值过大时不显示标签，避免相互重叠；具体数值通过 tooltip 查看
          const value = Number(params.value);
          if (!value) return "";
          return value >= 10000 ? "" : value.toFixed(0);
        },
      },
    },
    {
      name: "收入",
      data: [],
      type: "bar",
      barMaxWidth: 28,
      itemStyle: {
        color: "rgba(76, 152, 112, 0.9)",
        borderRadius: [3, 3, 0, 0],
      },
      label: {
        show: true,
        position: "top",
        fontSize: 11,
        color: "rgba(76, 152, 112, 0.9)",
      },
    },
    {
      name: "不计收支",
      data: [],
      type: "bar",
      itemStyle: {
        color: "rgba(66, 66, 66, 0.9)",
      },
      label: {
        show: true,
        position: "top",
        fontSize: 14,
        color: "rgba(66, 66, 66, 0.9)",
      },
    },
  ],
});

let chartDiv: any;
let chart: echarts.ECharts;

const query = ref<FlowQuery>({ pageNum: 1, pageSize: 20 });
const showFlowTable = ref(false);

const doQuery = () => {
  doApi
    .post<CommonChartData[]>("api/entry/analytics/month", {
      bookId: localStorage.getItem("bookId"),
      startDay: props.startDay,
      endDay: props.endDay,
    })
    .then((res) => {
      if (res) {
        if (res.length === 0) {
          allData.value = [];
          // console.log("MonthBar未查询到数据！");
          noData.value = true;
          return;
        }
        allData.value = res;
        noData.value = false;

        // 渲染图表
        renderChart();
      }
    });
};

onMounted(() => {
  chartDiv = document.getElementById(chartId.value);
  const oldInstance = echarts.getInstanceByDom(chartDiv);
  if (oldInstance) {
    oldInstance.dispose();
  }
  chart = echarts.init(chartDiv);
  chart.on("click", function (param) {
    // 横轴标签可能是 "1月"，也可能是 "YYYY-MM"，统一用下标还原成 "YYYY-MM"
    const yearMonth = axisMonths.value[param.dataIndex];
    if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) return;

    const [year, month] = yearMonth.split("-");
    // 取该月最后一天，避免 2 月等月份越界
    const lastDay = new Date(Number(year), Number(month), 0).getDate();
    query.value.startDay = `${yearMonth}-01`;
    query.value.endDay = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;
    // 点的是哪根柱子就查哪个类型（支出 / 收入 / 不计收支），
    // 不能用顶部的收支切换兜底：勾选"不计收支"图例后点灰柱会误查成支出
    query.value.flowType = param.seriesName || flowType.value;
    // 下钻默认按金额倒序（可在表格里点击列头调整）
    query.value.moneySort = "desc";
    showFlowTable.value = true;
  });
  doQuery();
});

// 顶部时间总控栏的区间变化时，重新查询并渲染
watch(
  () => [props.startDay, props.endDay],
  () => {
    if (chart) {
      doQuery();
    }
  }
);

// 收支切换时只需更新图例与系列显隐，无需重新请求数据
watch(flowType, () => {
  if (chart) {
    renderChart();
  }
});

// 明细里改了/删了流水，图表要跟着重查，否则同一页的柱子会互相矛盾
watch(flowDataVersion, () => {
  if (chart) {
    doQuery();
  }
});
</script>

<style scoped>
.chart-content {
  padding: 10px;
}

@media screen and (min-width: 960px) {
  .mini-buttons {
    display: none;
  }
}

@media screen and (max-width: 480px) {
  .pc-button {
    display: none;
  }

  .mini-buttons {
    margin: 8px 3px;
  }

  .chart-content {
    font-size: small;
  }

  .chart-content > div > canvas {
    margin: 20px;
  }
}
</style>
