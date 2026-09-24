import type { PolicyAction, PolicyDecision } from "../policy/policy-engine";

export interface AuditEvent {
  id: string;
  timestamp: string;
  eventType: "policy-decision" | "provider-test" | "model-request" | "vault-write" | "agent-run";
  action?: PolicyAction;
  targetPath?: string;
  allowed?: boolean;
  reason: string;
  outcome: "allowed" | "denied" | "succeeded" | "failed";
}

const MAX_AUDIT_EVENTS = 200;

export class AuditTrail {
  private readonly events: AuditEvent[];

  constructor(events: AuditEvent[] = []) {
    this.events = events.slice(-MAX_AUDIT_EVENTS);
  }

  recordPolicyDecision(decision: PolicyDecision): void {
    this.append({
      eventType: "policy-decision",
      action: decision.action,
      targetPath: decision.normalizedPath,
      allowed: decision.allowed,
      reason: decision.reason,
      outcome: decision.allowed ? "allowed" : "denied"
    });
  }

  recordProviderTest(outcome: "succeeded" | "failed", reason: string): void {
    this.append({
      eventType: "provider-test",
      reason,
      outcome
    });
  }

  recordModelRequest(outcome: "succeeded" | "failed", reason: string): void {
    this.append({
      eventType: "model-request",
      reason,
      outcome
    });
  }

  recordVaultWrite(
    action: Extract<
      PolicyAction,
      "createInboxNote" | "createKnowledgeSystemNote" | "appendDailyNote" |
      "createAgentSession" | "appendAgentSession" | "updateAgentProfile" | "modifyExistingNote"
    >,
    targetPath: string,
    outcome: "succeeded" | "failed",
    reason: string
  ): void {
    this.append({
      eventType: "vault-write",
      action,
      targetPath,
      reason,
      outcome
    });
  }

  recordAgentRun(outcome: "succeeded" | "failed", runId: string, reason: string): void {
    this.append({
      eventType: "agent-run",
      targetPath: runId,
      reason,
      outcome
    });
  }

  getRecent(limit = 10): AuditEvent[] {
    return this.events.slice(-limit).reverse();
  }

  toJSON(): AuditEvent[] {
    return [...this.events];
  }

  private append(event: Omit<AuditEvent, "id" | "timestamp">): void {
    this.events.push({
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString()
    });

    if (this.events.length > MAX_AUDIT_EVENTS) {
      this.events.splice(0, this.events.length - MAX_AUDIT_EVENTS);
    }
  }
}
