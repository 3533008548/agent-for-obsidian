import { describe, expect, it } from "vitest";
import {
  buildOverlapAnalysisMessages,
  buildOverlapCandidates,
  parseOverlapAnalysis,
  renderOverlapReportMarkdown,
  type NoteForOverlapScan,
  type OverlapScanReport
} from "../core/notes/duplicate-scan";

const REDIS_A: NoteForOverlapScan = {
  path: "daily/后端中redis.md",
  title: "后端中redis",
  text: "Redis 是内存键值数据库，常用作缓存、会话存储与消息队列，支持 RDB 与 AOF 持久化。"
};
const REDIS_B: NoteForOverlapScan = {
  path: "daily/Redis 缓存.md",
  title: "Redis 缓存",
  text: "Redis 是内存数据库，主要用来做缓存，也可以存会话。写入快，常配合数据库使用。"
};
const BM25: NoteForOverlapScan = {
  path: "daily/BM25.md",
  title: "BM25",
  text: "BM25 用文档里的词频与逆文档频率打分，引入了词频饱和与长度归一化，常用于检索排序。"
};

describe("overlap candidate selection", () => {
  it("pairs notes that share wording", () => {
    const candidates = buildOverlapCandidates([REDIS_A, REDIS_B, BM25]);
    const pair = candidates.find(
      (candidate) => candidate.a === REDIS_A.path && candidate.b === REDIS_B.path
    );
    expect(pair).toBeDefined();
    expect(pair?.signals.join()).toContain("重合");
  });

  it("pairs same-topic notes even when the wording differs", () => {
    const cache: NoteForOverlapScan = {
      path: "daily/高速缓存.md",
      title: "高速缓存",
      text: "把热点数据放在访问更快的介质上，减少后端压力。"
    };
    const withoutTopics = buildOverlapCandidates([REDIS_A, cache]);
    const withTopics = buildOverlapCandidates([REDIS_A, cache], {
      topics: new Map([
        [REDIS_A.path, "后端与缓存"],
        [cache.path, "后端与缓存"]
      ])
    });

    expect(withoutTopics).toHaveLength(0);
    expect(withTopics).toHaveLength(1);
    expect(withTopics[0]?.signals.join()).toContain("后端与缓存");
  });

  it("compares nothing when the library is unrelated", () => {
    expect(buildOverlapCandidates([BM25, { ...REDIS_A, path: "daily/x.md" }])).toHaveLength(0);
  });
});

describe("overlap verdict parsing", () => {
  const allowed = new Set([REDIS_A.path, REDIS_B.path]);

  it("keeps only the dispositions that need work", () => {
    const verdicts = parseOverlapAnalysis(
      JSON.stringify({
        pairs: [
          { a: REDIS_A.path, b: REDIS_B.path, disposition: "extract", overlap: "都解释了缓存的用途", reason: "共享缓存定位", extractTitle: "Redis 的定位", confidence: 0.8 },
          { a: REDIS_A.path, b: REDIS_B.path, disposition: "none", overlap: "只是词面相近", reason: "其实无关", confidence: 0.3 }
        ]
      }),
      allowed
    );

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.disposition).toBe("extract");
    expect(verdicts[0]?.extractTitle).toBe("Redis 的定位");
  });

  it("refuses paths the model invented", () => {
    expect(() =>
      parseOverlapAnalysis(
        '{"pairs":[{"a":"daily/不存在的.md","b":"' + REDIS_B.path + '","disposition":"merge","overlap":"x","reason":"y","confidence":1}]}',
        allowed
      )
    ).toThrow();
  });

  it("refuses an unknown disposition", () => {
    expect(() =>
      parseOverlapAnalysis(
        '{"pairs":[{"a":"' + REDIS_A.path + '","b":"' + REDIS_B.path + '","disposition":"delete","overlap":"x","reason":"y","confidence":1}]}',
        allowed
      )
    ).toThrow();
  });
});

describe("overlap report", () => {
  const notes = new Map([REDIS_A, REDIS_B, BM25].map((note) => [note.path, note]));

  it("groups by disposition and says which note a merge keeps", () => {
    const report: OverlapScanReport = {
      verdicts: [
        { a: REDIS_A.path, b: REDIS_B.path, disposition: "merge", overlap: "都讲 Redis 的定位", reason: "同一件事两种说法", canonical: REDIS_A.path, confidence: 0.9 },
        { a: BM25.path, b: REDIS_A.path, disposition: "link", overlap: "都提到排序", reason: "只有一小段相同", confidence: 0.6 }
      ],
      scanned: 3,
      compared: 2
    };
    const markdown = renderOverlapReportMarkdown(report, notes, "2026-10-02T15:00:00.000Z");

    expect(markdown).toContain("# 重复笔记检查");
    expect(markdown).toContain("## 建议合并（1）");
    expect(markdown).toContain("## 只需加一条关联链接（1）");
    expect(markdown).toContain("保留：[[daily/后端中redis.md]]");
    expect(markdown).toContain("scanned: 3");
  });

  it("spells out that merging must not drop content", () => {
    const report: OverlapScanReport = {
      verdicts: [
        { a: REDIS_A.path, b: REDIS_B.path, disposition: "merge", overlap: "x", reason: "y", canonical: REDIS_A.path, confidence: 0.9 }
      ],
      scanned: 2,
      compared: 1
    };
    const markdown = renderOverlapReportMarkdown(report, notes, "2026-10-02T15:00:00.000Z");

    expect(markdown).toContain("追加式");
    expect(markdown).toContain("不删段");
  });

  it("says so when nothing was found", () => {
    const markdown = renderOverlapReportMarkdown({ verdicts: [], scanned: 3, compared: 0 }, notes, "2026-10-02T15:00:00.000Z");
    expect(markdown).toContain("没有发现需要处理的重复");
  });
});

describe("overlap analysis prompt", () => {
  it("tells the model that overlap size is not the criterion", () => {
    const notes = new Map([REDIS_A, REDIS_B].map((note) => [note.path, note]));
    const system = buildOverlapAnalysisMessages([{ a: REDIS_A.path, b: REDIS_B.path }], notes)[0]?.content ?? "";

    expect(system).toContain("绝不要为了一小段重叠合并两篇");
    expect(system).toContain("追加式");
    expect(system).toContain("canonical");
  });
});
