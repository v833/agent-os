/**
 * 测试调度入口：自动发现 src 下的测试文件，以独立进程并行执行并校验每个文件的
 * 测试摘要。它绕开 Node 22 文件级并行时偶发的 IPC 反序列化问题，同时保留进程隔离。
 */
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = resolve(ROOT, "src");
const SCRIPTS = resolve(ROOT, "scripts");
const SUMMARY_PATTERN = /(?:^|\n)(?:ℹ|#) tests (\d+)\r?(?=\n|$)/g;
// Windows 进程生命周期测试单条约 1 秒；逻辑分片让这些独立用例并发执行，
// 同时避免物理拆文件造成测试夹具复制和后续维护漂移。
const SHARD_COUNTS = new Map([
  ["src/cli/runner.test.ts", 5],
  ["src/cli/acp-daemon.test.ts", 4],
  ["src/plugins/host.test.ts", 3],
]);
// LPT 先启动实测长文件，避免长子进程测试排到队尾形成空闲长尾。
const ESTIMATED_SECONDS = new Map([
  ["src/cli/runner.test.ts", 9],
  ["src/cli/acp-daemon.test.ts", 13],
  ["src/plugins/host.test.ts", 35],
  ["src/plugins/commands/board.test.ts", 1],
  ["src/core/bitable-bootstrap.test.ts", 1],
  ["src/cli/acp-runner.test.ts", 4],
]);

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const discovered = [
    ...(await discoverTestFiles(SRC)),
    ...(await discoverTestFiles(SCRIPTS)),
  ];
  const selected = await attachTestManifests(selectFiles(discovered, options.scope));

  if (selected.length === 0) {
    console.error(`[测试] ${options.scope} 范围内没有测试文件`);
    process.exitCode = 1;
  } else if (options.serial) {
    const expectedTestCount = selected.reduce(
      (sum, entry) => sum + entry.testNames.length,
      0,
    );
    const result = await runTestFiles(selected.map((entry) => entry.path));
    process.stdout.write(result.output);
    if (result.exitCode !== 0 || result.testCount !== expectedTestCount) {
      console.error(
        `[测试] 测试数量不完整：预期 ${expectedTestCount} 项，实际 ${formatCount(result.testCount)}`,
      );
      process.exitCode = 1;
    }
  } else {
    const scheduled = expandShards(selected);
    await runParallel(scheduled, selected, options.workers);
  }
}

export function parseArguments(args, parallelism = availableParallelism()) {
  let scope = "all";
  let serial = false;
  let workers = process.env.THREADPILOT_TEST_WORKERS === undefined
    ? undefined
    : Number(process.env.THREADPILOT_TEST_WORKERS);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--serial") {
      serial = true;
    } else if (argument === "--scope") {
      scope = args[++index];
    } else if (argument === "--workers") {
      workers = Number(args[++index]);
    } else {
      throw new Error(`未知测试参数: ${argument}`);
    }
  }

  if (!["all", "fast", "cli", "plugins"].includes(scope)) {
    throw new Error(`未知测试范围: ${scope}`);
  }
  workers ??= scope === "all"
    ? Math.min(6, parallelism)
    : scope === "cli"
      ? Math.min(3, parallelism)
      : Math.min(4, parallelism);
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`测试并发数必须是正整数: ${workers}`);
  }
  return { scope, serial, workers };
}

async function discoverTestFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await discoverTestFiles(path)));
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.mjs"))
    ) {
      files.push({ path, size: (await stat(path)).size });
    }
  }
  return files;
}

function selectFiles(files, scope) {
  const prefix = scope === "all" ? undefined : scope === "fast" ? ["core", "im"] : [scope];
  return files
    .filter(({ path }) => {
      if (!prefix) return true;
      const firstSegment = relative(SRC, path).split(sep)[0];
      return prefix.includes(firstSegment) || (scope === "cli" && path.endsWith("cli-events.test.ts"));
    })
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
}

async function attachTestManifests(files) {
  return Promise.all(
    files.map(async (entry) => {
      const source = await readFile(entry.path, "utf8");
      return {
        ...entry,
        source,
        testNames: testNamesFromSource(source, entry.path),
      };
    }),
  );
}

function expandShards(files) {
  const scheduled = [];
  for (const entry of files) {
    const projectPath = relative(ROOT, entry.path).split(sep).join("/");
    const shardCount = SHARD_COUNTS.get(projectPath);
    if (!shardCount) {
      scheduled.push({
        ...entry,
        expectedTestCount: entry.testNames.length,
        schedulingWeight: ESTIMATED_SECONDS.get(projectPath) ?? entry.size / 10_000,
      });
      continue;
    }

    const names = testNamesFromSource(entry.source ?? "", entry.path, true);
    if (
      names.length === 0 ||
      names.length !== entry.testNames.length ||
      new Set(names).size !== names.length
    ) {
      throw new Error(`${projectPath} 的顶层测试名必须存在且唯一，无法安全分片`);
    }
    const shards = distributeTestNames(names, shardCount);
    shards.forEach((shardNames, index) => {
      scheduled.push({
        ...entry,
        shardIndex: index + 1,
        shardCount: shards.length,
        expectedTestCount: shardNames.length,
        schedulingWeight:
          (ESTIMATED_SECONDS.get(projectPath) ?? entry.size / 10_000) /
          shards.length,
        testNamePattern: `^(?:${shardNames.map(escapeRegExp).join("|")})$`,
      });
    });
  }
  return scheduled.sort(
    (left, right) =>
      right.schedulingWeight - left.schedulingWeight ||
      left.path.localeCompare(right.path) ||
      (left.shardIndex ?? 0) - (right.shardIndex ?? 0),
  );
}

export function distributeTestNames(names, requestedShardCount) {
  const shards = Array.from(
    { length: Math.min(requestedShardCount, names.length) },
    () => [],
  );
  names.forEach((name, index) => shards[index % shards.length].push(name));
  return shards;
}

export function testNamesFromSource(sourceText, path = "test.ts", topLevelOnly = false) {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    false,
    path.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const names = [];
  const inspectCall = (call) => {
    const directTest = ts.isIdentifier(call.expression) && call.expression.text === "test";
    const directIt = ts.isIdentifier(call.expression) && call.expression.text === "it";
    const decoratedTest =
      ts.isPropertyAccessExpression(call.expression) &&
      ts.isIdentifier(call.expression.expression) &&
      ["test", "it"].includes(call.expression.expression.text) &&
      ["only", "skip", "todo"].includes(call.expression.name.text);
    if (!directTest && !directIt && !decoratedTest) return;
    if (!call.arguments[0] || !ts.isStringLiteralLike(call.arguments[0])) {
      throw new Error(`${path} 包含非字面量顶层测试名，无法安全分片`);
    }
    names.push(call.arguments[0].text);
  };
  if (topLevelOnly) {
    for (const statement of source.statements) {
      if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        inspectCall(statement.expression);
      }
    }
  } else {
    const visit = (node) => {
      if (ts.isCallExpression(node)) inspectCall(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return names;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function runParallel(files, selectedFiles, workerCount) {
  const startedAt = performance.now();
  const results = [];
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < files.length) {
      const entry = files[nextIndex++];
      const result = await runTestFiles([entry.path], entry.testNamePattern);
      results.push({ ...result, path: entry.path, entry });
      const passed =
        result.exitCode === 0 && result.testCount === entry.expectedTestCount;
      const marker = passed ? "通过" : "失败";
      const count = result.testCount === entry.expectedTestCount
        ? `${result.testCount} 项`
        : `预期 ${entry.expectedTestCount} 项，实际 ${formatCount(result.testCount)}`;
      const shard = entry.shardIndex
        ? ` [分片 ${entry.shardIndex}/${entry.shardCount}]`
        : "";
      console.log(
        `[${marker}] ${relative(ROOT, entry.path)}${shard} (${count}, ${(result.durationMs / 1000).toFixed(2)}s)`,
      );
      if (!passed) process.stdout.write(result.output);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workerCount, files.length) }, () => runWorker()),
  );

  const failed = results.filter(
    (result) =>
      result.exitCode !== 0 || result.testCount !== result.entry.expectedTestCount,
  );
  const failedFiles = new Set(failed.map((result) => result.path));
  const totalTests = results.reduce((sum, result) => sum + (result.testCount ?? 0), 0);
  const expectedTests = selectedFiles.reduce(
    (sum, entry) => sum + entry.testNames.length,
    0,
  );
  const completedFiles = new Set(results.map((result) => result.path));
  const logicalFileCount = selectedFiles.length;
  const passedFileCount = selectedFiles.filter(
    (entry) => completedFiles.has(entry.path) && !failedFiles.has(entry.path),
  ).length;
  const durationSeconds = ((performance.now() - startedAt) / 1000).toFixed(2);
  console.log(
    `[测试] ${passedFileCount}/${logicalFileCount} 个文件，${totalTests}/${expectedTests} 项测试，${failedFiles.size} 个文件失败，${durationSeconds}s，workers=${workerCount}`,
  );

  if (
    failed.length > 0 ||
    results.length !== files.length ||
    completedFiles.size !== logicalFileCount ||
    totalTests !== expectedTests
  ) {
    process.exitCode = 1;
  }
}

function formatCount(value) {
  return value === undefined ? "摘要缺失" : `${value} 项`;
}

function runTestFiles(files, testNamePattern) {
  const startedAt = performance.now();
  const arguments_ = [
    "--import=tsx",
    "--test",
    "--experimental-test-isolation=none",
    "--test-concurrency=1",
    "--test-reporter=spec",
    ...(testNamePattern ? [`--test-name-pattern=${testNamePattern}`] : []),
    ...files,
  ];

  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, arguments_, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => (output += `${error.stack ?? error.message}\n`));
    child.on("close", (code) => {
      const summaries = [...output.matchAll(SUMMARY_PATTERN)];
      const testCount = summaries.length ? Number(summaries.at(-1)[1]) : undefined;
      resolvePromise({
        durationMs: performance.now() - startedAt,
        exitCode: code ?? 1,
        output,
        testCount,
      });
    });
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main();
}
