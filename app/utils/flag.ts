import { ref } from "vue";

export const showBookDialogFlag = ref({
  visible: false,
});

export const showFlowExcelImportDialog = ref(false);
// 流水Json导入弹出框
export const showFlowJsonImportDialog = ref(false);
export const showFlowEditInvoiceDialog = ref(false);

export const showFlowTableDialog = ref(false);

export const showSetConvertDialog = ref(false);
export const showChangePasswordDialog = ref(false);

export const showFlowEditDialog = ref(false);
export const showAutoMergeFlowsDialog = ref(false);
export const showAutoDeduplicationFlowsDialog = ref(false);

// 流水数据变更的全局信号。
// 在「数据分析」里改了/删了一条流水后，页面上所有图表都要重新查询，
// 否则同一页里的柱子会互相矛盾（这里改了金额，那边的总额还是旧值）。
// 图表组件 watch 这个版本号，版本一变就重新拉数据。
export const flowDataVersion = ref(0);

/** 通知所有图表：流水数据变了，该重新查询了 */
export const notifyFlowChanged = () => {
  flowDataVersion.value++;
};
