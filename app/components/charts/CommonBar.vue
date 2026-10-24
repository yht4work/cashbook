<template>
  <div class="w-full">
    <div class="md:h-16 mb-2 relative">
      <h4
        class="hidden md:block text-center font-semibold text-green-950 dark:text-white my-2"
      >
        {{ title }}
      </h4>
      <span
        v-if="foldedCount > 0"
        class="absolute left-0 top-0 text-xs text-ink-muted"
        :title="`共 ${totalCount} 个类目，图中只显示金额最高的 ${topN} 个，其余合并为「其他」`"
      >
        前 {{ topN }} 项 / 共 {{ totalCount }} 项
      </span>
    </div>

    <div
      v-show="noData"
      :style="`width: ${width}; height: ${height};`"
      class="flex items-center justify-center"
    >
      <h3 class="text-lg text-red-500 font-medium">暂无数据</h3>
    </div>
    <div
      v-show="!noData"
      :id="chartId"
      :style="`width: ${width}; height: ${height};`"
    ></div>
  </div>

  <!-- 流水详情（可直接编辑 / 删除） -->
  <DatasFlowTableDialog v-model:visible="showFlowTable" :query="query" />
</template>

<script setup lang="ts">
import * as echarts from "echarts";
import { onMounted, ref, watch } from "vue";
import { doApi } from "~/utils/api";
import type { CommonChartData, CommonChartQuery } from "~/utils/model";
import DatasFlowTableDialog from "~/components/datas/FlowTableDialog.vue";
import { flowDataVersion } from "~/utils/flag";

const { isDark } = useAppTheme();

// 定义组件的props
interface Props {
  title: string;
  width: string;
  height: string;
  groupBy: string; // 分组字段 (payType/industryType/attribution)
  startDay?: string;
  endDay?: string;
  flowType?: string;
  seriesName?: string; // 系列名称
  queryField?: string; // 点击时传递给FlowTable的查询字段名
}

const props = withDefaults(defineProps<Props>(), {
  seriesName: "数据分析",
  queryField: "payType", // 默认为payType，保持向下兼容
});

// 生成唯一ID避免冲突
const chartId = ref(`commonBarDiv-${Math.random().toString(36).substr(2, 9)}`);

const chartParam = ref<CommonChartQuery & { groupBy: string }>({
  startDay: props.startDay,
  endDay: props.endDay,
  flowType: props.flowType,
  groupBy: props.groupBy,
});

const noData = ref(false);
// 类目太多时只画金额最高的几个，其余合并成「其他」
const topN = 12;
const totalCount = ref(0);
const foldedCount = ref(0);
// 「其他」里折进来的尾部类目，点击「其他」柱子时下钻用
const tailGroups = ref<CommonChartData[]>([]);

const optionRef = ref({
  tooltip: {
    trigger: "item",
    formatter: (params: any) => {
      const name = params?.name ?? "";
      const value = Number(params?.value ?? 0);
      return `${name}<br/>金额：${value.toFixed(2)} 元`;
    },
  },
  xAxis: {
    type: "category",
    data: [] as string[],
    axisLine: { lineStyle: { color: "#d1d5db" } },
    axisTick: { show: false },
    axisLabel: {
      rotate: 45, // 标签旋转45度，防止重叠
      fontSize: 12,
      color: "#6b7280",
      hideOverlap: true,
      formatter: (value: string) => truncate(value),
    },
  },
  yAxis: {
    type: "value",
    name: "金额(元)",
    nameTextStyle: { color: "#6b7280" },
    splitLine: { lineStyle: { color: "#e5e7eb", type: "dashed" } },
    axisLabel: { color: "#6b7280" },
  },
  grid: {
    left: 8,
    right: 16,
    // 顶部给数值标签留位置，底部给旋转后的横轴标签留位置
    top: 36,
    bottom: 64,
    containLabel: true,
  },
  series: [
    {
      name: props.seriesName,
      type: "bar",
      data: [] as any[],
      barMaxWidth: 30,
      itemStyle: {
        color: "rgba(217,159,8, 0.9)", // 默认黄色（支出色）
        borderRadius: [4, 4, 0, 0], // 顶部圆角
      },
      label: {
        show: true,
        position: "top",
        fontSize: 11,
        color: "#6b7280",
        formatter: (params: any) => compactMoney(params.value),
      },
      emphasis: {
        itemStyle: {
          color: "rgba(217,159,8, 1)", // 悬停时的颜色
        },
      },
    },
  ],
});

let chartDiv: any;
let chart: echarts.ECharts;

/** 横轴标签过长时截断，完整名称放在 tooltip 里 */
const truncate = (value: string) =>
  value.length > 5 ? `${value.substring(0, 5)}…` : value;

/** 柱顶数值：过万折成「万」，避免标签互相压住 */
const compactMoney = (value: any) => {
  const num = Number(value);
  if (!num) return "";
  if (Math.abs(num) >= 10000) {
    return `${(num / 10000).toFixed(1)}万`;
  }
  return num.toFixed(0);
};

const doQuery = (query: CommonChartQuery & { groupBy: string }) => {
  doApi
    .post<CommonChartData[]>("api/entry/analytics/common", {
      bookId: localStorage.getItem("bookId"),
      ...query,
    })
    .then((res) => {
      if (!res) return;
      if (res.length === 0) {
        noData.value = true;
        return;
      }
      noData.value = false;

      // 取出当前收支类型对应的金额
      const sumOf = (d: CommonChartData) => {
        if (query.flowType === "支出") return Number(d.outSum);
        if (query.flowType === "收入") return Number(d.inSum);
        return Number(d.zeroSum);
      };

      // 从高到低排序
      const sorted = [...res].sort((a, b) => sumOf(b) - sumOf(a));
      totalCount.value = sorted.length;

      // 类目过多时只保留前 N 个，其余合并成「其他」
      const head = sorted.slice(0, topN);
      const tail = sorted.slice(topN);
      tailGroups.value = tail;
      foldedCount.value = tail.length;

      const xAxisData: string[] = [];
      const dataList: any[] = [];
      head.forEach((d) => {
        xAxisData.push(d.type);
        dataList.push({
          name: d.type,
          value: sumOf(d).toFixed(2),
          // 记下这一类是不是「原始字段为空」归并出来的，
          // 点开时要用它来还原筛选条件
          isEmpty: !!d.isEmpty,
        });
      });
      if (tail.length > 0) {
        const otherSum = tail.reduce((sum, d) => sum + sumOf(d), 0);
        xAxisData.push("其他");
        dataList.push({
          name: `其他（${tail.length} 项）`,
          value: otherSum.toFixed(2),
          // 标记这是合并出来的类目（横轴标签只是「其他」，
          // 真正的 data name 是「其他（N 项）」，不能靠字符串判断）
          isOther: true,
        });
      }

      // 重新渲染图表
      optionRef.value.xAxis.data = xAxisData;
      optionRef.value.series[0].data = dataList;
      optionRef.value.xAxis.axisLabel.color = isDark.value
        ? "#9ca3af"
        : "#6b7280";
      optionRef.value.yAxis.axisLabel.color = isDark.value
        ? "#9ca3af"
        : "#6b7280";

      // 根据流水类型设置不同颜色，参考MonthBar.vue
      if (query.flowType == "支出") {
        optionRef.value.series[0].itemStyle.color = "rgba(217,159,8, 0.9)"; // 黄色
        optionRef.value.series[0].emphasis.itemStyle.color =
          "rgba(217,159,8, 1)";
      } else if (query.flowType == "收入") {
        optionRef.value.series[0].itemStyle.color = "rgba(76, 152, 112, 0.9)"; // 绿色
        optionRef.value.series[0].emphasis.itemStyle.color =
          "rgba(76, 152, 112, 1)";
      } else {
        optionRef.value.series[0].itemStyle.color = "rgba(66, 66, 66, 0.9)"; // 灰色
        optionRef.value.series[0].emphasis.itemStyle.color =
          "rgba(66, 66, 66, 1)";
      }

      // 确保图表完全重新渲染
      chart.clear();
      chart.setOption(optionRef.value);
    });
};

const query = ref();
const showFlowTable = ref(false);

// 监听 props 变化，更新 chartParam
watch(
  () => [props.startDay, props.endDay],
  ([newStartDay, newEndDay]) => {
    chartParam.value.startDay = newStartDay;
    chartParam.value.endDay = newEndDay;
  }
);

watch(
  chartParam,
  () => {
    doQuery(chartParam.value);
  },
  { deep: true }
);

// 明细里改了/删了流水，图表要跟着重查，否则同一页的柱子会互相矛盾
watch(flowDataVersion, () => {
  if (chart) {
    doQuery(chartParam.value);
  }
});

onMounted(() => {
  chartDiv = document.getElementById(chartId.value);
  const oldInstance = echarts.getInstanceByDom(chartDiv);
  if (oldInstance) {
    oldInstance.dispose();
  }
  chart = echarts.init(chartDiv);
  chart.on("click", function (param: any) {
    const itemName = param.name || (param.data && param.data.name) || "";
    // 「其他」是合并类目（横轴标签只是「其他」，真正的 data name 是
    // 「其他（N 项）」，不能靠字符串判断），点开时按折进来的类目逐个精确匹配
    if (param.data && param.data.isOther) {
      const empty = tailGroups.value.some((d) => d.isEmpty);
      const names = tailGroups.value
        .filter((d) => !d.isEmpty)
        .map((d) => d.type);
      query.value = {
        ...chartParam.value,
        [props.queryField]: undefined,
        [`${props.queryField}List`]: names,
        [`${props.queryField}Empty`]: empty ? true : undefined,
        attributionExact: undefined,
        // 下钻默认按金额倒序（可在表格里点击列头调整）
        moneySort: "desc",
      };
      showFlowTable.value = true;
      return;
    }
    // 根据queryField动态设置查询参数
    // isEmpty 为真时，说明这一类是「该字段为空」归并出来的：
    // 不能拿展示名去做 equals 匹配，否则一条都查不到
    const isEmpty = !!(param.data && param.data.isEmpty);
    query.value = {
      ...chartParam.value,
      [props.queryField]: isEmpty ? undefined : itemName,
      [`${props.queryField}Empty`]: isEmpty ? true : undefined,
      // 图上是按类目精确分组的，明细也要精确匹配，否则合计对不上
      attributionExact: props.queryField === "attribution" && !isEmpty,
      // 下钻默认按金额倒序（可在表格里点击列头调整）
      moneySort: "desc",
    };
    showFlowTable.value = true;
  });
  doQuery(chartParam.value);
});
</script>

<style scoped></style>
