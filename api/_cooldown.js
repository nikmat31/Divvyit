// Shared memory of which models just failed, so one unlucky scan pays for a
// stalled, capped or retired model and every scan after it skips straight
// past. Without this each scan rediscovers the same dead model on its own — a
// timeout alone burns a third of the request budget, every time, for everyone.
//
// Kept in the same Upstash as the rate limiter when it is configured (shared
// across every edge instance), plus an in-memory copy so a warm instance still
// benefits when Redis is absent or slow. Like the limiter it fails open: a
// metering outage just means no cooldowns, never a blocked scan.
//
// A cooling model is moved to the back of the chain, not removed. If every
// model is cooling the chain runs in its normal order, so a stale entry can
// cost latency but can never lock scanning out.

import { configured, pipeline } from "./_ratelimit.js";

const local = new Map(); // model -> { until: epoch ms, reason }
const key = (model) => `divvy:cool:${model}`;

/** @returns {Promise<Map<string, string>>} model -> reason, for models cooling now. */
export async function coolingModels(env, models) {
  const now = Date.now();
  const cooling = new Map();
  for (const m of models) {
    const hit = local.get(m);
    if (hit && hit.until > now) cooling.set(m, hit.reason);
  }
  if (configured(env)) {
    const out = await pipeline(env, [["MGET", ...models.map(key)]]);
    const values = out?.[0]?.result;
    if (Array.isArray(values)) {
      values.forEach((v, i) => {
        if (v) cooling.set(models[i], String(v));
      });
    }
  }
  return cooling;
}

/**
 * Applies the cooldowns gathered during one request in a single round trip.
 * @param set   [{ model, seconds, reason }]
 * @param clear models that answered after all, so their cooldown is lifted
 */
export async function updateCooldowns(env, { set = [], clear = [] }) {
  if (!set.length && !clear.length) return;
  const now = Date.now();
  for (const { model, seconds, reason } of set) {
    local.set(model, { until: now + seconds * 1000, reason });
  }
  for (const model of clear) local.delete(model);
  if (configured(env)) {
    await pipeline(env, [
      ...set.map(({ model, seconds, reason }) => ["SET", key(model), reason, "EX", seconds]),
      ...clear.map((model) => ["DEL", key(model)]),
    ]);
  }
}

// The provider's daily quotas reset at midnight Pacific time.
export function secondsUntilPacificMidnight(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(now);
    const get = (type) => Number(parts.find((p) => p.type === type)?.value) || 0;
    const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
    return Math.max(60, 86400 - elapsed);
  } catch {
    return 3600; // no timezone data: re-check hourly rather than guess a day
  }
}

/** How long to steer scans away from a model, judged by why it failed. */
export function cooldownFor(status, detail) {
  if (status === 404 || /no longer available|not found|not supported|does not exist/i.test(detail)) {
    // Retired for this key. Re-checked a few times a day in case access returns.
    return { seconds: 6 * 3600, reason: "unavailable" };
  }
  if (status === 429) {
    return /per ?day|daily/i.test(detail)
      ? { seconds: secondsUntilPacificMidnight(), reason: "daily-cap" }
      : { seconds: 60, reason: "rate-limited" };
  }
  if (status === 504) return { seconds: 60, reason: "slow" };
  if (status >= 500 || /high demand|overload/i.test(detail)) {
    return { seconds: 60, reason: "overloaded" };
  }
  return null; // a 4xx about this request says nothing about the next scan
}

// Test hook: the in-memory copy outlives a single request by design.
export function resetCooldowns() {
  local.clear();
}
