import * as fs from "fs";
import * as path from "path";
import prisma from "~~/server/lib/prisma";
import { invoiceReferenced } from "~~/server/utils/invoiceStore";

/**
 * @swagger
 * /api/entry/flow/invoice/del:
 *   post:
 *     summary: 删除流水发票（摘名；物理删除前查引用，仍被其他 Flow/ChatMessage 记着则保留文件）
 *     tags: ["Invoice"]
 *     security:
 *       - Authorization: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             bookId: string 账本ID
 *             id: number 流水ID
 *             invoice: string 发票文件名
 *     responses:
 *       200:
 *         description: 发票删除成功
 *         content:
 *           application/json:
 *             schema:
 *               Result:
 *                 d: 操作结果
 *       400:
 *         description: 删除失败
 *         content:
 *           application/json:
 *             schema:
 *               Error: {
 *                 message: 错误信息（"请先选择账本" | "Not Find ID" | "Not Find ImageName" | "流水信息不存在" | "小票删除失败"）
 *               }
 */
export default defineEventHandler(async (event) => {
  const { id, bookId, invoice } = await readBody(event);

  if (!bookId) {
    return error("请先选择账本");
  }

  if (!id) {
    return error("Not Find ID");
  }

  if (!invoice) {
    return error("Not Find ImageName");
  }

  try {
    const runtimeConfig = useRuntimeConfig();
    let dataPath = String(runtimeConfig.dataPath);

    if (!dataPath) {
      dataPath = process.cwd();
    }

    const imagePath = path.join(dataPath, "images", String(invoice));

    const flow = await prisma.flow.findUnique({
      where: {
        id: Number(id),
        bookId: String(bookId),
      },
    });

    if (!flow) {
      return error("流水信息不存在");
    }

    // 文件存在才谈删除；物理删除前查引用（其他 Flow / 聊天消息）——
    // 仍被别的行记着就只摘名不删文件，避免删 A 裂 B
    if (fs.existsSync(imagePath)) {
      if (!(await invoiceReferenced(String(invoice), Number(id)))) {
        await fs.promises.unlink(imagePath);
      }
    }

    const invoices = flow.invoice ? flow.invoice.split(",") : [];
    const newInvoices = invoices.filter((item) => item !== invoice);

    // 更新流水信息
    await prisma.flow.update({
      where: {
        id: Number(id),
        bookId: String(bookId),
      },
      data: {
        invoice: newInvoices.join(","),
      },
    });

    return success();
  } catch (err) {
    console.error(err);
    return error("小票删除失败");
  }
});
