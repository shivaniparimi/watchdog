import type { ChangedSymbol, FunctionDef, Language, ParsedPatch } from "./types.js";

const CONTROL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "else",
  "throw", "do", "try", "await", "typeof", "super", "this", "with", "yield",
]);

const JS_PATTERNS = [
  // function foo(  /  export default async function* foo<T>(
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/,
  // const foo = (...) =>  /  const foo = async function  /  const foo = x =>
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>|<)/,
  // class method:  async foo(a, b): Promise<X> {
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^={;]+)?\s*\{\s*$/,
];

const GO_PATTERN = /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[[(]/;

const JAVA_PATTERN =
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized|native|default)\s+)*(?:<[^>]+>\s+)?[\w<>[\],.?]+(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*\([^;]*$/;

const PYTHON_PATTERN = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;

/** Remove string literals and line comments so braces inside them aren't counted. */
function stripCode(line: string, lang: Language): string {
  const withoutStrings = line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
  const comment = lang === "python" ? "#" : "//";
  const idx = withoutStrings.indexOf(comment);
  return idx === -1 ? withoutStrings : withoutStrings.slice(0, idx);
}

/**
 * Find where a brace-delimited function ends. Returns null when the definition has no body
 * (an abstract/interface method, or a call that only looked like a definition).
 * Arrow functions with expression bodies end at the first `;` outside brackets.
 */
function findBraceEnd(lines: string[], startIdx: number, lang: Language): number | null {
  let parens = 0;
  let braces = 0;
  let bodyStarted = false;

  for (let i = startIdx; i < lines.length && i < startIdx + 2000; i++) {
    for (const ch of stripCode(lines[i] ?? "", lang)) {
      if (ch === "(" || ch === "[") parens++;
      else if (ch === ")" || ch === "]") parens--;
      else if (ch === "{") {
        if (parens === 0) bodyStarted = true;
        braces++;
      } else if (ch === "}") {
        braces--;
        if (bodyStarted && braces === 0) return i;
      } else if (ch === ";" && parens === 0 && braces === 0) {
        return bodyStarted || lang === "ts" || lang === "js" ? i : null;
      }
    }
    // An arrow function with an expression body may end without a semicolon.
    if (!bodyStarted && (lang === "ts" || lang === "js") && i > startIdx + 30) return null;
  }
  return bodyStarted ? lines.length - 1 : null;
}

function findPythonEnd(lines: string[], startIdx: number, indent: number): number {
  // Skip past a signature that may span several lines, ending with ":".
  let i = startIdx;
  let parens = 0;
  for (; i < lines.length; i++) {
    for (const ch of stripCode(lines[i] ?? "", "python")) {
      if (ch === "(" || ch === "[" || ch === "{") parens++;
      else if (ch === ")" || ch === "]" || ch === "}") parens--;
    }
    if (parens <= 0 && /:\s*(#.*)?$/.test(lines[i] ?? "")) break;
  }

  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j] ?? "";
    if (line.trim() === "") continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent <= indent) break;
    end = j;
  }
  return end;
}

/** Find every function/method definition in a file, with 1-based inclusive line ranges. */
export function findFunctions(content: string, lang: Language): FunctionDef[] {
  const lines = content.split("\n");
  const defs: FunctionDef[] = [];

  lines.forEach((line, idx) => {
    if (lang === "python") {
      const m = PYTHON_PATTERN.exec(line);
      if (m) {
        const end = findPythonEnd(lines, idx, m[1]!.length);
        defs.push({ name: m[2]!, start: idx + 1, end: end + 1 });
      }
      return;
    }

    let name: string | undefined;
    let isVariable = false;
    if (lang === "go") name = GO_PATTERN.exec(line)?.[1];
    else if (lang === "java") name = JAVA_PATTERN.exec(line)?.[1];
    else {
      for (const [i, re] of JS_PATTERNS.entries()) {
        name = re.exec(line)?.[1];
        if (name) {
          isVariable = i === 1;
          break;
        }
      }
    }
    if (!name || CONTROL_KEYWORDS.has(name)) return;

    const end = findBraceEnd(lines, idx, lang);
    if (end === null) return;
    // `const x = (a + b) * 2;` matched the variable pattern but isn't a function.
    if (isVariable && !/=>|\bfunction\b/.test(lines.slice(idx, end + 1).join("\n"))) return;
    defs.push({ name, start: idx + 1, end: end + 1 });
  });

  return defs;
}

/** The smallest function containing the line, so nested functions win over their parents. */
function innermost(defs: FunctionDef[], line: number): FunctionDef | undefined {
  let best: FunctionDef | undefined;
  for (const d of defs) {
    if (d.start <= line && line <= d.end && (!best || d.end - d.start < best.end - best.start)) {
      best = d;
    }
  }
  return best;
}

/** True for lines that can't change behavior: blank, comments, imports, logging, lone brackets. */
export function isTrivialLine(text: string, lang: Language): boolean {
  const t = text.trim();
  if (t === "" || /^[{}()[\];,]*$/.test(t)) return true;

  if (lang === "python") {
    if (t.startsWith("#")) return true;
    if (/^(import|from)\s+\S+/.test(t)) return true;
    if (/^(print|logging\.\w+|logger\.\w+|log\.\w+)\(/.test(t)) return true;
    if (/^("""|''')/.test(t) || /^[rbuf]?("|')[^"']*\1$/.test(t)) return true; // docstrings
    return false;
  }

  if (/^(\/\/|\/\*|\*|\*\/)/.test(t)) return true;
  if (/^(import|package)\s/.test(t)) return true;
  if (/^export\s+(\*|\{[^}]*\})\s+from\s/.test(t)) return true;
  if (/^(const|let|var)\s+[\w{}\s,]+=\s*require\(/.test(t)) return true;
  if (/^(console\.\w+|logger\.\w+|log\.\w+|fmt\.Print\w*|System\.(out|err)\.print\w*)\(/.test(t)) {
    return true;
  }
  return false;
}

/** Group a file's non-trivial changed lines by the function they fall in. */
export function changedSymbols(
  path: string,
  lang: Language,
  content: string,
  patch: ParsedPatch,
): ChangedSymbol[] {
  const defs = findFunctions(content, lang);
  const lines = content.split("\n");
  const byDef = new Map<FunctionDef, Set<number>>();

  for (const entry of patch.entries) {
    if (entry.kind === " " || isTrivialLine(entry.text, lang)) continue;
    // A removal sits between lines; attribute it to the function containing the next line.
    const line = Math.min(entry.newLine, lines.length);
    const def = innermost(defs, line);
    if (!def) continue;
    // A removal just above a function's first line (e.g. a deleted neighbour) isn't inside it.
    if (entry.kind === "-" && entry.newLine <= def.start) continue;
    if (!byDef.has(def)) byDef.set(def, new Set());
    byDef.get(def)!.add(line);
  }

  const symbols: ChangedSymbol[] = [];
  for (const [def, changed] of byDef) {
    const inRange = patch.entries.filter((e) => e.newLine >= def.start && e.newLine <= def.end);
    let isNew = true;
    for (let l = def.start; l <= def.end; l++) {
      if (!patch.added.has(l)) {
        isNew = false;
        break;
      }
    }

    symbols.push({
      id: `${path}#${def.name}@${def.start}`,
      path,
      language: lang,
      name: def.name,
      start: def.start,
      end: def.end,
      isNew,
      changedLines: [...changed].sort((a, b) => a - b),
      diffSnippet: inRange
        .map((e) => (e.kind === "-" ? `      - ${e.text}` : `L${e.newLine} ${e.kind} ${e.text}`))
        .join("\n"),
      body: lines.slice(def.start - 1, def.end).join("\n"),
    });
  }

  return symbols.sort((a, b) => a.start - b.start);
}
