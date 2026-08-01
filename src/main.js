import { parseReceipt } from "./parser.js";
import { computeTotals } from "./split.js";
import { runOCR } from "./ocr.js";
import { parseBillWithAI, AIUnavailable } from "./ai.js";

const STORAGE_KEY = "divvy.v1";
const PALETTE = [
  "#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316", "#64748b",
];
const CURRENCIES = [
  { sym: "₹", code: "INR" },
  { sym: "$", code: "USD" },
  { sym: "€", code: "EUR" },
  { sym: "£", code: "GBP" },
  { sym: "¥", code: "JPY" },
  { sym: "A$", code: "AUD" },
  { sym: "C$", code: "CAD" },
  { sym: "S$", code: "SGD" },
  { sym: "AED ", code: "AED" },
];

// Single source of truth for a blank bill. Both startup and "clear everything"
// go through this, so the two can never drift apart.
function blankState(currency = "₹") {
  return {
    currency,
    billName: "",
    billDate: "",
    billTotal: 0, // total printed on the bill, for reconciliation
    members: [],
    items: [],
    charges: { tax: "", tip: "", service: "", discount: "" },
  };
}

let state = migrate(load()) || blankState();

let ocr = { running: false, progress: 0, status: "", mode: "ocr" };

/* ---------- guided flow ----------
   1 People  ->  2 Bill  ->  3 Split
   Derived on load so a returning user lands where they left off. */
const STEPS = [
  { n: 1, label: "People" },
  { n: 2, label: "Bill" },
  { n: 3, label: "Split" },
];
let step = 1;
function deriveStep() {
  if (state.items.length) return 3;
  if (state.members.length) return 2;
  return 1;
}
function stepReachable(n) {
  if (n === 1) return true;
  if (n === 2) return state.members.length > 0;
  return state.items.length > 0;
}
function goStep(n, { scroll = true } = {}) {
  if (!stepReachable(n)) return;
  step = n;
  render();
  if (scroll) window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------- persistence + migration ---------- */
function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}
// Fill in anything a older/partial saved bill is missing so the rest of the
// app can assume a complete shape.
function migrate(s) {
  if (!s || typeof s !== "object") return null;
  const base = blankState(s.currency || "₹");
  const out = { ...base, ...s, currency: s.currency || "₹" };
  out.billName = typeof s.billName === "string" ? s.billName : "";
  out.billDate = typeof s.billDate === "string" ? s.billDate : "";
  out.charges = { ...base.charges, ...(s.charges || {}) };
  out.members = Array.isArray(s.members) ? s.members : [];
  out.items = (Array.isArray(s.items) ? s.items : []).map((it) => {
    const shares = it.shares && typeof it.shares === "object" ? it.shares : {};
    if (!it.shares) {
      // old model: assignedTo array -> shares map with weight 1
      (it.assignedTo || []).forEach((id) => (shares[id] = 1));
    }
    return { id: it.id || uid(), name: it.name ?? "", price: it.price ?? "", shares };
  });
  return out;
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function uid() {
  return Math.random().toString(36).slice(2, 9);
}
function money(n) {
  return state.currency + (Number(n) || 0).toFixed(2);
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/* ---------- mutations ---------- */
// render() rebuilds the DOM, which drops focus. Set this to keep the caret in a
// field across a re-render so names can be typed one after another.
let focusAfterRender = null;

function addMember(name) {
  name = name.trim();
  if (!name) return;
  const color = PALETTE[state.members.length % PALETTE.length];
  state.members.push({ id: uid(), name, color });
  save();
  focusAfterRender = "member-name";
  render();
}
function removeMember(id) {
  state.members = state.members.filter((m) => m.id !== id);
  state.items.forEach((it) => delete it.shares[id]);
  save();
  render();
}
function addItem(item = { name: "", price: "" }) {
  state.items.push({ id: uid(), name: item.name, price: item.price, shares: {} });
  save();
  render();
}
function removeItem(id) {
  state.items = state.items.filter((it) => it.id !== id);
  save();
  render();
}
// Is this dish explicitly split evenly across everyone?
function isEveryone(it) {
  if (!state.members.length) return false;
  const weights = state.members.map((m) => Number(it.shares[m.id]) || 0);
  return weights.every((w) => w > 0) && new Set(weights).size === 1;
}

// Toggle "everyone shares this equally". Turning it off clears the tags, which
// leaves the dish implicitly shared — same maths, but ready to be re-tagged.
function toggleEveryone(itemId) {
  const it = state.items.find((i) => i.id === itemId);
  if (!it) return;
  if (isEveryone(it)) it.shares = {};
  else {
    it.shares = {};
    state.members.forEach((m) => (it.shares[m.id] = 1));
  }
  save();
  render();
}

function setShare(itemId, memberId, delta, exact) {
  const it = state.items.find((i) => i.id === itemId);
  if (!it) return;
  const cur = Number(it.shares[memberId]) || 0;
  const next = exact != null ? exact : cur + delta;
  if (next <= 0) delete it.shares[memberId];
  else it.shares[memberId] = next;
  save();
  render();
}

function importParsed({ items, charges, detected, meta }) {
  items.forEach((it) =>
    state.items.push({
      id: uid(),
      // Surface the quantity the bill printed — it's the cue for uneven splits.
      name: it.qty > 1 ? `${it.name} ×${it.qty}` : it.name,
      price: it.price,
      shares: {},
    }),
  );
  for (const k of ["tax", "tip", "service", "discount"]) {
    if (charges[k] && !state.charges[k]) state.charges[k] = charges[k];
  }
  // Remember what the bill itself claimed, so we can flag bad scans.
  if (detected?.total) state.billTotal = detected.total;

  // The AI can also read the venue, date and currency straight off the bill —
  // prefill them, but never clobber something the user already set.
  if (meta) {
    if (meta.restaurant && !state.billName) state.billName = meta.restaurant;
    if (meta.date && !state.billDate) state.billDate = meta.date;
    if (
      meta.currencySymbol &&
      CURRENCIES.some((c) => c.sym.trim() === meta.currencySymbol.trim())
    ) {
      state.currency = CURRENCIES.find(
        (c) => c.sym.trim() === meta.currencySymbol.trim(),
      ).sym;
    }
  }
  save();
  render();
}

function clearAll() {
  if (!confirm("Clear all items, members, and charges? This can't be undone.")) return;
  state = blankState(state.currency);
  save();
  goStep(1); // start over means going back to the beginning, not sitting on an empty step
}

/* ---------- OCR / import ---------- */
async function handleFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;
  if (ocr.running) return; // one scan at a time

  let imported = 0;
  let lastText = "";
  let lastError = "";

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const label = files.length > 1 ? ` (${i + 1}/${files.length})` : "";
    ocr = { running: true, progress: 0, status: `Reading image…${label}`, mode: "ai" };
    render();

    // Try the AI proxy first — far more accurate on real photos. If it isn't
    // deployed or is unreachable we fall through to on-device OCR silently.
    let usedAI = false;
    try {
      const ai = await parseBillWithAI(file, {
        onStatus: (msg) => {
          ocr.status = msg + label;
          ocr.progress = 0;
          updateOcrUI();
        },
      });
      importParsed({
        items: ai.items,
        charges: {
          tax: ai.charges.tax ? String(ai.charges.tax) : "",
          tip: ai.charges.tip ? String(ai.charges.tip) : "",
          service: ai.charges.service ? String(ai.charges.service) : "",
          discount: ai.charges.discount ? String(ai.charges.discount) : "",
        },
        detected: { total: ai.printedTotal || 0 },
        meta: {
          restaurant: ai.restaurant,
          date: ai.date,
          currencySymbol: ai.currencySymbol,
        },
      });
      // Only count it once the import actually succeeded, otherwise a throw
      // here would report "Added N items" with nothing added.
      usedAI = true;
      imported += ai.items.length;
      ocr = {
        running: false,
        progress: 100,
        status:
          ai.confidence === "low"
            ? "Read with AI, but parts of the bill were unclear — please check every amount."
            : "",
      };
      render();
    } catch (e) {
      if (!(e instanceof AIUnavailable)) {
        // A real AI failure (bad image, rate limit). Record it, still try OCR.
        lastError = e?.message || String(e);
        console.warn("AI parse failed, falling back to on-device OCR:", e);
      }
    }
    if (usedAI) continue;

    // AI unavailable — fall back to on-device OCR and relabel the animation.
    ocr = { running: true, progress: 0, status: `Reading image…${label}`, mode: "ocr" };
    updateOcrUI();

    try {
      const text = await runOCR(file, {
        evaluate: (t) => parseReceipt(t).items.length,
        onStatus: (msg) => {
          ocr.status = msg + label;
          updateOcrUI();
        },
        onProgress: (p) => {
          ocr.progress = p;
          ocr.status = `Recognising text… ${p}%${label}`;
          updateOcrUI();
        },
      });
      lastText = text;
      const parsed = parseReceipt(text);
      if (parsed.items.length) {
        imported += parsed.items.length;
        ocr = { running: false, progress: 100, status: "" };
        importParsed(parsed);
      }
    } catch (e) {
      lastError = e?.message || String(e);
    }
  }

  if (imported) {
    ocr = {
      running: false,
      progress: 100,
      status: `Added ${imported} item${imported > 1 ? "s" : ""} — check the amounts.`,
      mode: ocr.mode,
    };
    // Parsing done: move the user straight on to tagging.
    goStep(3);
    return;
  }

  // Nothing usable: surface the raw text so it can be fixed by hand.
  ocr = {
    running: false,
    progress: 0,
    status:
      lastError ||
      "Couldn't find line items automatically. The raw text is below — edit it and press Parse text, or add dishes manually.",
  };
  render();
  if (lastText) {
    const box = document.getElementById("paste-box");
    if (box) {
      box.value = lastText;
      box.closest("details").open = true;
    }
  }
}

/* ---------- rendering ---------- */
const app = document.getElementById("app");

function render() {
  const totals = computeTotals(state);
  app.innerHTML = `
    <header class="app">
      <img class="brand-logo" src="/icon.svg" alt="" width="38" height="38" />
      <div>
        <h1>Divvy</h1>
        <div class="sub">Split any food bill, dish by dish</div>
      </div>
      <span class="spacer"></span>
      <select id="currency" title="Currency" aria-label="Currency">
        ${CURRENCIES.map(
          (c) =>
            `<option value="${c.sym}" ${c.sym === state.currency ? "selected" : ""}>${c.code} ${c.sym.trim()}</option>`,
        ).join("")}
      </select>
      <button class="ghost icon" id="btn-clear" title="Start over" aria-label="Start over">🗑️</button>
    </header>

    ${renderStepbar()}
    <div class="sheet">
      <div class="pane" key="step-${step}">${renderStep(totals)}</div>
    </div>
  `;
  renderCta(totals);
  wire();
  updateOcrUI();

  if (focusAfterRender) {
    document.getElementById(focusAfterRender)?.focus();
    focusAfterRender = null;
  }
}

function renderStepbar() {
  return `
    <nav class="stepbar" aria-label="Progress">
      ${STEPS.map((s) => {
        const active = s.n === step;
        const done = s.n < step && stepReachable(s.n);
        return `<button data-step="${s.n}" class="${active ? "active" : ""} ${done ? "done" : ""}"
            ${stepReachable(s.n) ? "" : "disabled"}
            ${active ? 'aria-current="step"' : ""}>
            <span class="n">${done ? "✓" : s.n}</span><span class="lbl">${s.label}</span>
          </button>`;
      }).join("")}
    </nav>`;
}

function renderStep(totals) {
  if (step === 1) return renderPeopleStep();
  if (step === 2) return renderBillStep();
  return renderSplitStep(totals);
}

/* ---------- Step 1: people ---------- */
function renderPeopleStep() {
  const chips = state.members
    .map(
      (m) => `
      <span class="member-chip">
        <span class="dot" style="background:${m.color}"></span>
        ${esc(m.name)}
        <button data-remove-member="${m.id}" title="Remove ${esc(m.name)}" aria-label="Remove ${esc(m.name)}">✕</button>
      </span>`,
    )
    .join("");
  return `
    <div class="pane-head">
      <h2>Who's splitting?</h2>
      <p>Add everyone at the table — first names are enough.</p>
    </div>
    <section class="card">
      <h2>People <span class="count">${state.members.length || ""}</span></h2>
      <div class="members">${chips || '<span class="empty">Nobody yet. Add the first person below.</span>'}</div>
      <form class="add-member" id="member-form">
        <input id="member-name" placeholder="Add a name…" autocomplete="off" enterkeyhint="done" />
        <button class="primary" type="submit">Add</button>
      </form>
    </section>`;
}

/* ---------- Step 2: the bill ---------- */
function renderBillStep() {
  return `
    <div class="pane-head">
      <h2>Add the bill</h2>
      <p>Snap a photo and we'll read the dishes and prices for you.</p>
    </div>
    <section class="card">
      <div id="ocr-area"></div>
      <div class="import-actions" id="import-actions">
        <div class="dropzone">
          <span class="zi">🧾</span>
          <p>Photo, screenshot or e-bill — JPEG, PNG, HEIC, WebP.<br />You can also drag one here or paste with ⌘V.</p>
          <button class="primary big" id="btn-photo">📷 Scan bill photo</button>
        </div>
        <button id="btn-add-item">＋ Enter dishes manually instead</button>
        <input type="file" id="file-input" accept="image/*,.heic,.heif" multiple hidden />
      </div>
      <details style="margin-top:12px">
        <summary class="hint" style="cursor:pointer">Or paste the bill text</summary>
        <textarea id="paste-box" placeholder="Paste receipt text here (one item per line)…" style="margin-top:9px" aria-label="Bill text"></textarea>
        <div class="toolbar"><button id="btn-parse-text">Parse text</button></div>
      </details>
      <p class="hint">
        For best results shoot the bill <b>flat, straight-on and well lit</b>,
        filling the frame. Faded or crumpled receipts can misread, so always
        check the amounts afterwards.
      </p>
    </section>`;
}

/* ---------- Step 3: split ---------- */
function renderSplitStep(totals) {
  return `
    <div class="pane-head">
      <h2>Who had what?</h2>
      <p>Tap a name under each dish. Use −/+ when someone had more than one.</p>
    </div>
    ${renderItems(totals)}
    ${renderCharges(totals)}
    ${renderTotals(totals)}`;
}

// The "Nikhil ₹200 · Priya ₹100" line under a dish. Kept separate so it can be
// refreshed in place while the user is typing in a price field.
function perLineHTML(it, totals) {
  const bd = totals.itemBreakdown[it.id] || {};
  if (!state.members.length) return "";
  const parts = state.members
    .filter((m) => bd[m.id] != null && (Number(it.shares[m.id]) || 0) > 0)
    .map((m) => `${esc(m.name)} ${money(bd[m.id])}`);
  if (!Object.keys(it.shares).length) {
    // Untagged dishes are shared by everyone — make that an action, not a label.
    return `<button class="per per-action" data-everyone="${it.id}">
        Shared equally by everyone · <u>tag it</u>
      </button>`;
  }
  return parts.length ? `<div class="per">${parts.join("  ·  ")}</div>` : "";
}

function renderItems(totals) {
  const rows = state.items
    .map((it) => {
      const everyoneChip =
        state.members.length > 1
          ? `<button class="assign-chip everyone ${isEveryone(it) ? "on" : ""}" data-everyone="${it.id}">👥 Everyone</button>`
          : "";
      const assignChips = state.members
        .map((m) => {
          const w = Number(it.shares[m.id]) || 0;
          if (w > 0) {
            return `
              <span class="assign-chip on" style="color:${m.color}">
                <span class="dot" style="background:${m.color}"></span>${esc(m.name)}
                <span class="stepper">
                  <button data-dec="${it.id}" data-member="${m.id}" title="Fewer">−</button>
                  <b>${w}</b>
                  <button data-inc="${it.id}" data-member="${m.id}" title="More">+</button>
                </span>
              </span>`;
          }
          return `<button class="assign-chip" data-add="${it.id}" data-member="${m.id}">
              <span class="dot" style="background:${m.color}"></span>＋${esc(m.name)}
            </button>`;
        })
        .join("");

      return `
        <div class="item">
          <div class="top">
            <input class="name" data-field="name" data-id="${it.id}" value="${esc(it.name)}" placeholder="Dish name" aria-label="Dish name" />
            <input class="price" data-field="price" data-id="${it.id}" value="${esc(it.price)}" inputmode="decimal" placeholder="0.00" aria-label="Price" />
            <button class="icon danger" data-remove-item="${it.id}" title="Remove dish" aria-label="Remove dish">✕</button>
          </div>
          ${state.members.length ? `<div class="assign">${everyoneChip}${assignChips}</div>` : `<div class="per">Add people above to assign this dish.</div>`}
          <div data-per="${it.id}">${perLineHTML(it, totals)}</div>
        </div>`;
    })
    .join("");
  return `
    <section class="card">
      <h2>Dishes <span class="count">${state.items.length || ""}</span></h2>
      ${rows || '<div class="empty">No dishes yet — scan a bill or add one manually.</div>'}
      <div class="toolbar">
        <button class="ghost" id="btn-rescan">📷 Scan another</button>
        <button id="btn-add-item-2">＋ Add dish</button>
      </div>
    </section>`;
}

function renderCharges(totals) {
  const f = (k, label) =>
    `<div><label for="ch-${k}">${label}</label><input id="ch-${k}" data-charge="${k}" value="${esc(state.charges[k])}" inputmode="decimal" placeholder="0.00" /></div>`;
  const any = ["tax", "tip", "service", "discount"].some((k) => Number(state.charges[k]));
  return `
    <section class="card">
      <h2>Tax, tip &amp; extras</h2>
      <details class="charges-wrap" ${any ? "open" : ""}>
        <summary>
          <span>${any ? "Detected on the bill" : "Add tax, tip or service"}</span>
          <span class="amt">${money(totals.extras)}</span>
        </summary>
        <div class="charges">
          ${f("tax", "Tax")}
          ${f("tip", "Tip")}
          ${f("service", "Service charge")}
          ${f("discount", "Discount (−)")}
        </div>
        <p class="hint">Split in proportion to what each person ate.</p>
      </details>
    </section>`;
}

function renderTotals(t) {
  const rows = t.perMember
    .map(
      (m) => `
      <div class="total-row">
        <span class="dot" style="background:${m.color}"></span>
        <span class="who">${esc(m.name)}<small>${money(m.food)} food · ${money(m.extra)} extras</small></span>
        <span class="amt">${money(m.total)}</span>
      </div>`,
    )
    .join("");

  const warn =
    t.unassignedTotal > 0 && state.members.length
      ? `<div class="warn">⚠︎ ${money(t.unassignedTotal)} of dishes aren't tagged to anyone — they're being shared by everyone. Tap names to assign.</div>`
      : "";

  // Compare our arithmetic with the total printed on the bill. A mismatch means
  // the scan misread something — far better to say so than to be quietly wrong.
  let mismatch = "";
  const printed = Number(state.billTotal) || 0;
  if (printed > 0 && state.items.length) {
    const diff = t.grand - printed;
    if (Math.abs(diff) > Math.max(2, printed * 0.01)) {
      mismatch = `<div class="warn">
        ⚠︎ This adds up to <b>${money(t.grand)}</b> but the bill says
        <b>${money(printed)}</b> (${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}).
        The scan probably misread a row — check the amounts above.
        <button class="link" id="btn-dismiss-mismatch">Dismiss</button>
      </div>`;
    } else {
      mismatch = `<div class="ok-note">✓ Matches the bill total of ${money(printed)}</div>`;
    }
  }

  return `
    <section class="card" id="totals-card">
      <h2>Each person owes</h2>
      ${rows || '<div class="empty">Add people and dishes to see the split.</div>'}
      ${warn}
      ${mismatch}
      <div class="summary">
        <div class="line"><span>Food subtotal</span><span>${money(t.subtotal)}</span></div>
        <div class="line"><span>Tax + tip + service − discount</span><span>${money(t.extras)}</span></div>
        <div class="line grand"><span>Grand total</span><span>${money(t.grand)}</span></div>
      </div>
    </section>`;
}

/* ---------- sticky action bar (contextual per step) ---------- */
function renderCta(totals) {
  document.querySelector(".cta-bar")?.remove();
  let inner = "";

  if (step === 1) {
    const n = state.members.length;
    inner = `<button class="primary big" id="cta-next" ${n ? "" : "disabled"}>
        ${n ? `Next — add the bill` : "Add someone to continue"}
      </button>`;
  } else if (step === 2) {
    inner = `<button class="ghost" id="cta-back">Back</button>
      ${
        state.items.length
          ? `<button class="primary grow2" id="cta-next">Next — split it</button>`
          : `<button class="grow2" id="cta-skip">Skip for now</button>`
      }`;
  } else {
    inner = `<div class="cta-total"><span>Total</span><b>${money(totals.grand)}</b></div>
      <button class="primary grow2" id="cta-share" ${state.members.length && state.items.length ? "" : "disabled"}>
        📤 Share the split
      </button>`;
  }

  const bar = document.createElement("div");
  bar.className = "cta-bar";
  bar.innerHTML = `<div class="cta-inner">${inner}</div>`;
  document.body.appendChild(bar);

  bar.querySelector("#cta-next")?.addEventListener("click", () => goStep(step + 1));
  bar.querySelector("#cta-back")?.addEventListener("click", () => goStep(step - 1));
  bar.querySelector("#cta-share")?.addEventListener("click", openShare);
  bar.querySelector("#cta-skip")?.addEventListener("click", () => {
    if (!state.items.length) addItem();
    goStep(3);
  });
}

/* ---------- shareable receipt ---------- */
// Round each person's share to a whole number while keeping the sum exactly
// equal to the rounded total (largest-remainder method).
function roundShares(amounts, target) {
  const tgt = Math.round(target);
  const floor = amounts.map((a) => Math.floor(a));
  const res = floor.slice();
  let rem = tgt - floor.reduce((s, x) => s + x, 0);
  const order = amounts.map((a, i) => ({ i, frac: a - Math.floor(a) }));
  if (rem > 0) {
    order.sort((a, b) => b.frac - a.frac);
    for (let k = 0; k < rem; k++) res[order[k % order.length].i]++;
  } else if (rem < 0) {
    order.sort((a, b) => a.frac - b.frac);
    for (let k = 0; k < -rem; k++) res[order[k % order.length].i]--;
  }
  return res;
}

function buildReceipt(t) {
  const people = t.perMember.map((m) => ({
    name: m.name,
    color: m.color,
    exact: m.total,
    items: state.items
      .filter((it) => (Number(it.shares[m.id]) || 0) > 0)
      .map((it) => {
        const w = Number(it.shares[m.id]);
        return (it.name || "Item").trim() + (w > 1 ? ` ×${w}` : "");
      }),
  }));
  const rounded = roundShares(people.map((p) => p.exact), t.grand);
  people.forEach((p, i) => (p.amount = rounded[i] || 0));
  const grand = rounded.reduce((s, x) => s + x, 0);
  const subtotal = Math.round(t.subtotal);
  return { people, subtotal, extras: grand - subtotal, grand };
}

function isoToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function formatDate(iso) {
  const parts = (iso || "").split("-").map(Number);
  const d =
    parts.length === 3 && parts[0]
      ? new Date(parts[0], parts[1] - 1, parts[2])
      : new Date();
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function shareText() {
  const R = buildReceipt(computeTotals(state));
  const cur = state.currency.trim();
  const title = state.billName.trim() || "Bill Split";
  const lines = [`*${title}* — ${formatDate(state.billDate)}`, ""];
  R.people.forEach((p) => lines.push(`${p.name}: ${cur}${p.amount}`));
  lines.push("", `Total: ${cur}${R.grand}`, "", "PAID ✅ now pay up — via Divvy");
  return lines.join("\n");
}

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
function dottedDivider(x, y, W, P, color) {
  x.strokeStyle = color;
  x.lineWidth = 1.5;
  x.setLineDash([2, 5]);
  x.beginPath();
  x.moveTo(P, y);
  x.lineTo(W - P, y);
  x.stroke();
  x.setLineDash([]);
  return y;
}
function dotLeader(x, x1, x2, y, color) {
  if (x2 <= x1) return;
  x.strokeStyle = color;
  x.lineWidth = 1.5;
  x.setLineDash([1.5, 5]);
  x.beginPath();
  x.moveTo(x1, y);
  x.lineTo(x2, y);
  x.stroke();
  x.setLineDash([]);
}
function roundRectPath(x, rx, ry, w, h, r) {
  x.beginPath();
  x.moveTo(rx + r, ry);
  x.arcTo(rx + w, ry, rx + w, ry + h, r);
  x.arcTo(rx + w, ry + h, rx, ry + h, r);
  x.arcTo(rx, ry + h, rx, ry, r);
  x.arcTo(rx, ry, rx + w, ry, r);
  x.closePath();
}

// A tilted "PAID · now pay up" rubber stamp, centered on (cx, cy).
function drawStamp(x, cx, cy) {
  const col = "#c8102e";
  x.save();
  x.translate(cx, cy);
  x.rotate((-11 * Math.PI) / 180);
  x.globalAlpha = 0.82;
  x.strokeStyle = col;
  x.fillStyle = col;
  const w = 250, h = 104, r = 14;
  x.lineWidth = 4;
  roundRectPath(x, -w / 2, -h / 2, w, h, r);
  x.stroke();
  x.lineWidth = 1.5;
  roundRectPath(x, -w / 2 + 8, -h / 2 + 8, w - 16, h - 16, r - 5);
  x.stroke();
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  try {
    x.letterSpacing = "8px";
  } catch {}
  x.font = `800 46px ${MONO}`;
  x.fillText("PAID", 4, 4);
  try {
    x.letterSpacing = "2px";
  } catch {}
  x.font = `700 15px ${MONO}`;
  x.fillText("· NOW PAY UP ·", 0, 30);
  try {
    x.letterSpacing = "0px";
  } catch {}
  x.restore();
  x.globalAlpha = 1;
}

function receiptCanvas() {
  const R = buildReceipt(computeTotals(state));
  const cur = state.currency.trim();
  const name = state.billName.trim();
  const P = 50, W = 700, scale = 3;
  const ROW = 44;

  // measure height
  let H = P + 24; // top + label
  if (name) H += 40;
  H += 30; // date
  H += 26; // divider gap
  H += R.people.length * ROW;
  H += 26 + 32 * 3; // divider + 3 summary rows
  H += 40; // divider gap
  H += 130; // stamp band
  H += 26 + P; // footer + bottom

  const c = document.createElement("canvas");
  c.width = W * scale;
  c.height = H * scale;
  const x = c.getContext("2d");
  x.scale(scale, scale);
  x.textBaseline = "alphabetic";
  x.fillStyle = "#fbfaf7";
  x.fillRect(0, 0, W, H);

  const ink = "#1a1c22", mut = "#8b93a1", ln = "#c7ccd6";
  let y = P + 8;

  // header
  x.textAlign = "center";
  if (name) {
    x.fillStyle = mut;
    try { x.letterSpacing = "6px"; } catch {}
    x.font = `700 14px ${MONO}`;
    x.fillText("BILL SPLIT", W / 2, y);
    try { x.letterSpacing = "0px"; } catch {}
    y += 40;
    x.fillStyle = ink;
    x.font = `800 30px ${MONO}`;
    x.fillText(fit(x, name, W - P * 2), W / 2, y);
    y += 30;
  } else {
    x.fillStyle = ink;
    try { x.letterSpacing = "4px"; } catch {}
    x.font = `800 30px ${MONO}`;
    x.fillText("BILL SPLIT", W / 2, y + 8);
    try { x.letterSpacing = "0px"; } catch {}
    y += 42;
  }
  x.fillStyle = mut;
  x.font = `16px ${MONO}`;
  x.fillText(formatDate(state.billDate), W / 2, y);
  y += 26;
  dottedDivider(x, y, W, P, ln);

  // people
  R.people.forEach((p) => {
    y += ROW;
    x.fillStyle = p.color;
    x.beginPath();
    x.arc(P + 7, y - 7, 6, 0, Math.PI * 2);
    x.fill();
    x.textAlign = "left";
    x.fillStyle = ink;
    x.font = `700 23px ${MONO}`;
    x.fillText(p.name, P + 24, y);
    const nameW = x.measureText(p.name).width;
    const amt = cur + p.amount;
    x.textAlign = "right";
    x.fillText(amt, W - P, y);
    const amtW = x.measureText(amt).width;
    dotLeader(x, P + 24 + nameW + 10, W - P - amtW - 10, y - 7, ln);
  });

  // summary
  y += 22;
  dottedDivider(x, y, W, P, ln);
  const sumLine = (label, val, bold) => {
    y += 32;
    x.textAlign = "left";
    x.fillStyle = bold ? ink : mut;
    x.font = `${bold ? 700 : 400} ${bold ? 23 : 17}px ${MONO}`;
    x.fillText(label, P, y);
    x.textAlign = "right";
    x.fillText(cur + val, W - P, y);
  };
  sumLine("Subtotal", R.subtotal, false);
  sumLine("Tax, tip & extras", R.extras, false);
  sumLine("TOTAL", R.grand, true);

  // stamp
  y += 40;
  drawStamp(x, W / 2, y + 40);
  y += 130;

  // footer
  x.textAlign = "center";
  x.fillStyle = mut;
  x.font = `15px ${MONO}`;
  x.fillText("Split with Divvy", W / 2, y);
  return c;
}
// alias kept for fitText name used above
function fit(x, s, maxW) {
  if (x.measureText(s).width <= maxW) return s;
  while (s.length > 1 && x.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

let toastEl;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(() => toastEl.classList.remove("show"), 1900);
}

function openShare() {
  if (!state.members.length || !state.items.length) return;
  if (!state.billDate) state.billDate = isoToday();

  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const card = document.createElement("div");
  card.className = "share-card";
  card.innerHTML = `
    <div class="share-fields">
      <input id="sh-name" placeholder="Restaurant / occasion (optional)" value="${esc(state.billName)}" autocomplete="off" />
      <input id="sh-date" type="date" value="${esc(state.billDate)}" />
    </div>
    <div class="receipt-preview" id="sh-preview"></div>
    <div class="share-btns">
      <button class="primary" id="sh-share">📤 Share</button>
      <button id="sh-copy">Copy text</button>
      <button id="sh-save">Save image</button>
      <button class="ghost" id="sh-close">Close</button>
    </div>`;
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  const preview = card.querySelector("#sh-preview");
  let canvas;
  function redraw() {
    canvas = receiptCanvas();
    canvas.style.width = "100%";
    canvas.style.height = "auto";
    canvas.style.display = "block";
    preview.innerHTML = "";
    preview.appendChild(canvas);
  }
  redraw();

  card.querySelector("#sh-name").oninput = (e) => {
    state.billName = e.target.value;
    save();
    redraw();
  };
  card.querySelector("#sh-date").onchange = (e) => {
    state.billDate = e.target.value;
    save();
    redraw();
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  card.querySelector("#sh-close").onclick = () => overlay.remove();

  const getBlob = () => new Promise((r) => canvas.toBlob(r, "image/png"));

  card.querySelector("#sh-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(shareText());
      toast("Summary copied");
    } catch {
      prompt("Copy the summary:", shareText());
    }
  };
  card.querySelector("#sh-save").onclick = async () => {
    const b = await getBlob();
    const u = URL.createObjectURL(b);
    const a = document.createElement("a");
    a.href = u;
    a.download = "bill-split.png";
    a.click();
    URL.revokeObjectURL(u);
    toast("Image saved");
  };
  card.querySelector("#sh-share").onclick = async () => {
    const text = shareText();
    try {
      const b = await getBlob();
      const file = new File([b], "bill-split.png", { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], text });
      } else if (navigator.share) {
        await navigator.share({ text });
      } else {
        await navigator.clipboard.writeText(text);
        toast("Copied (sharing not supported here)");
      }
    } catch {
      /* user cancelled the share sheet */
    }
  };
}

/* ---------- OCR sub-UI (updated without full re-render) ---------- */
function updateOcrUI() {
  const area = document.getElementById("ocr-area");
  const actions = document.getElementById("import-actions");
  if (!area) return;

  if (ocr.running) {
    if (actions) actions.style.display = "none";
    // Progress is only meaningful for on-device OCR; the AI call is a single
    // opaque request, so show an indeterminate bar for it instead.
    const indet = ocr.mode === "ai" || !ocr.progress;
    area.innerHTML = `
      <div class="scan">
        <div class="scan-doc">
          <i></i><i></i><i></i><i></i><i></i><i></i>
          <div class="scan-beam"></div>
        </div>
        <div class="scan-body">
          <div class="scan-title">
            Reading your bill
            <span class="badge">${ocr.mode === "ai" ? "✨ AI" : "On-device"}</span>
          </div>
          <div class="ocr-status">${esc(ocr.status)}</div>
          <div class="progress ${indet ? "indeterminate" : ""}">
            <span style="width:${indet ? 40 : ocr.progress}%"></span>
          </div>
        </div>
      </div>`;
  } else {
    if (actions) actions.style.display = "";
    area.innerHTML = ocr.status
      ? `<div class="ocr-status" style="margin-bottom:12px">${esc(ocr.status)}</div>`
      : "";
  }
}

/* ---------- events ---------- */
// Handlers for controls inside the totals card. Called on full render and again
// whenever that card is swapped out by refreshDerived().
function wireTotalsCard() {
  const dismiss = app.querySelector("#btn-dismiss-mismatch");
  if (dismiss)
    dismiss.onclick = () => {
      state.billTotal = 0;
      save();
      render();
    };
}

// Every step renders a different subset of the UI, so all lookups must tolerate
// a missing element — one unguarded null here silently kills the whole wiring.
function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el[`on${event}`] = handler;
  return el;
}

function wire() {
  on("btn-clear", "click", clearAll);
  on("currency", "change", (e) => {
    state.currency = e.target.value;
    save();
    render();
  });

  on("member-form", "submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("member-name");
    if (input) addMember(input.value);
  });

  app.querySelectorAll("[data-step]").forEach(
    (b) => (b.onclick = () => goStep(Number(b.dataset.step))),
  );

  const fileInput = document.getElementById("file-input");
  on("btn-photo", "click", () => fileInput?.click());
  if (fileInput) {
    fileInput.onchange = (e) => {
      handleFiles(e.target.files);
      e.target.value = ""; // allow re-picking the same file
    };
  }
  on("btn-rescan", "click", () => goStep(2));

  wireTotalsCard();

  on("btn-add-item", "click", () => {
    addItem();
    goStep(3);
  });
  on("btn-add-item-2", "click", () => addItem());

  on("btn-parse-text", "click", () => {
    const box = document.getElementById("paste-box");
    if (!box) return;
    const parsed = parseReceipt(box.value);
    if (!parsed.items.length) {
      alert("Couldn't find any priced items in that text.");
      return;
    }
    box.value = "";
    importParsed(parsed);
    goStep(3);
  });

  app.querySelectorAll("[data-remove-member]").forEach(
    (b) => (b.onclick = () => removeMember(b.dataset.removeMember)),
  );
  app.querySelectorAll("[data-remove-item]").forEach(
    (b) => (b.onclick = () => removeItem(b.dataset.removeItem)),
  );

  app.querySelectorAll("[data-everyone]").forEach(
    (b) => (b.onclick = () => toggleEveryone(b.dataset.everyone)),
  );

  // share steppers
  app.querySelectorAll("[data-add]").forEach(
    (b) => (b.onclick = () => setShare(b.dataset.add, b.dataset.member, 0, 1)),
  );
  app.querySelectorAll("[data-inc]").forEach(
    (b) => (b.onclick = () => setShare(b.dataset.inc, b.dataset.member, 1)),
  );
  app.querySelectorAll("[data-dec]").forEach(
    (b) => (b.onclick = () => setShare(b.dataset.dec, b.dataset.member, -1)),
  );

  // item text fields — update state live WITHOUT full re-render (keeps focus)
  app.querySelectorAll("input[data-field]").forEach((input) => {
    input.oninput = () => {
      const it = state.items.find((i) => i.id === input.dataset.id);
      if (!it) return;
      it[input.dataset.field] = input.value;
      save();
      refreshDerived();
    };
  });

  app.querySelectorAll("input[data-charge]").forEach((input) => {
    input.oninput = () => {
      state.charges[input.dataset.charge] = input.value;
      save();
      refreshDerived();
    };
  });
}

// Refresh everything derived from the numbers — the per-dish breakdown lines
// AND the totals card — without re-rendering the inputs, so the field you're
// typing in keeps focus and cursor position.
function refreshDerived() {
  const totals = computeTotals(state);

  state.items.forEach((it) => {
    const slot = app.querySelector(`[data-per="${it.id}"]`);
    if (slot) slot.innerHTML = perLineHTML(it, totals);
  });

  const totalsCard = app.querySelector("#totals-card");
  if (totalsCard) {
    const tmp = document.createElement("div");
    tmp.innerHTML = renderTotals(totals);
    totalsCard.replaceWith(tmp.firstElementChild);
    // The replaced markup includes the dismiss control, so re-attach handlers.
    wireTotalsCard();
  }

  // Keep the collapsed charges summary and the sticky bar's total in sync.
  const chargeAmt = app.querySelector("details.charges-wrap summary .amt");
  if (chargeAmt) chargeAmt.textContent = money(totals.extras);
  const ctaTotal = document.querySelector(".cta-total b");
  if (ctaTotal) ctaTotal.textContent = money(totals.grand);
}

/* ---------- drag & drop + clipboard paste (whole window) ---------- */
function imagesFrom(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.files?.length) out.push(...Array.from(dt.files));
  else if (dt.items) {
    for (const item of dt.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out.filter(
    (f) => f.type?.startsWith("image/") || /\.(heic|heif)$/i.test(f.name || ""),
  );
}

window.addEventListener("dragover", (e) => {
  if (e.dataTransfer?.types?.includes("Files")) {
    e.preventDefault();
    document.body.classList.add("dropping");
  }
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dropping");
});
window.addEventListener("drop", (e) => {
  document.body.classList.remove("dropping");
  const files = imagesFrom(e.dataTransfer);
  if (!files.length) return;
  e.preventDefault();
  handleFiles(files);
});
window.addEventListener("paste", (e) => {
  // Don't hijack pasting text into the bill-text box or any input.
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  const files = imagesFrom(e.clipboardData);
  if (!files.length) return;
  e.preventDefault();
  handleFiles(files);
});

step = deriveStep(); // returning users land where they left off
render();
