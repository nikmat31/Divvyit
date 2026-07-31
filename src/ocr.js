// Client-side OCR built to cope with whatever image a phone or laptop throws
// at it: JPEG, PNG, WebP, GIF, BMP, TIFF, AVIF and iPhone HEIC/HEIF, plus
// dark-mode screenshots of electronic bills.
//
// Pipeline: decode -> orient -> auto-crop to the receipt -> rescale for
// legibility -> grayscale -> auto-invert -> adaptive threshold -> Tesseract.
// Weak results trigger progressively different retries (gentler threshold,
// then 90° rotations) before giving up.

// Tesseract needs roughly 20-30px tall characters. Receipts are tall and
// narrow, so we size by the SHORT side and cap total pixels for speed.
const TARGET_SHORT = 1300;
const MAX_PIXELS = 5_000_000;
const MAX_LONG = 4200;

export function isPdf(file) {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
}

function looksLikeHeic(file) {
  return (
    /hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "")
  );
}

/* ---------------- decoding ---------------- */

async function loadDrawable(file) {
  // 1) createImageBitmap — fastest, and honours EXIF rotation.
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close?.() };
  } catch {
    /* fall through */
  }
  // 2) …without options (older Safari/Firefox reject the options bag).
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, cleanup: () => bmp.close?.() };
  } catch {
    /* fall through */
  }
  // 3) <img> + object URL. Decodes HEIC/HEIF on Safari and iOS, and AVIF/TIFF
  //    wherever the browser has a native decoder. Applies EXIF automatically.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("decode-failed"));
      el.src = url;
    });
    if (img.decode) await img.decode().catch(() => {});
    return {
      src: img,
      w: img.naturalWidth,
      h: img.naturalHeight,
      cleanup: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function friendlyDecodeError(file) {
  if (isPdf(file)) {
    return new Error(
      "That's a PDF. Open it, screenshot the itemised part, and scan that — or use “Or paste bill text” below.",
    );
  }
  if (looksLikeHeic(file)) {
    return new Error(
      "This browser can't open Apple HEIC photos. On iPhone: Settings › Camera › Formats › Most Compatible, or share the photo as JPEG — then try again.",
    );
  }
  return new Error(
    `Couldn't read “${file.name || "that file"}”. Try a JPEG or PNG screenshot of the bill.`,
  );
}

/* ---------------- canvas helpers ---------------- */

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function ctxOf(c) {
  return c.getContext("2d", { willReadFrequently: true });
}
function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  ctxOf(c).drawImage(src, 0, 0);
  return c;
}
function rotate90(src, turns) {
  const t = ((turns % 4) + 4) % 4;
  if (!t) return copyCanvas(src);
  const swap = t % 2 === 1;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const x = ctxOf(c);
  x.translate(c.width / 2, c.height / 2);
  x.rotate((t * Math.PI) / 2);
  x.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function toCanvas({ src, w, h }) {
  if (!w || !h) throw new Error("empty-image");
  const c = makeCanvas(w, h);
  const x = ctxOf(c);
  x.fillStyle = "#ffffff"; // transparent PNGs shouldn't become black
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(src, 0, 0);
  return c;
}

/* ---------------- auto-crop to the receipt ---------------- */

function otsu(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = v; }
  }
  return thr;
}

/**
 * A photographed receipt is usually the large bright object on a darker
 * surface. Find the biggest bright blob and crop to it — this removes table
 * texture that would otherwise be binarised into fake glyphs.
 * Returns a cropped canvas, or the original when detection isn't confident.
 */
function autoCrop(canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const pw = Math.min(320, W);
  const ph = Math.max(1, Math.round((H * pw) / W));
  if (pw < 40 || ph < 40) return canvas;

  const proxy = makeCanvas(pw, ph);
  ctxOf(proxy).drawImage(canvas, 0, 0, pw, ph);
  const d = ctxOf(proxy).getImageData(0, 0, pw, ph).data;

  const gray = new Uint8Array(pw * ph);
  for (let i = 0, k = 0; i < d.length; i += 4, k++) {
    gray[k] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
  }
  const thr = otsu(gray);
  const bright = new Uint8Array(pw * ph);
  for (let k = 0; k < gray.length; k++) bright[k] = gray[k] > thr ? 1 : 0;

  // largest 4-connected bright component
  const seen = new Uint8Array(pw * ph);
  const stack = new Int32Array(pw * ph);
  let best = null;
  for (let start = 0; start < bright.length; start++) {
    if (!bright[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let area = 0, minX = pw, maxX = -1, minY = ph, maxY = -1;
    while (sp) {
      const k = stack[--sp];
      const y = (k / pw) | 0;
      const x = k - y * pw;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && bright[k - 1] && !seen[k - 1]) { seen[k - 1] = 1; stack[sp++] = k - 1; }
      if (x < pw - 1 && bright[k + 1] && !seen[k + 1]) { seen[k + 1] = 1; stack[sp++] = k + 1; }
      if (y > 0 && bright[k - pw] && !seen[k - pw]) { seen[k - pw] = 1; stack[sp++] = k - pw; }
      if (y < ph - 1 && bright[k + pw] && !seen[k + pw]) { seen[k + pw] = 1; stack[sp++] = k + pw; }
    }
    if (!best || area > best.area) best = { area, minX, maxX, minY, maxY };
  }
  if (!best) return canvas;

  const frac = best.area / (pw * ph);
  if (frac < 0.04 || frac > 0.95) return canvas;

  // Rebuild just the winning component, then erode it a little so the paper's
  // shadowed rim doesn't drag surrounding table texture in with it.
  let comp = new Uint8Array(pw * ph);
  {
    let sp = 0;
    const st = new Int32Array(pw * ph);
    const seen2 = new Uint8Array(pw * ph);
    const startK = best.minY * pw + best.minX;
    // find a pixel that belongs to the component
    let seed = -1;
    for (let k = startK; k < bright.length; k++) {
      if (!bright[k]) continue;
      const y = (k / pw) | 0;
      const x = k - y * pw;
      if (x >= best.minX && x <= best.maxX && y >= best.minY && y <= best.maxY) { seed = k; break; }
    }
    if (seed < 0) return canvas;
    st[sp++] = seed;
    seen2[seed] = 1;
    while (sp) {
      const k = st[--sp];
      comp[k] = 1;
      const y = (k / pw) | 0;
      const x = k - y * pw;
      if (x > 0 && bright[k - 1] && !seen2[k - 1]) { seen2[k - 1] = 1; st[sp++] = k - 1; }
      if (x < pw - 1 && bright[k + 1] && !seen2[k + 1]) { seen2[k + 1] = 1; st[sp++] = k + 1; }
      if (y > 0 && bright[k - pw] && !seen2[k - pw]) { seen2[k - pw] = 1; st[sp++] = k - pw; }
      if (y < ph - 1 && bright[k + pw] && !seen2[k + pw]) { seen2[k + pw] = 1; st[sp++] = k + pw; }
    }
  }
  // The bright blob has holes wherever there's dark TEXT. Fill them, otherwise
  // masking punches the words out of the receipt. Flood the true outside from
  // the border; anything unreached is interior and belongs to the paper.
  {
    const outside = new Uint8Array(pw * ph);
    const st = new Int32Array(pw * ph);
    let sp = 0;
    const push = (k) => {
      if (!comp[k] && !outside[k]) { outside[k] = 1; st[sp++] = k; }
    };
    for (let x = 0; x < pw; x++) { push(x); push((ph - 1) * pw + x); }
    for (let y = 0; y < ph; y++) { push(y * pw); push(y * pw + pw - 1); }
    while (sp) {
      const k = st[--sp];
      const y = (k / pw) | 0;
      const x = k - y * pw;
      if (x > 0) push(k - 1);
      if (x < pw - 1) push(k + 1);
      if (y > 0) push(k - pw);
      if (y < ph - 1) push(k + pw);
    }
    for (let k = 0; k < comp.length; k++) if (!outside[k]) comp[k] = 1;
  }

  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(comp);
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const k = y * pw + x;
        if (!comp[k]) continue;
        if (
          x === 0 || y === 0 || x === pw - 1 || y === ph - 1 ||
          !comp[k - 1] || !comp[k + 1] || !comp[k - pw] || !comp[k + pw]
        ) next[k] = 0;
      }
    }
    comp = next;
  }

  // bbox of the eroded component
  let minX = pw, maxX = -1, minY = ph, maxY = -1, area = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (!comp[y * pw + x]) continue;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0 || area / (pw * ph) < 0.03) return canvas;

  // Alpha mask: opaque over the receipt, transparent everywhere else.
  const maskC = makeCanvas(pw, ph);
  const mctx = ctxOf(maskC);
  const mimg = mctx.createImageData(pw, ph);
  for (let k = 0; k < comp.length; k++) {
    const i = k * 4;
    mimg.data[i] = mimg.data[i + 1] = mimg.data[i + 2] = 255;
    mimg.data[i + 3] = comp[k] ? 255 : 0;
  }
  mctx.putImageData(mimg, 0, 0);

  // Apply the mask at full resolution, flatten onto white, then crop to bbox.
  const masked = makeCanvas(W, H);
  const mx2 = ctxOf(masked);
  mx2.drawImage(canvas, 0, 0);
  mx2.globalCompositeOperation = "destination-in";
  mx2.drawImage(maskC, 0, 0, W, H);
  mx2.globalCompositeOperation = "source-over";

  const sx = (minX / pw) * W;
  const sy = (minY / ph) * H;
  const sw = ((maxX - minX + 1) / pw) * W;
  const sh = ((maxY - minY + 1) / ph) * H;
  if (sw < 60 || sh < 60) return canvas;

  const out = makeCanvas(sw, sh);
  const octx = ctxOf(out);
  octx.fillStyle = "#ffffff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(masked, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

// Size so characters land in Tesseract's comfort zone: drive the SHORT side to
// ~1300px rather than capping the long side, which used to shrink tall
// receipts until the text was unreadable.
function resizeForOcr(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const short = Math.min(w, h);
  let scale = TARGET_SHORT / short;
  if (Math.max(w, h) * scale > MAX_LONG) scale = MAX_LONG / Math.max(w, h);
  if (w * scale * h * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  scale = Math.min(scale, 3);
  if (Math.abs(scale - 1) < 0.02) return canvas;

  const out = makeCanvas(w * scale, h * scale);
  const x = ctxOf(out);
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = "high";
  x.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

/* ---------------- enhancement ---------------- */

function adaptiveThreshold(gray, W, H) {
  const iw = W + 1;
  const integral = new Int32Array(iw * (H + 1));
  for (let y = 0; y < H; y++) {
    let rowSum = 0;
    for (let x = 0; x < W; x++) {
      rowSum += gray[y * W + x];
      integral[(y + 1) * iw + (x + 1)] = integral[y * iw + (x + 1)] + rowSum;
    }
  }
  // Window ~ a few text lines tall; too large re-introduces background shading.
  const r = Math.max(6, Math.round(Math.min(W, H) / 40));
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(H - 1, y + r);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(W - 1, x + r);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        integral[(y1 + 1) * iw + (x1 + 1)] -
        integral[y0 * iw + (x1 + 1)] -
        integral[(y1 + 1) * iw + x0] +
        integral[y0 * iw + x0];
      out[y * W + x] = gray[y * W + x] < sum / area - 8 ? 0 : 255;
    }
  }
  gray.set(out);
}

function contrastStretch(gray) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const loCut = gray.length * 0.02;
  const hiCut = gray.length * 0.98;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loCut) { lo = v; break; } }
  acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiCut) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < gray.length; i++) {
    const v = ((gray[i] - lo) / range) * 255;
    gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

function enhance(canvas, { binarize }) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = ctxOf(canvas);
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;

  const gray = new Uint8Array(W * H);
  let sum = 0;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    sum += g;
  }

  // Dark-mode screenshot (light text on dark) — invert so text is dark on light.
  if (sum / gray.length < 110) {
    for (let p = 0; p < gray.length; p++) gray[p] = 255 - gray[p];
  }

  if (binarize) adaptiveThreshold(gray, W, H);
  else contrastStretch(gray);

  for (let p = 0, i = 0; p < gray.length; p++, i += 4) {
    d[i] = d[i + 1] = d[i + 2] = gray[p];
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ---------------- recognition ---------------- */

let workerPromise = null;
async function getWorker(onProgress) {
  const T = globalThis.Tesseract;
  if (!T) {
    throw new Error(
      "OCR engine didn't load (it needs an internet connection the first time). You can still paste the bill text or add dishes manually.",
    );
  }
  if (!workerPromise) {
    workerPromise = T.createWorker("eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text" && workerPromise?._onProgress) {
          workerPromise._onProgress(Math.round(m.progress * 100));
        }
      },
    }).catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  const worker = await workerPromise;
  workerPromise._onProgress = onProgress;
  return worker;
}

// Exposed so the preprocessing stages can be inspected and tested in isolation.
export const _internals = { loadDrawable, toCanvas, autoCrop, resizeForOcr, enhance, rotate90 };

/**
 * Decode + crop an image for UPLOAD to a vision model. Deliberately keeps full
 * tone (no binarising) — models read natural greyscale far better than
 * thresholded bitmaps — but reuses the same receipt-detection crop, which both
 * improves accuracy and cuts the payload a lot.
 * @returns {{ base64: string, mimeType: string, width: number, height: number }}
 */
export async function prepareForUpload(file, opts = {}) {
  const { targetShort = 1200, maxLong = 2800, maxPixels = 4_000_000 } = opts;

  if (isPdf(file)) throw friendlyDecodeError(file);
  let drawable;
  try {
    drawable = await loadDrawable(file);
  } catch {
    throw friendlyDecodeError(file);
  }

  let cropped;
  try {
    cropped = autoCrop(toCanvas(drawable));
  } finally {
    drawable.cleanup?.();
  }

  const w = cropped.width;
  const h = cropped.height;
  let scale = targetShort / Math.min(w, h);
  if (Math.max(w, h) * scale > maxLong) scale = maxLong / Math.max(w, h);
  if (w * scale * h * scale > maxPixels) scale = Math.sqrt(maxPixels / (w * h));
  scale = Math.min(scale, 2);

  let out = cropped;
  if (Math.abs(scale - 1) > 0.02) {
    out = makeCanvas(w * scale, h * scale);
    const x = ctxOf(out);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, out.width, out.height);
    x.drawImage(cropped, 0, 0, out.width, out.height);
  }

  const blob = await new Promise((res) => out.toBlob(res, "image/jpeg", 0.85));
  if (!blob) throw new Error("Couldn't prepare the image for upload.");
  const base64 = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(",")[1] || "");
    fr.onerror = () => rej(new Error("read-failed"));
    fr.readAsDataURL(blob);
  });

  return { base64, mimeType: "image/jpeg", width: out.width, height: out.height };
}

/**
 * @param file      an image File/Blob
 * @param opts.evaluate(text) -> number   how useful the text is (item count)
 * @param opts.onProgress(pct)
 * @param opts.onStatus(msg)
 */
export async function runOCR(file, opts = {}) {
  const { evaluate = () => 1, onProgress, onStatus } = opts;

  if (isPdf(file)) throw friendlyDecodeError(file);

  onStatus?.("Reading image…");
  let drawable;
  try {
    drawable = await loadDrawable(file);
  } catch {
    throw friendlyDecodeError(file);
  }

  let prepared;
  try {
    onStatus?.("Finding the bill…");
    prepared = resizeForOcr(autoCrop(toCanvas(drawable)));
  } finally {
    drawable.cleanup?.();
  }

  const worker = await getWorker(onProgress);
  let best = { text: "", score: -1 };

  const attempt = async (label, canvas, psm) => {
    onStatus?.(label);
    await worker.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: "1",
    });
    const text = (await worker.recognize(canvas)).data.text || "";
    const score = evaluate(text);
    if (score > best.score) best = { text, score };
    return score;
  };

  // 1) binarised, single uniform block — right for most receipts
  if ((await attempt("Reading the bill…", enhance(copyCanvas(prepared), { binarize: true }), "6")) >= 3)
    return best.text;

  // 2) gentler contrast, column segmentation — for glossy or low-contrast photos
  if ((await attempt("Trying a sharper pass…", enhance(copyCanvas(prepared), { binarize: false }), "4")) >= 3)
    return best.text;

  // 3) the bill may have been photographed sideways with no EXIF hint
  for (const turns of [1, 3, 2]) {
    const rotated = enhance(rotate90(prepared, turns), { binarize: true });
    if ((await attempt("Checking orientation…", rotated, "6")) >= 3) return best.text;
  }

  return best.text;
}
