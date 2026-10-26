(() => {
  "use strict";
  const doc = document.documentElement;
  doc.classList.remove("no-js");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  /* ---------- background: a slowly drifting semantic graph ---------- */
  const canvas = $("#field");
  if (canvas && !reduced) {
    const ctx = canvas.getContext("2d");
    let w = 0, h = 0, dpr = 1, nodes = [], raf = 0, visible = true;
    const count = () => Math.round(Math.min(70, Math.max(26, (w * h) / 26000)));
    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = count();
      nodes = Array.from({ length: n }, (_, i) => nodes[i] || {
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.18, vy: (Math.random() - 0.5) * 0.18,
        r: Math.random() * 1.6 + 0.8, hub: Math.random() < 0.12,
      });
    };
    const tick = () => {
      ctx.clearRect(0, 0, w, h);
      const max = 150;
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < -20) a.x = w + 20; else if (a.x > w + 20) a.x = -20;
        if (a.y < -20) a.y = h + 20; else if (a.y > h + 20) a.y = -20;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d = Math.hypot(dx, dy);
          if (d < max) {
            ctx.strokeStyle = `rgba(94,234,212,${(1 - d / max) * 0.16})`;
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      for (const a of nodes) {
        ctx.fillStyle = a.hub ? "rgba(153,246,228,.75)" : "rgba(94,234,212,.45)";
        ctx.beginPath(); ctx.arc(a.x, a.y, a.hub ? a.r + 1.4 : a.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = visible ? requestAnimationFrame(tick) : 0;
    };
    resize();
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", () => {
      visible = !document.hidden;
      if (visible && !raf) raf = requestAnimationFrame(tick);
    });
    raf = requestAnimationFrame(tick);
  }

  /* ---------- nav: shadow on scroll, mobile menu, active section ---------- */
  const nav = $("#nav"), menu = $("#menu");
  const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });
  menu.addEventListener("click", () => {
    const open = !nav.classList.contains("open");
    nav.classList.toggle("open", open);
    menu.setAttribute("aria-expanded", String(open));
    menu.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  $$("#nav-links a").forEach((a) => a.addEventListener("click", () => {
    nav.classList.remove("open");
    menu.setAttribute("aria-expanded", "false");
  }));
  const links = new Map($$("#nav-links a").map((a) => [a.getAttribute("href").slice(1), a]));
  if ("IntersectionObserver" in window) {
    const spy = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => a.classList.remove("active"));
        const a = links.get(e.target.id);
        if (a) a.classList.add("active");
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    links.forEach((_, id) => { const s = document.getElementById(id); if (s) spy.observe(s); });
  }

  /* ---------- reveal on scroll ---------- */
  const reveals = $$(".reveal");
  if (reduced || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("seen"));
  } else {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target;
        const sibs = Array.from(el.parentElement.children).filter((c) => c.classList.contains("reveal"));
        el.style.transitionDelay = `${Math.min(sibs.indexOf(el), 6) * 70}ms`;
        el.classList.add("seen");
        io.unobserve(el);
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
    reveals.forEach((el) => io.observe(el));
  }

  /* ---------- hero: a scripted, illustrative agent session ---------- */
  const consoleEl = $("#console");
  const script = [
    ["c-user", "Add a button so admins can remove a team member."],
    ["c-call", 'averri.find("remove member")'],
    ["c-out", "Action:Team.removeMember · src/routes/members.ts:88"],
    ["c-call", 'averri.inspect("Action:Team.removeMember")'],
    ["c-out", "policy: owner or admin · requires: not the last owner"],
    ["c-call", 'averri.impact("Action:Team.removeMember")'],
    ["c-out", "2 routes · 1 event · 14 tests to run"],
    ["c-warn", "agent edits src/routes/members.ts …"],
    ["c-call", 'averri.check({ scope: "affected" })'],
    ["c-ok", "✓ 14 passed · 0 rules weakened"],
  ];
  if (consoleEl) {
    const render = (n) => {
      consoleEl.innerHTML = "";
      script.slice(0, n).forEach(([cls, text]) => {
        const li = document.createElement("li");
        li.className = cls; li.textContent = text;
        consoleEl.appendChild(li);
      });
    };
    if (reduced) {
      render(script.length);
    } else {
      let step = 1;
      const loop = () => {
        step += 1;
        if (step > script.length) {
          setTimeout(() => { step = 1; render(1); setTimeout(loop, 1200); }, 3600);
          return;
        }
        const [cls, text] = script[step - 1];
        const li = document.createElement("li");
        li.className = cls;
        consoleEl.appendChild(li);
        if (cls === "c-call") {
          let i = 0;
          const caret = document.createElement("span"); caret.className = "caret";
          const type = () => {
            li.textContent = text.slice(0, ++i); li.appendChild(caret);
            if (i < text.length) setTimeout(type, 22);
            else { caret.remove(); setTimeout(loop, 520); }
          };
          type();
        } else {
          li.textContent = text;
          setTimeout(loop, cls === "c-ok" ? 900 : 760);
        }
      };
      render(1);
      setTimeout(loop, 1100);
    }
  }

  /* ---------- tab helpers (explain switch + developer tabs) ---------- */
  const tabs = (buttons) => {
    buttons.forEach((btn, idx) => {
      const activate = () => {
        buttons.forEach((b) => {
          const on = b === btn;
          b.classList.toggle("on", on);
          b.setAttribute("aria-selected", String(on));
          b.tabIndex = on ? 0 : -1;
          const panel = document.getElementById(b.getAttribute("aria-controls"));
          panel.hidden = !on; panel.classList.toggle("on", on);
        });
      };
      btn.addEventListener("click", activate);
      btn.addEventListener("keydown", (e) => {
        const dir = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        const next = buttons[(idx + dir + buttons.length) % buttons.length];
        next.focus(); next.click();
      });
      btn.tabIndex = btn.getAttribute("aria-selected") === "true" ? 0 : -1;
    });
  };
  tabs($$(".switch [role=tab]"));
  tabs($$(".tab-list [role=tab]"));

  /* ---------- "try a rule" demo ---------- */
  const verdicts = {
    owner: ["ok", "✓", "Allowed", "Team owners can manage membership.", "auth-matrix · owner → 201"],
    admin: ["ok", "✓", "Allowed", "Team admins can manage membership too.", "auth-matrix · admin → 201"],
    member: ["bad", "✕", "Blocked", "Regular members can't invite people. The request is refused.", "auth-matrix · member → 403"],
    other: ["bad", "✕", "Blocked", "Being an admin somewhere else doesn't count. The rule checks this team.", "auth-matrix · other-team admin → 403"],
    anon: ["bad", "✕", "Blocked", "Nobody can invite without signing in first.", "auth-matrix · anonymous → 401"],
  };
  const verdict = $("#verdict");
  const whoBtns = $$(".who button");
  whoBtns.forEach((b) => b.addEventListener("click", () => {
    whoBtns.forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    const [kind, icon, title, text, tag] = verdicts[b.dataset.who];
    verdict.className = `verdict ${kind}`;
    verdict.innerHTML = "";
    const i = document.createElement("div"); i.className = "v-icon"; i.setAttribute("aria-hidden", "true"); i.textContent = icon;
    const t = document.createElement("p"); t.className = "v-title"; t.textContent = title;
    const p = document.createElement("p"); p.className = "v-text"; p.textContent = text;
    const g = document.createElement("span"); g.className = "tag"; g.textContent = `generated test: ${tag}`;
    verdict.append(i, t, p, g);
  }));

  /* ---------- copy buttons ---------- */
  const copyText = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
    const old = btn.textContent;
    btn.textContent = "Copied"; btn.classList.add("done");
    setTimeout(() => { btn.textContent = old; btn.classList.remove("done"); }, 1600);
  };
  $$(".copy").forEach((btn) => btn.addEventListener("click", () => {
    const holder = btn.closest("[data-copy]");
    if (holder) return copyText(holder.dataset.copy, btn);
    const code = btn.parentElement.querySelector("code");
    const text = Array.from(code.childNodes)
      .map((n) => (n.nodeType === 1 && n.classList.contains("c") ? "" : n.textContent))
      .join("")
      .split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").trim();
    copyText(text, btn);
  }));

  /* ---------- count-up numbers ---------- */
  const nums = $$("[data-count]");
  if (!reduced && "IntersectionObserver" in window) {
    const fmt = new Intl.NumberFormat("en-US");
    const co = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        const el = e.target, target = Number(el.dataset.count), t0 = performance.now(), dur = 1400;
        const step = (now) => {
          const p = Math.min(1, (now - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
          el.textContent = fmt.format(Math.round(target * eased));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
        co.unobserve(el);
      });
    }, { threshold: 0.6 });
    nums.forEach((n) => { n.textContent = "0"; co.observe(n); });
  }
})();
