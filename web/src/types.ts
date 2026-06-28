// Mirrors the engine's emitted shapes in ../../src/core/types.ts.
// Kept as a standalone copy so the dashboard builds without the engine.

export type Level = "critical" | "warn" | "ok" | "unknown";

export interface SslResult {
  level: Level;
  message: string;
  validTo: string | null;
  daysRemaining: number | null;
  issuer: string | null;
  authorized: boolean;
  authorizationError: string | null;
  altNames: string[];
}

export interface DomainResult {
  level: Level;
  message: string;
  expiry: string | null;
  daysRemaining: number | null;
  registrar: string | null;
  statuses: string[];
  source: "rdap" | "whois" | null;
}

export interface DnsResult {
  level: Level;
  message: string;
  recordHash: string;
  records: Record<string, string[]>;
  comparedTo: "previous" | "baseline" | "first-observation";
  drift: string[];
}

export interface TargetStatus {
  id: string;
  label: string;
  domain: string;
  worst: Level;
  ssl: SslResult | null;
  domain_: DomainResult | null;
  dns: DnsResult | null;
}

export interface StatusFile {
  schema: 1;
  generatedAt: string;
  durationMs: number;
  summary: Record<Level, number>;
  targets: TargetStatus[];
}
