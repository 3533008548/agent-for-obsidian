import { describe, expect, it } from "vitest";
import {
  assignNotes,
  convergeRegistry,
  createTopicRegistry,
  notesOfTopic,
  parseTopicRegistryMarkdown,
  renderTopicRegistryMarkdown,
  resolveTopicReference,
  topicDefinitionId,
  topicOfNote,
  topicStats,
  UNCLASSIFIED_TOPIC_ID,
  upsertTopics,
  type TopicDefinition
} from "../core/wiki/topic-registry";

const BACKEND: TopicDefinition = {
  id: "后端与缓存",
  name: "后端与缓存",
  definition: "后端服务里的缓存、消息与过期机制"
};
const MONITORING: TopicDefinition = {
  id: "可观测性与监控",
  name: "可观测性与监控",
  definition: "指标采集、告警与链路追踪",
  parentId: "后端与缓存"
};

function registryWith(topics: TopicDefinition[]) {
  return { ...createTopicRegistry(), topics };
}

describe("topic table", () => {
  it("derives a stable id from the name", () => {
    expect(topicDefinitionId("后端与缓存")).toBe("后端与缓存");
    expect(topicDefinitionId("RAG 检索")).toBe("rag-检索");
  });

  it("keeps a definition the user corrected", () => {
    const corrected: TopicDefinition = { ...BACKEND, definition: "我改过的判据" };
    const merged = upsertTopics([corrected], [{ ...BACKEND, definition: "模型新提的判据" }]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.definition).toBe("我改过的判据");
  });

  it("appends genuinely new topics after the known ones", () => {
    const merged = upsertTopics([BACKEND], [MONITORING]);
    expect(merged.map((topic) => topic.id)).toEqual(["后端与缓存", "可观测性与监控"]);
  });
});

describe("assignments", () => {
  it("files a vote for an unknown topic as unclassified", () => {
    const registry = assignNotes(
      registryWith([BACKEND]),
      [{ path: "daily/Redis TTL.md", topicId: "编造的主题", confidence: 0.9 }],
      new Set(["daily/Redis TTL.md"])
    );

    expect(registry.assignments["daily/Redis TTL.md"]?.topicId).toBe(UNCLASSIFIED_TOPIC_ID);
  });

  it("marks notes the model skipped as unclassified instead of hiding them", () => {
    const registry = assignNotes(
      registryWith([BACKEND]),
      [{ path: "daily/Redis.md", topicId: "后端与缓存", confidence: 0.9 }],
      new Set(["daily/Redis.md", "daily/没被分配.md"])
    );

    expect(registry.assignments["daily/没被分配.md"]?.topicId).toBe(UNCLASSIFIED_TOPIC_ID);
    expect(Object.keys(registry.assignments)).toHaveLength(2);
  });

  it("ignores a vote for a note that was never offered", () => {
    const registry = assignNotes(
      registryWith([BACKEND]),
      [{ path: "daily/不在库里.md", topicId: "后端与缓存", confidence: 1 }],
      new Set(["daily/Redis.md"])
    );

    expect(Object.keys(registry.assignments)).toEqual(["daily/Redis.md"]);
  });
});

describe("convergence", () => {
  it("folds a one-note topic into its parent", () => {
    // A Redis TTL note filed under monitoring because Prometheus shared its
    // batch — the parent link is what gets it back to the right topic.
    const assigned = assignNotes(
      registryWith([BACKEND, MONITORING]),
      [
        { path: "daily/Redis.md", topicId: "后端与缓存", confidence: 0.9 },
        { path: "daily/Redis TTL.md", topicId: "可观测性与监控", confidence: 0.8 }
      ],
      new Set(["daily/Redis.md", "daily/Redis TTL.md"])
    );

    const { registry, merged } = convergeRegistry(assigned);

    expect(merged).toEqual([{ from: "可观测性与监控", to: "后端与缓存" }]);
    expect(notesOfTopic(registry, "后端与缓存").sort()).toEqual(["daily/Redis TTL.md", "daily/Redis.md"]);
    expect(registry.topics.map((topic) => topic.id)).toEqual(["后端与缓存"]);
  });

  it("keeps a one-note topic that has no parent, and reports it as sparse", () => {
    const assigned = assignNotes(
      registryWith([BACKEND, { ...MONITORING, parentId: undefined }]),
      [
        { path: "daily/Redis.md", topicId: "后端与缓存", confidence: 0.9 },
        { path: "daily/Prometheus.md", topicId: "可观测性与监控", confidence: 0.8 },
        { path: "daily/SSE.md", topicId: "后端与缓存", confidence: 0.8 }
      ],
      new Set(["daily/Redis.md", "daily/Prometheus.md", "daily/SSE.md"])
    );

    const { registry, merged } = convergeRegistry(assigned);

    expect(merged).toEqual([]);
    expect(topicStats(registry).map((stat) => [stat.topic.name, stat.count]))
      .toEqual([["后端与缓存", 2], ["可观测性与监控", 1]]);
  });
});

describe("persisted table", () => {
  it("round-trips through the readable note", () => {
    const assigned = assignNotes(
      registryWith([BACKEND, MONITORING]),
      [
        { path: "daily/Redis.md", topicId: "后端与缓存", confidence: 0.9 },
        { path: "daily/Redis TTL.md", topicId: "后端与缓存", confidence: 0.8, secondaryTopicId: "可观测性与监控" }
      ],
      new Set(["daily/Redis.md", "daily/Redis TTL.md"])
    );
    const markdown = renderTopicRegistryMarkdown(assigned, "2026-10-01T10:00:00.000Z");

    expect(markdown).toContain("<!-- topic-registry -->");

    const parsed = parseTopicRegistryMarkdown(markdown);
    expect(parsed?.topics.map((topic) => topic.name)).toContain("后端与缓存");
    expect(parsed?.assignments["daily/Redis TTL.md"]?.topicId).toBe("后端与缓存");
    expect(parsed?.assignments["daily/Redis TTL.md"]?.secondaryTopicIds).toEqual(["可观测性与监控"]);
  });

  it("returns null for a note without a usable table", () => {
    expect(parseTopicRegistryMarkdown("# 主题表\n\n手写的笔记，没有 JSON。")).toBeNull();
    expect(parseTopicRegistryMarkdown("```json\n{ not json }\n```")).toBeNull();
  });

  it("lists unclassified notes so the gap stays visible", () => {
    const registry = assignNotes(registryWith([BACKEND]), [], new Set(["daily/孤立.md"]));
    const markdown = renderTopicRegistryMarkdown(registry, "2026-10-01T10:00:00.000Z");

    expect(markdown).toContain("未归类");
    expect(markdown).toContain("[[daily/孤立.md]]");
  });
});

describe("topic reference resolution", () => {
  const RAG: TopicDefinition = {
    id: "rag-与检索基础",
    name: "RAG 与检索基础",
    definition: "检索增强生成的召回与排序",
    aliases: ["检索增强"]
  };

  it("resolves every wording of one theme to the same topic", () => {
    const registry = registryWith([RAG, BACKEND]);
    for (const phrase of ["RAG 与检索基础", "RAG", "rag", "检索增强", "rag-与检索基础"]) {
      expect(resolveTopicReference(registry, phrase)?.topicId).toBe(RAG.id);
    }
    expect(resolveTopicReference(registry, "RAG 与检索基础")?.name).toBe("RAG 与检索基础");
  });

  it("refuses to guess when several topics could be meant", () => {
    const registry = registryWith([BACKEND, { ...BACKEND, id: "backend-advanced", name: "后端进阶" }]);
    expect(resolveTopicReference(registry, "后端")).toBeNull();
  });

  it("prefers an exact name over a looser containment match", () => {
    const registry = registryWith([BACKEND, { ...BACKEND, id: "backend-advanced", name: "后端进阶" }]);
    expect(resolveTopicReference(registry, "后端与缓存")?.topicId).toBe(BACKEND.id);
  });

  it("reports the topic of a note and nothing for an unclassified one", () => {
    const registry = assignNotes(
      registryWith([BACKEND]),
      [{ path: "daily/Redis.md", topicId: BACKEND.id, confidence: 0.9 }],
      new Set(["daily/Redis.md", "daily/孤立.md"])
    );

    expect(topicOfNote(registry, "daily/Redis.md")).toBe("后端与缓存");
    expect(topicOfNote(registry, "daily/孤立.md")).toBeNull();
    expect(topicOfNote(registry, "daily/不存在.md")).toBeNull();
  });
});
