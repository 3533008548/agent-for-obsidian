import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { enqueueMermaidRender, nextMermaidDiagramId } from "./mermaid-render-queue";

/**
 * Renders a mermaid diagram in place, next to the answer that produced it.
 *
 * Mermaid is loaded on demand: it is a large library and most answers have no
 * diagram, so pulling it in up front would slow the first paint for nothing.
 */
export function MermaidDiagram({ source }: { source: string }): ReactNode {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Taken once per mounted instance, and unique across the whole window:
  // mermaid looks its scratch container up by id, and `useId` would hand the
  // same id back to a component that remounts in the same position.
  const diagramIdRef = useRef("");
  if (!diagramIdRef.current) {
    diagramIdRef.current = nextMermaidDiagramId();
  }
  const diagramId = diagramIdRef.current;
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    setSvg(null);
    setError(null);

    let cancelled = false;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          // The app is light-themed; mermaid's own palette would otherwise come
          // out on a dark background.
          theme: "default",
          securityLevel: "strict",
          fontFamily: "Inter, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
        });
        // One render at a time: mermaid's scratch nodes live on document.body,
        // so overlapping renders delete each other's containers.
        const { svg: rendered } = await enqueueMermaidRender(() => mermaid.render(diagramId, source));
        if (!cancelled && mountedRef.current) {
          setSvg(rendered);
        }
      } catch (thrown) {
        if (!cancelled && mountedRef.current) {
          setError(thrown instanceof Error ? thrown.message : String(thrown));
        }
      } finally {
        // A parse failure leaves the measuring node behind.
        document.getElementById("d" + diagramId)?.remove();
      }
    })();

    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [source, diagramId]);

  if (error) {
    return (
      <p className="diagram-error" role="alert">
        这段 mermaid 画不出来：{error}
      </p>
    );
  }
  if (!svg) {
    return <p className="diagram-loading">正在绘制示意图…</p>;
  }
  // Mermaid's SVG comes from its own renderer over input the model wrote. It is
  // sanitised by mermaid with securityLevel "strict"; the wrapper is a sandbox
  // so a stray style attribute cannot reach the rest of the page.
  return (
    <div
      className="diagram-figure"
      role="img"
      aria-label="Mermaid 示意图"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
