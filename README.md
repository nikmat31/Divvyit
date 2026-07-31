# 🍽️ Divvy — food bill splitter

Scan any food bill (photo, screenshot, or pasted text), tag who ate what, and get each person's total — including a fair share of tax, tip and service. Everything runs in the browser: no accounts, no server, no upload. Your bill never leaves your device.

## Run it locally

The app is plain ES modules with **no build step**, but it must be served over HTTP (opening `index.html` via `file://` won't work, because browsers block module loading there).

```bash
cd "New App" && python3 -m http.server 8777
```

Then open **http://localhost:8777/**.

To test from your phone on the same Wi-Fi, use your Mac's IP: `http://<your-ip>:8777/`.

## Two ways it reads a bill

1. **AI vision (best)** — the image goes to `/api/parse-bill`, a small serverless function that calls **Google Gemini** and returns structured line items. Reads crumpled, angled, low-contrast receipts that OCR can't, and also picks up the restaurant name, date and printed total.
2. **On-device OCR (fallback)** — Tesseract.js in the browser. Used automatically whenever the AI endpoint is missing, unreachable, or rate-limited. Nothing leaves the device on this path.

The app always tries AI first and falls back silently, so it works before you deploy the function — just less accurately.

## Deploy (no Node needed)

### Vercel — recommended

Files in `api/` automatically become endpoints, so there's nothing to configure.

1. Push this folder to a GitHub repo.
2. On [vercel.com](https://vercel.com) → **Add New → Project** → import the repo. Framework preset: **Other**. No build command.
3. **Settings → Environment Variables** → add `GEMINI_API_KEY` (get one free at [aistudio.google.com/apikey](https://aistudio.google.com/apikey)).
4. Redeploy. Done.

Optional env vars: `GEMINI_MODEL` (defaults to `gemini-flash-latest`), `ALLOWED_ORIGINS` (comma-separated origins allowed to call the proxy cross-origin; same-origin always works).

> Vercel's free Hobby tier is **non-commercial**. If Divvy ever makes money, move to Pro or use Cloudflare.

### Cloudflare Pages — if you'd rather not use Git

Supports dashboard **Direct Upload**, so you can drag the folder in with no repo and no CLI.

1. Workers & Pages → Create → Pages → **Upload assets** → upload this folder.
2. Settings → **Variables and secrets** → add `GEMINI_API_KEY` as a secret.
3. The adapter at `functions/api/parse-bill.js` is picked up automatically.

### Netlify

Add a `netlify/functions/parse-bill.mjs` containing:

```js
import { handleParseBill } from "../../api/_bill-core.js";
export default (req) => handleParseBill(req, process.env);
export const config = { path: "/api/parse-bill" };
```

Then set `GEMINI_API_KEY` in Site configuration → Environment variables.

### Verify your key before deploying

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_KEY" | head -40
```

If that lists models, the key works. Model versions get retired — if a call fails with "no longer available", set `GEMINI_MODEL` to a current model from that list.

**HTTPS is required** for the camera, clipboard and native share sheet — all three hosts provide it automatically.

## Privacy

On the OCR path nothing leaves your device. On the AI path the **bill image is sent to Google**; on the Gemini free tier Google may use submitted data to improve their products. If that matters for your bills, either don't deploy the function (OCR-only still works) or use a paid tier with data-use guarantees.

## How to use

1. **Who's here** — add each person by name.
2. **Add the bill** — scan a photo, drag an image in, paste one with ⌘V, paste the receipt text, or add dishes manually. Parsed rows are always editable.
3. **Assign** — tap a name under each dish to add their share. Use the **−/+** steppers for uneven splits, e.g. a plate of 3 where one person had 2 and another had 1. A dish left untagged is shared equally by everyone.
4. **Tax, tip & extras** — auto-filled when detected; edit freely. Split in proportion to what each person ate.
5. **Each person owes** — live totals that reconcile to the grand total.
6. **Currency** — selector top-right (defaults to **₹ INR**).
7. **Share the split** — a receipt-style card with everyone's rounded amount and a **PAID · NOW PAY UP** stamp. Set a restaurant name and date, then Share (native share sheet), Copy text (WhatsApp-ready) or Save image (PNG).

## Accuracy & the reconciliation check

Divvy reads the **Total** printed on the bill and compares it with its own arithmetic. If they disagree by more than 1% you get a loud warning naming the gap; if they agree you get a green ✓. This is the safety net — on-device OCR will sometimes misread a digit, and a visible mismatch beats a silently wrong split.

Bills that print `Qty | Rate | Amount` are parsed structurally: when `qty × rate == amount` all three are trusted, which is far more robust than reading the right-most number. The quantity is carried into the dish name (`CHEESE PAKODA ×4`) so you know how many to divide.

Multiple tax lines are **summed**, not overwritten — an Indian bill with SGST + CGST + VAT adds up correctly.

**Real-world expectation:** a flat, well-lit, straight-on photo parses well. A crumpled, stained or faded thermal receipt shot at an angle will recover most item *names* but misread some *amounts* — the mismatch warning will tell you, and every row is editable. For those bills, pasting the text (from an emailed/PDF bill) is the accurate path.

## Scanning: what works

Decoding tries `createImageBitmap` first, then falls back to an `<img>` decode, so it reads **JPEG, PNG, WebP, GIF, BMP, AVIF, TIFF and HEIC/HEIF** wherever the browser has a decoder (HEIC works natively on Safari/iOS).

Before OCR each image is oriented via EXIF, rescaled (big photos down, small ones up), converted to grayscale, **auto-inverted if it's a dark-mode screenshot**, and passed through a local adaptive threshold that handles uneven lighting and shadows. If the first pass finds no line items, a second gentler pass runs with different page segmentation.

- **PDF bills** aren't decoded in-browser — screenshot the itemised section, or use "Or paste bill text" (which is more accurate than OCR anyway).
- Non-Latin dish names (Devanagari, Tamil, CJK…) are preserved.
- Money parsing handles `1,250` → 1250, `1,234.56`, and `1.234,56` correctly, and ignores rates like `CGST 2.5%`.

## Project layout

| File | Purpose |
|------|---------|
| `index.html` | Page shell, meta tags, module entry |
| `src/main.js` | UI rendering, state, share sheet |
| `src/split.js` | The splitting math (pure functions) |
| `src/parser.js` | Text → line items + charges (pure functions) |
| `src/ocr.js` | Image decoding, auto-crop, preprocessing, Tesseract |
| `src/ai.js` | Client for the AI proxy, with graceful fallback |
| `src/style.css` | All styles (light + dark) |
| `api/_bill-core.js` | The Gemini call + response validation (platform-agnostic) |
| `api/parse-bill.js` | Vercel endpoint (thin adapter) |
| `functions/api/parse-bill.js` | Cloudflare Pages endpoint (thin adapter) |
| `manifest.webmanifest`, `icon.svg` | Installability / home-screen icon |

Tesseract.js is loaded from a CDN on first scan; everything else is local. The
`_`-prefix on `_bill-core.js` keeps Vercel from exposing it as a route.

To point a local copy at your deployed proxy while developing:

```js
localStorage.setItem("divvy.aiEndpoint", "https://your-app.vercel.app/api/parse-bill")
```

(and add your local origin to `ALLOWED_ORIGINS` on the host).

## Known gaps

- No offline support yet (no service worker), and the first OCR scan needs a connection to fetch the engine.
- One bill at a time — there's no saved history.
- The proxy has no rate limiting. It's protected by same-origin, POST-only, a mime-type check and a 5MB cap, but a determined person could still burn your free quota. Add rate limiting before sharing the URL widely.
- No automated tests yet; `split.js` and `parser.js` are pure and would be easy to cover.
