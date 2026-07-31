// Provider call + validation for bill parsing. Pure Web-standard code (fetch,
// Request, Response) so the same file runs on Cloudflare Pages Functions,
// Netlify Functions, Vercel Edge, Deno Deploy, etc.
//
// The API key NEVER reaches the browser — it lives in the platform's env vars.

// Alias that always resolves to Google's current Flash model. Deliberately not
// pinned: Google retires specific versions (gemini-2.5-flash stopped accepting
// new API keys), which hard-breaks a pinned default. Pin a version via the
// GEMINI_MODEL env var if you need byte-stable behaviour.
const DEFAULT_MODEL = "gemini-flash-latest";
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
  if (request.method !== "POST") {
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

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0, // deterministic extraction, not creative writing
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (e) {
    return json({ error: "Couldn't reach the model provider." }, 502, origin);
  }

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = payload?.error?.message || `HTTP ${res.status}`;
    const status = res.status === 429 ? 429 : 502;
    let error;
    if (res.status === 429) {
      error = "Free-tier rate limit hit — wait a moment and try again.";
    } else if (/no longer available|not found|not supported/i.test(detail)) {
      // Google retires model versions; make the fix obvious rather than cryptic.
      error = `Model "${model}" isn't usable with this API key. Set the GEMINI_MODEL environment variable to a current model. (${detail})`;
    } else {
      error = `Model provider error: ${detail}`;
    }
    return json({ error }, status, origin);
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
    return json({ error: `Model returned nothing (${reason}).` }, 502, origin);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "Model returned malformed JSON." }, 502, origin);
  }

  const result = clean(parsed);
  if (!result.items.length) {
    return json(
      { error: "No line items were readable in that image.", ...result },
      422,
      origin,
    );
  }
  return json(result, 200, origin);
}
