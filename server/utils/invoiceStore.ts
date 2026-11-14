/**
 * 小票文件的内容寻址复用与引用检查（server 侧共用）。
 *
 * 背景：images/ 目录历来「上传即落盘」（{bookId}-{flowId}-{ts}-{i}.{ext}），
 * 同一张 PDF 挂多笔会存多份拷贝。这里提供两件配对能力：
 *
 * - findSameContent：上传落盘前找同内容文件（长度→哈希两级过滤），
 *   命中即复用盘上文件名，不再写新文件——一票挂多账不翻倍；
 * - invoiceReferenced：删除路径（invoice/del、invoice/clean）物理删除前查
 *   Flow.invoice / ChatMessage.images 里是否还有**别的行**记着这个名字，
 *   仍被引用就只摘名不删文件，避免删 A 裂 B。
 *
 * 匹配没有持久索引：每上传一张对目录 readdir + stat（同长度才继续读文件算
 * SHA-256），个人账本量级下毫秒级；省一张哈希表和一次迁移。同内容**同请求
 * 内重复**不做复用（skip=imageNames，保持一行内名字互异，规避同行重复 token
 * 让 del 的引用检查漏判）；并发同时上传同内容的「检查-写入」竞态会各落一份，
 * 量级可接受，不加锁。
 */
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import prisma from "~~/server/lib/prisma";

export const imagesDir = (dataDir: string): string =>
  path.join(dataDir, "images");

export const sha256 = (buf: Buffer): string => {
  return createHash("sha256").update(buf).digest("hex");
};

/**
 * 盘上找与 buf 同内容的文件：命中返回其文件名，否则 null。
 * skip 的名字不参与匹配（放行同请求内重复上传各落一份）。
 */
export const findSameContent = async (
  dataDir: string,
  buf: Buffer,
  skip: string[] = []
): Promise<string | null> => {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(imagesDir(dataDir));
  } catch {
    return null; // 目录尚不存在（首张图），不可能命中
  }
  const sameSize: string[] = [];
  for (const name of entries) {
    if (skip.includes(name) || name.startsWith(".")) {
      continue;
    }
    try {
      const st = await fs.promises.stat(path.join(imagesDir(dataDir), name));
      if (st.isFile() && st.size === buf.length) {
        sameSize.push(name);
      }
    } catch {
      // 并发删/写导致条目瞬变：跳过该候选
    }
  }
  const target = sha256(buf);
  for (const name of sameSize) {
    try {
      const other = await fs.promises.readFile(
        path.join(imagesDir(dataDir), name)
      );
      if (sha256(other) === target) {
        return name;
      }
    } catch {
      // 读失败（刚被并发删了）：跳过
    }
  }
  return null;
};

/**
 * 文件名是否仍被其他行引用：Flow.invoice 与 ChatMessage.images 均为逗号分隔
 * 文件名列，先 contains 粗捞再按 token 精确比对（避免 -1.jpg 误配 -11.jpg）。
 * excludeFlowId 传发起删除的流水 id（它自己这一行不算数）。
 */
export const invoiceReferenced = async (
  name: string,
  excludeFlowId?: number
): Promise<boolean> => {
  const flows = await prisma.flow.findMany({
    where: { invoice: { contains: name } },
    select: { id: true, invoice: true },
  });
  const citedByOther = flows.some(
    (f) =>
      f.id !== excludeFlowId &&
      String(f.invoice || "")
        .split(",")
        .includes(name)
  );
  if (citedByOther) {
    return true;
  }
  const msgs = await prisma.chatMessage.findMany({
    where: { images: { contains: name } },
    select: { images: true },
  });
  return msgs.some((m) =>
    String(m.images || "")
      .split(",")
      .includes(name)
  );
};
