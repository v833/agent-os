/**
 * ThreadPilot 引导入口：创建根 Context 并挂载 loader 插件。
 * loader 读取 cordis.yml 声明式装配全部服务与功能插件——“一切皆为插件”。
 */
import "dotenv/config";
import { Context } from "cordis";
import { apply as loaderApply, name as loaderName } from "./plugins/loader.js";

const root = new Context();

try {
  await root.plugin({ name: loaderName, apply: loaderApply });
  // 原始根 Context 不限制服务访问，这里输出与旧版一致的启动摘要。
  for (const adapter of root.cli.list()) {
    console.log(`[CLI] id=${adapter.id} command=${adapter.command}`);
  }
  for (const config of root.config.bots) {
    console.log(
      `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId} access_mode=${config.accessMode} workspace=${config.workspaceDir}`,
    );
  }
  console.log(`[团队] Team Leader=${root.config.teamLeaderId}`);
  console.log("ThreadPilot 启动完成");
} catch (error) {
  console.error("ThreadPilot 启动失败:", (error as Error).message);
  process.exit(1);
}
