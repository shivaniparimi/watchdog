import { minimatch } from "minimatch";
import type { FileKind, Language } from "./types.js";

const EXTENSIONS: Record<string, Language> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "python",
  go: "go",
  java: "java",
};

/** Paths that never need tests: dependencies, build output, generated code, config. */
const ALWAYS_IGNORE = [
  /(^|\/)(node_modules|vendor|dist|build|out|coverage|\.next|__generated__|generated|migrations)\//,
  /\.d\.[cm]?ts$/,
  /\.min\.js$/,
  /(^|\/)[^/]+\.config\.[cm]?[jt]s$/,
  /(^|\/)(setup|conftest)\.py$/,
  /(^|\/)__init__\.py$/,
];

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?|spec|e2e)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go)$/,
  /(Test|Tests|IT)\.java$/,
];

export function languageOf(path: string): Language | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSIONS[ext] ?? null;
}

/** ts and js tests can cover each other, so they share a family. */
export function languageFamily(lang: Language): string {
  return lang === "ts" || lang === "js" ? "js" : lang;
}

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

export function classifyFile(path: string, ignoreGlobs: string[] = []): FileKind {
  if (!languageOf(path)) return "ignore";
  if (ignoreGlobs.some((glob) => minimatch(path, glob, { dot: true }))) return "ignore";
  if (isTestPath(path)) return "test";
  if (ALWAYS_IGNORE.some((re) => re.test(path))) return "ignore";
  return "source";
}
