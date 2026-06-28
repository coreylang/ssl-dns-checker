import tls from "node:tls";
import type { Level, SslResult, Target } from "../core/types.js";

const DAY_MS = 86_400_000;

/** Days-remaining thresholds, worst first. The first one crossed wins. */
export const SSL_THRESHOLDS = [3, 7, 14, 30] as const;

function levelForDays(days: number, authorized: boolean): Level {
  if (days < 0) return "critical"; // already expired
  if (!authorized) return "critical"; // valid dates but chain won't verify
  if (days <= 7) return "critical";
  if (days <= 30) return "warn";
  return "ok";
}

/**
 * Inspect a server's leaf certificate.
 *
 * We connect with `rejectUnauthorized: false` on purpose: a normal handshake
 * throws on an expired or chain-broken cert *before* we can read it, and that
 * is exactly the certificate we most need to report on. We then judge validity
 * ourselves from `socket.authorized` + the cert dates.
 */
export function checkSsl(target: Target, timeoutMs = 10_000): Promise<SslResult> {
  const host = target.sslHost ?? target.domain;
  const port = target.port ?? 443;
  const checkedAt = new Date().toISOString();

  return new Promise<SslResult>((resolve) => {
    const fail = (message: string): SslResult => ({
      kind: "ssl",
      level: "critical",
      message,
      checkedAt,
      validTo: null,
      daysRemaining: null,
      issuer: null,
      authorized: false,
      authorizationError: message,
      altNames: [],
    });

    let settled = false;
    const done = (r: SslResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate(true);
        if (!cert || Object.keys(cert).length === 0) {
          socket.destroy();
          return done(fail("Server presented no certificate"));
        }

        const validTo = new Date(cert.valid_to);
        const daysRemaining = Math.floor((validTo.getTime() - Date.now()) / DAY_MS);
        const authorized = socket.authorized;
        const authError = authorized ? null : String(socket.authorizationError ?? "unverified chain");
        const level = levelForDays(daysRemaining, authorized);

        const altNames = (cert.subjectaltname ?? "")
          .split(",")
          .map((s) => s.trim().replace(/^DNS:/, ""))
          .filter(Boolean);

        let message: string;
        if (daysRemaining < 0) message = `Certificate expired ${-daysRemaining}d ago`;
        else if (!authorized) message = `Chain does not verify: ${authError}`;
        else message = `Valid for ${daysRemaining}d`;

        socket.end();
        done({
          kind: "ssl",
          level,
          message,
          checkedAt,
          validTo: validTo.toISOString(),
          daysRemaining,
          issuer: (cert.issuer?.O ?? cert.issuer?.CN ?? "unknown") as string,
          authorized,
          authorizationError: authError,
          altNames,
        });
      },
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done(fail(`Handshake timed out after ${timeoutMs}ms`));
    });
    socket.on("error", (err) => done(fail(`TLS error: ${err.message}`)));
  });
}
