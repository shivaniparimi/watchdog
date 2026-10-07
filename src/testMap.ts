import { classifyFile, languageFamily, languageOf } from "./classify.js";
import type { Language } from "./types.js";

/** Read-only view of the repository at the PR's head commit. */
export interface RepoReader {
  listFiles(): string[];
  read(path: string): string | null;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

/** The module name a source file is imported as. `src/cart/index.ts` → `cart`. */
export function sourceStem(path: string): string {
  const stem = stripExt(basename(path));
  return stem === "index" || stem === "__init__" ? basename(dirname(path)) || stem : stem;
}

/** The module a test file is named after. `total.test.ts`, `test_total.py`, `TotalTest.java` → `total`. */
export function testStem(path: string): string {
  return stripExt(basename(path))
    .replace(/\.(test|spec)$/, "")
    .replace(/^test_/, "")
    .replace(/_test$/, "")
    .replace(/(Test|Tests|IT)$/, "")
    .toLowerCase();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does the test file import the source module? */
function importsModule(testContent: string, sourcePath: string, lang: Language): boolean {
  const stem = escapeRegex(sourceStem(sourcePath));
  const fileStem = escapeRegex(stripExt(basename(sourcePath)));
  switch (lang) {
    case "ts":
    case "js":
      // from '../cart/total'  /  require("./total.js")  /  from '@/cart'
      return new RegExp(`(from|require\\(|import\\()\\s*["'][^"']*\\/(${stem}|${fileStem})(\\.[cm]?[jt]sx?)?["']`).test(
        testContent,
      );
    case "python":
      // from app.cart.total import x  /  import app.cart.total  /  from app.cart import total
      return new RegExp(
        `^\\s*(from\\s+[\\w.]*\\b${stem}\\b[\\w.]*\\s+import|import\\s+[\\w.]*\\b${stem}\\b|from\\s+[\\w.]+\\s+import\\s+.*\\b${stem}\\b)`,
        "m",
      ).test(testContent);
    case "java":
      return new RegExp(`\\b${fileStem}\\b`).test(testContent);
    case "go":
      return false; // Go tests live in the same package directory; handled by the caller.
  }
}

/** Find test files that probably test the given source file. */
export function candidateTests(sourcePath: string, repo: RepoReader): string[] {
  const lang = languageOf(sourcePath);
  if (!lang) return [];
  const family = languageFamily(lang);
  const stem = sourceStem(sourcePath).toLowerCase();
  const fileStem = stripExt(basename(sourcePath)).toLowerCase();

  const matches: string[] = [];
  for (const file of repo.listFiles()) {
    const fileLang = languageOf(file);
    if (!fileLang || languageFamily(fileLang) !== family) continue;
    if (classifyFile(file) !== "test") continue;

    const ts = testStem(file);
    if (ts === stem || ts === fileStem) {
      matches.push(file);
      continue;
    }
    if (lang === "go" && dirname(file) === dirname(sourcePath)) {
      matches.push(file);
      continue;
    }
    const content = repo.read(file);
    if (content && importsModule(content, sourcePath, lang)) matches.push(file);
  }
  return matches;
}

/** Excerpts of a test file around each mention of `name`, or null if it never mentions it. */
export function mentionExcerpt(content: string, name: string, context = 12, maxLines = 120): string | null {
  const re = new RegExp(`(^|[^\\w$])${escapeRegex(name)}(?![\\w$])`);
  const lines = content.split("\n");
  const hits = lines.flatMap((line, i) => (re.test(line) ? [i] : []));
  if (hits.length === 0) return null;

  const keep = new Set<number>();
  for (const h of hits) {
    for (let i = Math.max(0, h - context); i <= Math.min(lines.length - 1, h + context); i++) keep.add(i);
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (out.length >= maxLines) {
      out.push("…");
      break;
    }
    if (i !== prev + 1 && out.length > 0) out.push("…");
    out.push(`${i + 1}: ${lines[i]}`);
    prev = i;
  }
  return out.join("\n");
}
