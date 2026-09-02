/**
 * CLI 注册表：登记 ThreadPilot 支持的执行引擎。引擎插件通过 registerCliAdapter
 * 把自己登记进统一注册表（“一切皆插件”：新增执行引擎 = 新增一个插件，
 * 从 cordis.yml 移除引擎插件 = 引擎整体下线）。
 */
import type { CliAccessMode, CliAdapter, CliId } from "./types.js";

/** 引擎键同时区分 ID 与接入模式，让同一引擎的不同接入协议独立登记。 */
function engineKey(id: CliId, accessMode: CliAccessMode): string {
  return `${id}:${accessMode}`;
}

const registeredEngines = new Map<string, CliAdapter>();

/** 引擎插件登记自己的适配器；相同 id+accessMode 重复登记会覆盖旧实现。 */
export function registerCliAdapter(adapter: CliAdapter): void {
  registeredEngines.set(
    engineKey(adapter.id, adapter.accessMode ?? "headless"),
    adapter,
  );
}

/** 按持久化的引擎 ID 返回对应适配器。 */
export function getCliAdapter(
  id: CliId,
  accessMode: CliAccessMode = "headless",
): CliAdapter {
  const adapter = registeredEngines.get(engineKey(id, accessMode));
  if (!adapter) {
    throw new Error(
      `执行引擎 ${id} 不支持 ${accessMode === "acp" ? "ACP" : accessMode} 接入模式`,
    );
  }
  return adapter;
}

/** 返回全部已注册适配器，供启动日志和能力检查使用；同一 ID 只保留首个实现。 */
export function listCliAdapters(): CliAdapter[] {
  const byId = new Map<CliId, CliAdapter>();
  for (const adapter of registeredEngines.values()) {
    if (!byId.has(adapter.id)) byId.set(adapter.id, adapter);
  }
  return [...byId.values()];
}
