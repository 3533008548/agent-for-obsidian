/**
 * Serialises mermaid rendering and hands out ids that cannot collide.
 *
 * Mermaid 11+ keeps its scratch DOM on `document.body` and finds its own
 * elements by id, so two renders running at the same time interfere: the
 * second one removes the first one's container and the first one then fails
 * with "Cannot read properties of null (reading 'firstChild')". React ids are
 * not a safe source of ids here, because `useId` is derived from the tree
 * position — a component that remounts in the same place gets the same id and
 * overlaps its own previous render.
 */

let sequence = 0;

/** Ids are unique for the lifetime of the window, not just within one React tree. */
export function nextMermaidDiagramId(): string {
  sequence += 1;
  return `kb-mermaid-${sequence}`;
}

let queue: Promise<unknown> = Promise.resolve();

/** Runs mermaid renders one after another; a failed render does not block the next. */
export function enqueueMermaidRender<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Test seam: forgets the queue and the counter. */
export function resetMermaidRenderState(): void {
  sequence = 0;
  queue = Promise.resolve();
}
