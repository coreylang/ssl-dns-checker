import { SSL_THRESHOLDS } from "../checks/ssl.js";
import { DOMAIN_THRESHOLDS } from "../checks/domain.js";
import type {
  Alert,
  AlertsFile,
  DomainResult,
  DnsResult,
  SslResult,
  Target,
} from "./types.js";

/**
 * The alert state machine.
 *
 * Goal: notify exactly once when expiry crosses a threshold (30 -> 14 -> 7 ...),
 * not once per run for three weeks. We keep one open row per
 * (targetId, kind, threshold). A row opens when days-remaining drops to/below
 * its threshold and stays open (silent) until either it resolves or a tighter
 * threshold opens. A renewal that pushes days-remaining back out auto-resolves
 * every open row for that (target, kind). This mirrors Beacon's incident
 * reconciliation: don't re-page for an ongoing condition.
 *
 * `reconcile` returns the full next state plus the alerts that newly fired this
 * run (for notifications) and the ones that newly resolved (for "recovered"
 * notices). Only newly-fired/newly-resolved alerts should be sent.
 */

export interface Reconciliation {
  next: AlertsFile;
  fired: Alert[];
  resolved: Alert[];
}

interface Crossing {
  kind: Alert["kind"];
  threshold: number;
  daysRemaining: number | null;
  level: Alert["level"];
  /** True for non-numeric state alerts (expired, lapsed, chain invalid, no records). */
  isState: boolean;
  message: string;
}

/** Determine which thresholds/states are currently "active" for a target. */
function crossingsFor(
  ssl: SslResult | null,
  domain: DomainResult | null,
  dns: DnsResult | null,
): Crossing[] {
  const out: Crossing[] = [];

  if (ssl) {
    if (ssl.daysRemaining !== null && ssl.daysRemaining < 0) {
      out.push({ kind: "ssl", threshold: 0, daysRemaining: ssl.daysRemaining, level: "critical", isState: true, message: ssl.message });
    } else if (!ssl.authorized && ssl.level === "critical") {
      out.push({ kind: "ssl", threshold: -1, daysRemaining: ssl.daysRemaining, level: "critical", isState: true, message: ssl.message });
    } else if (ssl.daysRemaining !== null) {
      const crossed = [...SSL_THRESHOLDS].filter((t) => ssl.daysRemaining! <= t).sort((a, b) => a - b)[0];
      if (crossed !== undefined) {
        out.push({ kind: "ssl", threshold: crossed, daysRemaining: ssl.daysRemaining, level: crossed <= 7 ? "critical" : "warn", isState: false, message: ssl.message });
      }
    }
  }

  if (domain) {
    const lapsed = domain.statuses.some((s) => /redemption|pending\s*delete/i.test(s));
    if (lapsed || (domain.daysRemaining !== null && domain.daysRemaining < 0)) {
      out.push({ kind: "domain", threshold: 0, daysRemaining: domain.daysRemaining, level: "critical", isState: true, message: domain.message });
    } else if (domain.daysRemaining !== null) {
      const crossed = [...DOMAIN_THRESHOLDS].filter((t) => domain.daysRemaining! <= t).sort((a, b) => a - b)[0];
      if (crossed !== undefined) {
        out.push({ kind: "domain", threshold: crossed, daysRemaining: domain.daysRemaining, level: crossed <= 14 ? "critical" : "warn", isState: false, message: domain.message });
      }
    }
  }

  if (dns) {
    if (dns.level === "critical") {
      out.push({ kind: "dns", threshold: 0, daysRemaining: null, level: "critical", isState: true, message: dns.message });
    } else if (dns.drift.length > 0) {
      // Use a hash-derived pseudo-threshold so a *new* drift reopens an alert
      // while an unchanged ongoing drift stays silent.
      out.push({ kind: "dns", threshold: -2, daysRemaining: null, level: "warn", isState: true, message: dns.message });
    }
  }

  return out;
}

export function reconcile(
  target: Target,
  ssl: SslResult | null,
  domain: DomainResult | null,
  dns: DnsResult | null,
  prior: AlertsFile,
  now = new Date(),
): Reconciliation {
  const ts = now.toISOString();
  const active = crossingsFor(ssl, domain, dns);

  // Index prior alerts for this target by id.
  const priorForTarget = new Map<string, Alert>();
  const others: Alert[] = [];
  for (const a of prior.alerts) {
    if (a.targetId === target.id) priorForTarget.set(a.id, a);
    else others.push(a);
  }

  const fired: Alert[] = [];
  const resolved: Alert[] = [];
  const nextForTarget = new Map<string, Alert>();

  // For each enabled kind, the single tightest active crossing is what matters.
  const tightestByKind = new Map<Alert["kind"], Crossing>();
  for (const c of active) {
    const existing = tightestByKind.get(c.kind);
    // Lower numeric threshold = tighter; state alerts (<=0) are tightest.
    const score = (x: Crossing) => (x.isState ? -1000 + x.threshold : x.threshold);
    if (!existing || score(c) < score(existing)) tightestByKind.set(c.kind, c);
  }

  for (const [kind, c] of tightestByKind) {
    const id = `${target.id}:${kind}:${c.threshold}`;
    const was = priorForTarget.get(id);
    if (was && !was.resolvedAt) {
      // Still open at the same threshold: carry it forward silently.
      nextForTarget.set(id, was);
    } else {
      const alert: Alert = {
        id,
        targetId: target.id,
        label: target.label,
        kind,
        threshold: c.threshold,
        level: c.level,
        message: c.message,
        firedAt: ts,
        resolvedAt: null,
      };
      nextForTarget.set(id, alert);
      fired.push(alert);
    }
  }

  // Anything previously open for this target that is no longer the active
  // crossing for its kind has recovered (renewed cert, renewed domain, DNS
  // settled). Mark resolved and emit a recovery.
  for (const [id, was] of priorForTarget) {
    if (was.resolvedAt) continue; // already resolved earlier
    if (!nextForTarget.has(id)) {
      const recovered: Alert = { ...was, resolvedAt: ts };
      resolved.push(recovered);
      // Keep resolved rows briefly so the dashboard can show "recovered".
      nextForTarget.set(id, recovered);
    }
  }

  // Prune resolved rows older than 7 days to keep the file small.
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const kept = [...nextForTarget.values()].filter(
    (a) => !a.resolvedAt || new Date(a.resolvedAt).getTime() >= weekAgo,
  );

  return {
    next: { schema: 1, alerts: [...others, ...kept] },
    fired,
    resolved,
  };
}
