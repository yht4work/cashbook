<template>
  <template v-if="visible">
    <!-- 流水详情弹窗 -->
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
      @click="closeDialog"
    >
      <div
        class="w-full max-w-6xl max-h-[90vh] bg-white dark:bg-gray-800 rounded-lg shadow-xl overflow-hidden"
        @click.stop
      >
        <div
          class="flex justify-between items-center p-4 border-b border-gray-200 dark:border-gray-700"
        >
          <h3 class="text-lg font-semibold text-green-950 dark:text-white">
            流水详情
          </h3>
          <button
            @click="closeDialog"
            class="px-4 py-2 bg-red-600 text-white rounded-md shadow-sm hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 transition-colors"
          >
            关闭
          </button>
        </div>
        <div class="p-2 md:p-4 overflow-y-auto max-h-[calc(90vh-80px)]">
          <DatasFlowTable
            ref="tableRef"
            :query="query"
            :actions="true"
            @edit-item="editItem"
            @updated="onDataChanged"
          />
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
import { ref } from "vue";
import DatasFlowTable from "~/components/datas/FlowTable.vue";
import FlowEditDialog from "~/components/dialog/FlowEditDialog.vue";
import { showFlowEditDialog, notifyFlowChanged } from "~/utils/flag";

const props = defineProps({
  visible: { type: Boolean, default: false },
  query: { type: Object, default: () => ({}) },
});
const emit = defineEmits(["update:visible"]);

const tableRef = ref();
// 正在编辑的流水，交给 FlowEditDialog 回填表单
const selectedFlow = ref<any>({});

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
