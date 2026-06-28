import { checkSsl } from "../checks/ssl.js";
import { checkDomain } from "../checks/domain.js";
import { checkDns } from "../checks/dns.js";
import { reconcile } from "./alerts.js";
import type {
  Alert,
  AlertsFile,
  DnsResult,
  Level,
  StatusFile,
  Target,
  TargetStatus,
} from "./types.js";

const LEVEL_RANK: Record<Level, number> = { critical: 0, warn: 1, unknown: 2, ok: 3 };

/** Worst (lowest rank) wins. */
function worstOf(levels: Level[]): Level {
  if (levels.length === 0) return "unknown";
  return levels.reduce((acc, l) => (LEVEL_RANK[l] < LEVEL_RANK[acc] ? l : acc), "ok" as Level);
}

function enabled(target: Target, kind: "ssl" | "domain" | "dns"): boolean {
  return target.checks?.[kind] !== false;
}

export interface RunResult {
  status: StatusFile;
  alerts: AlertsFile;
  fired: Alert[];
  resolved: Alert[];
}

/**
 * Run every enabled check for every target, build the status file the
 * dashboard reads, and reconcile the alert state machine against prior state.
 *
 * `priorStatus` supplies the previous DNS snapshot for drift detection.
 * `priorAlerts` supplies the open/resolved alert rows.
 */
export async function run(
  targets: Target[],
  priorStatus: StatusFile | null,
  priorAlerts: AlertsFile,
): Promise<RunResult> {
  const startedAt = Date.now();
  const priorById = new Map<string, TargetStatus>(
    (priorStatus?.targets ?? []).map((t) => [t.id, t]),
  );

  const targetStatuses: TargetStatus[] = [];
  let alertsState = priorAlerts;
  const allFired: Alert[] = [];
  const allResolved: Alert[] = [];

  for (const target of targets) {
    const prevDns: DnsResult | null = priorById.get(target.id)?.dns ?? null;

    const [ssl, domain, dns] = await Promise.all([
      enabled(target, "ssl") ? checkSsl(target) : Promise.resolve(null),
      enabled(target, "domain") ? checkDomain(target) : Promise.resolve(null),
      enabled(target, "dns") ? checkDns(target, prevDns) : Promise.resolve(null),
    ]);

    const worst = worstOf(
      [ssl?.level, domain?.level, dns?.level].filter((l): l is Level => l !== undefined),
    );

    targetStatuses.push({
      id: target.id,
      label: target.label,
      domain: target.domain,
      worst,
      ssl,
      domain_: domain,
      dns,
    });

    const rec = reconcile(target, ssl, domain, dns, alertsState);
    alertsState = rec.next;
    allFired.push(...rec.fired);
    allResolved.push(...rec.resolved);
  }

  const summary: Record<Level, number> = { critical: 0, warn: 0, ok: 0, unknown: 0 };
  for (const t of targetStatuses) summary[t.worst]++;

  const status: StatusFile = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    targets: targetStatuses,
  };

  return { status, alerts: alertsState, fired: allFired, resolved: allResolved };
}
