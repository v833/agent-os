/**
 * ACP Runner：在 AcpDaemon（常驻进程）上驱动一轮 Agent Client Protocol 交互。
 * 生产路径由 cli 服务注入共享 daemon；无注入时创建临时 daemon 跑完即回收，
 * 供纯函数调用与测试使用。
 */
import { AcpDaemon } from "./acp-daemon.js";
import type { RunCliOptions } from "./runner.js";
import type { CliRunResult } from "./types.js";

/**
 * 执行一轮 ACP prompt。不注入常驻 daemon 时，临时拉起一个 ACP server 进程
 * 完成本轮后立即关闭；需要复用进程请通过 RunCliOptions.acpDaemon 注入。
 */
export async function runAcp(options: RunCliOptions): Promise<CliRunResult> {
  const daemon = new AcpDaemon(options.adapter, undefined, options.env);
  try {
    return await daemon.runTurn(options);
  } finally {
    await daemon.close();
  }
}
