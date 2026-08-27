/**
 * bitable-bootstrap 核心建表流水线测试：标准字段定义、单选色盘映射、
 * 纯函数流水线执行顺序与异常降级行为。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  BITABLE_FIELD_TYPES,
  BOARD_STATUS_OPTIONS,
  DEFAULT_BOOTSTRAP_FIELDS,
  bootstrapBitableBoard,
  createLarkBootstrapClient,
  type BitableBootstrapClient,
} from "./bitable-bootstrap.js";
import { BOARD_STATES } from "./bitable-board.js";

test("bitable-bootstrap: 定义了 10 个标准业务字段与 6 色状态枚举", () => {
  assert.equal(DEFAULT_BOOTSTRAP_FIELDS.length, 10);
  assert.equal(BOARD_STATUS_OPTIONS.length, 6);

  const stateField = DEFAULT_BOOTSTRAP_FIELDS.find(
    (f) => f.fieldName === "当前状态",
  );
  assert.ok(stateField);
  assert.equal(stateField.type, BITABLE_FIELD_TYPES.SINGLE_SELECT);
  assert.deepEqual(stateField.property?.options, [
    { name: BOARD_STATES.TODO, color: 0 },
    { name: BOARD_STATES.SPEC, color: 1 },
    { name: BOARD_STATES.DEV, color: 2 },
    { name: BOARD_STATES.QA, color: 3 },
    { name: BOARD_STATES.DONE, color: 4 },
    { name: BOARD_STATES.FAILED, color: 5 },
  ]);

  const taskIdField = DEFAULT_BOOTSTRAP_FIELDS.find(
    (f) => f.fieldName === "任务ID",
  );
  assert.equal(taskIdField?.type, BITABLE_FIELD_TYPES.TEXT);

  const tokensField = DEFAULT_BOOTSTRAP_FIELDS.find(
    (f) => f.fieldName === "消耗Token",
  );
  assert.equal(tokensField?.type, BITABLE_FIELD_TYPES.NUMBER);
  assert.deepEqual(tokensField?.property, { formatter: "0" });
});

test("bitable-bootstrap: 顺利执行完整的建表流水线 (App ➔ 10个字段 ➔ 看板视图)", async () => {
  const createdFields: string[] = [];
  const calls: string[] = [];

  const mockClient: BitableBootstrapClient = {
    async createApp(name, folderToken) {
      calls.push(`createApp:${name}:${folderToken ?? ""}`);
      return {
        appToken: "bascnTestAppToken",
        defaultTableId: "tblTestTableId",
        url: "https://feishu.cn/base/bascnTestAppToken",
      };
    },
    async createField(appToken, tableId, field) {
      calls.push(`createField:${appToken}:${tableId}:${field.fieldName}`);
      createdFields.push(field.fieldName);
      return { fieldId: `fld_${field.fieldName}` };
    },
    async createView(appToken, tableId, name, type) {
      calls.push(`createView:${appToken}:${tableId}:${name}:${type}`);
      return { viewId: "vewTestKanban" };
    },
  };

  const result = await bootstrapBitableBoard(mockClient, {
    name: "我的测试看板",
  });

  assert.equal(result.appToken, "bascnTestAppToken");
  assert.equal(result.tableId, "tblTestTableId");
  assert.equal(result.url, "https://feishu.cn/base/bascnTestAppToken");
  assert.equal(result.name, "我的测试看板");
  assert.equal(result.kanbanViewId, "vewTestKanban");
  assert.equal(createdFields.length, 10);
  assert.deepEqual(createdFields, [
    "任务ID",
    "任务标题",
    "负责人(Bot)",
    "发起人",
    "当前状态",
    "轮次",
    "产物链接(文档/PR)",
    "消耗Token",
    "耗时",
    "群聊ID",
  ]);
  assert.equal(calls[0], "createApp:我的测试看板:");
  assert.equal(
    calls[calls.length - 1],
    "createView:bascnTestAppToken:tblTestTableId:任务看板:kanban",
  );
});

test("bitable-bootstrap: 当创建 App 失败时抛出异常", async () => {
  const mockClient: BitableBootstrapClient = {
    async createApp() {
      throw new Error("403 Forbidden: 权限不足");
    },
    async createField() {
      return { fieldId: "fld1" };
    },
    async createView() {
      return { viewId: "vew1" };
    },
  };

  await assert.rejects(
    bootstrapBitableBoard(mockClient, { name: "失败看板" }),
    /403 Forbidden: 权限不足/,
  );
});

test("bitable-bootstrap: 当字段创建失败时中断并抛出异常", async () => {
  const mockClient: BitableBootstrapClient = {
    async createApp() {
      return {
        appToken: "bascnApp",
        defaultTableId: "tblTable",
        url: "https://feishu.cn/base/bascnApp",
      };
    },
    async createField(_appToken, _tableId, field) {
      if (field.fieldName === "负责人(Bot)") {
        throw new Error("字段创建限流或冲突");
      }
      return { fieldId: `fld_${field.fieldName}` };
    },
    async createView() {
      return { viewId: "vew1" };
    },
  };

  await assert.rejects(
    bootstrapBitableBoard(mockClient),
    /字段创建限流或冲突/,
  );
});

test("bitable-bootstrap: 当看板视图创建失败时抛出异常，不展示半成品看板", async () => {
  const mockClient: BitableBootstrapClient = {
    async createApp() {
      return {
        appToken: "bascnApp",
        defaultTableId: "tblTable",
        url: "https://feishu.cn/base/bascnApp",
      };
    },
    async createField() {
      return { fieldId: "fld1" };
    },
    async createView() {
      throw new Error("视图创建接口不支持");
    },
  };

  await assert.rejects(
    bootstrapBitableBoard(mockClient),
    /视图创建接口不支持/,
  );
});

test("bitable-bootstrap: 实现提供 prepareFields 时由实现复用默认主键列", async () => {
  const prepared: string[] = [];
  const created: string[] = [];
  const mockClient: BitableBootstrapClient = {
    async createApp() {
      return {
        appToken: "bascnApp",
        defaultTableId: "tblTable",
        url: "https://feishu.cn/base/bascnApp",
      };
    },
    async prepareFields(_appToken, _tableId, fields) {
      prepared.push(...fields.map((field) => field.fieldName));
    },
    async createField(_appToken, _tableId, field) {
      created.push(field.fieldName);
      return { fieldId: `fld_${field.fieldName}` };
    },
    async createView() {
      return { viewId: "vew1" };
    },
  };

  await bootstrapBitableBoard(mockClient);
  assert.deepEqual(prepared, DEFAULT_BOOTSTRAP_FIELDS.map((field) => field.fieldName));
  assert.deepEqual(created, []);
});

test("bitable-bootstrap: 99991400 频控响应按指数退避后重试成功", async () => {
  let appCalls = 0;
  const calls: string[] = [];
  const client = createLarkBootstrapClient({
    bitable: {
      v1: {
        app: {
          create: async () => {
            appCalls += 1;
            if (appCalls === 1) return { code: 99991400, msg: "频控" };
            return {
              code: 0,
              data: {
                app: {
                  app_token: "bascnApp",
                  default_table_id: "tblTable",
                  url: "https://feishu.cn/base/bascnApp",
                },
              },
            };
          },
        },
        appTableField: {
          list: async () => {
            calls.push("list");
            return { code: 0, data: { items: [], has_more: false } };
          },
          create: async () => ({
            code: 0,
            data: { field: { field_id: "fld1" } },
          }),
        },
        appTableView: {
          create: async () => ({
            code: 0,
            data: { view: { view_id: "vew1" } },
          }),
        },
      },
    },
  } as never);

  const result = await bootstrapBitableBoard(client, { fields: [] });
  assert.equal(result.appToken, "bascnApp");
  assert.equal(appCalls, 2);
  assert.deepEqual(calls, ["list"]);
});

test("bitable-bootstrap: 频控重试按 500/1000/2000ms 指数退避且每次尝试都过 10 QPS 节流", async () => {
  const timestamps: number[] = [];
  const client = createLarkBootstrapClient({
    bitable: {
      v1: {
        app: {
          create: async () => {
            timestamps.push(Date.now());
            if (timestamps.length < 4) return { code: 99991400, msg: "频控" };
            return {
              code: 0,
              data: {
                app: {
                  app_token: "bascnApp",
                  default_table_id: "tblTable",
                  url: "https://feishu.cn/base/bascnApp",
                },
              },
            };
          },
        },
        appTableField: {
          list: async () => ({ code: 0, data: { items: [], has_more: false } }),
          create: async () => ({
            code: 0,
            data: { field: { field_id: "fld1" } },
          }),
        },
        appTableView: {
          create: async () => ({
            code: 0,
            data: { view: { view_id: "vew1" } },
          }),
        },
      },
    },
  } as never);

  await bootstrapBitableBoard(client, { fields: [] });
  assert.equal(timestamps.length, 4, "初始请求 + 3 次重试");
  const gaps = [
    timestamps[1] - timestamps[0],
    timestamps[2] - timestamps[1],
    timestamps[3] - timestamps[2],
  ];
  // 每次实际尝试前都过 10 QPS 节流（最多加 100ms），退避间隔 500/1000/2000ms，
  // 用宽松区间验证，避免 CI 计时抖动导致误报。
  assert.ok(gaps[0] >= 480 && gaps[0] < 900, `首次重试间隔 ${gaps[0]}ms 应约 500ms`);
  assert.ok(gaps[1] >= 980 && gaps[1] < 1600, `二次重试间隔 ${gaps[1]}ms 应约 1000ms`);
  assert.ok(gaps[2] >= 1980 && gaps[2] < 2800, `三次重试间隔 ${gaps[2]}ms 应约 2000ms`);
});

test("bitable-bootstrap: 有字段更新能力时重命名默认主键并跳过重复创建", async () => {
  const updates: unknown[] = [];
  const creates: string[] = [];
  const client = createLarkBootstrapClient({
    bitable: {
      v1: {
        appTableField: {
          list: async () => ({
            code: 0,
            data: {
              items: [{ field_id: "fld-primary", field_name: "多行文本", type: 1, is_primary: true }],
              has_more: false,
            },
          }),
          update: async (payload: unknown) => {
            updates.push(payload);
            return { code: 0, data: {} };
          },
          create: async (payload: { data?: { field_name?: string } }) => {
            creates.push(payload.data?.field_name ?? "");
            return { code: 0, data: { field: { field_id: "fld-created" } } };
          },
        },
      },
    },
  } as never);

  await client.prepareFields?.("bascnApp", "tblTable", [
    { fieldName: "任务ID", type: BITABLE_FIELD_TYPES.TEXT },
    { fieldName: "任务标题", type: BITABLE_FIELD_TYPES.TEXT },
  ]);

  assert.equal(updates.length, 1);
  assert.deepEqual((updates[0] as { data: { field_name: string } }).data.field_name, "任务ID");
  assert.deepEqual(creates, ["任务标题"]);
});

test("bitable-bootstrap: SDK 没有字段更新接口时安全追加任务ID字段", async () => {
  const creates: string[] = [];
  const client = createLarkBootstrapClient({
    bitable: {
      v1: {
        appTableField: {
          list: async () => ({
            code: 0,
            data: {
              items: [{ field_id: "fld-primary", field_name: "多行文本", type: 1, is_primary: true }],
              has_more: false,
            },
          }),
          create: async (payload: { data?: { field_name?: string } }) => {
            creates.push(payload.data?.field_name ?? "");
            return { code: 0, data: { field: { field_id: "fld-created" } } };
          },
        },
      },
    },
  } as never);

  await client.prepareFields?.("bascnApp", "tblTable", [
    { fieldName: "任务ID", type: BITABLE_FIELD_TYPES.TEXT },
    { fieldName: "任务标题", type: BITABLE_FIELD_TYPES.TEXT },
  ]);

  assert.deepEqual(creates, ["任务ID", "任务标题"]);
});

test("bitable-bootstrap: 兼容字符串形式的成功码并保留失败错误码", async () => {
  const client = createLarkBootstrapClient({
    bitable: {
      v1: {
        app: {
          create: async () => ({
            code: "0",
            data: {
              app: {
                app_token: "bascnApp",
                default_table_id: "tblTable",
                url: "https://feishu.cn/base/bascnApp",
              },
            },
          }),
        },
        appTableField: {
          list: async () => ({ code: "0", data: { items: [], has_more: false } }),
          create: async () => ({
            code: "0",
            data: { field: { field_id: "fld1" } },
          }),
        },
        appTableView: {
          create: async () => ({
            code: "0",
            data: { view: { view_id: "vew1" } },
          }),
        },
      },
    },
  } as never);

  const result = await bootstrapBitableBoard(client, { fields: [] });
  assert.equal(result.appToken, "bascnApp");

  const failingClient = createLarkBootstrapClient({
    bitable: {
      v1: {
        app: { create: async () => ({ code: "99991663", msg: "Forbidden" }) },
        appTableField: { create: async () => ({ code: "0", data: {} }) },
        appTableView: { create: async () => ({ code: "0", data: {} }) },
      },
    },
  } as never);
  await assert.rejects(
    failingClient.createApp("失败看板"),
    /Forbidden \(code: 99991663\)/,
  );
});
