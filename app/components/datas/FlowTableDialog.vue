<template>
  <template v-if="visible">
    <!-- 流水详情弹窗：上图下表（趋势线与列表共用同一组筛选） -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      @click="closeDialog"
    >
      <div
        class="w-full max-w-6xl h-[85vh] bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden flex flex-col"
        @click.stop
      >
        <div
          class="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-700 shrink-0"
        >
          <h3 class="text-lg font-semibold text-green-950 dark:text-white">
            流水详情
          </h3>
          <div class="flex items-center gap-2">
            <button
              @click="trendCollapsed = !trendCollapsed"
              class="px-3 py-2 text-sm font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-950/40 rounded-md hover:bg-green-100 dark:hover:bg-green-950/60 focus:outline-none focus:ring-2 focus:ring-green-500 transition-colors"
            >
              {{ trendCollapsed ? "展开趋势" : "收起趋势" }}
            </button>
            <button
              @click="closeDialog"
              class="px-4 py-2 bg-red-600 text-white rounded-md shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
            >
              关闭
            </button>
          </div>
        </div>

        <!--
          弹窗只有表格区一个滚动条：趋势图固定在上方（不随表格滚走），
          表格区由 FlowTable 的 embedded 模式负责滚动，分页和合计条固定在底部
        -->
        <div class="p-2 md:p-4 flex flex-col gap-2 md:gap-3 flex-1 min-h-0 overflow-hidden">
          <!-- 微观每日趋势：强制同一筛选条件的每日流水 -->
          <div v-if="!trendCollapsed" class="shrink-0">
            <ChartsDailyLineChart
              :key="trendKey"
              title="每日趋势"
              height="230px"
              :filter="trendFilter"
              :default-flow-type="defaultFlowType"
              :disable-drill="true"
            />
          </div>

          <!-- 流水列表 -->
          <div class="flex-1 min-h-0">
            <DatasFlowTable
              ref="tableRef"
              :query="query"
              :embedded="true"
              :actions="true"
              @edit-item="editItem"
              @updated="onDataChanged"
            />
          </div>
        </div>
      </div>
    </div>

    <!--
      编辑流水：叠在详情弹窗之上（FlowEditDialog 自带 z-index 999）。
      只在详情弹窗可见时才渲染它，否则页面上多个图表组件会同时弹出好几个编辑框。
    -->
    <FlowEditDialog
      v-if="showFlowEditDialog"
      title="修改流水"
      :flow="selectedFlow"
      :success-callback="onFlowSaved"
    />
  </template>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import DatasFlowTable from "~/components/datas/FlowTable.vue";
import FlowEditDialog from "~/components/dialog/FlowEditDialog.vue";
import ChartsDailyLineChart from "~/components/charts/DailyLineChart.vue";
import { showFlowEditDialog, notifyFlowChanged } from "~/utils/flag";

const props = defineProps({
  visible: { type: Boolean, default: false },
  query: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["update:visible"]);

const tableRef = ref();
// 正在编辑的流水，交给 FlowEditDialog 回填表单
const selectedFlow = ref<any>({});
// 趋势图收起状态：想全屏看明细时一键收掉（默认展示）
const trendCollapsed = ref(false);

/** 传给趋势图的强制筛选：去掉分页/排序（聚合端点不认识） */
const trendFilter = computed(() => {
  const { pageNum, pageSize, moneySort, daySort, ...rest } = props.query || {};
  return rest;
});

/** 趋势图初始档位跟随点击柱子的收支类型 */
const defaultFlowType = computed(() => {
  const t = props.query?.flowType;
  return t === "收入" || t === "不计收支" ? t : "支出";
});

/** query 变了（换一次下钻）就重建趋势图，避免带着上一份的图例状态 */
const trendKey = computed(
  () => `${JSON.stringify(trendFilter.value)}|${defaultFlowType.value}`
);

/** 点「编辑」：打开修改流水的弹窗 */
const editItem = (item: any) => {
  selectedFlow.value = item;
  showFlowEditDialog.value = true;
};

/** 保存成功：刷新表格，并通知所有图表重新查询 */
const onFlowSaved = () => {
  tableRef.value?.refresh?.();
  notifyFlowChanged();
};

/** 表格里删除流水 / 修改小票后抛出的事件：数据变了，通知外层 */
const onDataChanged = () => {
  notifyFlowChanged();
};

const closeDialog = () => {
  // 编辑框可能还开着，一起关掉。
  // 不关的话，下次打开别的图表详情时会带着这个全局标记，
  // 直接冒出一个空的编辑表单。
  showFlowEditDialog.value = false;
  emit("update:visible", false);
};
</script>