// invoice.ts：扩展名 → MIME / PDF 判定 / blob URL 规范
// 环境是 node：URL.createObjectURL 不存在，测试里打桩成记录收到 blob 的 type
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getInvoiceMime,
  isPdfInvoice,
  invoiceObjectUrl,
} from "~/utils/invoice";

describe("getInvoiceMime / isPdfInvoice", () => {
  it("常见图片扩展名映射 MIME", () => {
    expect(getInvoiceMime("a.jpg")).toBe("image/jpeg");
    expect(getInvoiceMime("A.JPG")).toBe("image/jpeg");
    expect(getInvoiceMime("x-1.png")).toBe("image/png");
    expect(getInvoiceMime("1-2.svg")).toBe("image/svg+xml");
  });

  it("pdf 映射 application/pdf", () => {
    expect(getInvoiceMime("b1-3-1700000000000-1.pdf")).toBe(
      "application/pdf"
    );
    expect(getInvoiceMime("RECEIPT.PDF")).toBe("application/pdf");
  });

  it("未识别扩展名返回空串（不当图片处理）", () => {
    expect(getInvoiceMime("weird.xyz")).toBe("");
    expect(getInvoiceMime("noext")).toBe("");
  });

  it("isPdfInvoice 只认 pdf 扩展名（大小写不敏感）", () => {
    expect(isPdfInvoice("a.pdf")).toBe(true);
    expect(isPdfInvoice("B.PDF")).toBe(true);
    expect(isPdfInvoice("a.jpg")).toBe(false);
    expect(isPdfInvoice("a.pdf.bak")).toBe(false);
  });
});

describe("invoiceObjectUrl", () => {
  const urlFromBlobTypes: string[] = [];

  beforeEach(() => {
    urlFromBlobTypes.length = 0;
    (URL as any).createObjectURL = vi.fn((blob: Blob) => {
      urlFromBlobTypes.push(blob.type);
      return `blob:stub-${urlFromBlobTypes.length}`;
    });
  });

  afterEach(() => {
    delete (URL as any).createObjectURL;
  });

  it("图片 blob 类型不匹配时按扩展名重打并复用 URL 机制", () => {
    const res = new Blob(["x"], { type: "" });
    expect(invoiceObjectUrl(res, "a.png")).toBe("blob:stub-1");
    expect(urlFromBlobTypes).toEqual(["image/png"]);
  });

  it("类型已正确时直接用原 blob", () => {
    const res = new Blob(["x"], { type: "image/jpeg" });
    expect(invoiceObjectUrl(res, "a.jpg")).toBe("blob:stub-1");
    expect(urlFromBlobTypes).toEqual(["image/jpeg"]);
  });

  it("pdf 打 application/pdf", () => {
    const res = new Blob(["%PDF-1.4"], { type: "" });
    expect(invoiceObjectUrl(res, "1-9-1.pdf")).toBe("blob:stub-1");
    expect(urlFromBlobTypes).toEqual(["application/pdf"]);
  });

  it("未识别类型保持响应原样（不伪造 MIME）", () => {
    const res = new Blob(["zz"], { type: "application/zip" });
    expect(invoiceObjectUrl(res, "file.zip")).toBe("blob:stub-1");
    expect(urlFromBlobTypes).toEqual(["application/zip"]);
  });
});
