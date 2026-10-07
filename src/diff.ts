import type { ChangedFile, ParsedPatch, PatchEntry } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse one file's unified diff into entries labelled with new-file line numbers. */
export function parsePatch(patch: string): ParsedPatch {
  const entries: PatchEntry[] = [];
  const added = new Set<number>();
  const commentable = new Set<number>();
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    // Skip file headers (diff --git, ---, +++) before the first hunk, and "\ No newline" markers.
    if (!inHunk || raw.startsWith("\\")) continue;

    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === "+") {
      entries.push({ kind: "+", newLine, text });
      added.add(newLine);
      commentable.add(newLine);
      newLine++;
    } else if (kind === "-") {
      entries.push({ kind: "-", newLine, text });
    } else if (kind === " " || raw === "") {
      // An empty line inside a hunk is a context line whose leading space was trimmed.
      entries.push({ kind: " ", newLine, text });
      commentable.add(newLine);
      newLine++;
    }
  }

  return { entries, added, commentable };
}

/** Split `git diff` output covering many files into per-file ChangedFiles (used by the local CLI). */
export function splitGitDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const chunks = diff.split(/^diff --git /m).slice(1);

  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const header = lines[0] ?? "";
    let path = /^a\/.+? b\/(.+)$/.exec(header)?.[1] ?? "";
    let status: ChangedFile["status"] = "modified";

    for (const line of lines.slice(1, 8)) {
      if (line.startsWith("new file mode")) status = "added";
      else if (line.startsWith("deleted file mode")) status = "removed";
      else if (line.startsWith("rename to ")) {
        status = "renamed";
        path = line.slice("rename to ".length);
      } else if (line.startsWith("+++ b/")) path = line.slice("+++ b/".length);
    }

    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    const patch = hunkStart === -1 ? undefined : lines.slice(hunkStart).join("\n").replace(/\n+$/, "");
    if (path) files.push({ path, status, patch });
  }

  return files;
}
