/**
 * 产品文档提交测试：覆盖 Schema 路径边界、工具调用提取和真实落盘检查。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertProductSpecDocuments,
  findProductSpecRequest,
  ProductSpecRequestSchema,
} from "./product-spec.js";

const validRequest = {
  title: "用户详情页",
  summary: "增加只读详情页，并覆盖权限与空状态。",
  specPath: ".scratch/user-detail/spec.md",
  ticketsPath: ".scratch/user-detail/issues",
};

test("合法产品文档提交通过校验并提取最近一次调用", () => {
  assert.equal(ProductSpecRequestSchema.safeParse(validRequest).success, true);
  assert.deepEqual(
    findProductSpecRequest([
      { toolName: "Bash", input: {} },
      { toolName: "request_spec_approval", input: validRequest },
    ]),
    validRequest,
  );
  assert.equal(findProductSpecRequest(undefined), undefined);
});

test("拒绝绝对路径、父目录穿越与空摘要", () => {
  for (const specPath of [
    "../outside/spec.md",
    "..\\outside\\spec.md",
    "/tmp/spec.md",
    "C:\\temp\\spec.md",
    "C:temp\\spec.md",
  ]) {
    assert.equal(
      ProductSpecRequestSchema.safeParse({ ...validRequest, specPath }).success,
      false,
      specPath,
    );
  }
  assert.equal(
    ProductSpecRequestSchema.safeParse({ ...validRequest, summary: "" }).success,
    false,
  );
});

test("只接受同一 feature 下的标准 Spec 与 Tickets 路径", () => {
  for (const invalid of [
    { specPath: "README.md", ticketsPath: "." },
    {
      specPath: ".scratch/user-detail/README.md",
      ticketsPath: ".scratch/user-detail/issues",
    },
    {
      specPath: ".scratch/user-detail/spec.md",
      ticketsPath: ".scratch/other/issues",
    },
    {
      specPath: ".scratch/user-detail/spec.md",
      ticketsPath: ".scratch/user-detail",
    },
  ]) {
    assert.equal(
      ProductSpecRequestSchema.safeParse({ ...validRequest, ...invalid })
        .success,
      false,
      JSON.stringify(invalid),
    );
  }
});

test("只在 Spec 与至少一个 Markdown Ticket 真实落盘后通过", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-os-product-spec-"));
  try {
    const featureDir = join(workspace, ".scratch", "user-detail");
    const ticketsDir = join(featureDir, "issues");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(join(featureDir, "spec.md"), "# Spec\n", "utf8");
    await writeFile(join(ticketsDir, "notes.txt"), "not a ticket\n", "utf8");

    await assert.rejects(
      assertProductSpecDocuments(workspace, validRequest),
      /Tickets: \.scratch\/user-detail\/issues/,
    );

    await writeFile(join(ticketsDir, "01-detail-view.md"), "# Ticket\n", "utf8");
    await assert.doesNotReject(
      assertProductSpecDocuments(workspace, validRequest),
    );

    await rm(join(featureDir, "spec.md"));
    await assert.rejects(
      assertProductSpecDocuments(workspace, validRequest),
      /Spec: \.scratch\/user-detail\/spec\.md/,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
