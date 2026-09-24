export type DesktopAgentIntent =
  | "answer"
  | "start-session"
  | "close-session"
  | "open-profile"
  | "remember-profile"
  | "forget-profile"
  | "open-assistant-state"
  | "set-current-focus"
  | "compile-wiki"
  | "expand-wiki"
  | "inspect-wiki-sources"
  | "process-images"
  | "format-clipboard"
  | "complete-relations"
  | "verify-wiki";

export interface DesktopAgentIntentRequest {
  question: string;
  activeNotePath?: string;
}

export interface DesktopAgentIntentResult {
  intent: DesktopAgentIntent;
  subject?: string;
  notePath?: string;
  sessionTitle?: string;
}

/**
 * Routes only explicit operational requests. Everything ambiguous stays on the
 * normal Q&A path so a short question never triggers a write or external call.
 */
export function detectDesktopAgentIntent(request: DesktopAgentIntentRequest): DesktopAgentIntentResult {
  const question = request.question.trim();
  if (!question || looksLikeQuestion(question)) {
    return { intent: "answer" };
  }

  if (/(?:结束|关闭|退出).{0,8}会话|会话.{0,8}(?:结束|关闭|退出)/u.test(question)) {
    return { intent: "close-session" };
  }
  const sessionMatch = /(?:开始|新建|创建|开启).{0,8}会话(?:[：:，,\s]+(.+))?/u.exec(question);
  if (sessionMatch) {
    return { intent: "start-session", sessionTitle: cleanSubject(sessionMatch[1]) };
  }
  if (/(?:打开|查看|编辑|更新).{0,8}用户画像|用户画像.{0,8}(?:打开|查看|编辑|更新)/u.test(question)) {
    return { intent: "open-profile" };
  }
  const rememberMatch = /^(?:请|帮我)?(?:记住|写入(?:用户)?画像|加入(?:用户)?画像)[：:，,\s]*(.+)$/u.exec(question);
  if (rememberMatch) {
    return { intent: "remember-profile", subject: cleanSubject(rememberMatch[1]) };
  }
  const forgetMatch = /^(?:请|帮我)?(?:忘记|删除(?:用户)?画像中的|移除(?:用户)?画像中的)[：:，,\s]*(.+)$/u.exec(question);
  if (forgetMatch) {
    return { intent: "forget-profile", subject: cleanSubject(forgetMatch[1]) };
  }
  if (/(?:打开|查看|看看).{0,8}(?:助手状态|当前状态|记忆状态)|(?:助手状态|当前状态|记忆状态).{0,8}(?:打开|查看|看看)/u.test(question)) {
    return { intent: "open-assistant-state" };
  }
  const focusMatch = /^(?:请|帮我)?(?:设为当前重点|记录当前重点|设定当前重点|更新当前重点)[：:，,\s]*(.+)$/u.exec(question);
  if (focusMatch) {
    return { intent: "set-current-focus", subject: cleanSubject(focusMatch[1]) };
  }
  if (/(?:补全|扩展|增量(?:补全|编译)?).{0,16}(?:llm\s*wiki|知识百科|笔记百科|wiki)|(?:llm\s*wiki|知识百科|笔记百科|wiki).{0,16}(?:补全|扩展|增量(?:补全|编译)?)/iu.test(question)) {
    return { intent: "expand-wiki", subject: extractSubject(question, /(?:llm\s*wiki|知识百科|笔记百科|wiki)/iu) };
  }
  if (/(?:检查|查看|核查|校验).{0,16}(?:llm\s*wiki|知识百科|笔记百科|wiki).{0,12}(?:来源|证据)|(?:来源|证据).{0,12}(?:检查|查看|核查|校验).{0,16}(?:llm\s*wiki|知识百科|笔记百科|wiki)/iu.test(question)) {
    return { intent: "inspect-wiki-sources", subject: extractSubject(question, /(?:llm\s*wiki|知识百科|笔记百科|wiki)/iu) };
  }
  if (/(?:编译|生成|创建|构建).{0,16}(?:llm\s*wiki|知识百科|笔记百科|wiki)|(?:llm\s*wiki|知识百科|笔记百科|wiki).{0,16}(?:编译|生成|创建|构建)/iu.test(question)) {
    return { intent: "compile-wiki", subject: extractSubject(question, /(?:llm\s*wiki|知识百科|笔记百科|wiki)/iu) };
  }
  if (/(?:联网)?(?:核验|校验|比对|查漏补缺).{0,16}(?:llm\s*wiki|知识百科|笔记百科|wiki)|(?:llm\s*wiki|知识百科|笔记百科|wiki).{0,16}(?:联网)?(?:核验|校验|比对|查漏补缺)/iu.test(question)) {
    return { intent: "verify-wiki", subject: extractSubject(question, /(?:llm\s*wiki|知识百科|笔记百科|wiki)/iu) };
  }
  if (/(?:解析|识别|处理).{0,8}(?:图片|图像)|(?:图片|图像).{0,8}(?:解析|识别|处理)/u.test(question)) {
    return { intent: "process-images" };
  }
  if (/(?:整理|转换|修复).{0,8}(?:剪贴板|粘贴(?:内容|格式)?|表格格式)|(?:剪贴板|粘贴(?:内容|格式)?|表格格式).{0,8}(?:整理|转换|修复)/u.test(question)) {
    return { intent: "format-clipboard" };
  }
  if (/(?:补全|整理|分析).{0,10}(?:笔记)?关联|(?:笔记)?关联.{0,10}(?:补全|整理|分析)/u.test(question)) {
    return { intent: "complete-relations", notePath: extractNotePath(question) ?? request.activeNotePath };
  }
  return { intent: "answer" };
}

function looksLikeQuestion(question: string): boolean {
  return /^(?:什么是|什么叫|怎么|如何|为何|为什么|能否|可以|是否|有没有|请问|我想知道|介绍一下)/u.test(question);
}

function extractSubject(question: string, marker: RegExp): string | undefined {
  const withoutMarker = question.replace(marker, "");
  const subject = cleanSubject(withoutMarker
    .replace(/(?:请|帮我|给我|把|将|为|针对|对|进行|一下|编译|生成|创建|构建|补全|扩展|增量|联网|核验|校验|检查|查看|核查|来源|证据|比对|查漏补缺|知识体系|主题)/gu, " "));
  return subject || undefined;
}

function extractNotePath(question: string): string | undefined {
  const wikiLink = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/u.exec(question)?.[1];
  if (wikiLink) {
    return wikiLink.trim();
  }
  return /(?:[\w\u4e00-\u9fa5 .-]+\/)+[\w\u4e00-\u9fa5 .-]+\.md/iu.exec(question)?.[0]?.trim();
}

function cleanSubject(value: string | undefined): string | undefined {
  const subject = value?.replace(/\s+/gu, " ").trim().replace(/[。！？!?]+$/u, "");
  return subject || undefined;
}
