import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { evalCases, findEvalCase, type EvalCase } from "./cases.js";
import {
  extractZeroSource,
  finalSourceResponseFailures,
  sourcePatternFailures,
} from "./source.js";

interface RunOptions {
  caseId: string | null;
  dryRun: boolean;
  fixture: boolean;
  json: boolean;
  keepAlive: boolean;
  maxTurns: number;
  models: string[];
  outDir: string;
  sandboxRuntime: string;
  sandboxTimeoutMs: number;
  sandboxTimeoutMsExplicit: boolean;
  sandboxVcpus: number;
  commandTimeoutMs: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface AgentToolResult {
  toolUseId: string;
  name: string;
  output: unknown;
}

interface AgentStep {
  turn: number;
  id: string;
  type: string;
  text: string;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
  usage: unknown;
}

interface AgentMetrics {
  turnCount: number;
  toolCallCount: number;
  zeroCliCallCount: number;
  zeroSkillLoadCount: number;
  zeroCheckCallCount: number;
  zeroRunCallCount: number;
}

interface AgentRun {
  responseText: string;
  steps: AgentStep[];
  metrics: AgentMetrics | null;
  error: string | null;
  rawOutputPath?: string;
  stderrPath?: string;
}

interface SandboxContext {
  sandbox: Sandbox;
  sandboxId: string;
  projectDir: string;
}

interface SandboxCredentials {
  token?: string;
  teamId?: string;
  projectId?: string;
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const zero = join(repoRoot, "bin", "zero");
const AI_GATEWAY_HOST = "ai-gateway.vercel.sh";
const AI_GATEWAY_URL = `https://${AI_GATEWAY_HOST}`;
const DEFAULT_PROJECT_DIR = "/vercel/sandbox/zero-lang";
const PROMPT_PATH = "/tmp/zero-eval-prompt.txt";
const REMOTE_EVAL_ROOT = "/tmp/zero-evals";
const REMOTE_RESULTS_ROOT = `${REMOTE_EVAL_ROOT}/results`;
const REMOTE_WORKSPACE_ROOT = `${REMOTE_EVAL_ROOT}/workspaces`;
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_SANDBOX_SETUP_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MODELS = [
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.6",
];
const LOCAL_ARCHIVE_EXCLUDE_DIRS = new Set([
  ".claude",
  ".cursor",
  ".vercel",
  ".zero",
]);

const systemPrompt = [
  "You are an agent evaluating a Zero programming task.",
  "Work inside the repository checkout prepared by the evaluator.",
  "Use the local ./bin/zero compiler as your source of Zero-specific guidance and verification.",
  "First run ./bin/zero skills get zero --full.",
  "Load any additional skills recommended by that skill before writing code.",
  "Use ./bin/zero check --json to inspect diagnostics, then ./bin/zero run to verify stdout.",
  "For the final answer, output code only: exactly the verified source bytes.",
  "Do not summarize success, mention stdout, add a preamble, or use Markdown fences.",
].join("\n");

async function main() {
  loadDotEnvFiles([".env", ".env.local"]);
  const options = parseArgs(process.argv.slice(2));
  const selectedCases = selectCases(options.caseId);
  applyDefaultSandboxTimeout(options, selectedCases.length);

  if (options.dryRun) {
    printJsonOrText(options.json, {
      models: options.models,
      gatewayURL: AI_GATEWAY_URL,
      maxTurns: options.maxTurns,
      commandTimeoutMs: options.commandTimeoutMs,
      sandboxTimeoutMs: options.sandboxTimeoutMs,
      mode: options.fixture ? "fixture" : "sandbox",
      cases: selectedCases.map(
        ({ id, title, prompt, expectedStdout, requiredSourcePatterns }) => ({
          id,
          title,
          prompt,
          expectedStdout,
          requiredSourcePatternCount: requiredSourcePatterns.length,
        }),
      ),
    });
    return;
  }

  await mkdir(options.outDir, { recursive: true });

  let sandboxContext: SandboxContext | null = null;
  try {
    if (!options.fixture) {
      sandboxContext = await createSandboxContext(options);
    }

    const results = [];
    for (const model of options.models) {
      for (const evalCase of selectedCases) {
        results.push(await runCase(evalCase, model, options, sandboxContext));
      }
    }

    const summary = {
      ok: results.every((result) => result.passed),
      models: options.models,
      outDir: options.outDir,
      sandboxId: sandboxContext?.sandboxId ?? null,
      sandboxKeptAlive: Boolean(sandboxContext && options.keepAlive),
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      results,
    };

    await writeFile(
      join(options.outDir, "summary.json"),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    printJsonOrText(options.json, summary);
    if (!summary.ok) process.exitCode = 1;
  } finally {
    if (sandboxContext && !options.keepAlive) {
      await sandboxContext.sandbox.stop({ blocking: true }).catch(() => {});
    } else if (sandboxContext) {
      process.stderr.write(
        `Leaving Vercel Sandbox running: ${sandboxContext.sandboxId}\n`,
      );
    }
  }
}

async function createSandboxContext(
  options: RunOptions,
): Promise<SandboxContext> {
  ensureSandboxAuthEnv();
  const gatewayCredential = resolveGatewayCredential();
  const archivePath = createSourceArchive(options.outDir);
  const sandboxCredentials = resolveSandboxCredentials();

  process.stderr.write("Creating Vercel Sandbox for Zero evals...\n");
  const sandbox = await Sandbox.create({
    ...sandboxCredentials,
    runtime: options.sandboxRuntime,
    timeout: options.sandboxTimeoutMs,
    resources: { vcpus: options.sandboxVcpus },
    networkPolicy: buildAIGatewayNetworkPolicy(gatewayCredential),
    env: buildClaudeGatewayEnv(),
  });
  const sandboxId = sandbox.sandboxId;
  const projectDir =
    process.env.ZERO_EVAL_SANDBOX_PROJECT_DIR?.trim() || DEFAULT_PROJECT_DIR;

  try {
    process.stderr.write(`Sandbox ready: ${sandboxId}\n`);
    await sandbox.writeFiles([
      {
        path: "/tmp/zero-lang-source.tar.gz",
        content: readFileSync(archivePath),
      },
    ]);
    await runSandboxCommandChecked(
      sandbox,
      {
        cmd: "bash",
        args: ["-lc", buildSandboxSetupScript(projectDir)],
      },
      "sandbox setup",
    );
    return { sandbox, sandboxId, projectDir };
  } catch (error) {
    await sandbox.stop({ blocking: true }).catch(() => {});
    throw error;
  }
}

async function runCase(
  evalCase: EvalCase,
  model: string,
  options: RunOptions,
  sandboxContext: SandboxContext | null,
) {
  const started = performance.now();
  const caseDir = join(options.outDir, modelPathSegment(model), evalCase.id);
  await rm(caseDir, { force: true, recursive: true });
  await mkdir(caseDir, { recursive: true });
  const sandboxProjectDir = sandboxContext
    ? await createSandboxRunWorkspace(sandboxContext, evalCase, model)
    : null;

  const agentRun: AgentRun =
    options.fixture || !sandboxContext || !sandboxProjectDir
      ? {
          responseText: evalCase.fixtureSource,
          steps: [],
          metrics: null,
          error: null,
        }
      : await runSandboxAgentCase(
          evalCase,
          model,
          options,
          sandboxContext,
          sandboxProjectDir,
          caseDir,
        );

  const responsePath = join(caseDir, "response.md");
  const stepsPath = options.fixture ? null : join(caseDir, "steps.json");
  const sourcePath = join(caseDir, "candidate.0");
  const source = extractZeroSource(agentRun.responseText);

  await writeFile(responsePath, agentRun.responseText);
  if (stepsPath) {
    await writeFile(stepsPath, `${JSON.stringify(agentRun.steps, null, 2)}\n`);
  }
  await writeFile(sourcePath, source);

  const validation = sandboxContext
    ? await validateSourceInSandbox(
        sandboxContext,
        evalCase,
        model,
        source,
        sandboxProjectDir ?? sandboxContext.projectDir,
      )
    : await validateSourceLocally(sourcePath);
  const { check, run, remoteSourcePath } = validation;

  let error: string | null =
    agentRun.error ?? (check.code === 0 ? null : "zero check failed");
  const patternFailures = sourcePatternFailures(
    source,
    evalCase.requiredSourcePatterns,
  );
  const responseFormatFailures = finalSourceResponseFailures(
    agentRun.responseText,
    source,
  );
  const agentRequirementFailures = options.fixture
    ? []
    : getAgentRequirementFailures(agentRun.metrics, options.maxTurns);
  const actualStdout = run?.stdout ?? "";
  const passed =
    agentRun.error === null &&
    check.code === 0 &&
    run?.code === 0 &&
    actualStdout === evalCase.expectedStdout &&
    patternFailures.length === 0 &&
    responseFormatFailures.length === 0 &&
    agentRequirementFailures.length === 0;

  if (!passed && !error) {
    error = failureReason({
      run,
      actualStdout,
      expectedStdout: evalCase.expectedStdout,
      patternFailures,
      responseFormatFailures,
      agentRequirementFailures,
    });
  }

  const result = {
    id: evalCase.id,
    title: evalCase.title,
    passed,
    model,
    mode: options.fixture ? "fixture" : "sandbox",
    durationMs: Math.round(performance.now() - started),
    sourcePath,
    remoteSourcePath,
    remoteProjectDir: sandboxProjectDir,
    responsePath,
    stepsPath,
    rawOutputPath: agentRun.rawOutputPath ?? null,
    stderrPath: agentRun.stderrPath ?? null,
    agentError: agentRun.error,
    agent: agentRun.metrics,
    check,
    run,
    expectedStdout: evalCase.expectedStdout,
    actualStdout,
    sourcePatternFailures: patternFailures,
    responseFormatFailures,
    agentRequirementFailures,
    error,
  };

  await writeFile(
    join(caseDir, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
}

async function runSandboxAgentCase(
  evalCase: EvalCase,
  model: string,
  options: RunOptions,
  context: SandboxContext,
  projectDir: string,
  caseDir: string,
): Promise<AgentRun> {
  const prompt = buildClaudePrompt(evalCase, options, projectDir);
  await context.sandbox.writeFiles([
    {
      path: PROMPT_PATH,
      content: prompt,
      mode: 0o600,
    },
  ]);

  const claudeArgs = [
    "--model",
    shellQuote(claudeModelName(model)),
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  const commandTimeoutSeconds = Math.max(
    1,
    Math.ceil(options.commandTimeoutMs / 1000),
  );
  const script = [
    "set -euo pipefail",
    `cd ${shellQuote(projectDir)}`,
    `export ANTHROPIC_BASE_URL=${shellQuote(AI_GATEWAY_URL)}`,
    "export ANTHROPIC_AUTH_TOKEN=placeholder",
    "export ANTHROPIC_API_KEY=",
    `export BASH_DEFAULT_TIMEOUT_MS=${shellQuote(String(Math.min(options.commandTimeoutMs, 600_000)))}`,
    `export BASH_MAX_TIMEOUT_MS=${shellQuote(String(options.commandTimeoutMs))}`,
    `ZERO_EVAL_PROMPT="$(cat ${shellQuote(PROMPT_PATH)})"`,
    `timeout --foreground ${commandTimeoutSeconds}s claude ${claudeArgs.join(" ")} -p "$ZERO_EVAL_PROMPT"`,
  ].join("\n");

  const output = await runSandboxCommand(
    context.sandbox,
    {
      cmd: "bash",
      args: ["-lc", script],
      cwd: projectDir,
    },
    "claude eval",
  );
  const rawOutputPath = join(caseDir, "claude-stream.jsonl");
  const stderrPath = join(caseDir, "claude-stderr.txt");
  await writeFile(rawOutputPath, output.stdout);
  await writeFile(stderrPath, output.stderr);

  const parsed = parseClaudeStream(output.stdout);
  const commandError =
    output.code === 0
      ? null
      : `Claude Code failed with exit code ${output.code}\n${truncate(output.stderr || output.stdout, 4_000)}`;
  const resultError =
    commandError ??
    (parsed.responseText.trim()
      ? null
      : "Claude Code stream did not include a final result");
  return { ...parsed, error: resultError, rawOutputPath, stderrPath };
}

async function createSandboxRunWorkspace(
  context: SandboxContext,
  evalCase: EvalCase,
  model: string,
) {
  const workspaceDir = `${REMOTE_WORKSPACE_ROOT}/${modelPathSegment(model)}/${modelPathSegment(evalCase.id)}`;
  const script = [
    "set -euo pipefail",
    `rm -rf ${shellQuote(workspaceDir)}`,
    `mkdir -p ${shellQuote(workspaceDir)}`,
    `cp -a ${shellQuote(`${context.projectDir}/.`)} ${shellQuote(workspaceDir)}`,
  ].join("\n");
  await runSandboxCommandChecked(
    context.sandbox,
    {
      cmd: "bash",
      args: ["-lc", script],
    },
    "prepare eval workspace",
  );
  return workspaceDir;
}

function buildClaudePrompt(
  evalCase: EvalCase,
  options: RunOptions,
  projectDir: string,
) {
  return [
    systemPrompt,
    "",
    "Task:",
    evalCase.prompt,
    "",
    `Repository root: ${projectDir}`,
    `You have at most ${options.maxTurns} agent turns before the evaluator marks the run failed.`,
    "Use shell commands from the repository root. Prefer ./bin/zero, not any global zero binary.",
    "After ./bin/zero check and ./bin/zero run confirm the expected output, return code only.",
    "Do not include a success sentence, explanation, or Markdown fence.",
  ].join("\n");
}

async function validateSourceLocally(sourcePath: string) {
  const check = await runLocalCommand(zero, ["check", "--json", sourcePath]);
  let run: CommandResult | null = null;
  if (check.code === 0) {
    run = await runLocalCommand(zero, [
      "run",
      "--out",
      join(dirname(sourcePath), "program"),
      sourcePath,
    ]);
  }
  return { check, run, remoteSourcePath: null };
}

async function validateSourceInSandbox(
  context: SandboxContext,
  evalCase: EvalCase,
  model: string,
  source: string,
  projectDir: string,
) {
  const remoteCaseDir = `${REMOTE_RESULTS_ROOT}/${modelPathSegment(model)}/${
    evalCase.id
  }`;
  const remoteSourcePath = `${remoteCaseDir}/candidate.0`;
  await runSandboxCommandChecked(
    context.sandbox,
    { cmd: "mkdir", args: ["-p", remoteCaseDir] },
    "create eval case directory",
  );
  await context.sandbox.writeFiles([
    {
      path: remoteSourcePath,
      content: source,
    },
  ]);

  const check = await runSandboxCommand(
    context.sandbox,
    {
      cmd: "bash",
      args: ["-lc", `./bin/zero check --json ${shellQuote(remoteSourcePath)}`],
      cwd: projectDir,
    },
    "zero check",
  );
  let run: CommandResult | null = null;
  if (check.code === 0) {
    run = await runSandboxCommand(
      context.sandbox,
      {
        cmd: "bash",
        args: [
          "-lc",
          `./bin/zero run --out ${shellQuote(`${remoteCaseDir}/program`)} ${shellQuote(remoteSourcePath)}`,
        ],
        cwd: projectDir,
      },
      "zero run",
    );
  }

  return { check, run, remoteSourcePath };
}

async function runSandboxCommand(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  },
  _label: string,
): Promise<CommandResult> {
  const result = await sandbox.runCommand(params);
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()]);
  return { code: result.exitCode, stdout, stderr };
}

async function runSandboxCommandChecked(
  sandbox: Sandbox,
  params: {
    cmd: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  },
  label: string,
) {
  process.stderr.write(`${label}...\n`);
  const result = await runSandboxCommand(sandbox, params, label);
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.code}\n${truncate(result.stderr || result.stdout, 4_000)}`,
    );
  }
  return result;
}

function parseClaudeStream(output: string): AgentRun {
  const steps: AgentStep[] = [];
  let responseText = "";
  let latestAssistantText = "";
  let toolResultCount = 0;

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    const eventType = typeof event.type === "string" ? event.type : "unknown";
    if (eventType === "assistant") {
      const message = isRecord(event.message) ? event.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCalls: AgentToolCall[] = [];
      const textParts: string[] = [];
      for (const block of content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: typeof block.id === "string" ? block.id : "",
            name: typeof block.name === "string" ? block.name : "tool",
            input: "input" in block ? block.input : null,
          });
        }
      }
      latestAssistantText = textParts.join("");
      steps.push({
        turn: steps.length + 1,
        id: typeof message.id === "string" ? message.id : "",
        type: eventType,
        text: truncate(latestAssistantText, 4_000),
        toolCalls,
        toolResults: [],
        usage: "usage" in message ? message.usage : null,
      });
      continue;
    }

    if (eventType === "user") {
      const message = isRecord(event.message) ? event.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      const toolResults: AgentToolResult[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        toolResultCount += 1;
        toolResults.push({
          toolUseId:
            typeof block.tool_use_id === "string"
              ? block.tool_use_id
              : `tool-result-${toolResultCount}`,
          name: "tool_result",
          output: summarizeToolResult(block),
        });
      }
      if (toolResults.length > 0) {
        const latest = steps.at(-1);
        if (latest) {
          latest.toolResults.push(...toolResults);
        } else {
          steps.push({
            turn: steps.length + 1,
            id: "",
            type: eventType,
            text: "",
            toolCalls: [],
            toolResults,
            usage: null,
          });
        }
      }
      continue;
    }

    if (eventType === "result") {
      responseText =
        typeof event.result === "string" ? event.result : latestAssistantText;
    }
  }

  if (!responseText) responseText = latestAssistantText;
  return {
    responseText,
    steps,
    metrics: measureAgent(steps),
    error: null,
  };
}

function summarizeToolResult(block: Record<string, unknown>) {
  const value = block.content;
  if (typeof value !== "string") return value ?? null;
  return truncate(value, 2_000);
}

function createSourceArchive(outDir: string) {
  const archivePath = join(outDir, "source.tar.gz");
  const fileListPath = join(outDir, "source-files.txt");
  writeFileSync(fileListPath, buildSourceArchiveFileList(outDir));
  const metadataArgs = process.platform === "darwin" ? ["--no-xattrs"] : [];
  const result = spawnSync(
    "tar",
    [...metadataArgs, "--null", "-T", fileListPath, "-czf", archivePath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to create eval source archive\n${result.stderr.trim()}`,
    );
  }
  return archivePath;
}

function buildSourceArchiveFileList(outDir: string) {
  const result = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `failed to list eval source files\n${result.stderr.trim()}`,
    );
  }

  const outDirPath = repoRelativePath(outDir);
  const entries = result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((entry) => existsSync(join(repoRoot, entry)))
    .filter((entry) => !isLocalArchiveConfigPath(entry))
    .filter((entry) => !outDirPath || !isPathAtOrBelow(entry, outDirPath));

  if (entries.length === 0) {
    throw new Error(
      "failed to create eval source archive: no source files found",
    );
  }

  return `${entries.join("\0")}\0`;
}

function isLocalArchiveConfigPath(path: string) {
  const [firstSegment] = path.split("/", 1);
  if (LOCAL_ARCHIVE_EXCLUDE_DIRS.has(firstSegment)) return true;
  if (path === ".env") return true;
  if (path.startsWith(".env.") && path !== ".env.example") return true;
  return false;
}

function repoRelativePath(path: string) {
  const relativePath = relative(repoRoot, resolve(path)).replaceAll("\\", "/");
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("/")
  ) {
    return null;
  }
  return relativePath;
}

function isPathAtOrBelow(path: string, parent: string) {
  return path === parent || path.startsWith(`${parent}/`);
}

function buildSandboxSetupScript(projectDir: string) {
  return [
    "set -euo pipefail",
    "as_root() { if command -v sudo >/dev/null 2>&1; then sudo \"$@\"; else \"$@\"; fi; }",
    "install_build_tools() {",
    "  if command -v make >/dev/null 2>&1 && { command -v cc >/dev/null 2>&1 || command -v gcc >/dev/null 2>&1 || command -v clang >/dev/null 2>&1; }; then return; fi",
    "  if command -v apt-get >/dev/null 2>&1; then",
    "    as_root apt-get update",
    "    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential ca-certificates git gzip make npm tar",
    "  elif command -v apk >/dev/null 2>&1; then",
    "    as_root apk add --no-cache build-base ca-certificates git gzip make npm tar",
    "  elif command -v dnf >/dev/null 2>&1; then",
    "    as_root dnf install -y ca-certificates gcc git glibc-devel gzip make npm tar",
    "  elif command -v yum >/dev/null 2>&1; then",
    "    as_root yum install -y ca-certificates gcc git glibc-devel gzip make npm tar",
    "  else",
    "    echo 'no supported package manager found to install make and a C compiler' >&2",
    "    exit 127",
    "  fi",
    "}",
    "install_build_tools",
    `rm -rf ${shellQuote(projectDir)}`,
    `mkdir -p ${shellQuote(projectDir)}`,
    `tar -xzf /tmp/zero-lang-source.tar.gz -C ${shellQuote(projectDir)}`,
    `cd ${shellQuote(projectDir)}`,
    "make -C native/zero-c",
    "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code",
    "claude --version",
    "./bin/zero --version",
  ].join("\n");
}

function buildAIGatewayNetworkPolicy(gatewayCredential: string): NetworkPolicy {
  return {
    allow: {
      "*": [],
      [AI_GATEWAY_HOST]: [
        {
          transform: [
            {
              headers: {
                authorization: `Bearer ${gatewayCredential}`,
              },
            },
          ],
        },
      ],
    },
  };
}

function buildClaudeGatewayEnv() {
  return {
    ANTHROPIC_BASE_URL: AI_GATEWAY_URL,
    // Claude Code expects Anthropic-shaped auth, but the sandbox policy injects
    // the real AI Gateway bearer token on outbound requests.
    ANTHROPIC_AUTH_TOKEN: "placeholder",
    ANTHROPIC_API_KEY: "",
  };
}

function resolveGatewayCredential() {
  const credential =
    process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;

  if (!credential) {
    throw new Error(
      [
        "Missing AI Gateway credential.",
        "Set AI_GATEWAY_API_KEY or run `vercel env pull` to provide VERCEL_OIDC_TOKEN.",
      ].join(" "),
    );
  }

  return credential;
}

function resolveSandboxCredentials(): SandboxCredentials {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;

  if (token && teamId && projectId) {
    return { token, teamId, projectId };
  }

  return {};
}

function ensureSandboxAuthEnv() {
  const credentials = resolveSandboxCredentials();
  if (credentials.token && credentials.teamId && credentials.projectId) return;
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return;
  throw new Error(
    [
      "Missing Vercel Sandbox credentials.",
      "Set VERCEL_OIDC_TOKEN, or set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
    ].join(" "),
  );
}

function loadDotEnvFiles(paths: string[]) {
  for (const path of paths) {
    const fullPath = join(repoRoot, path);
    if (!existsSync(fullPath)) continue;
    const lines = readFileSync(fullPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(
        trimmed,
      );
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = parseDotEnvValue(match[2]);
    }
  }
}

function parseDotEnvValue(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "\""
      ? inner
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, "\"")
          .replace(/\\\\/g, "\\")
      : inner;
  }
  const commentStart = trimmed.search(/\s#/);
  return commentStart === -1 ? trimmed : trimmed.slice(0, commentStart).trimEnd();
}

function shellQuote(value: string) {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function claudeModelName(value: string) {
  return value.startsWith("anthropic/") ? value.slice("anthropic/".length) : value;
}

function parseArgs(args: string[]): RunOptions {
  let caseId: string | null = null;
  let dryRun = false;
  let fixture = false;
  let json = false;
  let keepAlive = false;
  let maxTurns = 10;
  let models = defaultModels();
  const requestedModels: string[] = [];
  let outDir = join(repoRoot, ".zero", "evals", "runs", timestamp());
  let sandboxRuntime = process.env.ZERO_EVAL_SANDBOX_RUNTIME ?? "node24";
  let sandboxTimeoutMsExplicit =
    process.env.ZERO_EVAL_SANDBOX_TIMEOUT_MS !== undefined &&
    process.env.ZERO_EVAL_SANDBOX_TIMEOUT_MS !== "";
  let sandboxTimeoutMs = parsePositiveIntOrDefault(
    process.env.ZERO_EVAL_SANDBOX_TIMEOUT_MS,
    DEFAULT_SANDBOX_TIMEOUT_MS,
    "ZERO_EVAL_SANDBOX_TIMEOUT_MS",
  );
  let sandboxVcpus = parsePositiveIntOrDefault(
    process.env.ZERO_EVAL_SANDBOX_VCPUS,
    4,
    "ZERO_EVAL_SANDBOX_VCPUS",
  );
  let commandTimeoutMs = parsePositiveIntOrDefault(
    process.env.ZERO_EVAL_COMMAND_TIMEOUT_MS,
    DEFAULT_COMMAND_TIMEOUT_MS,
    "ZERO_EVAL_COMMAND_TIMEOUT_MS",
  );

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--case") {
      caseId = requiredValue(args, ++i, "--case");
    } else if (arg === "--model") {
      requestedModels.push(
        ...parseModelList(requiredValue(args, ++i, "--model"), "--model"),
      );
    } else if (arg === "--models") {
      requestedModels.push(
        ...parseModelList(requiredValue(args, ++i, "--models"), "--models"),
      );
    } else if (arg === "--max-turns") {
      maxTurns = parsePositiveInt(
        requiredValue(args, ++i, "--max-turns"),
        "--max-turns",
      );
    } else if (arg === "--out") {
      outDir = resolve(requiredValue(args, ++i, "--out"));
    } else if (arg === "--sandbox-runtime") {
      sandboxRuntime = requiredValue(args, ++i, "--sandbox-runtime");
    } else if (arg === "--sandbox-timeout-ms") {
      sandboxTimeoutMsExplicit = true;
      sandboxTimeoutMs = parsePositiveInt(
        requiredValue(args, ++i, "--sandbox-timeout-ms"),
        "--sandbox-timeout-ms",
      );
    } else if (arg === "--sandbox-vcpus") {
      sandboxVcpus = parsePositiveInt(
        requiredValue(args, ++i, "--sandbox-vcpus"),
        "--sandbox-vcpus",
      );
    } else if (arg === "--command-timeout-ms") {
      commandTimeoutMs = parsePositiveInt(
        requiredValue(args, ++i, "--command-timeout-ms"),
        "--command-timeout-ms",
      );
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--fixture") {
      fixture = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--keep-alive") {
      keepAlive = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown evals flag: ${arg}`);
    }
  }

  if (requestedModels.length > 0) {
    models = uniqueOrdered(requestedModels);
  }

  return {
    caseId,
    dryRun,
    fixture,
    json,
    keepAlive,
    maxTurns,
    models,
    outDir,
    sandboxRuntime,
    sandboxTimeoutMs,
    sandboxTimeoutMsExplicit,
    sandboxVcpus,
    commandTimeoutMs,
  };
}

function applyDefaultSandboxTimeout(options: RunOptions, caseCount: number) {
  if (options.fixture || options.sandboxTimeoutMsExplicit) return;
  const runCount = Math.max(1, options.models.length * caseCount);
  const requiredTimeoutMs =
    DEFAULT_SANDBOX_SETUP_TIMEOUT_MS + runCount * options.commandTimeoutMs;
  options.sandboxTimeoutMs = Math.max(
    options.sandboxTimeoutMs,
    requiredTimeoutMs,
  );
}

function defaultModels() {
  if (process.env.ZERO_EVAL_MODELS) {
    return parseModelList(process.env.ZERO_EVAL_MODELS, "ZERO_EVAL_MODELS");
  }
  if (process.env.ZERO_EVAL_MODEL) {
    return parseModelList(process.env.ZERO_EVAL_MODEL, "ZERO_EVAL_MODEL");
  }
  return DEFAULT_MODELS;
}

function parseModelList(value: string, label: string): string[] {
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  if (models.length === 0) {
    throw new Error(`${label} requires at least one model id`);
  }
  return uniqueOrdered(models);
}

function uniqueOrdered(values: string[]) {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function selectCases(caseId: string | null) {
  if (!caseId) return evalCases;
  const evalCase = findEvalCase(caseId);
  if (!evalCase) {
    const ids = evalCases.map((item) => item.id).join(", ");
    throw new Error(`Unknown eval case '${caseId}'. Available cases: ${ids}`);
  }
  return [evalCase];
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parsePositiveIntOrDefault(
  value: string | undefined,
  fallback: number,
  label: string,
) {
  if (value === undefined || value === "") return fallback;
  return parsePositiveInt(value, label);
}

async function runLocalCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    execFile(
      command,
      args,
      { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs },
      (error, stdout, stderr) => {
        const code =
          typeof error?.code === "number" ? error.code : error ? 1 : 0;
        resolveCommand({ code, stdout, stderr });
      },
    );
  });
}

function failureReason(input: {
  run: CommandResult | null;
  actualStdout: string;
  expectedStdout: string;
  patternFailures: string[];
  responseFormatFailures: string[];
  agentRequirementFailures: string[];
}) {
  if (!input.run) return "zero run did not execute";
  if (input.run.code !== 0) return `zero run exited ${input.run.code}`;
  if (input.actualStdout !== input.expectedStdout) {
    return "stdout did not match expected output";
  }
  if (input.patternFailures.length > 0) {
    return "source did not match required patterns";
  }
  if (input.responseFormatFailures.length > 0) {
    return "final response included prose or Markdown";
  }
  if (input.agentRequirementFailures.length > 0) {
    return "agent did not satisfy the required Zero CLI workflow";
  }
  return "unknown failure";
}

function getAgentRequirementFailures(
  metrics: AgentMetrics | null,
  maxTurns: number,
): string[] {
  if (!metrics) return ["missing agent metrics"];
  const failures = [];
  if (metrics.turnCount > maxTurns) {
    failures.push(
      `agent used ${metrics.turnCount} turns, exceeding max ${maxTurns}`,
    );
  }
  if (metrics.zeroCliCallCount === 0) failures.push("zero CLI was not called");
  if (metrics.zeroSkillLoadCount === 0) {
    failures.push("zero skill was not loaded");
  }
  if (metrics.zeroCheckCallCount === 0) failures.push("zero check was not called");
  if (metrics.zeroRunCallCount === 0) failures.push("zero run was not called");
  return failures;
}

function measureAgent(steps: AgentStep[]): AgentMetrics {
  const toolCalls = steps.flatMap((step) => step.toolCalls);
  const commands = toolCalls
    .map((call) => toolCommand(call))
    .filter((command): command is string => Boolean(command));
  const zeroCommands = commands.filter(isZeroCliCommand);
  return {
    turnCount: steps.length,
    toolCallCount: toolCalls.length,
    zeroCliCallCount: zeroCommands.length,
    zeroSkillLoadCount: zeroCommands.filter(isZeroSkillLoadCommand).length,
    zeroCheckCallCount: zeroCommands.filter((command) =>
      /\b(?:\.\/)?bin\/zero\s+check\b/.test(command),
    ).length,
    zeroRunCallCount: zeroCommands.filter((command) =>
      /\b(?:\.\/)?bin\/zero\s+run\b/.test(command),
    ).length,
  };
}

function toolCommand(call: AgentToolCall): string | null {
  if (!isRecord(call.input)) return null;
  const command = call.input.command;
  return typeof command === "string" ? command : null;
}

function isZeroCliCommand(command: string) {
  return /\b(?:\.\/)?bin\/zero\b/.test(command);
}

function isZeroSkillLoadCommand(command: string) {
  return (
    /\b(?:\.\/)?bin\/zero\s+skills\s+get\s+zero\b/.test(command) &&
    /--full\b/.test(command)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function modelPathSegment(model: string) {
  const segment = model
    .replace(/\//g, "__")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return segment || "model";
}

function printJsonOrText(json: boolean, value: unknown) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (isSummary(value)) {
    for (const result of value.results) {
      const steps = result.agent
        ? `, ${result.agent.turnCount} turns, ${result.agent.toolCallCount} tools`
        : "";
      const status = result.passed ? "PASS" : "FAIL";
      console.log(
        `${status} ${result.model} ${result.id} ${result.mode} (${result.durationMs} ms${steps})`,
      );
      if (!result.passed && result.error) console.log(`  ${result.error}`);
      if (result.agentRequirementFailures.length > 0) {
        console.log(`  ${result.agentRequirementFailures.join("; ")}`);
      }
      if (result.responseFormatFailures.length > 0) {
        console.log(`  ${result.responseFormatFailures.join("; ")}`);
      }
    }
    if (value.sandboxId) {
      console.log(
        `sandbox: ${value.sandboxId}${value.sandboxKeptAlive ? " (kept alive)" : ""}`,
      );
    }
    console.log(`results: ${value.outDir}`);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function isSummary(value: unknown): value is {
  outDir: string;
  sandboxId: string | null;
  sandboxKeptAlive: boolean;
  results: Array<{
    id: string;
    model: string;
    mode: string;
    passed: boolean;
    durationMs: number;
    error: string | null;
    agent: AgentMetrics | null;
    agentRequirementFailures: string[];
    responseFormatFailures: string[];
  }>;
} {
  return Boolean(
    value &&
      typeof value === "object" &&
      "results" in value &&
      Array.isArray(value.results),
  );
}

function printHelp() {
  console.log(`Usage: pnpm evals -- [options]

Options:
  --case <id>              Run one case, e.g. hello-world
  --model <id>             AI Gateway model id. May be repeated; overrides defaults
  --models <ids>           Comma-separated AI Gateway model ids; overrides defaults
  --max-turns <n>          Maximum Claude turns before failing scoring (default: 10)
  --out <dir>              Output directory (default: .zero/evals/runs/<timestamp>)
  --sandbox-runtime <id>   Vercel Sandbox runtime (default: ZERO_EVAL_SANDBOX_RUNTIME or node24)
  --sandbox-timeout-ms <n> Sandbox timeout (default: ZERO_EVAL_SANDBOX_TIMEOUT_MS or enough for selected runs)
  --sandbox-vcpus <n>      Sandbox vCPU count (default: ZERO_EVAL_SANDBOX_VCPUS or 4)
  --command-timeout-ms <n> Claude command timeout (default: ZERO_EVAL_COMMAND_TIMEOUT_MS or 1200000)
  --keep-alive             Leave the Vercel Sandbox running after the eval
  --dry-run                Print selected cases without creating a sandbox
  --fixture                Run checked-in fixture answers locally instead of calling Claude
  --json                   Print JSON output

Live eval credentials:
  Vercel Sandbox: VERCEL_OIDC_TOKEN, or VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID
  AI Gateway: AI_GATEWAY_API_KEY or VERCEL_OIDC_TOKEN

Default models:
  ${DEFAULT_MODELS.join("\n  ")}

Model environment:
  ZERO_EVAL_MODELS=<comma-separated ids>
  ZERO_EVAL_MODEL=<single id, kept for compatibility>
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
