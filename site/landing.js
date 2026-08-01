/* Divvy landing — the four-step demo that plays inside the phone.
   Vanilla, no dependencies, same as the app itself. */

const PEOPLE = [
  { name: "Nikhil", color: "#4f46e5" },
  { name: "Priya", color: "#0ea5e9" },
  { name: "Arjun", color: "#10b981" },
];

const DISHES = [
  { name: "Paneer Tikka", price: 320, who: [0, 1, 2] },
  { name: "Butter Naan ×4", price: 180, who: [0, 1, 2] },
  { name: "Ultra Beer ×2", price: 580, who: [0, 0] }, // Nikhil had both
  { name: "Mango Lassi", price: 130, who: [2] },
];

const money = (n) => "₹" + Math.round(n);

/* Per-person totals, mirroring how the app actually splits:
   each dish divided by its share count, extras in proportion. */
function totals() {
  const food = PEOPLE.map(() => 0);
  DISHES.forEach((d) => {
    d.who.forEach((i) => (food[i] += d.price / d.who.length));
  });
  const sub = food.reduce((a, b) => a + b, 0);
  const tax = Math.round(sub * 0.05);
  return PEOPLE.map((p, i) => ({
    ...p,
    amount: Math.round(food[i] + (tax * food[i]) / sub),
  }));
}

const STEP_MS = [3400, 4200, 4600, 4200];
const CAPTIONS = [
  "Adding everyone at the table…",
  "Reading the bill — dishes, prices, tax.",
  "Tagging who had what. Nikhil had both beers.",
  "Sent. Everyone knows what they owe.",
];

const screen = document.getElementById("demo-screen");
const caption = document.getElementById("demo-caption");
const stepEls = [...document.querySelectorAll("#steps li")];
const stepBtns = [...document.querySelectorAll("#steps button")];

let current = -1;
let timer = null;

/* ---------- the four screens ---------- */

function screenAdd() {
  const chips = PEOPLE.map(
    (p, i) =>
      `<span class="chip" style="animation-delay:${0.35 + i * 0.55}s">
         <span class="d" style="background:${p.color}"></span>${p.name}
       </span>`,
  ).join("");
  return `
    <div class="scr">
      <h4>Who's splitting?</h4>
      <p class="sub">First names are enough.</p>
      <div class="chips">${chips}</div>
      <div class="mini" style="margin-top:auto">
        <div class="row muted"><span>People</span><b>3</b></div>
      </div>
    </div>`;
}

function screenUpload() {
  return `
    <div class="scr">
      <h4>Add the bill</h4>
      <p class="sub">Photo, screenshot or e-bill.</p>
      <span class="ai-pill">✨ Reading with AI</span>
      <div class="scanbox">
        <i></i><i></i><i></i><i></i><i></i>
        <div class="beam"></div>
      </div>
      <div class="mini">
        <div class="row"><span>Paneer Tikka</span><b>320</b></div>
        <div class="row"><span>Butter Naan ×4</span><b>180</b></div>
        <div class="row"><span>Ultra Beer ×2</span><b>580</b></div>
        <div class="row"><span>Mango Lassi</span><b>130</b></div>
        <div class="dash"></div>
        <div class="row muted"><span>Tax 5%</span><b>61</b></div>
      </div>
    </div>`;
}

function screenTag() {
  const dishes = DISHES.slice(0, 3)
    .map((d, di) => {
      const tags = PEOPLE.map((p, pi) => {
        const n = d.who.filter((w) => w === pi).length;
        const on = n > 0;
        return `<span class="chip tag ${on ? "on" : ""}" style="${on ? `color:${p.color}` : ""}">
            <span class="d" style="background:${p.color};opacity:${on ? 1 : 0.35}"></span>${p.name}${n > 1 ? " ×" + n : ""}
          </span>`;
      }).join("");
      const each = d.price / d.who.length;
      const names = [...new Set(d.who)]
        .map((i) => `${PEOPLE[i].name} ${money(each * d.who.filter((w) => w === i).length)}`)
        .join(" · ");
      return `
        <div class="dish" style="animation-delay:${0.2 + di * 0.5}s">
          <div class="dh"><span>${d.name}</span><span>${d.price}</span></div>
          <div class="chips">${tags}</div>
          <div class="per">${names}</div>
        </div>`;
    })
    .join("");
  return `
    <div class="scr">
      <h4>Who had what?</h4>
      <p class="sub">Tap a name. Use −/+ for seconds.</p>
      ${dishes}
    </div>`;
}

function screenSend() {
  const t = totals();
  const grand = t.reduce((a, b) => a + b.amount, 0);
  const rows = t
    .map(
      (p, i) =>
        `<div class="who" style="animation:pop .3s var(--ease) ${0.15 + i * 0.18}s both">
           <span>${p.name}</span><b>${money(p.amount)}</b>
         </div>`,
    )
    .join("");
  return `
    <div class="scr">
      <h4>Send the split</h4>
      <p class="sub">Straight into the group chat.</p>
      <div class="sharecard">
        <div class="ttl">BILL SPLIT</div>
        ${rows}
        <div class="dash" style="border-top:1.5px dashed var(--line-2)"></div>
        <div class="who"><span>TOTAL</span><b>${money(grand)}</b></div>
        <div class="stamp" style="animation-delay:.85s">PAID</div>
      </div>
      <div class="sent" style="animation:pop .3s var(--ease) 1.2s both">✓ Shared to WhatsApp</div>
    </div>`;
}

const SCREENS = [screenAdd, screenUpload, screenTag, screenSend];

/* ---------- playback ---------- */

function show(i, { auto = true } = {}) {
  current = i;
  screen.innerHTML = SCREENS[i]();
  caption.textContent = CAPTIONS[i];

  stepEls.forEach((li, n) => {
    li.classList.toggle("on", n === i);
    li.classList.toggle("done", n < i);
    const bar = li.querySelector(".sbar i");
    bar.style.animation = "none";
    void bar.offsetWidth; // restart the fill animation
    if (n === i) bar.style.animation = `fill ${STEP_MS[i]}ms linear forwards`;
    else bar.style.width = n < i ? "100%" : "0";
  });

  clearTimeout(timer);
  if (auto) timer = setTimeout(() => show((i + 1) % SCREENS.length), STEP_MS[i]);
}

stepBtns.forEach((b) =>
  b.addEventListener("click", () => show(Number(b.dataset.step))),
);

// Only animate while the demo is actually on screen.
const io = new IntersectionObserver(
  (entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        if (current === -1) show(0);
      } else {
        clearTimeout(timer);
      }
    });
  },
  { threshold: 0.25 },
);
io.observe(document.getElementById("demo"));

// Pause when the tab is hidden so it isn't spinning in the background.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(timer);
  else if (current >= 0) show(current);
});

/* ---------- fair-share visual ---------- */
(function fairShare() {
  const el = document.getElementById("fair-vis");
  if (!el) return;
  const t = totals();
  const max = Math.max(...t.map((p) => p.amount));
  const even = Math.round(t.reduce((a, b) => a + b.amount, 0) / t.length);

  el.innerHTML =
    t
      .map(
        (p) => `
      <div class="fv-row">
        <div class="fv-top"><span>${p.name}</span><b>${money(p.amount)}</b></div>
        <div class="fv-bar"><span data-w="${(p.amount / max) * 100}" style="width:0;background:${p.color}"></span></div>
      </div>`,
      )
      .join("") +
    `<div class="fv-note">An even split would charge everyone ${money(even)} —
       and Arjun, who had one lassi, would be paying for two beers he never drank.</div>`;

  // Grow the bars once they scroll into view.
  const obs = new IntersectionObserver(
    (entries, o) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        el.querySelectorAll(".fv-bar span").forEach((s, i) => {
          setTimeout(() => (s.style.width = s.dataset.w + "%"), i * 130);
        });
        o.disconnect();
      });
    },
    { threshold: 0.4 },
  );
  obs.observe(el);
})();
