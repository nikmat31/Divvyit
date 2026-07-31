// Turns raw OCR / pasted text into structured line items + detected charges.

/**
 * Locale-agnostic money parse.
 *
 * The tricky case is grouping vs decimal separators: "1,250" is 1250 on an
 * Indian bill, while "1,25" is 1.25 in parts of Europe. Money is effectively
 * never written with 3 decimal places, so we use the length of the last group
 * to decide:
 *   last group of 3 digits -> every separator is grouping   ("1,250"    -> 1250)
 *   last group of 1-2      -> that separator is the decimal ("1,234.56" -> 1234.56)
 */
export function toNumber(raw) {
  const s = String(raw).replace(/[^\d.,]/g, "");
  if (!s) return null;

  const dec = Math.max(s.lastIndexOf("."), s.lastIndexOf(","));
  let n;
  if (dec === -1) {
    n = parseFloat(s);
  } else {
    const tail = s.slice(dec + 1);
    if (/^\d{3}$/.test(tail)) {
      n = parseFloat(s.replace(/[.,]/g, "")); // grouping, not a decimal point
    } else {
      const intPart = s.slice(0, dec).replace(/[.,]/g, "");
      n = parseFloat(`${intPart || "0"}.${tail.replace(/[.,]/g, "")}`);
    }
  }
  return Number.isFinite(n) ? n : null;
}

const MONEY = /-?(?:[$€£¥₹]|Rs\.?|INR|AED)?\s?\d[\d.,]*\d|\d/gi;

const CHARGE_RULES = [
  { key: "discount", re: /\b(discount|promo|coupon)\b/i },
  { key: "tax", re: /\b(tax|gst|vat|hst|pst|igst|cgst|sgst|utgst)\b/i },
  { key: "service", re: /\b(service|svc|convenience|packing|delivery)\b/i },
  { key: "tip", re: /\b(tip|gratuity)\b/i },
];

// Lines that are never dishes.
const NOISE =
  /\b(sub\s*total|subtotal|total|balance|amount due|round\s*off|rounding|change|cash|card|upi|visa|master|amex|rupay|paid|payment|thank|visit again|invoice|receipt|bill\s*no|t\.?\s*no|w\.?\s*no|table|server|steward|cashier|order\s*#|check\s*#|guest|covers|particulars|qty|date|time|tel|phone|ph\s*[:.]|www\.|http|gst\s*no|gstin|vat\s*no|vatin|fssai|cin|e\.?&\.?o\.?e)\b|x{4,}/i;

// Anything that looks like a total, for reconciliation against our own maths.
const TOTAL_RE = /\b(grand\s*total|total)\b/i;
const SUBTOTAL_RE = /\b(sub\s*total|subtotal)\b/i;

function numberTokens(line) {
  // Drop rates like the "2.5" in "SGST @2.5% : 113.25".
  return [...line.matchAll(MONEY)].filter(
    (t) => !line.slice(t.index + t[0].length).trimStart().startsWith("%"),
  );
}

/**
 * Pick the amount from a line, using the Qty | Rate | Amount layout that most
 * restaurant bills print. When qty * rate == amount we can trust all three,
 * which is far more robust than "take the right-most number" on noisy OCR.
 */
function extractAmount(line) {
  const tokens = numberTokens(line);
  if (!tokens.length) return null;

  if (tokens.length >= 3) {
    const last3 = tokens.slice(-3);
    const [qty, rate, amount] = last3.map((t) => toNumber(t[0]));
    if (
      qty != null && rate != null && amount != null &&
      Number.isInteger(qty) && qty >= 1 && qty <= 99 &&
      rate > 0 && amount > 0 &&
      Math.abs(qty * rate - amount) <= Math.max(1, amount * 0.02)
    ) {
      return { value: amount, qty, index: last3[0].index, raw: last3[2][0] };
    }
  }

  const pick = tokens[tokens.length - 1];
  return { value: toNumber(pick[0]), qty: 1, index: pick.index, raw: pick[0] };
}

// OCR loves to prepend junk ("Fo CHEESE PAKODA", "go VEG CRISPY"). Strip short
// leading tokens as long as a real word survives.
function stripLeadingNoise(name) {
  let out = name.replace(/^[^\p{L}\d]+/u, "");
  for (let i = 0; i < 3; i++) {
    const m = out.match(/^(\S{1,2})[\s,.:;+*'"|`~^]+(.*)$/u);
    if (!m) break;
    const rest = m[2];
    if (/\p{L}{3,}/u.test(rest)) out = rest.replace(/^[^\p{L}\d]+/u, "");
    else break;
  }
  return out;
}

function cleanName(name) {
  return stripLeadingNoise(String(name))
    .replace(/\s{2,}/g, " ")
    .replace(/[\s.:,\-|_*'"`~^]+$/u, "")
    .trim();
}

function plausibleItem(name, amount, raw) {
  if (!name || amount == null) return false;
  if (amount <= 0 || amount >= 200000) return false;
  // Phone / GST / FSSAI numbers are long digit runs, never prices.
  if ((String(raw).match(/\d/g) || []).length > 7) return false;
  if (/\d{5,}/.test(name)) return false;
  // Needs a real word, not just stray characters.
  return /\p{L}{3,}/u.test(name);
}

export function parseReceipt(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const items = [];
  const sums = { tax: 0, tip: 0, service: 0, discount: 0 };
  let detectedTotal = 0;
  let detectedSubtotal = 0;

  for (const line of lines) {
    const found = extractAmount(line);
    if (!found || found.value == null) continue;

    // Totals: remember the biggest for later reconciliation, never an item.
    if (SUBTOTAL_RE.test(line)) {
      detectedSubtotal += found.value;
      continue;
    }
    if (TOTAL_RE.test(line)) {
      detectedTotal = Math.max(detectedTotal, found.value);
      continue;
    }

    // Junk must be filtered BEFORE charges, or an id line like
    // "GST NO:27AAAFH0148N1ZD (12:48 AM)" gets read as a tax of 48.
    if (NOISE.test(line)) continue;

    // Charges accumulate — a bill can carry SGST *and* CGST *and* VAT.
    const charge = CHARGE_RULES.find((c) => c.re.test(line));
    if (charge) {
      if (found.value > 0 && found.value < 200000) sums[charge.key] += found.value;
      continue;
    }

    const name = cleanName(line.slice(0, found.index));
    if (!plausibleItem(name, found.value, found.raw)) continue;

    items.push({ name, price: found.value, qty: found.qty || 1 });
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const charges = {
    tax: sums.tax ? String(round2(sums.tax)) : "",
    tip: sums.tip ? String(round2(sums.tip)) : "",
    service: sums.service ? String(round2(sums.service)) : "",
    discount: sums.discount ? String(round2(sums.discount)) : "",
  };

  return {
    items,
    charges,
    // Printed figures we can check our own arithmetic against.
    detected: {
      total: detectedTotal || 0,
      subtotal: detectedSubtotal || 0,
    },
  };
}
