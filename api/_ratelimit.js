// Rate limiting for the bill-parsing proxy, backed by Upstash Redis over its
// REST API (plain fetch — no SDK, so nothing to install and it runs on any edge
// runtime).
//
// Two independent limits:
//   per-IP   — stops one person hammering the endpoint
//   per-day  — a global ceiling so the provider's free tier can't be drained
//              in a single burst, whoever is calling
//
// Both are OPTIONAL. With no UPSTASH_* env vars configured this module does
// nothing and every request is allowed, so the app still works before you set
// Redis up. If Upstash itself errors or times out we also allow the request:
// a metering outage shouldn't take the product down, and the worst case is
// quota exhaustion, which degrades to on-device OCR rather than failing.

const DEFAULT_PER_IP_HOURLY = 15;
const DEFAULT_PER_DAY = 500;
const TIMEOUT_MS = 1500; // never let metering add real latency

function configured(env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

/** Client IP as seen by the platform. */
export function clientIp(request) {
  const h = request.headers;
  const xff = h.get("x-forwarded-for");
  return (
    h.get("cf-connecting-ip") ||
    h.get("x-real-ip") ||
    (xff ? xff.split(",")[0].trim() : "") ||
    "unknown"
  );
}

// Day bucket in UTC, matching how most providers reset their daily quota.
function dayKey() {
  return new Date().toISOString().slice(0, 10);
}
// Hour bucket, so per-IP limits roll rather than resetting on the hour only.
function hourKey() {
  return new Date().toISOString().slice(0, 13);
}

/**
 * One round trip: INCR both counters and set their TTLs.
 * Upstash's pipeline endpoint returns results in order.
 */
async function pipeline(env, commands) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // fail open
  } finally {
    clearTimeout(t);
  }
}

/**
 * @returns {{ok: true} | {ok: false, reason: "ip"|"day", retryAfter: number}}
 */
export async function checkRateLimit(request, env) {
  // "disabled"  — no Upstash credentials, limiting skipped
  // "unavailable" — credentials present but Redis didn't answer (failing open)
  // "active"    — counters incremented normally
  if (!configured(env)) return { ok: true, state: "disabled" };

  const perIp = Number(env.RATE_PER_IP_HOURLY) || DEFAULT_PER_IP_HOURLY;
  const perDay = Number(env.RATE_PER_DAY) || DEFAULT_PER_DAY;

  const ipKey = `divvy:ip:${clientIp(request)}:${hourKey()}`;
  const globalKey = `divvy:day:${dayKey()}`;

  const out = await pipeline(env, [
    ["INCR", ipKey],
    ["EXPIRE", ipKey, 3600, "NX"],
    ["INCR", globalKey],
    ["EXPIRE", globalKey, 86400, "NX"],
  ]);
  if (!out || !Array.isArray(out)) return { ok: true, state: "unavailable" };

  const ipCount = Number(out[0]?.result ?? 0);
  const dayCount = Number(out[2]?.result ?? 0);
  const base = {
    state: "active",
    limit: perIp,
    remaining: Math.max(0, perIp - ipCount),
    dayRemaining: Math.max(0, perDay - dayCount),
  };

  if (ipCount > perIp) {
    // Seconds left in this hour bucket.
    const retryAfter = 3600 - (Math.floor(Date.now() / 1000) % 3600);
    return { ...base, ok: false, reason: "ip", retryAfter };
  }
  if (dayCount > perDay) {
    const retryAfter = 86400 - (Math.floor(Date.now() / 1000) % 86400);
    return { ...base, ok: false, reason: "day", retryAfter };
  }
  return { ...base, ok: true };
}
