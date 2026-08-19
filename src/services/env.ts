export function readEnvValue(contents: string, key: string): string | null {
  const expression = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*(.*)$`);
  for (const line of contents.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    const match = line.match(expression);
    if (!match) {
      continue;
    }
    return unquoteEnvValue(match[1].trim()) || null;
  }
  return null;
}

export const ENV_TEMPLATE = [
  "# 本文件仅保存在本机的 Obsidian 插件目录，请不要提交到 Git。",
  "# 文本问答/笔记提案使用 DeepSeek；PDF OCR 与图片解析使用 GLM；联网检索使用 Tavily。",
  "DEEPSEEK_API_KEY=",
  "GLM_API_KEY=",
  "TAVILY_API_KEY=",
  ""
].join("\n");

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  )) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
