// invoiceStore：内容寻址复用 + 删除引用检查
// findSameContent 走临时目录（无 DB）；invoiceReferenced 走真实库
// （cashbook_db，种子行用专用 bookId，afterAll 清干净）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import prisma from "~~/server/lib/prisma";
import {
  findSameContent,
  invoiceReferenced,
  imagesDir,
  sha256,
} from "~~/server/utils/invoiceStore";

describe("findSameContent", () => {
  const root = path.join(os.tmpdir(), "inv-store-test-" + process.pid);
  const dir = path.join(root, "images"); // findSameContent 收数据根，在 root/images 找

  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, buf: Buffer) =>
    fs.writeFileSync(path.join(dir, name), buf);

  it("目录不存在 → null（首张图）", async () => {
    expect(
      await findSameContent(path.join(dir, "no-such-dir"), Buffer.from("x"))
    ).toBe(null);
  });

  it("同内容命中：返回盘上文件名", async () => {
    write("a-1-1.pdf", Buffer.from("same-bytes"));
    expect(
      await findSameContent(root, Buffer.from("same-bytes"))
    ).toBe("a-1-1.pdf");
  });

  it("同长度不同内容 → null（长度过滤后靠哈希区分）", async () => {
    write("b-1-1.jpg", crypto.randomBytes(64));
    // 与 b 内容量同、内容异
    expect(
      await findSameContent(root, crypto.randomBytes(64))
    ).toBe(null);
    // 与 b 同长度同内容则命中
    const same = (fs.readFileSync(path.join(dir, "b-1-1.jpg")));
    expect(await findSameContent(root, same)).toBe("b-1-1.jpg");
  });

  it("skip 名单不参与匹配（同请求重复上传各落一份）", async () => {
    write("c-1-1.pdf", Buffer.from("dup-in-request"));
    expect(
      await findSameContent(root, Buffer.from("dup-in-request"), ["c-1-1.pdf"])
    ).toBe(null);
  });

  it("点开头的隐藏文件不参与", async () => {
    write(".hidden.pdf", Buffer.from("secret-content"));
    expect(await findSameContent(root, Buffer.from("secret-content"))).toBe(null);
  });
});

describe("invoiceReferenced", () => {
  const TAG = "dedup-e2e-check-";
  const NAME = TAG + "1.jpg";
  const BOOK = "dedup-store-dbpro";
  let flowA = 0;
  let flowB = 0;
  let sessionId = 0;

  beforeAll(async () => {
    if (Number(await count("User", "id=999998")) === 0) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "User" (id, username, password, name) VALUES (999998, 'dedup-dbpro', 'sha-PLACEHOLDER-not-a-login', 'invoiceStore 测试')`
      );
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Book" ("userId","bookId","bookName") VALUES (999998,'${BOOK}','引用检查探测') ON CONFLICT DO NOTHING`
    );
    flowA = await newFlow(NAME);
    flowB = await newFlow(TAG + "2.jpg");
    const sess = await prisma.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO "ChatSession" ("userId","title") VALUES (999998,'dedup 引用检查') RETURNING id`
    );
    sessionId = sess[0].id;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ChatMessage" ("sessionId","userId","role","content","images") VALUES (${sessionId},999998,'user','图片引用探针','${NAME}')`
    );
  });

  const count = async (table: string, cond: string): Promise<number> => {
    const out = (await prisma.$queryRawUnsafe<{ n: string }[]>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE ${cond}`
    )) as { n: string }[];
    return Number(out[0].n);
  };
  const newFlow = async (invoice: string): Promise<number> => {
    const out = (await prisma.$queryRawUnsafe<{ id: number }[]>(
      `INSERT INTO "Flow" ("userId","bookId","day","flowType","industryType","payType","money","name","attribution","invoice") VALUES (999998,'${BOOK}','2026-11-14','支出','餐饮','现金',1,'引用探针','本人','${invoice}') RETURNING id`
    )) as { id: number }[];
    return out[0].id;
  };

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ChatMessage" WHERE "sessionId"=${sessionId}`
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ChatSession" WHERE "id"=${sessionId}`
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "Flow" WHERE "bookId"='${BOOK}'`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Book" WHERE "bookId"='${BOOK}'`
    );
  });

  it("别的 Flow 记着 → true；自己是唯一 Flow 引用时排除后为 false", async () => {
    // flowA(flowB) 都在，排除 A 则 B 仍引用
    expect(await invoiceReferenced(NAME, flowA)).toBe(true);
    // 排除自己且没有别的 Flow（ChatMessage 行为空时才判 false 的分支在下一用例）
    expect(await invoiceReferenced(TAG + "2.jpg", flowB)).toBe(false);
  });

  it("只剩 ChatMessage 引用 → true（跨表查重覆盖聊天侧）", async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Flow" WHERE "id"=${flowA}`
    );
    // flowA 已删，ChatMessage.images 走 token 精确匹配命中
    expect(await invoiceReferenced(NAME, flowB)).toBe(true);
  });

  it("token 精确比对：仅 SQL contains 误配的行不算引用", async () => {
    // 清掉所有真引用（两条 Flow 已在前面用例里删；beforeAll 的消息删掉），
    // 只留一条 images 含「名字带前缀的相似串」的消息：contains 会命中它，
    // 但 token 逐位不等 → 必须判 false，否则误留文件
    await prisma.$executeRawUnsafe(`DELETE FROM "Flow" WHERE "id"=${flowB}`);
    await prisma.$executeRawUnsafe(
      `DELETE FROM "ChatMessage" WHERE "images"='${NAME}'`
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ChatMessage" ("sessionId","userId","role","content","images") VALUES (${sessionId},999998,'user','误配探针','zz${NAME}')`
    );
    expect(await invoiceReferenced(NAME)).toBe(false);
  });
});
