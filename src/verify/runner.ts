import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Framework = "vitest" | "jest" | "pytest";
export type RunnerLanguage = "js" | "python";

export interface RunResult {
  /** "error" means the tests couldn't run at all (import, syntax or collection errors), not that they failed. */
  status: "pass" | "fail" | "error" | "timeout";
  output: string;
  durationMs: number;
}

export interface TestRunner {
  framework: Framework;
  language: RunnerLanguage;
  run(files: string[], timeoutMs: number): Promise<RunResult>;
}

const MAX_OUTPUT = 20_000;

/** Output that means the test file never ran, per framework. */
const BROKEN: Record<Framework, RegExp> = {
  vitest:
    /No test files found|Failed to load url|Failed to resolve import|Cannot find module|SyntaxError|Transform failed|Failed to parse source/i,
  jest: /Test suite failed to run|Cannot find module|SyntaxError|No tests found/i,
  pytest:
    /ERROR collecting|ModuleNotFoundError|ImportError while importing|SyntaxError|no tests ran|file or directory not found/i,
};

/**
 * Environment for test processes: everything except secrets. Tests run PR code and AI-written code,
 * so tokens and API keys (including the Action's INPUT_* variables) are never passed on.
 */
export function scrubbedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(INPUT_|ACTIONS_)|TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH/i.test(key)) continue;
    clean[key] = value;
  }
  return { ...clean, CI: "true", NODE_ENV: "test", PYTHONDONTWRITEBYTECODE: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
}

/** Run a command in its own process group so a timeout kills test workers too. */
function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string; timedOut: boolean; durationMs: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, { cwd, env: scrubbedEnv(), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, output: output.slice(-MAX_OUTPUT), timedOut, durationMs: Date.now() - started });
    };
    child.on("close", done);
    child.on("error", (err) => {
      output += String(err);
      done(127);
    });
  });
}

function classify(framework: Framework, code: number | null, output: string, timedOut: boolean): RunResult["status"] {
  if (timedOut) return "timeout";
  if (code === 0) return "pass";
  // pytest: 2 = interrupted (collection errors), 4 = usage error, 5 = no tests collected.
  if (framework === "pytest" && (code === 2 || code === 4 || code === 5)) return "error";
  if (code === 127) return "error";
  return BROKEN[framework].test(output) ? "error" : "fail";
}

function makeRunner(
  framework: Framework,
  language: RunnerLanguage,
  root: string,
  command: (files: string[]) => [string, string[]],
): TestRunner {
  return {
    framework,
    language,
    async run(files, timeoutMs) {
      const [cmd, args] = command(files);
      const r = await exec(cmd, args, root, timeoutMs);
      return { status: classify(framework, r.code, r.output, r.timedOut), output: r.output, durationMs: r.durationMs };
    },
  };
}

function pythonCommand(): string | null {
  for (const py of ["python", "python3"]) {
    const r = spawnSync(py, ["-m", "pytest", "--version"], { encoding: "utf8", env: scrubbedEnv(), timeout: 30_000 });
    if (r.status === 0) return py;
  }
  return null;
}

/** Find the test frameworks this repository can actually run (installed, not just listed). */
export function detectRunners(root: string): Map<RunnerLanguage, TestRunner> {
  const runners = new Map<RunnerLanguage, TestRunner>();

  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    let deps: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      deps = { ...pkg.dependencies, ...pkg.devDependencies };
    } catch {
      // Unreadable package.json: no JS runner.
    }
    const bin = (name: string) => join(root, "node_modules", ".bin", name);
    if (deps.vitest && existsSync(bin("vitest"))) {
      runners.set(
        "js",
        makeRunner("vitest", "js", root, (files) => [bin("vitest"), ["run", "--reporter=dot", "--no-color", ...files]]),
      );
    } else if (deps.jest && existsSync(bin("jest"))) {
      runners.set(
        "js",
        makeRunner("jest", "js", root, (files) => [bin("jest"), ["--ci", "--colors=false", ...files]]),
      );
    }
  }

  const looksLikePython = [
    "pytest.ini",
    "pyproject.toml",
    "setup.cfg",
    "tox.ini",
    "conftest.py",
    "requirements.txt",
  ].some((f) => existsSync(join(root, f)));
  if (looksLikePython) {
    const py = pythonCommand();
    if (py) {
      runners.set(
        "python",
        makeRunner("pytest", "python", root, (files) => [
          py,
          ["-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", ...files],
        ]),
      );
    }
  }
  return runners;
}

/** Which runner applies to a source or test file. */
export function runnerLanguageOf(path: string): RunnerLanguage | null {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return "js";
  if (/\.py$/.test(path)) return "python";
  return null;
}
