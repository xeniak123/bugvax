import { ICONS } from "./icons.js";
import { CAST } from "./cast.js";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const coarse = window.matchMedia("(hover: none), (pointer: coarse)").matches;
const gsap = window.gsap;
const ScrollTrigger = window.ScrollTrigger;
const hasGsap = Boolean(gsap && ScrollTrigger);
if (hasGsap) gsap.registerPlugin(ScrollTrigger);

/* ---------- Icons (Phosphor UI icons, Simple Icons brand marks) ---------- */

function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("svg[data-icon]")) {
    const src = ICONS.ui[el.dataset.icon] ?? ICONS.brand[el.dataset.icon];
    if (!src) continue;
    const svg = new DOMParser().parseFromString(src, "image/svg+xml").documentElement;
    el.setAttribute("viewBox", svg.getAttribute("viewBox") ?? "0 0 24 24");
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("focusable", "false");
    el.innerHTML = [...svg.children].filter((n) => n.nodeName !== "title").map((n) => n.outerHTML).join("");
    el.removeAttribute("data-icon");
  }
}

/* ---------- Copy to clipboard ---------- */

const toastEl = document.querySelector("[data-toast]");
let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("is-on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("is-on"), 2600);
}

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-copy]");
  if (!btn) return;
  const text = btn.dataset.copy;
  const done = () => {
    btn.classList.add("copied");
    setTimeout(() => btn.classList.remove("copied"), 1600);
  };
  let promise;
  try {
    promise = navigator.clipboard.writeText(text);
  } catch {
    promise = Promise.reject();
  }
  promise.then(done, () => toast(`Copy this: ${text}`));
});

/* ---------- Nav ---------- */

const nav = document.getElementById("nav");
const sentinel = document.createElement("div");
sentinel.style.cssText = "position:absolute;top:80px;left:0;width:1px;height:1px;pointer-events:none";
document.body.prepend(sentinel);
new IntersectionObserver(([entry]) => nav.classList.toggle("is-scrolled", !entry.isIntersecting)).observe(sentinel);

/* ---------- Smooth scrolling ---------- */

let lenis = null;
if (hasGsap && !reduced && window.Lenis) {
  lenis = new window.Lenis({ lerp: 0.11, smoothWheel: true });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
}
for (const a of document.querySelectorAll('a[href^="#"]')) {
  a.addEventListener("click", (e) => {
    const id = a.getAttribute("href");
    const target = id.length > 1 ? document.querySelector(id) : document.body;
    if (!target) return;
    e.preventDefault();
    if (lenis) lenis.scrollTo(target, { offset: id === "#top" ? 0 : -8, duration: 1.2 });
    else target.scrollIntoView({ behavior: reduced ? "auto" : "smooth" });
  });
}

/* ---------- Hero: the SEM field ---------- */

const countEl = document.querySelector("[data-count]");
const magEl = document.querySelector("[data-mag]");
const scaleEl = document.querySelector("[data-scale]");
const barEl = document.querySelector(".scalebar i");
const hintEl = document.querySelector("[data-hint]");
if (coarse && hintEl) hintEl.textContent = "Tap the field to release a bug";

function updateDatabar(mag) {
  magEl.textContent = `${Math.round(mag / 10) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, " ") + "×";
  // Pick the largest round length that still fits, like a real instrument's scale bar.
  const pxPerMicron = 8.4 * (mag / 1200);
  const unit = [10, 5, 2, 1, 0.5].find((u) => u * pxPerMicron <= 150) ?? 0.5;
  barEl.style.setProperty("--bar", `${Math.round(unit * pxPerMicron)}px`);
  scaleEl.textContent = `${unit} µm`;
}

const canvas = document.querySelector(".hero-canvas");
import("./hero.js")
  .then(({ initHero }) => {
    const hero = initHero(canvas, {
      reduced,
      onNeutralize: (n) => {
        countEl.textContent = String(n);
      },
    });
    if (!hero) throw new Error("no webgl");
    updateDatabar(hero.magnification());
    if (hasGsap) {
      ScrollTrigger.create({
        trigger: ".hero",
        start: "top top",
        end: "bottom top",
        scrub: true,
        onUpdate: (self) => {
          hero.setZoom(self.progress);
          updateDatabar(hero.magnification());
        },
      });
    }
  })
  .catch(() => document.documentElement.classList.add("no-webgl"));

/* ---------- How it works: sticky specimen ---------- */

const steps = [...document.querySelectorAll(".step")];
const specimen = document.querySelector(".specimen");
const specName = document.querySelector("[data-spec-name]");
const specPlates = steps.map((step) => {
  const plate = step.querySelector(".plate").cloneNode(true);
  specimen.appendChild(plate);
  return plate;
});
let activeStep = -1;
function setStep(i) {
  if (i === activeStep) return;
  activeStep = i;
  steps.forEach((s, k) => s.classList.toggle("is-active", k === i));
  specPlates.forEach((p, k) => p.classList.toggle("is-active", k === i));
  specName.textContent = steps[i].dataset.spec;
  const checks = specPlates[i].querySelectorAll(".checks li");
  if (hasGsap && !reduced && checks.length) {
    gsap.fromTo(checks, { x: -10, opacity: 0.35 }, { x: 0, opacity: 1, duration: 0.5, stagger: 0.12, ease: "power3.out", delay: 0.15 });
    gsap.fromTo(specPlates[i].querySelectorAll(".tick"), { scale: 0.6 }, { scale: 1, duration: 0.45, stagger: 0.12, ease: "back.out(2)", delay: 0.2 });
  }
}
setStep(0);
if (hasGsap) {
  steps.forEach((step, i) => {
    ScrollTrigger.create({
      trigger: step,
      start: "top 58%",
      end: "bottom 58%",
      onToggle: (self) => self.isActive && setStep(i),
    });
  });
  gsap.to(".rail i", {
    scaleY: 1,
    ease: "none",
    scrollTrigger: { trigger: ".steps", start: "top 58%", end: "bottom 58%", scrub: true },
  });
}

/* ---------- Demo: replay the real recording ---------- */

const FG = { 30: "fg-muted", 31: "fg-magenta", 32: "fg-gold", 33: "fg-amber", 34: "fg-cyan", 35: "fg-magenta", 36: "fg-cyan", 90: "fg-muted", 91: "fg-magenta", 92: "fg-gold", 93: "fg-amber", 94: "fg-cyan", 95: "fg-magenta", 96: "fg-cyan" };
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function ansiToHtml(raw) {
  let out = "";
  let fg = null;
  let bold = false;
  let dim = false;
  let last = 0;
  const flush = (text) => {
    if (!text) return;
    const cls = [fg, bold && "bold", dim && "dim"].filter(Boolean).join(" ");
    out += cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text);
  };
  const re = /\x1b\[([0-9;]*)m/g;
  let m;
  while ((m = re.exec(raw))) {
    flush(raw.slice(last, m.index));
    last = re.lastIndex;
    for (const code of (m[1] || "0").split(";").map(Number)) {
      if (code === 0) (fg = null), (bold = false), (dim = false);
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) (bold = false), (dim = false);
      else if (code === 39) fg = null;
      else if (FG[code]) fg = FG[code];
    }
  }
  flush(raw.slice(last));
  return out.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function initPlayer() {
  const root = document.querySelector(".player");
  const term = root.querySelector("[data-term]");
  const playBtn = root.querySelector("[data-play]");
  const restartBtn = root.querySelector("[data-restart]");
  const scrub = root.querySelector("[data-scrub]");
  const fill = scrub.querySelector(".fill");
  const speedBtn = root.querySelector("[data-speed]");
  const timeEl = root.querySelector("[data-time]");
  const events = CAST.events;
  const duration = events[events.length - 1][0];
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // Chapters: where each command is typed.
  const labels = ["demo", "learn", "fix", "scan"];
  let n = 0;
  for (const [t, text] of events) {
    if (text.includes("❯") && n < labels.length) {
      const dot = document.createElement("span");
      dot.className = "chapter";
      dot.style.left = `${(t / duration) * 100}%`;
      dot.innerHTML = `<span>${labels[n++]}</span>`;
      scrub.appendChild(dot);
    }
  }

  let t = 0;
  let idx = 0;
  let raw = "";
  let playing = false;
  let speed = 1;
  let lastFrame = 0;

  const setPlayIcon = (name, label) => {
    playBtn.innerHTML = `<svg data-icon="${name}"></svg>`;
    playBtn.setAttribute("aria-label", label);
    hydrateIcons(playBtn);
  };

  function paint() {
    term.innerHTML = ansiToHtml(raw) + (t < duration ? '<span class="caret"></span>' : "");
    term.scrollTop = term.scrollHeight;
  }
  function progress() {
    fill.style.transform = `scaleX(${Math.min(1, t / duration)})`;
    scrub.setAttribute("aria-valuenow", String(Math.round((t / duration) * 100)));
    timeEl.textContent = `${fmt(t)} / ${fmt(duration)}`;
  }
  function advance() {
    let changed = false;
    while (idx < events.length && events[idx][0] <= t) {
      raw += events[idx][1];
      idx++;
      changed = true;
    }
    if (changed) paint();
    progress();
  }
  function seek(target) {
    t = Math.max(0, Math.min(duration, target));
    idx = 0;
    raw = "";
    advance();
    paint();
  }
  function loop(now) {
    if (!playing) return;
    const dt = Math.min(0.25, (now - lastFrame) / 1000);
    lastFrame = now;
    t += dt * speed;
    advance();
    if (t >= duration) {
      t = duration;
      pause();
      paint();
      return;
    }
    requestAnimationFrame(loop);
  }
  function play() {
    if (t >= duration) seek(0);
    playing = true;
    lastFrame = performance.now();
    setPlayIcon("pause", "Pause");
    requestAnimationFrame(loop);
  }
  function pause() {
    playing = false;
    setPlayIcon("play", t >= duration ? "Replay" : "Play");
  }

  playBtn.addEventListener("click", () => (playing ? pause() : play()));
  restartBtn.addEventListener("click", () => {
    seek(0);
    play();
  });
  speedBtn.addEventListener("click", () => {
    speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
    speedBtn.textContent = `${speed}×`;
  });
  const seekFromPointer = (e) => {
    const r = scrub.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * duration);
  };
  scrub.addEventListener("pointerdown", (e) => {
    scrub.setPointerCapture(e.pointerId);
    seekFromPointer(e);
  });
  scrub.addEventListener("pointermove", (e) => {
    if (scrub.hasPointerCapture(e.pointerId)) seekFromPointer(e);
  });
  scrub.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") seek(t + 2);
    else if (e.key === "ArrowLeft") seek(t - 2);
    else return;
    e.preventDefault();
  });

  if (reduced) {
    seek(duration);
    pause();
  } else {
    progress();
    paint();
    let started = false;
    new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          started = true;
          play();
        }
      },
      { threshold: 0.25 },
    ).observe(root);
  }
}
initPlayer();

/* ---------- Install: the vial rack ---------- */

const MCP = { command: "npx", args: ["-y", "bugvax", "mcp"] };
const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=bugvax&config=${btoa(JSON.stringify(MCP))}`;
const vscodeLink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "bugvax", ...MCP }))}`;
const desktopConfig = JSON.stringify(
  { mcpServers: { bugvax: { ...MCP, env: { BUGVAX_ROOT: "/path/to/your/repo" } } } },
  null,
  2,
);

const TOOLS = [
  {
    name: "Claude Code",
    icon: "claude",
    note: "Every edit Claude makes is checked. A re-introduced bug goes straight back to the agent, with the proven fix and the commit where it was fixed before.",
    blocks: [
      { label: "Guard every edit", code: "npx bugvax init --claude-code" },
      { label: "Add the MCP server", code: "claude mcp add bugvax -- npx -y bugvax mcp" },
    ],
    foot: "On native Windows, run the MCP command as: claude mcp add bugvax -- cmd /c npx -y bugvax mcp",
  },
  {
    name: "Codex",
    sub: "ChatGPT",
    icon: "openai",
    note: "Codex is the coding agent in ChatGPT. Its CLI, IDE extension and app share one configuration, so this covers all three.",
    blocks: [
      { label: "Guard every patch", code: "npx bugvax init --codex" },
      { label: "Add the MCP server", code: "codex mcp add bugvax -- npx -y bugvax mcp" },
    ],
  },
  {
    name: "Cursor",
    icon: "cursor",
    note: "Before the agent finishes, bugvax checks its changes. If it re-introduced a known bug, it gets one more turn to fix it.",
    blocks: [
      { label: "Guard the agent", code: "npx bugvax init --cursor" },
      { label: "Add the MCP server", code: "npx bugvax init --mcp", link: { label: "Add to Cursor", href: cursorLink } },
    ],
  },
  {
    name: "Gemini CLI",
    icon: "googlegemini",
    note: "After every file write, findings are added to the tool result, so Gemini sees them before its next step.",
    blocks: [
      { label: "Guard every write", code: "npx bugvax init --gemini" },
      { label: "Add the MCP server", code: "gemini mcp add bugvax npx -- -y bugvax mcp" },
    ],
  },
  {
    name: "VS Code",
    sub: "Copilot",
    icon: "visualstudiocode",
    note: "Copilot agent mode reaches bugvax through MCP: it can check code before writing it and ask what broke here before.",
    blocks: [
      {
        label: "Add the MCP server",
        code: `code --add-mcp '${JSON.stringify({ name: "bugvax", ...MCP })}'`,
        link: { label: "Install in VS Code", href: vscodeLink },
      },
    ],
  },
  {
    name: "Claude Desktop",
    icon: "anthropic",
    note: "Point bugvax at the repository you are working on, then ask Claude what went wrong in it before.",
    blocks: [{ label: "claude_desktop_config.json", code: desktopConfig }],
  },
  {
    name: "Windsurf",
    icon: "windsurf",
    note: "Cascade uses bugvax through MCP, like any other MCP client.",
    blocks: [{ label: "~/.codeium/windsurf/mcp_config.json", code: desktopConfig }],
  },
  {
    name: "GitHub Actions",
    icon: "githubactions",
    note: "Pull requests that re-introduce a known bug fail, with annotations on the exact changed lines.",
    blocks: [
      {
        label: ".github/workflows/bugvax.yml",
        code: "name: bugvax\non: pull_request\njobs:\n  bugvax:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v5\n      - uses: xeniak123/bugvax@v1",
      },
    ],
  },
  {
    name: "git hook",
    sub: "pre-commit",
    icon: "git",
    note: "Commits that re-introduce a known bug are blocked locally, before they ever reach a pull request.",
    blocks: [{ label: "Install the hook", code: "npx bugvax init --git-hook" }],
  },
];

function initRack() {
  const rack = document.querySelector("[data-rack]");
  const dose = document.querySelector("[data-dose]");
  dose.classList.add("dose-swap");
  dose.id = "dose";

  rack.innerHTML = TOOLS.map(
    (tool, i) => `
    <button class="vial" type="button" role="tab" id="vial-${i}" aria-controls="dose" aria-selected="false" tabindex="-1">
      <span class="body" aria-hidden="true">
        <span class="cap"></span><span class="neck"></span>
        <span class="glass"><span class="liquid"></span><span class="tag"><svg data-icon="${tool.icon}"></svg></span><span class="shine"></span></span>
      </span>
      <span class="name">${tool.name}${tool.sub ? `<small>${tool.sub}</small>` : ""}</span>
    </button>`,
  ).join("");
  hydrateIcons(rack);
  const vials = [...rack.querySelectorAll(".vial")];

  const copyIcons = '<span class="copy-state" aria-hidden="true"><svg class="is-idle" data-icon="copy"></svg><svg class="is-done" data-icon="check"></svg></span>';
  function doseHtml(tool) {
    const blocks = tool.blocks
      .map(
        (b) => `
      <div class="cmdblock">
        <header>
          <span class="label">${escapeHtml(b.label)}</span>
          <span class="tools">
            ${b.link ? `<a class="mini-btn is-gold" href="${b.link.href}">${escapeHtml(b.link.label)}<svg data-icon="arrow-up-right"></svg></a>` : ""}
            <button class="mini-btn" type="button" data-copy="${escapeHtml(b.code)}" aria-label="Copy">${copyIcons}Copy</button>
          </span>
        </header>
        <pre><code>${escapeHtml(b.code)}</code></pre>
      </div>`,
      )
      .join("");
    return `
      <div>
        <div class="dose-title"><svg data-icon="${tool.icon}"></svg><h3 class="h3" style="margin:0">${tool.name}</h3></div>
        <p class="dose-note">${tool.note}</p>
        ${tool.foot ? `<p class="dose-foot"><code>${escapeHtml(tool.foot)}</code></p>` : ""}
      </div>
      <div class="dose-blocks">${blocks}</div>`;
  }

  let current = -1;
  let swapTimer;
  function select(i, { focus = false, animate = true } = {}) {
    if (i === current) return;
    current = i;
    vials.forEach((v, k) => {
      v.setAttribute("aria-selected", String(k === i));
      v.tabIndex = k === i ? 0 : -1;
    });
    dose.setAttribute("aria-labelledby", `vial-${i}`);
    if (focus) vials[i].focus();
    const render = () => {
      dose.innerHTML = doseHtml(TOOLS[i]);
      hydrateIcons(dose);
      dose.classList.remove("is-leaving");
    };
    clearTimeout(swapTimer);
    if (animate && !reduced) {
      dose.classList.add("is-leaving");
      swapTimer = setTimeout(render, 180);
      if (hasGsap) {
        gsap.fromTo(vials[i].querySelector(".liquid"), { rotate: -9 }, { rotate: 0, duration: 1.1, ease: "elastic.out(1, 0.32)" });
      }
    } else {
      render();
    }
    if (vials[i].scrollIntoView && coarse) vials[i].scrollIntoView({ behavior: reduced ? "auto" : "smooth", inline: "center", block: "nearest" });
  }

  vials.forEach((v, i) => v.addEventListener("click", () => select(i)));
  rack.addEventListener("keydown", (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (e.key === "Home") select(0, { focus: true });
    else if (e.key === "End") select(vials.length - 1, { focus: true });
    else if (keys[e.key]) select((current + keys[e.key] + vials.length) % vials.length, { focus: true });
    else return;
    e.preventDefault();
  });
  select(0, { animate: false });
}
initRack();

/* ---------- Scroll motion ---------- */

hydrateIcons();

if (hasGsap && !reduced) {
  // Hero copy settles in on load.
  gsap.from([".hero .display", ".hero .lede", ".hero .hero-ctas"], {
    y: 28,
    opacity: 0,
    duration: 1.1,
    ease: "expo.out",
    stagger: 0.08,
    delay: 0.15,
  });
  gsap.from(".databar", { yPercent: 100, duration: 0.9, ease: "expo.out", delay: 0.5 });

  // Content stays readable at rest; it only slides the last few pixels into place as it arrives.
  const revealed = gsap.utils.toArray("[data-reveal]");
  gsap.set(revealed, { y: 44 });
  ScrollTrigger.batch(revealed, {
    start: "top 90%",
    once: true,
    onEnter: (batch) => gsap.to(batch, { y: 0, duration: 1.1, ease: "expo.out", stagger: 0.07 }),
  });

  for (const fig of document.querySelectorAll("[data-parallax]")) {
    gsap.fromTo(
      fig.querySelector("img"),
      { yPercent: -6 },
      { yPercent: 4, ease: "none", scrollTrigger: { trigger: fig, start: "top bottom", end: "bottom top", scrub: true } },
    );
  }
  gsap.fromTo(".final-bg", { yPercent: -6 }, { yPercent: 6, ease: "none", scrollTrigger: { trigger: ".final", start: "top bottom", end: "bottom top", scrub: true } });

  gsap.to(".flow-line i", {
    scaleX: 1,
    ease: "none",
    scrollTrigger: { trigger: ".flow", start: "top 80%", end: "bottom 50%", scrub: true },
  });
} else {
  // Without scroll-linked motion the progress lines are simply drawn in full.
  for (const el of document.querySelectorAll(".rail i, .flow-line i")) el.style.transform = "none";
}
