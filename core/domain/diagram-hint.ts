/**
 * Decides when an answer should draw something.
 *
 * Some questions are about structure — the shape of a B-tree, the rotations of
 * a red-black tree, the order of a request through a system — and for those a
 * wall of prose is a poor substitute for one diagram. Others are not, and a
 * diagram on every answer would be slower without being clearer.
 *
 * This is the coarse half: a rule decides whether the question even looks like
 * the kind that benefits, and the model then decides whether this particular
 * answer needs one. Keeping a rule in front means most answers never carry the
 * instruction at all.
 */

const DIAGRAM_TRIGGERS: RegExp[] = [
  // "什么是红黑树" — asking what a thing is often means "what does it look
  // like from the outside", which is exactly what a diagram answers.
  /什么是|什么叫|何为/u,
  /解释|讲解|讲讲|讲一下|介绍一下|通俗/u,
  /区别|差异|差别|不同|对比|比较|优劣/u,
  /原理|机制|流程|过程|步骤|结构|架构|层次|层级|关系/u,
  /怎么工作|如何工作|怎么实现|如何运转|怎么流转/u
];

/** Too terse to have a shape worth drawing: "401 是什么" is just a lookup. */
const MINIMUM_LENGTH = 5;

export function wantsDiagram(question: string): boolean {
  const normalized = question.trim().replace(/\s+/gu, " ");
  if (normalized.length < MINIMUM_LENGTH) {
    return false;
  }
  return DIAGRAM_TRIGGERS.some((trigger) => trigger.test(normalized));
}

/**
 * Appended to the answer prompt when the rule above agrees.
 *
 * Mermaid rather than a generated image: the subject is a relationship between
 * parts, which declarative syntax gets right and a diffusion model reliably
 * gets wrong. The fenced block is also plain text, so it stays readable in the
 * note itself and can be corrected by hand when the picture is not quite right.
 */
export const DIAGRAM_INSTRUCTION = [
  "这是概念、结构或流程类问题：请在 Markdown 中用恰好一个 mermaid 代码块（```mermaid 围栏）",
  "附一张示意图，流程图、结构图或对比图按内容选择最合适的一种。",
  "要求：节点文字简短，只使用 Mermaid 支持的语法，不要额外解释这张图或 Mermaid 本身；",
  "图放在最能说明问题的那段文字之后。其余要求与本提示一致。"
].join("");
