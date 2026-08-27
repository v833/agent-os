/**
 * 飞书多维表格（Bitable）自动化建表流水线与纯函数契约：封装应用创建、
 * 10 个标准业务字段创建、6 色单选状态枚举及看板视图创建。它位于 Agent OS
 * 看板初始化指令与飞书 OpenAPI 之间，不依赖任何 Cordis 运行时或插件状态。
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { BOARD_STATES } from "./bitable-board.js";

/** 多维表格字段类型枚举（飞书 Bitable 官方规范）。 */
export const BITABLE_FIELD_TYPES = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
} as const;

/** 单选选项定义（带色盘颜色编号 0~5）。 */
export interface SingleSelectOption {
  name: string;
  color: number;
}

/** 看板状态与官方色盘映射（0:浅灰, 1:暖黄, 2:科技蓝, 3:紫罗兰, 4:生机绿, 5:告警红）。 */
export const BOARD_STATUS_OPTIONS: SingleSelectOption[] = [
  { name: BOARD_STATES.TODO, color: 0 },
  { name: BOARD_STATES.SPEC, color: 1 },
  { name: BOARD_STATES.DEV, color: 2 },
  { name: BOARD_STATES.QA, color: 3 },
  { name: BOARD_STATES.DONE, color: 4 },
  { name: BOARD_STATES.FAILED, color: 5 },
];

/** 建表字段定义。 */
export interface BitableBootstrapField {
  fieldName: string;
  type: number;
  property?: Record<string, unknown>;
}

/** 10 个标准业务字段定义（与 bitable-board 同步契约保持一致）。 */
export const DEFAULT_BOOTSTRAP_FIELDS: BitableBootstrapField[] = [
  { fieldName: "任务ID", type: BITABLE_FIELD_TYPES.TEXT },
  { fieldName: "任务标题", type: BITABLE_FIELD_TYPES.TEXT },
  { fieldName: "负责人(Bot)", type: BITABLE_FIELD_TYPES.TEXT },
  { fieldName: "发起人", type: BITABLE_FIELD_TYPES.TEXT },
  {
    fieldName: "当前状态",
    type: BITABLE_FIELD_TYPES.SINGLE_SELECT,
    property: { options: BOARD_STATUS_OPTIONS },
  },
  {
    fieldName: "轮次",
    type: BITABLE_FIELD_TYPES.NUMBER,
    property: { formatter: "0" },
  },
  { fieldName: "产物链接(文档/PR)", type: BITABLE_FIELD_TYPES.TEXT },
  {
    fieldName: "消耗Token",
    type: BITABLE_FIELD_TYPES.NUMBER,
    property: { formatter: "0" },
  },
  {
    fieldName: "耗时",
    type: BITABLE_FIELD_TYPES.NUMBER,
    property: { formatter: "0" },
  },
  { fieldName: "群聊ID", type: BITABLE_FIELD_TYPES.TEXT },
];

export type BitableViewType = "form" | "kanban" | "grid" | "gallery" | "gantt";

/** 自动化建表客户端最小接口，供纯函数流水线与单元测试 Mock 复用。 */
export interface BitableBootstrapClient {
  createApp(
    name: string,
    folderToken?: string,
  ): Promise<{ appToken: string; defaultTableId: string; url: string }>;
  createField(
    appToken: string,
    tableId: string,
    field: BitableBootstrapField,
  ): Promise<{ fieldId: string }>;
  /** 为新表准备标准字段；实现可复用飞书自动创建的默认主键列。 */
  prepareFields?(
    appToken: string,
    tableId: string,
    fields: BitableBootstrapField[],
  ): Promise<void>;
  createView(
    appToken: string,
    tableId: string,
    name: string,
    type: BitableViewType,
  ): Promise<{ viewId: string }>;
}

/** 初始化看板的结果元数据。 */
export interface BootstrapBoardResult {
  appToken: string;
  tableId: string;
  url: string;
  name: string;
  kanbanViewId?: string;
  createdAt: string;
}

export interface BootstrapBoardOptions {
  name?: string;
  folderToken?: string;
  fields?: BitableBootstrapField[];
}

function hasApiErrorCode(code: unknown): boolean {
  if (code === undefined || code === null || code === "") return false;
  const numeric = Number(code);
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

function apiErrorMessage(
  response: { code?: unknown; msg?: unknown },
  fallback: string,
): string {
  const message = typeof response.msg === "string" ? response.msg.trim() : "";
  const rawCode = response.code;
  const code = rawCode === undefined || rawCode === null ? "" : String(rawCode);
  const hasCode = hasApiErrorCode(rawCode);
  if (message) return hasCode ? `${message} (code: ${code})` : message;
  return hasCode ? `${fallback}(code: ${code})` : fallback;
}

/**
 * 自动化建表纯函数流水线：原子化执行 App 创建 ➔ 标准字段准备 ➔ 看板视图创建。
 * 任何一步失败都向调用方传播，避免在资源不完整时展示“已就绪”。
 */
export async function bootstrapBitableBoard(
  client: BitableBootstrapClient,
  options: BootstrapBoardOptions = {},
): Promise<BootstrapBoardResult> {
  const appName = options.name?.trim() || "Agent OS 任务看板";
  const fields = options.fields ?? DEFAULT_BOOTSTRAP_FIELDS;

  // Step 1: 创建多维表格应用
  const app = await client.createApp(appName, options.folderToken);
  if (!app.appToken || !app.defaultTableId) {
    throw new Error("创建多维表格失败：未返回 app_token 或 default_table_id");
  }
  const appToken = app.appToken;
  const defaultTableId = app.defaultTableId;

  try {
    // Step 2: 准备 10 个标准业务字段。真实 SDK 实现会复用默认主键列；
    // 测试或其他实现未提供 prepareFields 时回退为逐列创建。
    if (client.prepareFields) {
      await client.prepareFields(appToken, defaultTableId, fields);
    } else {
      for (const field of fields) {
        await client.createField(appToken, defaultTableId, field);
      }
    }

    // Step 3: 创建看板视图
    const view = await client.createView(
      appToken,
      defaultTableId,
      "任务看板",
      "kanban",
    );

    return {
      appToken,
      tableId: defaultTableId,
      url: app.url,
      name: appName,
      kanbanViewId: view.viewId,
      createdAt: new Date().toISOString(),
    };
  } catch (error) {
    // 表格已创建但后续步骤失败时，把 appToken 附到错误对象上，供调用方
    // 提示「已创建但未挂载」，避免用户重复建表产生孤儿表格。
    (error as { appToken?: string }).appToken = appToken;
    throw error;
  }
}

/** 飞书 API 请求间隔（控制在 10 QPS 以内）。 */
const REQUEST_INTERVAL_MS = 100;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 基于飞书 SDK 创建实际的 BitableBootstrapClient，内置串行速率控制与指数退避重试。
 */
export function createLarkBootstrapClient(
  lark: Lark.Client,
): BitableBootstrapClient {
  let requestTail = Promise.resolve();
  let lastRequestStartedAt = 0;

  const request = <T>(operation: () => Promise<T>): Promise<T> => {
    const scheduled = requestTail.then(() =>
      withRetry(() => throttledOperation(operation)),
    );
    requestTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  /** 每次实际 API 尝试（含频控重试）前都执行 10 QPS 节流，避免重试绕过间隔。 */
  const throttledOperation = async <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    let remaining =
      REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt);
    while (remaining > 0) {
      await sleep(remaining);
      remaining =
        REQUEST_INTERVAL_MS - (Date.now() - lastRequestStartedAt);
    }
    lastRequestStartedAt = Date.now();
    return operation();
  };

  const isRateLimitResponse = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const response = value as { code?: unknown; msg?: unknown };
    const code = Number(response.code);
    return (
      code === 99991400 ||
      code === 429 ||
      (typeof response.msg === "string" &&
        (response.msg.includes("99991400") || response.msg.includes("429")))
    );
  };

  const isRateLimitError = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return false;
    const value = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
    const code = Number(value.code);
    const status = Number(value.status);
    const statusCode = Number(value.statusCode);
    return (
      code === 99991400 ||
      code === 429 ||
      status === 429 ||
      statusCode === 429 ||
      (typeof value.message === "string" &&
        (value.message.includes("99991400") || value.message.includes("429")))
    );
  };

  const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    while (true) {
      try {
        const response = await operation();
        if (!isRateLimitResponse(response)) return response;
        attempt += 1;
        if (attempt > MAX_RETRIES) return response;
        await sleep(500 * 2 ** (attempt - 1));
      } catch (error) {
        if (!isRateLimitError(error)) throw error;
        attempt += 1;
        if (attempt > MAX_RETRIES) throw error;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  };

  return {
    async createApp(name, folderToken) {
      const response = await request(() =>
        lark.bitable.v1.app.create({
          data: {
            name,
            folder_token: folderToken || "",
          },
        }),
      );
      if (hasApiErrorCode(response.code)) {
        throw new Error(apiErrorMessage(response, "创建多维表格失败"));
      }
      const app = response.data?.app;
      if (!app?.app_token || !app?.default_table_id) {
        throw new Error("创建多维表格失败：响应缺少 app 核心信息");
      }
      return {
        appToken: app.app_token,
        defaultTableId: app.default_table_id,
        url: app.url || `https://feishu.cn/base/${app.app_token}`,
      };
    },
    async createField(appToken, tableId, field) {
      const response = await request(() =>
        lark.bitable.v1.appTableField.create({
          path: { app_token: appToken, table_id: tableId },
          data: {
            field_name: field.fieldName,
            type: field.type,
            ...(field.property ? { property: field.property } : {}),
          },
        }),
      );
      if (hasApiErrorCode(response.code)) {
        throw new Error(apiErrorMessage(response, `创建字段「${field.fieldName}」失败`));
      }
      const fieldId = response.data?.field?.field_id;
      if (!fieldId) {
        throw new Error(`创建字段「${field.fieldName}」未返回 field_id`);
      }
      return { fieldId };
    },
    async prepareFields(appToken, tableId, fields) {
      const existing: Array<{
        field_id?: string;
        field_name: string;
        type: number;
        is_primary?: boolean;
      }> = [];
      let pageToken: string | undefined;
      do {
        const response = await request(() =>
          lark.bitable.v1.appTableField.list({
            path: { app_token: appToken, table_id: tableId },
            params: {
              page_size: 100,
              ...(pageToken ? { page_token: pageToken } : {}),
            },
          }),
        );
        if (hasApiErrorCode(response.code)) {
          throw new Error(apiErrorMessage(response, "读取默认字段失败"));
        }
        existing.push(...(response.data?.items ?? []));
        const pageData = response.data as
          | (typeof response.data & { next_page_token?: string })
          | undefined;
        pageToken = pageData?.has_more
          ? pageData.page_token || pageData.next_page_token
          : undefined;
      } while (pageToken);

      const taskIdField = fields.find((field) => field.fieldName === "任务ID");
      let reusedFieldId: string | undefined;
      const existingTaskId = existing.find((field) => field.field_name === taskIdField?.fieldName);
      const primary = existing.find((field) => field.is_primary);
      if (existingTaskId?.field_id) {
        reusedFieldId = existingTaskId.field_id;
      } else if (primary?.field_id && taskIdField) {
        // node-sdk 1.71.x 尚未暴露字段更新接口；有更新能力的替代 SDK/Mock
        // 可以重命名默认主键，否则回退为追加标准字段，保证流水线仍可完成。
        const fieldApi = lark.bitable.v1.appTableField as unknown as {
          update?: (payload: unknown) => Promise<{ code?: unknown; msg?: unknown }>;
        };
        if (typeof fieldApi.update === "function") {
          const response = await request(() =>
            fieldApi.update!({
              path: {
                app_token: appToken,
                table_id: tableId,
                field_id: primary.field_id!,
              },
              data: {
                field_name: taskIdField.fieldName,
                type: taskIdField.type,
                ...(taskIdField.property ? { property: taskIdField.property } : {}),
                is_primary: true,
              },
            }),
          );
          if (hasApiErrorCode(response.code)) {
            throw new Error(apiErrorMessage(response, "复用默认主键列失败"));
          }
          reusedFieldId = primary.field_id;
        }
      }

      for (const field of fields) {
        if (field.fieldName === taskIdField?.fieldName && reusedFieldId) continue;
        if (existing.some((item) => item.field_name === field.fieldName)) continue;
        await this.createField(appToken, tableId, field);
      }
    },
    async createView(appToken, tableId, name, type: BitableViewType) {
      const response = await request(() =>
        lark.bitable.v1.appTableView.create({
          path: { app_token: appToken, table_id: tableId },
          data: {
            view_name: name,
            view_type: type,
          },
        }),
      );
      if (hasApiErrorCode(response.code)) {
        throw new Error(apiErrorMessage(response, "创建看板视图失败"));
      }
      const viewId = response.data?.view?.view_id;
      if (!viewId) {
        throw new Error("创建看板视图未返回 view_id");
      }
      return { viewId };
    },
  };
}
