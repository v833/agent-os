/**
 * workspaces 服务插件：为协作和编排提供稳定工作树 revision 指纹。
 * QA Gate 通过 ctx.workspaces 取版本，不直接依赖 Git 或文件系统实现。
 */
import { Service, type Context } from "cordis";
import { workspaceRevision } from "../core/workspace-revision.js";
import {
  createWorkspaceSnapshot,
  type WorkspaceSnapshot,
} from "../core/workspace-snapshot.js";

/** 工作区版本能力；后续可替换为远端快照服务而不改变协作插件。 */
export class WorkspacesService extends Service {
  private readonly snapshots = new Map<string, WorkspaceSnapshot>();

  constructor(ctx: Context) {
    super(ctx, "workspaces");
  }

  revision(workspaceDir: string): Promise<string> {
    return workspaceRevision(workspaceDir);
  }

  /** 为一次 QA 审查创建隔离快照；快照目录由 releaseSnapshot 回收。 */
  async snapshot(sourceWorkspaceDir: string): Promise<WorkspaceSnapshot> {
    const snapshot = await createWorkspaceSnapshot(sourceWorkspaceDir);
    this.snapshots.set(snapshot.workspaceDir, snapshot);
    return snapshot;
  }

  /** 释放已完成审查的快照，重复释放是幂等的。 */
  async releaseSnapshot(workspaceDir: string): Promise<void> {
    const snapshot = this.snapshots.get(workspaceDir);
    if (!snapshot) return;
    this.snapshots.delete(workspaceDir);
    await snapshot.cleanup();
  }

  async dispose(): Promise<void> {
    const snapshots = [...this.snapshots.values()];
    this.snapshots.clear();
    // 同一 Git 仓库的多个 worktree 清理会竞争仓库锁，按顺序回收更可靠。
    for (const snapshot of snapshots) await snapshot.cleanup();
  }
}

export const name = "workspaces";

export function apply(ctx: Context) {
  const service = new WorkspacesService(ctx);
  return () => service.dispose();
}
