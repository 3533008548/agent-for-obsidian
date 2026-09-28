import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface LaunchArguments {
  /** Knowledge base directory requested on the command line, if usable. */
  requestedRootPath: string | null;
  /** A path that was requested but is not an existing directory. */
  unusableRootPath: string | null;
  showHelp: boolean;
}

export const LAUNCH_USAGE = [
  "用法：知识环 [知识库目录]",
  "",
  "  <目录>            直接打开这个目录下的 Markdown 知识库",
  "  --dir=<目录>       同上",
  "  -d <目录>          同上",
  "  --help            显示这段说明",
  "",
  "目录里放的是普通 Markdown 文件即可，也可以直接给一个 .md 文件，会打开它所在的目录。",
  "不带参数时沿用上次打开的知识库。"
].join("\n");

/**
 * Read the knowledge base directory from the command line, so a desktop
 * shortcut or a shell can open one directly instead of going through the
 * folder picker.
 *
 * Electron passes its own switches through `argv` too, so anything unknown is
 * ignored rather than treated as a path.
 */
export function parseLaunchArguments(
  argv: string[],
  isDirectory: (path: string) => boolean = isExistingDirectory
): LaunchArguments {
  let requested: string | null = null;
  let showHelp = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--help" || argument === "-h") {
      showHelp = true;
    } else if (argument.startsWith("--dir=")) {
      requested ??= unquote(argument.slice("--dir=".length));
    } else if (argument === "--dir" || argument === "-d") {
      const next = argv[index + 1];
      if (next && !next.startsWith("-")) {
        requested ??= unquote(next);
        index += 1;
      }
    } else if (argument && !argument.startsWith("-")) {
      requested ??= unquote(argument);
    }
  }

  if (!requested) {
    return { requestedRootPath: null, unusableRootPath: null, showHelp };
  }

  const candidate = resolve(requested);
  // Pointing at a note instead of the folder is a natural mistake.
  const target = /\.(md|markdown)$/iu.test(candidate) ? dirname(candidate) : candidate;
  if (isDirectory(target)) {
    return { requestedRootPath: target, unusableRootPath: null, showHelp };
  }
  return { requestedRootPath: null, unusableRootPath: requested, showHelp };
}

function unquote(value: string): string {
  return value.trim().replace(/^"|"$/gu, "");
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
