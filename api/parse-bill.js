// POST /api/parse-bill  — Vercel Edge Function.
// Thin adapter; all logic lives in _bill-core.js (files prefixed with "_" are
// not turned into routes by Vercel).
//
// Requires the GEMINI_API_KEY environment variable, set in the Vercel dashboard
// under Settings -> Environment Variables. Optional: GEMINI_MODEL, ALLOWED_ORIGINS.
import { handleParseBill } from "./_bill-core.js";

export const config = { runtime: "edge" };

export default async function handler(request) {
  return handleParseBill(request, {
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GEMINI_MODEL: process.env.GEMINI_MODEL,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
  });
}
