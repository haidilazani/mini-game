/* ============================================================
   Liquid Slots — game logic, reel animation, WebAudio sounds
   ============================================================ */
(() => {
  "use strict";

  // ---------- Config ----------
  const SYMBOLS = ["🍒", "🍋", "🍊", "🍇", "🔔", "⭐", "💎", "7️⃣"];
  // Weighted odds for each reel outcome (higher = more common)
  const WEIGHTS = { "🍒": 5, "🍋": 5, "🍊": 4, "🍇": 4, "🔔": 3, "⭐": 3, "💎": 2, "7️⃣": 1 };
  // Triple-match multipliers
  const PAY3 = { "7️⃣": 100, "💎": 50, "⭐": 25, "🔔": 20, "🍇": 12, "🍊": 12, "🍋": 8, "🍒": 8 };
  const PAY_PAIR = 2;

  const REPEATS = 12;        // copies of the symbol set per strip
  const MID = 3;             // strip repeat we normalize back to
  const BASE_ROT = 4;        // full set rotations for reel 0
  const SPIN_MS = [1900, 2500, 3150];
  const BET_STEPS = [5, 10, 25, 50, 100, 250];
  const START_BALANCE = 1000;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const reelEls = [...document.querySelectorAll(".reel")];
  const balanceEl = $("balance");
  const betEl = $("betDisplay");
  const lastWinEl = $("lastWin");
  const marqueeEl = $("marquee");
  const winBannerEl = $("winBanner");
  const spinBtn = $("spinBtn");
  const machineEl = document.querySelector(".machine");

  // ---------- State ----------
  let balance = Number(localStorage.getItem("ls_balance") ?? START_BALANCE);
  let betIdx = Number(localStorage.getItem("ls_betIdx") ?? 1);
  let spinning = false;
  let soundOn = localStorage.getItem("ls_sound") !== "off";

  // ============================================================
  // Theme
  // ============================================================
  const themeBtn = $("themeToggle");
  const applyTheme = (t) => {
    document.documentElement.dataset.theme = t;
    themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
    localStorage.setItem("ls_theme", t);
  };
  applyTheme(
    localStorage.getItem("ls_theme") ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
  );
  themeBtn.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
    sfx.click();
  });

  // ============================================================
  // WebAudio sound engine (all sounds synthesized — no files)
  // ============================================================
  let audioCtx = null;
  const ctx = () => (audioCtx ??= new (window.AudioContext || window.webkitAudioContext)());

  function tone({ freq = 440, type = "sine", dur = 0.15, vol = 0.2, when = 0, slideTo = null }) {
    if (!soundOn) return;
    const ac = ctx();
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  const sfx = {
    click:  () => tone({ freq: 600, type: "triangle", dur: 0.07, vol: 0.12 }),
    tick:   () => tone({ freq: 1100 + Math.random() * 300, type: "square", dur: 0.03, vol: 0.035 }),
    thud:   () => { tone({ freq: 150, type: "sine", dur: 0.18, vol: 0.35, slideTo: 58 });
                    tone({ freq: 800, type: "triangle", dur: 0.05, vol: 0.1 }); },
    lose:   () => { tone({ freq: 220, type: "triangle", dur: 0.18, vol: 0.1 });
                    tone({ freq: 165, type: "triangle", dur: 0.25, vol: 0.1, when: 0.14 }); },
    win() { // ascending arpeggio
      [523, 659, 784, 1047].forEach((f, i) =>
        tone({ freq: f, type: "triangle", dur: 0.22, vol: 0.18, when: i * 0.1 }));
    },
    jackpot() { // fanfare + coin shower
      const notes = [523, 659, 784, 1047, 784, 1047, 1319, 1568];
      notes.forEach((f, i) => {
        tone({ freq: f, type: "sawtooth", dur: 0.28, vol: 0.12, when: i * 0.13 });
        tone({ freq: f * 2, type: "sine", dur: 0.28, vol: 0.07, when: i * 0.13 });
      });
      // closing chord
      [523, 659, 784, 1047].forEach((f) =>
        tone({ freq: f, type: "triangle", dur: 1.2, vol: 0.1, when: notes.length * 0.13 }));
      // coins: rapid random high pings
      for (let i = 0; i < 22; i++) {
        tone({
          freq: 1800 + Math.random() * 1600, type: "sine",
          dur: 0.09, vol: 0.05, when: 0.3 + i * 0.075 + Math.random() * 0.03,
        });
      }
    },
  };

  const soundBtn = $("soundToggle");
  const renderSound = () => (soundBtn.textContent = soundOn ? "🔊" : "🔇");
  renderSound();
  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("ls_sound", soundOn ? "on" : "off");
    renderSound();
    sfx.click();
  });

  // ============================================================
  // Reels
  // ============================================================
  // Each reel gets its own shuffled symbol order, repeated REPEATS times.
  function shuffled(arr, seed) {
    const a = [...arr];
    let s = seed;
    for (let i = a.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      const j = Math.floor((s / 233280) * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  class Reel {
    constructor(el, index) {
      this.el = el;
      this.strip = el.querySelector(".strip");
      this.set = shuffled(SYMBOLS, 7 + index * 13);
      this.setLen = this.set.length;
      this.cells = [];
      for (let r = 0; r < REPEATS; r++) {
        for (const sym of this.set) {
          const cell = document.createElement("div");
          cell.className = "cell";
          cell.textContent = sym;
          this.strip.appendChild(cell);
          this.cells.push(cell);
        }
      }
      this.pos = MID * this.setLen + index; // integer index of symbol on the payline
      this.render();
    }

    cellH() { return this.cells[0].offsetHeight; }

    render() {
      const ty = -(this.pos - 1) * this.cellH();
      this.strip.style.transform = `translateY(${ty}px)`;
      return ty;
    }

    symbolAt(pos) { return this.set[Math.round(pos) % this.setLen]; }

    centerCell() { return this.cells[Math.round(this.pos)]; }

    // Spin so that `target` symbol lands on the payline. Resolves when settled.
    spin(target, duration, rotations) {
      return new Promise((resolve) => {
        const start = this.pos;
        const curMod = start % this.setLen;
        const targetIdx = this.set.indexOf(target);
        const delta = ((targetIdx - curMod) % this.setLen + this.setLen) % this.setLen;
        const distance = rotations * this.setLen + (delta === 0 ? this.setLen : delta);
        const t0 = performance.now();
        let lastTick = -1;

        this.el.classList.add("blurred");

        const frame = (now) => {
          const p = Math.min((now - t0) / duration, 1);
          const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
          this.pos = start + distance * eased;
          this.render();

          // tick sound on each symbol passing the payline (throttled near the end)
          const whole = Math.floor(this.pos);
          if (whole !== lastTick) {
            lastTick = whole;
            if (p < 0.9 || whole % 2 === 0) sfx.tick();
          }
          // un-blur as the reel decelerates
          if (p > 0.72) this.el.classList.remove("blurred");

          if (p < 1) {
            requestAnimationFrame(frame);
          } else {
            // normalize back to the middle of the strip
            this.pos = MID * this.setLen + targetIdx;
            const ty = this.render();
            // settle bounce
            this.strip.style.setProperty("--ty", `${ty}px`);
            this.el.classList.add("bounce");
            sfx.thud();
            setTimeout(() => this.el.classList.remove("bounce"), 400);
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
    }
  }

  const reels = reelEls.map((el, i) => new Reel(el, i));
  addEventListener("resize", () => reels.forEach((r) => r.render()));

  // ---------- Weighted outcome ----------
  const weightPool = Object.entries(WEIGHTS).flatMap(([s, w]) => Array(w).fill(s));
  const randSymbol = () => weightPool[Math.floor(Math.random() * weightPool.length)];

  // ============================================================
  // HUD
  // ============================================================
  const fmt = (n) => n.toLocaleString("en-US");

  function renderHUD() {
    balanceEl.textContent = fmt(balance);
    betEl.textContent = fmt(BET_STEPS[betIdx]);
    localStorage.setItem("ls_balance", balance);
    localStorage.setItem("ls_betIdx", betIdx);
    spinBtn.disabled = spinning || balance < BET_STEPS[betIdx];
  }

  function countUp(el, from, to, ms = 700) {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min((now - t0) / ms, 1);
      el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 2))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function setMarquee(text, excited = false) {
    marqueeEl.textContent = text;
    marqueeEl.classList.toggle("excited", excited);
  }

  function showBanner(text, lose = false) {
    winBannerEl.textContent = text;
    winBannerEl.classList.toggle("lose", lose);
    winBannerEl.classList.add("show");
  }
  function hideBanner() { winBannerEl.classList.remove("show"); }

  // ============================================================
  // Bet controls
  // ============================================================
  $("betUp").addEventListener("click", () => {
    if (spinning) return;
    betIdx = Math.min(betIdx + 1, BET_STEPS.length - 1);
    sfx.click(); renderHUD();
  });
  $("betDown").addEventListener("click", () => {
    if (spinning) return;
    betIdx = Math.max(betIdx - 1, 0);
    sfx.click(); renderHUD();
  });
  $("betMax").addEventListener("click", () => {
    if (spinning) return;
    // highest bet step the balance can afford
    betIdx = Math.max(0, BET_STEPS.findLastIndex((b) => b <= balance));
    sfx.click(); renderHUD();
  });
  $("resetBtn").addEventListener("click", () => {
    if (spinning) return;
    balance = START_BALANCE;
    lastWinEl.textContent = "0";
    sfx.click();
    setMarquee("Credits reset — good luck! 🍀");
    renderHUD();
  });

  // ============================================================
  // Win evaluation
  // ============================================================
  function evaluate(line) {
    const [a, b, c] = line;
    if (a === b && b === c) {
      return { mult: PAY3[a], triple: a, jackpot: a === "7️⃣", hits: [0, 1, 2] };
    }
    if (a === b) return { mult: PAY_PAIR, hits: [0, 1] };
    if (b === c) return { mult: PAY_PAIR, hits: [1, 2] };
    if (a === c) return { mult: PAY_PAIR, hits: [0, 2] };
    return { mult: 0, hits: [] };
  }

  // ============================================================
  // Confetti
  // ============================================================
  const canvas = $("confetti");
  const cctx = canvas.getContext("2d");
  let particles = [];
  let confettiRunning = false;

  function resizeCanvas() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    cctx.scale(devicePixelRatio, devicePixelRatio);
  }
  resizeCanvas();
  addEventListener("resize", resizeCanvas);

  const CONFETTI_COLORS = ["#ffd166", "#ff5ca8", "#8f7bff", "#3ddc97", "#5bc8ff", "#ff9f43"];

  function burstConfetti(count) {
    for (let i = 0; i < count; i++) {
      particles.push({
        x: innerWidth / 2 + (Math.random() - 0.5) * innerWidth * 0.5,
        y: innerHeight * 0.35,
        vx: (Math.random() - 0.5) * 14,
        vy: -Math.random() * 13 - 4,
        w: 6 + Math.random() * 7,
        h: 4 + Math.random() * 5,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        life: 1,
      });
    }
    if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(confettiFrame); }
  }

  function confettiFrame() {
    cctx.clearRect(0, 0, innerWidth, innerHeight);
    particles = particles.filter((p) => p.life > 0 && p.y < innerHeight + 30);
    for (const p of particles) {
      p.vy += 0.35;            // gravity
      p.vx *= 0.99;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      p.life -= 0.004;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot);
      cctx.globalAlpha = Math.max(p.life, 0);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cctx.restore();
    }
    if (particles.length) requestAnimationFrame(confettiFrame);
    else { confettiRunning = false; cctx.clearRect(0, 0, innerWidth, innerHeight); }
  }

  // ============================================================
  // Jackpot overlay
  // ============================================================
  const overlay = $("jackpotOverlay");
  function showJackpot(amount) {
    $("jackpotAmount").textContent = `+${fmt(amount)}`;
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    machineEl.classList.add("shake");
    setTimeout(() => machineEl.classList.remove("shake"), 600);
    const hide = () => {
      overlay.classList.remove("show");
      overlay.setAttribute("aria-hidden", "true");
      overlay.removeEventListener("click", hide);
    };
    overlay.addEventListener("click", hide);
    setTimeout(hide, 5000);
  }

  // ============================================================
  // Spin!
  // ============================================================
  async function spin() {
    const bet = BET_STEPS[betIdx];
    if (spinning || balance < bet) return;

    spinning = true;
    ctx().resume?.();        // unlock audio on user gesture
    sfx.click();

    balance -= bet;
    renderHUD();
    spinBtn.disabled = true;
    spinBtn.classList.add("spinning");
    hideBanner();
    reels.forEach((r) => r.centerCell().classList.remove("hit"));
    setMarquee("Rolling… 🎲");

    // decide the outcome up front, then animate to it
    const line = reels.map(() => randSymbol());

    await Promise.all(
      reels.map((r, i) => r.spin(line[i], SPIN_MS[i], BASE_ROT + i))
    );

    // ----- settle result -----
    const result = evaluate(line);
    const winAmount = result.mult * bet;

    if (winAmount > 0) {
      const prevBalance = balance;
      balance += winAmount;
      result.hits.forEach((i) => reels[i].centerCell().classList.add("hit"));
      countUp(balanceEl, prevBalance, balance);
      countUp(lastWinEl, 0, winAmount);

      if (result.jackpot) {
        setMarquee("💰 TRIPLE SEVENS — JACKPOT!!! 💰", true);
        showBanner(`JACKPOT +${fmt(winAmount)}!`);
        sfx.jackpot();
        burstConfetti(220);
        setTimeout(() => burstConfetti(160), 600);
        showJackpot(winAmount);
      } else if (result.triple) {
        setMarquee(`Triple ${result.triple}! Big win! 🎉`, true);
        showBanner(`BIG WIN +${fmt(winAmount)}!`);
        sfx.win();
        burstConfetti(90);
      } else {
        setMarquee("Nice pair! 😎");
        showBanner(`WIN +${fmt(winAmount)}`);
        sfx.win();
      }
    } else {
      lastWinEl.textContent = "0";
      sfx.lose();
      setMarquee(balance < BET_STEPS[0] ? "Out of credits — hit ↺ Reset!" : "So close! Spin again 🍀");
      showBanner("No luck this time…", true);
    }

    spinning = false;
    spinBtn.classList.remove("spinning");
    renderHUD();
  }

  spinBtn.addEventListener("click", spin);
  addEventListener("keydown", (e) => {
    if ((e.code === "Space" || e.code === "Enter") && !e.repeat) {
      const tag = document.activeElement?.tagName;
      if (tag !== "BUTTON" || document.activeElement === spinBtn) {
        e.preventDefault();
        spin();
      }
    }
  });

  // ---------- Init ----------
  renderHUD();
})();
