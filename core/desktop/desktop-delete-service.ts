import { hashText } from "../domain/content-hash";
import { TRASH_FOLDER, normalizeVaultPath } from "../policy/policy-engine";

/**
 * Where deleted notes go.
 *
 * A dot-folder so it stays out of the way in the note tree, and inside the
 * workspace so the existing "path must stay under the root" guard covers it
 * like any other write. `.trash` is the name git and most editors already
 * recognise, so the files stay recoverable with whatever the user reaches for
 * first — including this app's own undo button.
 */
export { TRASH_FOLDER };

export interface DeleteNotePreview {
  kind: "delete-note";
  /** The note to remove. */
  targetPath: string;
  /** Where it will be moved, relative to the workspace root. */
  trashPath: string;
  /** Captured at preview time so `apply` can refuse a stale confirmation. */
  beforeContent: string;
  contentHash: string;
  /** Why the note is being removed, kept in the trash manifest. */
  reason: string;
  /** First few lines, so a confirmation card can show what is about to go. */
  excerpt: string;
  /** What referred to it, so an accidental deletion is visible before it happens. */
  inboundLinks: string[];
}

/**
 * Resolve where a note lands in the trash.
 *
 * The original relative path is kept inside the trash so two notes of the same
 * name in different folders cannot overwrite each other, and a name that is
 * already taken in the trash gets a counter rather than replacing something
 * the user deleted earlier.
 */
export function resolveTrashPath(targetPath: string, takenPaths: ReadonlySet<string>): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${TRASH_FOLDER}/${stamp}__${targetPath.replace(/[<>:"/\\|?*]/g, "-")}`;
  if (!takenPaths.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 500; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!takenPaths.has(candidate)) {
      return candidate;
    }
  }
  throw new Error("回收站里同名笔记过多，无法为这次删除分配位置。");
}

/**
 * A short, quotable view of the note for the confirmation card.
 *
 * Deletion is the one action where showing the target *is* the safety
 * mechanism, so this deliberately keeps the original heading and first
 * sentences rather than a character count.
 */
export function excerptForConfirmation(content: string, limit = 180): string {
  const body = content
    .replace(/^---[\s\S]*?^---/mu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line) && !/^<!--/.test(line));
  const text = body.join(" ").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** Stable fingerprint, so a confirmation cannot delete a rewritten note. */
export function contentFingerprint(content: string): string {
  return hashText(content);
}

/**
 * Build the delete preview, or explain why the note cannot be deleted.
 *
 * Existence is checked here rather than at apply time so the caller learns it
 * immediately; the hash is captured so that a note edited between preview and
 * confirmation is not silently deleted in its new form.
 */
export function buildDeletePreview(input: {
  targetPath: string;
  content: string;
  takenTrashPaths: ReadonlySet<string>;
  reason: string;
  inboundLinks: readonly string[];
}): DeleteNotePreview {
  const targetPath = normalizeVaultPath(input.targetPath);
  if (!targetPath) {
    throw new Error("要删除的笔记路径不是有效的知识库相对路径。");
  }
  if (!input.content.trim()) {
    throw new Error("要删除的笔记内容为空，拒绝执行。");
  }
  return {
    kind: "delete-note",
    targetPath,
    trashPath: resolveTrashPath(targetPath, input.takenTrashPaths),
    beforeContent: input.content,
    contentHash: contentFingerprint(input.content),
    reason: input.reason.trim() || "用户请求删除。",
    excerpt: excerptForConfirmation(input.content),
    inboundLinks: [...input.inboundLinks]
  };
}

/**
 * The manifest written next to the trashed note.
 *
 * Without it a note in `.trash` is just a file: there is no way to tell a
 * deliberate deletion from a stray copy, or to recover the original path.
 */
export function renderTrashManifest(preview: DeleteNotePreview, deletedAt: Date): string {
  const lines = [
    "---",
    "trashed: true",
    `deleted-at: \"${deletedAt.toISOString()}\"`,
    `original-path: \"${preview.targetPath}\"`,
    `content-hash: \"${preview.contentHash}\"`,
    "reason:",
    `  - \"${preview.reason.replace(/"/g, '\\"')}\"`,
    ...(preview.inboundLinks.length
      ? ["referenced-by:", ...preview.inboundLinks.map((link) => `  - \"${link.replace(/"/g, '\\"')}\"`)]
      : []),
    "---",
    "",
    `# 已删除：${preview.targetPath}`,
    "",
    `删除时间：${deletedAt.toLocaleString("zh-CN")}`,
    `原因：${preview.reason}`,
    "",
    "## 删除前的内容摘要",
    "",
    preview.excerpt || "（无正文）",
    ""
  ];
  return lines.join("\n");
}
