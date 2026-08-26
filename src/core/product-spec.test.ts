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
  isProductSpecOwner,
  productSpecDocumentRevision,
  ProductSpecFlowStore,
  ProductSpecRequestSchema,
} from "./product-spec.js";
import { JsonProductSpecFlowStore } from "./product-spec-store.js";

const validRequest = {
  title: "用户详情页",
  summary: "增加只读详情页，并覆盖权限与空状态。",
  deliveryMode: "local" as const,
  specPath: ".scratch/user-detail/spec.md",
  ticketsPath: ".scratch/user-detail/issues",
};

const validLarkRequest = {
  title: "用户详情页",
  summary: "增加只读详情页，并覆盖权限与空状态。",
  deliveryMode: "lark-doc" as const,
  documentUrl: "https://example.feishu.cn/docx/AbCdEf123",
};

const legacyLocalRequest = {
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

test("旧版本本地提交会自动补齐 local 交付方式", () => {
  assert.deepEqual(
    ProductSpecRequestSchema.safeParse(legacyLocalRequest).data,
    validRequest,
  );
  assert.deepEqual(
    findProductSpecRequest([
      { toolName: "request_spec_approval", input: legacyLocalRequest },
    ]),
    validRequest,
  );
});

test("飞书模式只接受 Docx URL，并与本地路径严格互斥", () => {
  assert.equal(ProductSpecRequestSchema.safeParse(validLarkRequest).success, true);
  assert.equal(
    ProductSpecRequestSchema.safeParse({
      ...validLarkRequest,
      documentUrl: "https://docs.doubao.com/wiki/AbCdEf123",
    }).success,
    false,
  );
  assert.equal(
    ProductSpecRequestSchema.safeParse({
      ...validLarkRequest,
      specPath: validRequest.specPath,
    }).success,
    false,
  );
  assert.equal(
    ProductSpecRequestSchema.safeParse({
      ...validRequest,
      documentUrl: validLarkRequest.documentUrl,
    }).success,
    false,
  );
  assert.equal(
    ProductSpecRequestSchema.safeParse({
      ...validLarkRequest,
      documentUrl: "https://example.feishu.cn/sheets/AbCdEf123",
    }).success,
    false,
  );
  for (const documentUrl of [
    "http://example.feishu.cn/docx/AbCdEf123",
    "https://evil.example/docx/AbCdEf123",
    "file:///tmp/docx/AbCdEf123",
    "https://user:secret@example.feishu.cn/docx/AbCdEf123",
    "https://example.feishu.cn:8443/docx/AbCdEf123",
    "https://example.feishu.cn/path/docx/AbCdEf123",
  ]) {
    assert.equal(
      ProductSpecRequestSchema.safeParse({ ...validLarkRequest, documentUrl })
        .success,
      false,
      documentUrl,
    );
  }
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

test("产品文档内容指纹会区分 Spec 或 Ticket 的修改", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agent-os-product-revision-"));
  try {
    const featureDir = join(workspace, ".scratch", "revision");
    const ticketsDir = join(featureDir, "issues");
    await mkdir(ticketsDir, { recursive: true });
    await writeFile(join(featureDir, "spec.md"), "# Spec v1\n", "utf8");
    await writeFile(join(ticketsDir, "01.md"), "# Ticket v1\n", "utf8");
    const first = await productSpecDocumentRevision(workspace, {
      ...validRequest,
      specPath: ".scratch/revision/spec.md",
      ticketsPath: ".scratch/revision/issues",
    });
    await writeFile(join(ticketsDir, "01.md"), "# Ticket v2\n", "utf8");
    const second = await productSpecDocumentRevision(workspace, {
      ...validRequest,
      specPath: ".scratch/revision/spec.md",
      ticketsPath: ".scratch/revision/issues",
    });
    assert.notEqual(first, second);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("产品方案 Flow 会替换旧待确认状态，并且确认只写入一次时间", () => {
  const store = new ProductSpecFlowStore();
  const first = store.create({
    taskId: "task-1",
    botId: "product",
    sessionId: "session-1",
    ownerOpenId: "ou_owner",
    workspaceDir: "C:\\workspace",
    documentRevision: "revision-1",
    request: validRequest,
  });
  const second = store.create({
    taskId: "task-1",
    botId: "product",
    sessionId: "session-1",
    ownerOpenId: "ou_owner",
    workspaceDir: "C:\\workspace",
    documentRevision: "revision-2",
    request: { ...validRequest, title: "用户详情页 v2" },
  });

  assert.equal(store.get(first.token)?.status, "expired");
  const approved = store.approve(second.token);
  assert.equal(approved?.status, "approved");
  assert.ok(approved?.approvedAt);
  assert.equal(store.approve(second.token), undefined);
  assert.equal(
    isProductSpecOwner(second, { operatorOpenId: "ou_other" }),
    false,
  );
  assert.equal(
    isProductSpecOwner(
      { ...second, ownerUnionId: "on_owner" },
      { operatorOpenId: "ou_other", operatorUnionId: "on_owner" },
    ),
    true,
  );
});

test("云文档 Flow 持久化后可按 Docx token 找回原产品会话", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-os-product-flow-store-"));
  const filePath = join(directory, "flows.json");
  try {
    const store = new JsonProductSpecFlowStore(filePath);
    const created = store.create({
      taskId: "task-cloud",
      botId: "product",
      sessionId: "session-cloud",
      ownerOpenId: "ou_owner",
      workspaceDir: "C:\\workspace",
      collaboration: {
        taskId: "team-task",
        fromBotId: "leader",
        reportToBotId: "leader",
        round: 1,
        maxRounds: 4,
      },
      request: validLarkRequest,
    });
    const restored = new JsonProductSpecFlowStore(filePath);
    assert.equal(
      restored.findPendingByDocument("product", "AbCdEf123")?.token,
      created.token,
    );
    assert.equal(
      restored.findPendingByDocument("product", "AbCdEf123")?.sessionId,
      "session-cloud",
    );
    assert.equal(
      restored.findPendingByDocument("product", "AbCdEf123")?.collaboration
        ?.reportToBotId,
      "leader",
    );
    assert.equal(restored.findPendingByDocument("other", "AbCdEf123"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
