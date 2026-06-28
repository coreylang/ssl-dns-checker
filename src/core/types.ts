// Shared types for the Vigil engine. The dashboard consumes the JSON shapes
// emitted here (StatusFile / AlertsFile), so treat these as a public contract.

export type CheckKind = "ssl" | "domain" | "dns";

/** Worst-to-best ordering matters: see `rank()` in core/runner.ts. */
export type Level = "critical" | "warn" | "ok" | "unknown";

/** A thing to watch. Declared by the user in config/targets.json. */
export interface Target {
  /** Stable slug, unique across the config. Used as a key in results + alerts. */
  id: string;
  /** Human label shown in the dashboard. */
  label: string;
  /** Registrable domain, e.g. "thestatus.dev". Used for domain + DNS checks. */
  domain: string;
  /** Host to open the TLS connection against. Defaults to `domain`. */
  sslHost?: string;
  /** TLS port. Defaults to 443. */
  port?: number;
  /** Which checks to run. Omitted check defaults to true. */
  checks?: Partial<Record<CheckKind, boolean>>;
  /** DNS record types to snapshot. Defaults to ["A", "AAAA", "MX", "NS", "TXT"]. */
  dnsTypes?: DnsRecordType[];
  /**
   * Optional pinned DNS baseline. When set, drift is measured against this
   * instead of the previous observation, catching unannounced prod changes.
   * Shape: { A: ["1.2.3.4"], MX: ["10 mail.example.com"], ... }
   */
  dnsBaseline?: Partial<Record<DnsRecordType, string[]>>;
}

export type DnsRecordType =
  | "A"
  | "AAAA"
  | "MX"
  | "NS"
  | "TXT"
  | "CNAME"
  | "SOA";

// --- Per-check results ------------------------------------------------------

export interface SslResult {
  kind: "ssl";
  level: Level;
  message: string;
  checkedAt: string;
  validTo: string | null;
  daysRemaining: number | null;
  issuer: string | null;
  /** Did the chain actually verify? A valid-but-unverifiable cert is its own alert. */
  authorized: boolean;
  authorizationError: string | null;
  altNames: string[];
}

export interface DomainResult {
  kind: "domain";
  level: Level;
  message: string;
  checkedAt: string;
  expiry: string | null;
  daysRemaining: number | null;
  registrar: string | null;
  /** EPP status codes. redemptionPeriod / pendingDelete mean it already lapsed. */
  statuses: string[];
  /** Where the data came from: rdap is structured and preferred. */
  source: "rdap" | "whois" | null;
}

export interface DnsRecordSet {
  // Normalized, sorted record values keyed by type.
  [type: string]: string[];
}

export interface DnsResult {
  kind: "dns";
  level: Level;
  message: string;
  checkedAt: string;
  /** Stable hash of the normalized record set. Cheap equality across runs. */
  recordHash: string;
  records: DnsRecordSet;
  /** What we compared against: the prior snapshot or a pinned baseline. */
  comparedTo: "previous" | "baseline" | "first-observation";
  /** Human-readable diff lines, empty when nothing changed. */
  drift: string[];
}

// --- Aggregated status (the file the dashboard reads) -----------------------

export interface TargetStatus {
  id: string;
  label: string;
  domain: string;
  /** Worst level across the target's enabled checks. */
  worst: Level;
  ssl: SslResult | null;
  domain_: DomainResult | null;
  dns: DnsResult | null;
}

export interface StatusFile {
  schema: 1;
  generatedAt: string;
  /** Run duration in milliseconds, for the "ran in Nms" footer. */
  durationMs: number;
  summary: Record<Level, number>;
  targets: TargetStatus[];
}

// --- Alert state machine ----------------------------------------------------

/**
 * One row per (targetId, kind, threshold). Open when a threshold has been
 * crossed and not yet renewed; resolved when expiry moves back beyond it.
 * This is what makes alerts fire exactly once instead of every run.
 */
export interface Alert {
  id: string; // `${targetId}:${kind}:${threshold}`
  targetId: string;
  label: string;
  kind: CheckKind;
  /** Days-remaining threshold that was crossed (e.g. 30, 14, 7). 0 = state alert. */
  threshold: number;
  level: Level;
  message: string;
  firedAt: string;
  resolvedAt: string | null;
}

export interface AlertsFile {
  schema: 1;
  alerts: Alert[];
}
