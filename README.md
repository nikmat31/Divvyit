<div align="center">

<img src="icon.svg" width="88" height="88" alt="Divvy">

# Divvy

**Split any food bill, dish by dish.**

Scan a bill, tag who ate what, and get exactly what each person owes —
including a fair share of tax, tip and service.

### 🍽️ [Open Divvy](https://divvyit.online/app) · [divvyit.online](https://divvyit.online)

</div>

---

## What it does

Splitting a restaurant bill fairly is annoying: someone had two beers, three people
shared the naan, and the tax needs spreading over all of it. Divvy does the
bookkeeping.

1. **Add the bill.** Photograph it, paste a screenshot, paste the text, or type
   dishes in by hand. Every parsed row stays editable.
2. **Add the people.** Just first names.
3. **Tag who had what.** Tap a name under a dish. Use **−/+** for uneven splits —
   a plate of three where one person had two and another had one.
4. **Read off the totals.** Tax, tip and service are spread in proportion to what
   each person actually ate, and totals update as you type.
5. **Share it.** A receipt-style card with everyone's amount, ready for the group chat.

Nothing to install, no account, no sign-up.

## What makes it accurate

Bill splitting is only useful if the numbers are right, so most of the work is in
getting them right and in **telling you when they might not be**.

**It checks its own arithmetic.** Divvy reads the total printed on the bill and
compares it against the sum of what it extracted. Agreement gets a green ✓;
disagreement gets a loud warning naming the exact gap. A visible mismatch beats a
silently wrong split.

**It understands bill layouts.** Restaurant bills usually print `Qty | Rate |
Amount`. Divvy validates that `qty × rate == amount` before trusting a row — far
more robust than grabbing the right-most number — and carries the quantity through
(`CHEESE PAKODA ×4`) so you know how many portions to divide.

**It sums every tax line.** An Indian bill listing SGST *and* CGST *and* VAT adds
up correctly instead of capturing only the first.

**Its money parsing is locale-aware.** `1,250` is twelve hundred and fifty, not
one-point-two-five. `1,234.56` and `1.234,56` both work. Percentage rates like
`CGST 2.5%` aren't mistaken for amounts.

**Shared amounts are whole numbers that still add up.** Per-person totals are
rounded to whole units using largest-remainder rounding, so the split always sums
to exactly the bill total — no lingering one-rupee discrepancy.

## Reading the bill

Two engines, and it picks the best available automatically.

**AI vision** — the image goes to a small server-side function that calls Google
Gemini and returns structured line items. This handles the hard cases: crumpled
thermal receipts, angled photos, faded print, poor lighting. It also reads the
restaurant name and the printed total off the bill.

**On-device OCR** — Tesseract.js running entirely in your browser, used
automatically whenever the AI service is unavailable or busy. Before recognition,
each image is oriented from its EXIF data, **auto-cropped to the receipt** (so the
table underneath isn't read as text), rescaled so characters land in a legible
range, inverted if it's a dark-mode screenshot, and passed through an adaptive
local threshold that copes with uneven lighting. If the first pass finds nothing, it
retries with different settings and orientations.

Between them: **JPEG, PNG, WebP, GIF, BMP, AVIF, HEIC/HEIF**. Drag an image in, paste
one with ⌘V, or pick several at once. Non-Latin dish names (Devanagari, Tamil, CJK)
are preserved.

> **For best results**, shoot the bill flat, straight-on and well lit, filling the
> frame. For emailed or PDF bills, pasting the text is more accurate than any scan.

## Privacy

- Your bills, people and splits are stored **only in your browser** (`localStorage`).
  There's no account, no database and no server-side copy.
- On the **OCR** path, the image never leaves your device.
- On the **AI** path, the image is sent to Google's Gemini API to be read. If you'd
  rather nothing left your device, self-host without the AI function — the app works
  fully on OCR alone.

## Self-hosting

Static files plus one serverless function. **No build step, no bundler, no
dependencies to install** — the browser loads the source directly as ES modules.

### Run locally

```bash
python3 -m http.server 8777
```

Open `http://localhost:8777`. It must be served over HTTP — opening `index.html`
via `file://` won't work, because browsers block module loading there. The AI
function won't exist locally, so scans use OCR.

### Deploy

Works on any host that serves static files and functions.

| Host | Notes |
|---|---|
| **Vercel** | Import the repo, framework preset **Other**, no build command. `api/` becomes endpoints automatically. |
| **Cloudflare Pages** | Dashboard **Direct Upload** works with no Git. The adapter in `functions/` is picked up automatically. |
| **Netlify** | Add a 3-line adapter importing `api/_bill-core.js`. |

Then set the environment variable:

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | for AI scanning | Free key from [Google AI Studio](https://aistudio.google.com/apikey). Server-side only — it is never sent to the browser. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-latest`. Pin a specific version if you want stable behaviour. |
| `ALLOWED_ORIGINS` | no | Comma-separated extra origins permitted to call the proxy. Same-origin always works. |

HTTPS is required for the camera, clipboard and native share sheet — all the hosts
above provide it.

> **Deploying publicly?** Anything fronting an API key belongs behind rate limiting
> and an access check. The shipped validation (POST-only, mime-type check, size cap)
> is input hygiene, not access control.

## How it's built

Vanilla JavaScript, no framework, no build tooling. The whole client is five ES
modules; the logic that matters is in pure functions that are easy to reason about
and test.

| File | Purpose |
|---|---|
| `index.html` | Page shell and module entry |
| `src/main.js` | UI rendering, state, share card |
| `src/split.js` | The splitting maths — pure functions |
| `src/parser.js` | Text → line items and charges — pure functions |
| `src/ocr.js` | Image decode, auto-crop, preprocessing, Tesseract |
| `src/ai.js` | AI client, with automatic fallback |
| `src/style.css` | All styling, light and dark |
| `api/_bill-core.js` | Gemini call and response validation |
| `api/parse-bill.js` | Vercel endpoint |
| `functions/api/parse-bill.js` | Cloudflare Pages endpoint |

Tesseract.js loads from a CDN on first scan. Everything else is local. Installable
to a phone home screen via the web manifest, and themed for light and dark.

## Limitations

- **Photo scans aren't perfect.** A badly degraded receipt will misread some
  amounts. The reconciliation check will tell you, and every row is editable — but
  check the numbers on a bad scan.
- **PDFs aren't read directly.** Screenshot the itemised section, or paste the text.
- **One bill at a time.** There's no saved history yet.
- **No offline support yet** — the first OCR scan fetches the engine.

## Licence

[MIT](LICENSE) — do what you like with it.
