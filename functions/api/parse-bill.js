// POST /api/parse-bill — Cloudflare Pages Functions adapter.
// Only used when deploying to Cloudflare Pages; Vercel uses /api/parse-bill.js.
// Set GEMINI_API_KEY as a secret under the Pages project's Settings.
import { handleParseBill } from "../../api/_bill-core.js";

export const onRequest = ({ request, env }) => handleParseBill(request, env);
