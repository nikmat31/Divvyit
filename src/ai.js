// Talks to our own /api/parse-bill proxy, which holds the Gemini key server
// side. Falls back to on-device Tesseract in main.js whenever this is
// unavailable (not deployed, offline, rate-limited, quota exhausted).

import { prepareForUpload } from "./ocr.js";

// Same-origin by default. Point at a deployed proxy while developing locally:
//   localStorage.setItem("divvy.aiEndpoint", "https://your-app.vercel.app/api/parse-bill")
export function endpoint() {
  try {
    return localStorage.getItem("divvy.aiEndpoint") || "/api/parse-bill";
  } catch {
    return "/api/parse-bill";
  }
}

// Thrown when the proxy simply isn't there — the caller should fall back
// quietly rather than showing an error.
export class AIUnavailable extends Error {}

const TIMEOUT_MS = 45000;

/**
 * @returns {{ items: {name,qty,price}[], charges: object, printedTotal: number,
 *             restaurant: string, date: string, currencySymbol: string,
 *             confidence: string }}
 */
export async function parseBillWithAI(file, { onStatus } = {}) {
  onStatus?.("Preparing image…");
  const { base64, mimeType } = await prepareForUpload(file);

  onStatus?.("Reading the bill with AI…");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(endpoint(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // Network error / aborted / no such host -> treat as "not available".
    throw new AIUnavailable(
      e?.name === "AbortError" ? "AI request timed out." : "AI service unreachable.",
    );
  } finally {
    clearTimeout(timer);
  }

  // No function deployed: a static host returns the HTML shell or a 404.
  if (res.status === 404 || res.status === 405) {
    throw new AIUnavailable("AI endpoint not deployed.");
  }
  const ctype = res.headers.get("content-type") || "";
  if (!ctype.includes("application/json")) {
    throw new AIUnavailable("AI endpoint not deployed.");
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error || `AI request failed (${res.status})`;
    // A missing key is a deployment problem, not a per-image failure.
    if (res.status === 500 && /GEMINI_API_KEY/i.test(msg)) throw new AIUnavailable(msg);
    throw new Error(msg);
  }
  const out = normalize(data);
  if (!out.items.length) {
    throw new Error(data?.error || "The AI couldn't read any items on that bill.");
  }
  return out;
}

const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

/**
 * Force whatever came back into one canonical shape. Defensive on purpose: the
 * model's own field name is `amount` while our proxy normalises to `price`, and
 * charges may arrive nested or flat. Accepting both means a contract change on
 * either side degrades gracefully instead of throwing.
 */
function normalize(data) {
  const d = data || {};
  const c = d.charges && typeof d.charges === "object" ? d.charges : d;
  return {
    items: (Array.isArray(d.items) ? d.items : [])
      .map((it) => ({
        name: String(it?.name ?? "").trim(),
        qty: Math.max(1, Math.round(Number(it?.qty) || 1)),
        price: n(it?.price ?? it?.amount),
      }))
      .filter((it) => it.name && it.price > 0),
    charges: {
      tax: n(c.tax),
      tip: n(c.tip),
      service: n(c.service),
      discount: n(c.discount),
    },
    printedTotal: n(d.printedTotal),
    restaurant: String(d.restaurant ?? "").trim(),
    date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || "") ? d.date : "",
    currencySymbol: String(d.currencySymbol ?? "").trim(),
    confidence: ["high", "medium", "low"].includes(d.confidence) ? d.confidence : "medium",
  };
}
