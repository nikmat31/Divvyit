// Provider call + validation for bill parsing. Pure Web-standard code (fetch,
// Request, Response) so the same file runs on Cloudflare Pages Functions,
// Netlify Functions, Vercel Edge, Deno Deploy, etc.
//
// The API key NEVER reaches the browser — it lives in the platform's env vars.

import { checkRateLimit } from "./_ratelimit.js";

// Models are tried in order until one answers. A single model is a single point
// of failure: the provider answers "this model is currently experiencing high
// demand" often enough that one-shot calls fail most of the time, so overload
// has to be survivable rather than fatal.
//
// Order matters more than it looks. Newer keys are only granted the rolling
// aliases — a key that 404s on gemini-2.5-flash burns a doomed call at the head
// of every single scan, which wastes latency AND triples the per-minute quota
// spend. So the aliases lead and the pinned versions sit at the back as
// backstops for keys that do have them. Check x-ai-attempts against a real
// deployment before reordering: 1 means the head of the chain is right.
// Override with GEMINI_MODEL, comma-separated to set your own chain.
const DEFAULT_MODEL_CHAIN = [
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
];

// A single attempt is capped so one slow model can't eat the whole budget; the
// budget caps the handler as a whole, keeping us inside the platform's function
// limit even after retries. Both are roomy once thinking is off (requestBody).
const DEFAULT_ATTEMPT_MS = 9000;
const DEFAULT_BUDGET_MS = 20000;
const ATTEMPTS_PER_MODEL = 2;
const MIN_ATTEMPT_MS = 2500; // no point starting an attempt we can't finish

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // ~5MB decoded; the client sends far less
const ALLOWED_MIME = /^image\/(jpeg|png|webp|heic|heif)$/i;

// Gemini structured-output schema. Forcing a schema is what stops the model
// from returning prose or inventing extra fields.
const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    restaurant: { type: "STRING" },
    date: { type: "STRING" }, // yyyy-mm-dd when legible, else ""
    currencySymbol: { type: "STRING" },
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          qty: { type: "INTEGER" },
          amount: { type: "NUMBER" },
        },
        required: ["name", "amount"],
      },
    },
    tax: { type: "NUMBER" },
    tip: { type: "NUMBER" },
    service: { type: "NUMBER" },
    discount: { type: "NUMBER" },
    printedTotal: { type: "NUMBER" },
    confidence: { type: "STRING" }, // "high" | "medium" | "low"
  },
  required: ["items"],
};

const PROMPT = `You are reading a photograph of a restaurant or food bill. Extract the ordered line items and the charges.

Rules — follow exactly:
1. Many bills print three numeric columns: Qty, Rate (unit price), Amount (line total). "amount" MUST be the line total actually charged, i.e. qty x rate — NOT the unit rate. If only one number is present, that is the amount.
2. "qty" is the number of units ordered for that row. Use 1 when no quantity is printed.
3. Include only things that were actually ordered — food, drinks, alcohol. Include every section (e.g. a separate liquor or bar section).
4. NEVER include: subtotals, section totals ("Food Total", "Liquor Total"), grand totals, tax lines, service charges, tips, discounts, round-off, table/bill/order numbers, GST/VAT/FSSAI/CIN registration numbers, phone numbers, addresses, dates, times, or "thank you" text.
5. Sum ALL tax lines into a single "tax" number. Indian bills often list SGST and CGST and VAT separately — add them together.
6. "service" is service/packing/delivery/convenience charges. "tip" is gratuity. "discount" is a positive number representing money taken off.
7. "printedTotal" is the single final total printed on the bill (the amount actually payable). This is used to verify the extraction, so read it carefully.
8. All numbers must be plain — no currency symbols, no thousands separators. Use a dot for decimals.
9. Do NOT guess. If a row's amount is genuinely illegible, omit that row rather than inventing a number. Set "confidence" to "low" if significant parts of the bill are unreadable.
10. Keep item names as printed (abbreviations are fine). Preserve non-Latin scripts as-is.`;

function json(body, status, origin) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// Same-origin needs no CORS. Extra origins (e.g. a local dev server) can be
// allowed explicitly via the ALLOWED_ORIGINS env var — comma separated.
function pickOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Normalise + sanity-check whatever the model returned. */
function clean(raw) {
  const items = (Array.isArray(raw?.items) ? raw.items : [])
    .map((it) => ({
      name: String(it?.name ?? "").trim().slice(0, 80),
      qty: Number.isFinite(Number(it?.qty)) ? Math.max(1, Math.round(Number(it.qty))) : 1,
      price: num(it?.amount),
    }))
    .filter((it) => it.name && it.price > 0 && it.price < 1_000_000);

  return {
    restaurant: String(raw?.restaurant ?? "").trim().slice(0, 80),
    date: /^\d{4}-\d{2}-\d{2}$/.test(raw?.date || "") ? raw.date : "",
    currencySymbol: String(raw?.currencySymbol ?? "").trim().slice(0, 4),
    items,
    charges: {
      tax: num(raw?.tax),
      tip: num(raw?.tip),
      service: num(raw?.service),
      discount: num(raw?.discount),
    },
    printedTotal: num(raw?.printedTotal),
    confidence: ["high", "medium", "low"].includes(raw?.confidence)
      ? raw.confidence
      : "medium",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ordered list of models to try for one request. */
function modelChain(env) {
  const pinned = String(env.GEMINI_MODEL || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(pinned.length ? pinned : DEFAULT_MODEL_CHAIN)];
}

function requestBody(imageBase64, mimeType, useThinking, diagThinking) {
  const generationConfig = {
    temperature: 0, // deterministic extraction, not creative writing
    responseMimeType: "application/json",
    responseSchema: RESPONSE_SCHEMA,
  };
  // Reading a bill is transcription, not reasoning. On the thinking-enabled
  // Flash builds the reasoning pass adds seconds per call for no accuracy gain
  // here, and latency is precisely what used to push us past the function
  // limit. Models that refuse the field are handled by the "no-thinking"
  // outcome in the loop below.
  if (!useThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (diagThinking === "off") delete generationConfig.thinkingConfig;
  if (diagThinking === "budget0") generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (diagThinking === "minimal" || diagThinking === "low") {
    generationConfig.thinkingConfig = { thinkingLevel: diagThinking };
  }

  return JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: PROMPT },
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
        ],
      },
    ],
    generationConfig,
  });
}

/**
 * What to do about a failed attempt.
 *   "retry"       transient — same model again
 *   "next"        this model is unusable — move down the chain
 *   "stop"        our request or our key is wrong — more attempts can't help
 *   "no-thinking" the model rejected thinkingConfig — resend without it
 */
function classify(status, detail) {
  if (status === 400 && /thinking/i.test(detail)) return "no-thinking";
  // Only two 4xx causes are the same on every model: a bad key, and a content
  // block on this image. Anything else is one model refusing something about
  // our request — a parameter, the schema, access for this key — and the next
  // model may well accept it. Stopping there used to strand scans with most of
  // the budget unspent.
  if (status === 401 || /api.?key|credential/i.test(detail)) return "stop";
  if (/returned nothing/i.test(detail) && status === 400) return "stop";
  if (status === 400 || status === 403) return "next";
  if (status === 404 || /no longer available|not found|not supported|does not exist/i.test(detail)) {
    return "next";
  }
  // Every 429 moves down the chain. Both ceilings the provider enforces — the
  // per-minute one and the daily one — are metered per project AND per model
  // (the quota ids read "...PerProjectPerModel"), so one model running out says
  // nothing about the allowance left on the next. Stopping the whole chain on
  // the first 429 stranded scans a second model would have served. Which
  // ceiling was hit only changes the wording — see sawDailyCap.
  if (status === 429) return "next";
  if (status >= 500 || /high demand|overload|unavailable|try again/i.test(detail)) return "retry";
  return "next";
}

/** One call to one model. Never throws; failures come back as data. */
async function callModel({ apiKey, model, body, timeoutMs }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: abort.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body,
    });
    const payload = await res.json().catch(() => null);

    if (!res.ok) {
      const message = payload?.error?.message || `HTTP ${res.status}`;
      // The quota id is the only thing that says whether a 429 is the
      // per-minute ceiling or the daily one, and it lives in the details rather
      // than the message. Carried along so classify() can tell them apart.
      const quotaIds = (payload?.error?.details || [])
        .flatMap((d) => d?.violations || [])
        .map((v) => v?.quotaId || v?.quotaMetric || "")
        .filter(Boolean)
        .join(" ");
      return {
        ok: false,
        status: res.status,
        detail: quotaIds ? `${message} [${quotaIds}]` : message,
      };
    }

    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();

    if (!text) {
      const reason =
        payload?.promptFeedback?.blockReason ||
        payload?.candidates?.[0]?.finishReason ||
        "empty response";
      // A refusal returns the same way every time, so treat it as terminal;
      // an otherwise-empty candidate is usually a blip worth retrying.
      const terminal = /safety|recitation|blocklist|prohibited/i.test(reason);
      return {
        ok: false,
        status: terminal ? 400 : 502,
        detail: `Model returned nothing (${reason}).`,
      };
    }

    try {
      return { ok: true, parsed: JSON.parse(text) };
    } catch {
      return { ok: false, status: 502, detail: "Model returned malformed JSON." };
    }
  } catch (e) {
    const timedOut = e?.name === "AbortError";
    return {
      ok: false,
      timedOut,
      status: timedOut ? 504 : 502,
      detail: timedOut
        ? `No response within ${Math.round(timeoutMs / 1000)}s.`
        : "Couldn't reach the model provider.",
    };
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/parse-bill?models — which models this deployment's key can call
// generateContent on, straight from the provider. Guessing this from attempt
// counts is how the chain ended up led by models the key had never had. Model
// ids only; the key never appears in the response. Cached so repeated hits
// can't turn into a stream of upstream calls.
let modelsCache = null;
async function listModels(apiKey) {
  if (modelsCache && Date.now() - modelsCache.at < 10 * 60 * 1000) return modelsCache.body;
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      { headers: { "x-goog-api-key": apiKey } },
    );
    const data = await res.json().catch(() => null);
    if (!res.ok) return { error: data?.error?.message || `HTTP ${res.status}` };
    const body = {
      chain: DEFAULT_MODEL_CHAIN,
      models: (data?.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => String(m.name || "").replace(/^models\//, ""))
        .sort(),
    };
    modelsCache = { at: Date.now(), body };
    return body;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

export async function handleParseBill(request, env) {
  const origin = pickOrigin(request, env);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: origin
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-max-age": "86400",
          }
        : {},
    });
  }
  const wantsModels =
    request.method === "GET" && new URL(request.url).searchParams.has("models");
  if (request.method !== "POST" && !wantsModels) {
    return json({ error: "Use POST." }, 405, origin);
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return json(
      { error: "Server is missing GEMINI_API_KEY. Set it in your host's environment variables." },
      500,
      origin,
    );
  }

  if (wantsModels) return json(await listModels(apiKey), 200, origin);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected a JSON body." }, 400, origin);
  }

  const { imageBase64, mimeType } = body || {};
  if (typeof imageBase64 !== "string" || !imageBase64) {
    return json({ error: "Missing imageBase64." }, 400, origin);
  }
  if (!ALLOWED_MIME.test(String(mimeType || ""))) {
    return json({ error: "Unsupported image type." }, 415, origin);
  }
  // base64 inflates by ~4/3; keeps someone from posting a huge payload.
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
    return json({ error: "Image too large — resize and retry." }, 413, origin);
  }

  // Metered only once the payload is known-good, so malformed requests can't
  // burn someone's allowance, and always before the billable model call.
  const limit = await checkRateLimit(request, env);

  // Non-sensitive diagnostics: says whether limiting is switched on and how
  // much allowance is left. Also the only way to tell "configured" apart from
  // "silently failing open" without reading platform logs.
  const withLimitHeaders = (res) => {
    res.headers.set("x-ratelimit-state", limit.state || "unknown");
    if (limit.state === "active") {
      res.headers.set("x-ratelimit-limit", String(limit.limit));
      res.headers.set("x-ratelimit-remaining", String(limit.remaining));
      res.headers.set("x-ratelimit-day-remaining", String(limit.dayRemaining));
    }
    return res;
  };

  if (!limit.ok) {
    const body = {
      error:
        limit.reason === "ip"
          ? "You've scanned a lot of bills in the last hour. Give it a few minutes — you can still add dishes by hand in the meantime."
          : "Divvy has hit its daily scanning limit. Scans fall back to your device for now, or add dishes by hand.",
    };
    const res = json(body, 429, origin);
    res.headers.set("retry-after", String(limit.retryAfter));
    return withLimitHeaders(res);
  }

  // Work down the chain, retrying each model while the whole thing stays inside
  // the budget. Bounding it matters: if we run into the platform's own function
  // limit it kills us mid-flight and the host's HTML error page goes back
  // instead of our JSON, so the client waits the full limit before it can fall
  // back to on-device OCR. Answering ourselves is always faster.
  // TEMPORARY, preview deployments only (they sit behind Vercel login):
  // ?model=<id>&thinking=budget0|minimal|low|off to measure candidates one at a
  // time. Production never reads these params.
  const diagParams = env.VERCEL_ENV === "preview" ? new URL(request.url).searchParams : null;
  const diagModel = diagParams?.get("model");
  const diagThinking = diagParams?.get("thinking");
  const chain = diagModel ? [diagModel] : modelChain(env);
  const attemptCap = Number(env.GEMINI_TIMEOUT_MS) || DEFAULT_ATTEMPT_MS;
  const deadline = Date.now() + (Number(env.GEMINI_BUDGET_MS) || DEFAULT_BUDGET_MS);

  let useThinking = false; // off unless a model turns out to insist on it
  let attempts = 0;
  let lastStatus = 502;
  let lastDetail = "Couldn't reach the model provider.";
  let lastModel = chain[0];
  let sawOverload = false;
  let sawDailyCap = false;
  // One entry per upstream call. Without it a failure only shows its final
  // summary, and one flag can mask what the other models actually said.
  const trace = [];
  const traceHeader = () =>
    trace.map((t) => `${t.model}:${t.status}:${t.ms}ms`).join(", ");

  // The client shows this text and falls back to on-device OCR either way, so
  // it should say what went wrong and whether trying again is worth it.
  const failure = () => {
    let status = lastStatus === 504 ? 504 : 502;
    let error;
    // Ordered by what the caller can do about it, most recent cause first.
    if (sawDailyCap) {
      // Nothing a retry can fix today, so don't imply one will help. Named as
      // the key's ceiling rather than the app's, since that is where the fix is.
      status = 429;
      error =
        "The API key's daily quota is used up. Scans fall back to your device until it resets.";
    } else if (lastStatus === 429) {
      status = 429;
      error = "Scans are being throttled — wait a few seconds and try again.";
    } else if (sawOverload) {
      status = 503;
      error = "The model provider is busy right now. Give it a few seconds and scan again.";
    } else if (lastStatus === 504) {
      error = "Reading the bill took too long. Trying again usually works.";
    } else if (/no longer available|not found|not supported|does not exist/i.test(lastDetail)) {
      // Google retires model versions; make the fix obvious rather than cryptic.
      error = `None of these models worked with this API key (${chain.join(
        ", ",
      )}). Set GEMINI_MODEL to one your key can use. (${lastDetail})`;
    } else {
      error = `Model provider error: ${lastDetail}`;
    }
    const res = json({ error, trace }, status, origin);
    if (status === 503) res.headers.set("retry-after", "5");
    res.headers.set("x-ai-trace", traceHeader());
    res.headers.set("x-ai-model", lastModel);
    res.headers.set("x-ai-attempts", String(attempts));
    return withLimitHeaders(res);
  };

  for (const model of chain) {
    let tries = 0;
    while (tries < ATTEMPTS_PER_MODEL) {
      const left = deadline - Date.now();
      if (left < MIN_ATTEMPT_MS) return failure();

      tries++;
      attempts++;
      lastModel = model;

      const startedAt = Date.now();
      const attempt = await callModel({
        apiKey,
        model,
        body: requestBody(imageBase64, mimeType, useThinking, diagThinking),
        timeoutMs: Math.min(attemptCap, left),
      });

      if (attempt.ok) {
        const result = clean(attempt.parsed);
        const res = result.items.length
          ? json(result, 200, origin)
          : json({ error: "No line items were readable in that image.", ...result }, 422, origin);
        trace.push({ model, status: 200, ms: Date.now() - startedAt });
        res.headers.set("x-ai-model", model);
        res.headers.set("x-ai-attempts", String(attempts));
        res.headers.set("x-ai-trace", traceHeader());
        return withLimitHeaders(res);
      }

      trace.push({
        model,
        status: attempt.status,
        ms: Date.now() - startedAt,
        // Provider messages name the model and the reason, never the key.
        detail: String(attempt.detail).slice(0, 240),
      });
      lastStatus = attempt.status;
      lastDetail = attempt.detail;

      if (attempt.status === 429 && /per ?day|daily/i.test(attempt.detail)) sawDailyCap = true;
      if (/high demand|overload|unavailable/i.test(attempt.detail) || attempt.status === 503) {
        sawOverload = true;
      }

      const verdict = classify(attempt.status, attempt.detail);
      if (verdict === "stop") return failure();
      if (verdict === "next") break;
      if (verdict === "no-thinking" && !useThinking) {
        // A config mismatch, not a real attempt — let this model think and give
        // it its full allowance. Can only fire once, since the flag stays set.
        useThinking = true;
        tries--;
        continue;
      }
      // Transient: pause briefly so a demand spike has a moment to clear.
      if (tries < ATTEMPTS_PER_MODEL) {
        await sleep(Math.max(0, Math.min(500, deadline - Date.now() - MIN_ATTEMPT_MS)));
      }
    }
  }

  return failure();
}
