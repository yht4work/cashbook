/**
 * 流水小票文件工具：按扩展名决定展示方式与 blob MIME。
 * 图片照旧 <img> 缩略图 + 全屏蒙层；PDF 等非图片显示为文档卡片，
 * 点击用 window.open 交给浏览器原生查看器（不做内嵌渲染）。
 */

const INVOICE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** 扩展名 → MIME；未识别的扩展名返回 ""（不当图片处理） */
export const getInvoiceMime = (fileName: string): string => {
  const ext = fileName.toLowerCase().split(".").pop() || "";
  return INVOICE_MIME[ext] ?? "";
};

export const isPdfInvoice = (fileName: string): boolean =>
  (fileName.toLowerCase().split(".").pop() || "") === "pdf";

/** blob URL 新标签打开（PDF 等文件小票交给浏览器原生查看器） */
export const openInvoiceFile = (url: string): void => {
  if (url) window.open(url, "_blank");
};

/**
 * 把下载响应规范成带正确 MIME 的 blob URL。
 * mime 为 ""（未识别类型）时保持响应原样，不在前端伪造类型。
 */
export const invoiceObjectUrl = (
  res: Blob | ArrayBuffer | string,
  fileName: string
): string => {
  const mime = getInvoiceMime(fileName);
  let blob: Blob;
  if (mime) {
    blob =
      res instanceof Blob && res.type === mime
        ? res
        : new Blob([res as BlobPart], { type: mime });
  } else {
    blob = res instanceof Blob ? res : new Blob([res as BlobPart]);
  }
  return URL.createObjectURL(blob);
};
