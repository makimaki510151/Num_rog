(() => {
  "use strict";

  const WORLD = 640;
  const UPGRADE_EVERY = 10;
  const UPGRADE_PICKS = 5;
  const STORAGE_BEST = "num_rog_best";
  const STORAGE_SET = "num_rog_settings";
  const SURVIVAL_DIFF = 5;

  const CONTROL_MODES = [
    { id: "wasd", label: "WASD", hint: "キーボード" },
    { id: "arrows", label: "矢印キー", hint: "キーボード" },
    { id: "padL", label: "左スティック", hint: "ゲームパッド" },
    { id: "padR", label: "右スティック", hint: "ゲームパッド" },
    { id: "padD", label: "十字ボタン", hint: "ゲームパッド" },
    { id: "mouse", label: "マウス", hint: "カーソルの方向へ進む" },
    { id: "vpad", label: "タッチパッド", hint: "画面上のスティック" },
    { id: "swipe", label: "なぞる", hint: "触れた方向へ進む" }
  ];

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const hypot = Math.hypot;
  const TAU = Math.PI * 2;

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function formatNum(n) {
    n = Math.max(0, Math.ceil(n));
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1) + "k";
    if (n < 1e6) return Math.floor(n / 1000) + "k";
    if (n < 1e7) return (n / 1e6).toFixed(1) + "M";
    return Math.floor(n / 1e6) + "M";
  }

  function calcScore(seconds) {
    const t = Math.max(0, seconds);
    return Math.floor(t * t * SURVIVAL_DIFF);
  }

  function loadBest() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_BEST) || "null");
    } catch {
      return null;
    }
  }

  function saveBest(rec) {
    localStorage.setItem(STORAGE_BEST, JSON.stringify(rec));
  }

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_SET) || "{}");
    } catch {
      return {};
    }
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_SET, JSON.stringify({
      mode: input.mode
    }));
  }

  const audio = {
    ctx: null,
    enabled: true,
    ensure() {
      if (this.ctx) {
        if (this.ctx.state === "suspended") this.ctx.resume();
        return this.ctx;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      return this.ctx;
    },
    beep(freq, dur, type, gain) {
      const ctx = this.ensure();
      if (!ctx || !this.enabled) return;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || "square";
      o.frequency.value = freq;
      g.gain.value = gain || 0.04;
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + dur);
    },
    hit() { this.beep(180, 0.12, "sawtooth", 0.05); },
    kill() {
      this.beep(70, 0.14, "sawtooth", 0.08);
      this.beep(240, 0.08, "square", 0.05);
      this.beep(920, 0.05, "triangle", 0.035);
    },
    hurt() { this.beep(90, 0.22, "square", 0.07); },
    dead() { this.beep(60, 0.5, "sawtooth", 0.08); },
    pick() { this.beep(520, 0.1, "square", 0.04); this.beep(780, 0.12, "square", 0.03); },
    over() { this.beep(220, 0.18, "triangle", 0.05); }
  };

  const canvas = $("game-canvas");
  const ctx = canvas.getContext("2d");
  const input = {
    mode: "wasd",
    keys: new Set(),
    mouse: { x: 0, y: 0, on: false },
    vpad: { active: false, ax: 0, ay: 0, id: null },
    swipe: { active: false, sx: 0, sy: 0, id: null }
  };

  let state = "title";
  let dpr = 1;
  let viewW = 800;
  let viewH = 600;
  let elapsed = 0;
  let upgradeIn = UPGRADE_EVERY;
  let kills = 0;
  let shake = 0;
  let flash = 0;
  let killFlash = 0;
  let hitStop = 0;
  let originX = 0;
  let originY = 0;
  let viewScale = 1;
  let player;
  let enemies = [];
  let bullets = [];
  let zones = [];
  let particles = [];
  let floats = [];
  let bolts = [];
  let spawnAcc = 0;
  let history = [];
  let upgradeSlots = [];
  let owned = {};

  const UPGRADES = [
    { id: "vital", kind: "能力", name: "体力", desc: (lv) => `最大残数が${lv + 3}から${lv + 4}になり、1回復します。` },
    { id: "haste", kind: "能力", name: "速さ", desc: () => "移動が速くなります。" },
    { id: "regen", kind: "能力", name: "回復", desc: () => "時間とともに残数が戻ります。間隔も短くなります。" },
    { id: "iframe", kind: "能力", name: "無敵時間", desc: () => "当たったあとの無敵が長くなります。" },
    { id: "shrink", kind: "能力", name: "小型化", desc: () => "当たり判定が小さくなります。" },
    { id: "power", kind: "能力", name: "火力", desc: () => "すべての攻撃のダメージが1増えます。" },
    { id: "rate", kind: "能力", name: "連射", desc: () => "攻撃の間隔が短くなります。" },
    { id: "range", kind: "能力", name: "射程", desc: () => "攻撃の届く範囲が広がります。" },
    { id: "pulse", kind: "攻撃", name: "衝撃波", desc: (lv) => lv ? `衝撃波の火力が${lv}から${lv + 1}になります。` : "まわりに衝撃波を出します。火力は1です。" },
    { id: "orbit", kind: "攻撃", name: "回転刃", desc: (lv) => lv ? `刃の火力が${lv}から${lv + 1}になります。` : "まわりを回る刃を得ます。火力は1です。" },
    { id: "shot", kind: "攻撃", name: "通常弾", desc: (lv) => `通常弾の火力が${1 + lv}から${2 + lv}になります。` },
    { id: "trail", kind: "攻撃", name: "軌跡", desc: (lv) => lv ? `軌跡の火力が${lv}から${lv + 1}になります。` : "通った跡が敵を削ります。火力は1です。" },
    { id: "chain", kind: "攻撃", name: "雷", desc: (lv) => lv ? `雷の火力が${lv}から${lv + 1}になります。` : "近くの敵へ雷が飛びます。火力は1です。" },
    { id: "thorns", kind: "攻撃", name: "棘", desc: (lv) => lv ? `接触の火力が${lv}から${lv + 1}になります。` : "触れた敵を削ります。火力は1です。" },
    { id: "cross", kind: "攻撃", name: "十字弾", desc: (lv) => lv ? `十字弾の火力が${lv}から${lv + 1}になります。` : "上下左右へ弾を出します。火力は1です。" },
    { id: "forward", kind: "攻撃", name: "前方弾", desc: (lv) => lv ? `前方弾の火力が${lv}から${lv + 1}になります。` : "進んでいる方向へ弾を出します。火力は1です。" },
    { id: "slow", kind: "攻撃", name: "減速", desc: (lv) => lv ? `減速の火力が${lv}から${lv + 1}になります。` : "まわりの敵を遅くし、削ります。火力は1です。" },
    { id: "nova", kind: "攻撃", name: "爆発", desc: (lv) => lv ? `爆発の火力が${lv}から${lv + 1}になります。` : "周期的に大きく爆発します。火力は1です。" },
    { id: "beam", kind: "攻撃", name: "レーザー", desc: (lv) => lv ? `レーザーの火力が${lv}から${lv + 1}になります。` : "回転するレーザーを得ます。火力は1です。" },
    { id: "echo", kind: "攻撃", name: "残像", desc: (lv) => lv ? `残像の火力が${lv}から${lv + 1}になります。` : "遅れて追う残像が敵を削ります。火力は1です。" }
  ];

  const UMAP = Object.fromEntries(UPGRADES.map((u) => [u.id, u]));

  function applyUpgrade(id) {
    owned[id] = (owned[id] || 0) + 1;
    const p = player;
    switch (id) {
      case "vital": p.maxHp += 1; p.hp = Math.min(p.maxHp, p.hp + 1); break;
      case "haste": p.speedMul *= 1.09; break;
      case "regen": p.regenLv += 1; if (p.regenLv === 1) p.regenT = 10.5; break;
      case "iframe": p.iframeMul *= 1.22; break;
      case "shrink": p.sizeMul = Math.max(0.22, p.sizeMul * 0.9); break;
      case "power": p.dmgBonus += 1; break;
      case "rate": p.rateMul *= 1.1; break;
      case "range": p.rangeMul *= 1.12; break;
      case "shot": p.shotLv += 1; break;
      case "pulse": p.pulseLv += 1; break;
      case "orbit": p.orbitLv += 1; break;
      case "trail": p.trailLv += 1; break;
      case "chain": p.chainLv += 1; break;
      case "thorns": p.thornsLv += 1; break;
      case "cross": p.crossLv += 1; break;
      case "forward": p.forwardLv += 1; break;
      case "slow": p.slowLv += 1; break;
      case "nova": p.novaLv += 1; break;
      case "beam": p.beamLv += 1; break;
      case "echo": p.echoLv += 1; break;
    }
  }

  const ENEMY_DEFS = [
    { id: "chaser", shape: "square", unlock: 0, hp: 1, spd: 82, r: 16, w: 1.1 },
    { id: "swarm", shape: "circle", unlock: 0, hp: 1, spd: 112, r: 11, w: 1.5 },
    { id: "drifter", shape: "circle", unlock: 18, hp: 1, spd: 74, r: 18, w: 1 },
    { id: "dasher", shape: "triangle", unlock: 32, hp: 1, spd: 64, r: 15, w: 1.05 },
    { id: "predictor", shape: "diamond", unlock: 50, hp: 1, spd: 92, r: 16, w: 1 },
    { id: "orbiter", shape: "hex", unlock: 75, hp: 2, spd: 98, r: 17, w: 0.95 },
    { id: "zigzag", shape: "trap", unlock: 95, hp: 1, spd: 102, r: 15, w: 0.95 },
    { id: "rook", shape: "plus", unlock: 125, hp: 2, spd: 128, r: 16, w: 0.85 },
    { id: "spiral", shape: "penta", unlock: 155, hp: 2, spd: 90, r: 17, w: 0.8 },
    { id: "interceptor", shape: "chevron", unlock: 185, hp: 2, spd: 108, r: 16, w: 0.85 },
    { id: "blinker", shape: "star", unlock: 220, hp: 2, spd: 58, r: 16, w: 0.6 },
    { id: "tank", shape: "square", unlock: 250, hp: 5, spd: 52, r: 26, w: 0.4 }
  ];

  function growthRate() {
    return 1 + (SURVIVAL_DIFF * 10 - 1) * 0.04;
  }

  function minutesEff() {
    return elapsed / 60 * growthRate();
  }

  function speedDiff() {
    const m = minutesEff();
    return 1 + m * 0.2 + m * m * 0.035;
  }

  function hpScale() {
    const m = minutesEff();
    return Math.pow(1 + m * 1.35, 1.45);
  }

  function makePlayer() {
    return {
      x: WORLD / 2,
      y: WORLD / 2,
      vx: 0,
      vy: 0,
      hp: 3,
      maxHp: 3,
      baseSpeed: 200,
      speedMul: 1,
      sizeMul: 1,
      dmgMul: 1,
      dmgBonus: 0,
      rateMul: 1,
      rangeMul: 1,
      iframeMul: 1,
      regenLv: 0,
      shotLv: 0,
      pulseLv: 0,
      orbitLv: 0,
      trailLv: 0,
      chainLv: 0,
      thornsLv: 0,
      crossLv: 0,
      forwardLv: 0,
      slowLv: 0,
      novaLv: 0,
      beamLv: 0,
      echoLv: 0,
      iframe: 0,
      regenT: 0,
      shotT: 0,
      pulseT: 0,
      trailT: 0,
      chainT: 0,
      thornsT: 0,
      crossT: 0,
      forwardT: 0,
      slowT: 0,
      novaT: 0,
      beamAng: 0,
      orbitAng: 0,
      facing: 0,
      hitFlash: 0
    };
  }

  function playerR() {
    return 16 * player.sizeMul;
  }

  function spawnEnemy(type) {
    const def = type || pick(availableTypes());
    const pos = spawnAwayFromPlayer(def);
    const hp = Math.max(1, Math.round(def.hp * hpScale()));
    enemies.push({
      id: def.id,
      shape: def.shape,
      x: pos.x,
      y: pos.y,
      vx: 0,
      vy: 0,
      r: def.r,
      hp,
      maxHp: hp,
      spd: def.spd * speedDiff() * rand(0.92, 1.08),
      rot: 0,
      t: rand(0, 10),
      phase: Math.random() * TAU,
      dash: 0,
      dashCd: rand(0.6, 1.6),
      blink: rand(2.5, 4.5),
      axis: Math.random() < 0.5 ? "x" : "y",
      slow: 1,
      thornCd: 0,
      hitFlash: 0
    });
  }

  function spawnAwayFromPlayer(def) {
    const inset = 36 + def.r;
    const px = player ? player.x : WORLD / 2;
    const py = player ? player.y : WORLD / 2;
    const candidates = [];
    const n = 12;
    for (let i = 0; i < n; i++) {
      const t = (i + Math.random()) / n;
      const u = lerp(inset, WORLD - inset, t);
      candidates.push({ x: u, y: inset });
      candidates.push({ x: u, y: WORLD - inset });
      candidates.push({ x: inset, y: u });
      candidates.push({ x: WORLD - inset, y: u });
    }
    candidates.sort((a, b) => hypot(b.x - px, b.y - py) - hypot(a.x - px, a.y - py));
    const far = candidates.slice(0, Math.max(8, (candidates.length * 0.2) | 0));
    return pick(far);
  }

  function availableTypes() {
    const list = ENEMY_DEFS.filter((d) => elapsed * growthRate() >= d.unlock);
    return list.length ? list : ENEMY_DEFS.slice(0, 1);
  }

  function weightedSpawn() {
    const list = availableTypes();
    let sum = 0;
    for (const d of list) sum += d.w;
    let r = Math.random() * sum;
    for (const d of list) {
      r -= d.w;
      if (r <= 0) return d;
    }
    return list[0];
  }

  function maxEnemies() {
    const m = minutesEff();
    return Math.min(150, Math.floor(12 + m * 8.5 + m * m * 1.1));
  }

  function spawnInterval() {
    const m = minutesEff();
    return 1.05 * Math.max(0.11, 1 - m * 0.17);
  }

  function nearestEnemy(x, y, maxDist) {
    let best = null;
    let bestD = maxDist || 1e9;
    for (const e of enemies) {
      const d = hypot(e.x - x, e.y - y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  function hurtEnemy(e, dmg, hx, hy) {
    if (e.hp <= 0) return;
    e.hp -= dmg;
    e.hitFlash = 0.08;
    spawnFloat(e.x, e.y - e.r, formatNum(dmg), "#efe6c8");
    if (hx != null) {
      const d = hypot(e.x - hx, e.y - hy) || 1;
      e.x += (e.x - hx) / d * 4;
      e.y += (e.y - hy) / d * 4;
    }
    if (e.hp <= 0) killEnemy(e);
  }

  function killEnemy(e) {
    e.hp = 0;
    kills += 1;
    audio.kill();
    const power = Math.min(1.7, 0.75 + e.r / 26);
    shake = Math.max(shake, 4.2 * power);
    killFlash = Math.min(0.22, killFlash + 0.08 * power);
    hitStop = Math.min(0.055, hitStop + 0.022 * power);
    burstKill(e);
    spawnFloat(e.x, e.y - 6, "0", "#f0ece4", { pop: 1.15, life: 0.48, vy: 56 });
  }

  function burst(x, y, r, color, n) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      const s = rand(40, 180);
      particles.push({
        kind: "spark",
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.25, 0.7),
        max: 0.7,
        r: rand(1.5, r * 0.35),
        color
      });
    }
    capParticles();
  }

  function burstKill(e) {
    const colors = ["#c17f79", "#d4a09b", "#efe6c8", "#e2c4c0", "#d7b3ae"];
    particles.push({
      kind: "ghost",
      x: e.x,
      y: e.y,
      r: e.r,
      rot: e.rot,
      shape: e.shape,
      life: 0.28,
      max: 0.28,
      grow: 2.6,
      color: "#f0ece4"
    });
    particles.push({
      kind: "core",
      x: e.x,
      y: e.y,
      r: e.r * 1.15,
      life: 0.12,
      max: 0.12,
      color: "#f0ece4"
    });
    particles.push({
      kind: "ring",
      x: e.x,
      y: e.y,
      r: e.r * 0.35,
      grow: 78 + e.r * 2.2,
      life: 0.34,
      max: 0.34,
      color: "#f0ece4",
      lw: 3.6
    });
    particles.push({
      kind: "ring",
      x: e.x,
      y: e.y,
      r: e.r * 0.15,
      grow: 42 + e.r,
      life: 0.18,
      max: 0.18,
      color: "#c17f79",
      lw: 5
    });
    const n = 16 + ((e.r * 0.7) | 0);
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + rand(-0.18, 0.18);
      const s = rand(110, 360) * (0.75 + e.r / 32);
      const shard = i % 3 === 0;
      particles.push({
        kind: shard ? "shard" : "spark",
        x: e.x,
        y: e.y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: rand(0.28, 0.72),
        max: 0.72,
        r: shard ? rand(3.2, 7.2) : rand(1.6, 4.4),
        rot: a,
        spin: rand(-14, 14),
        color: pick(colors)
      });
    }
    capParticles();
  }

  function capParticles() {
    if (particles.length > 720) particles.splice(0, particles.length - 600);
  }

  function spawnFloat(x, y, text, color, extra) {
    extra = extra || {};
    floats.push({
      x,
      y,
      text,
      color,
      life: extra.life || 0.7,
      max: extra.life || 0.7,
      pop: extra.pop || 0,
      vy: extra.vy || 28
    });
    if (floats.length > 90) floats.splice(0, 20);
  }

  function fireBullet(x, y, ang, spd, dmg, life, r, kind) {
    bullets.push({
      x, y,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      dmg, life, r: r || 4,
      kind: kind || ""
    });
  }

  function addZone(x, y, r, life, dmg, slow) {
    zones.push({ x, y, r, life, max: life, dmg, slow: slow || 0, tick: 0 });
  }

  function hitDmg(base) {
    return Math.max(1, Math.round(base) + (player.dmgBonus || 0));
  }

  function fmtSec(s) {
    return s.toFixed(2) + "秒";
  }

  function shotInterval() {
    return Math.max(0.05, 0.5 / (player.rateMul * (1 + player.shotLv * 0.06)));
  }

  function shotCount() {
    return 1 + Math.floor(player.shotLv / 3);
  }

  function orbitCount() {
    return Math.max(1, player.orbitLv);
  }

  function echoCount() {
    return Math.max(1, player.echoLv);
  }

  function regenInterval() {
    return Math.max(0.35, 10.5 - player.regenLv * 1.4);
  }

  function tickDps(lv) {
    return Math.max(1, lv) + (player.dmgBonus || 0);
  }

  function upgradeStatLines(id) {
    const p = player;
    const rm = p.rateMul;
    const rg = p.rangeMul;
    const lv = owned[id] || 0;
    switch (id) {
      case "vital": return [`残数 ${p.hp} / ${p.maxHp}`];
      case "haste": return [`移動 ${Math.round(p.baseSpeed * p.speedMul)}`, `倍率 ×${p.speedMul.toFixed(2)}`];
      case "regen": return [`回復間隔 ${fmtSec(regenInterval())}`, "上限まで1ずつ回復"];
      case "iframe": return [`当たったあとの無敵 ${fmtSec(0.7 * p.iframeMul)}`];
      case "shrink": return [`当たり半径 ${playerR().toFixed(1)}`];
      case "power": return [`全攻撃 +${p.dmgBonus}`];
      case "rate": return [`攻撃間隔 ×${rm.toFixed(2)}`];
      case "range": return [`射程 ×${rg.toFixed(2)}`];
      case "shot": return [
        `火力 ${hitDmg(1 + p.shotLv)}`,
        `発射間隔 ${fmtSec(shotInterval())}`,
        `弾数 ${shotCount()}`,
        `射程 ${(480 * rg) | 0}`
      ];
      case "pulse": return [
        `火力 ${hitDmg(p.pulseLv)}`,
        `発射間隔 ${fmtSec(1.35 / rm)}`,
        `半径 ${(88 + p.pulseLv * 10) * rg | 0}`
      ];
      case "orbit": return [
        `火力 ${hitDmg(p.orbitLv)}`,
        `刃 ${orbitCount()}本`,
        `ヒット間隔 0.16秒`,
        `半径 ${(46 + p.orbitLv * 7) * rg | 0}`
      ];
      case "trail": return [
        `火力 ${hitDmg(p.trailLv)}`,
        `設置間隔 0.07秒`,
        `持続 ${fmtSec(0.45 + p.trailLv * 0.08)}`,
        `半径 ${(18 + p.trailLv * 3) * rg | 0}`
      ];
      case "chain": return [
        `火力 ${hitDmg(p.chainLv)}`,
        `発射間隔 ${fmtSec(1.05 / rm)}`,
        `連鎖 ${p.chainLv}体`,
        `射程 ${(210 * rg) | 0}`
      ];
      case "thorns": return [`火力 ${hitDmg(p.thornsLv)}`, "触れたとき", "間隔 0.28秒"];
      case "cross": return [
        `火力 ${hitDmg(p.crossLv)}`,
        `発射間隔 ${fmtSec(Math.max(0.05, 0.62 / rm))}`,
        "上下左右"
      ];
      case "forward": return [
        `火力 ${hitDmg(p.forwardLv)}`,
        `発射間隔 ${fmtSec(Math.max(0.05, 0.4 / rm))}`,
        `弾数 ${1 + Math.floor(p.forwardLv / 4) * 2}`
      ];
      case "slow": return [
        `火力 ${hitDmg(p.slowLv)}`,
        `間隔 ${fmtSec(0.45 / rm)}`,
        `半径 ${(92 + p.slowLv * 12) * rg | 0}`,
        `減速 ${Math.round(Math.min(0.9, 0.1 * p.slowLv) * 100)}%`
      ];
      case "nova": return [
        `火力 ${hitDmg(p.novaLv)}`,
        `発射間隔 ${fmtSec(3.1 / rm)}`,
        `半径 ${(150 + p.novaLv * 18) * rg | 0}`
      ];
      case "beam": return [
        `火力 ${tickDps(p.beamLv)}/秒`,
        "回り続ける",
        `長さ ${(240 + p.beamLv * 28) * rg | 0}`,
        `太さ ${(6 + p.beamLv * 1.4).toFixed(1)}`
      ];
      case "echo": return [
        `火力 ${tickDps(p.echoLv)}/秒`,
        `残像 ${echoCount()}体`,
        "遅延 0.18秒ごと"
      ];
      default: return lv ? [`レベル ${lv}`] : [];
    }
  }

  function openPause() {
    if (state !== "playing") return;
    state = "paused";
    buildControlGrid($("control-grid-pause"));
    renderPauseStats();
    $("control-modal").classList.remove("hidden");
    syncVpad();
  }

  function closePause() {
    $("control-modal").classList.add("hidden");
    if (state === "paused") state = "playing";
    syncVpad();
  }

  function giveUp() {
    if (state !== "paused") return;
    $("control-modal").classList.add("hidden");
    endGame(false, "giveup");
  }

  function renderPauseStats() {
    if (!player) return;
    const chips = [
      ["残数", `${player.hp} / ${player.maxHp}`],
      ["移動", String(Math.round(player.baseSpeed * player.speedMul))],
      ["攻撃の追加", `+${player.dmgBonus}`],
      ["連射", `×${player.rateMul.toFixed(2)}`],
      ["射程", `×${player.rangeMul.toFixed(2)}`],
      ["通常弾", `${hitDmg(1 + player.shotLv)} / ${fmtSec(shotInterval())}`]
    ];
    $("core-stats").innerHTML = chips.map(([k, v]) => (
      `<div class="stat-chip"><span>${k}</span><strong>${v}</strong></div>`
    )).join("");

    const rows = [];
    rows.push({
      id: "shot",
      name: "通常弾",
      lv: player.shotLv,
      builtin: true
    });
    for (const u of UPGRADES) {
      const lv = owned[u.id] || 0;
      if (!lv || u.id === "shot") continue;
      rows.push({ id: u.id, name: u.name, lv, builtin: false });
    }
    if (owned.shot) {
      rows[0].lv = owned.shot;
    }
    const extra = rows.filter((r) => r.id !== "shot");
    const list = [rows[0]].concat(extra);
    $("owned-upgrades").innerHTML = list.map((r) => {
      const nums = upgradeStatLines(r.id).join(" ／ ");
      const lvText = r.builtin && !owned.shot ? "最初から" : `レベル ${r.lv}`;
      return `<div class="owned-item">
        <div class="owned-top"><span class="owned-name">${r.name}</span><span class="owned-lv">${lvText}</span></div>
        <div class="owned-nums">${nums}</div>
      </div>`;
    }).join("");
  }

  function playerDamage() {
    if (player.iframe > 0 || player.hp <= 0) return;
    player.hp -= 1;
    player.iframe = 0.7 * player.iframeMul;
    player.hitFlash = 0.2;
    shake = 12;
    flash = 0.28;
    audio.hurt();
    burst(player.x, player.y, 18, "#8aa9a4", 14);
    if (player.hp <= 0) endGame(false);
  }

  function endGame(cleared, reason) {
    state = "over";
    audio.dead();
    const score = calcScore(elapsed);
    const rec = loadBest();
    const isBest = !rec || score > rec.score;
    if (isBest) {
      saveBest({
        score,
        time: elapsed,
        kills
      });
    }
    $("control-modal").classList.add("hidden");
    $("result-kicker").textContent = "結果";
    $("result-title").textContent = reason === "giveup" ? "あきらめました" : "残数がなくなりました";
    $("result-time").textContent = formatTime(elapsed);
    $("result-kills").textContent = String(kills);
    $("result-score").textContent = score.toLocaleString();
    $("result-best").textContent = isBest ? "自己ベストを更新しました" : `自己ベスト ${(rec && rec.score ? rec.score : score).toLocaleString()}`;
    $("result-modal").classList.remove("hidden");
    syncVpad();
    refreshBest();
  }

  function resetRun() {
    elapsed = 0;
    upgradeIn = UPGRADE_EVERY;
    kills = 0;
    shake = 0;
    flash = 0;
    killFlash = 0;
    hitStop = 0;
    player = makePlayer();
    enemies = [];
    bullets = [];
    zones = [];
    particles = [];
    floats = [];
    bolts = [];
    history = [];
    owned = {};
    spawnAcc = 0.4;
    for (let i = 0; i < 4; i++) spawnEnemy(ENEMY_DEFS[0]);
  }

  function startGame() {
    audio.ensure();
    saveSettings();
    resetRun();
    state = "playing";
    $("title-screen").classList.add("hidden");
    $("game-screen").classList.remove("hidden");
    $("result-modal").classList.add("hidden");
    $("upgrade-modal").classList.add("hidden");
    $("control-modal").classList.add("hidden");
    syncVpad();
    resize();
  }

  function backToTitle() {
    state = "title";
    $("game-screen").classList.add("hidden");
    $("result-modal").classList.add("hidden");
    $("upgrade-modal").classList.add("hidden");
    $("control-modal").classList.add("hidden");
    $("title-screen").classList.remove("hidden");
    $("vpad").classList.add("hidden");
    refreshBest();
  }

  function getMoveAxis() {
    let ax = 0;
    let ay = 0;
    const mode = input.mode;
    if (mode === "wasd") {
      if (input.keys.has("KeyW") || input.keys.has("KeyZ")) ay -= 1;
      if (input.keys.has("KeyS")) ay += 1;
      if (input.keys.has("KeyA") || input.keys.has("KeyQ")) ax -= 1;
      if (input.keys.has("KeyD")) ax += 1;
    } else if (mode === "arrows") {
      if (input.keys.has("ArrowUp")) ay -= 1;
      if (input.keys.has("ArrowDown")) ay += 1;
      if (input.keys.has("ArrowLeft")) ax -= 1;
      if (input.keys.has("ArrowRight")) ax += 1;
    } else if (mode === "mouse" && input.mouse.on) {
      const w = screenToWorld(input.mouse.x, input.mouse.y);
      ax = w.x - player.x;
      ay = w.y - player.y;
      if (hypot(ax, ay) < 18) return { x: 0, y: 0 };
    } else if (mode === "vpad") {
      ax = input.vpad.ax;
      ay = input.vpad.ay;
    } else if (mode === "swipe") {
      if (!input.swipe.active) return { x: 0, y: 0 };
      const w = screenToWorld(input.swipe.sx, input.swipe.sy);
      ax = w.x - player.x;
      ay = w.y - player.y;
      if (hypot(ax, ay) < 16) return { x: 0, y: 0 };
    } else if (mode === "padL" || mode === "padR" || mode === "padD") {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const gp of pads) {
        if (!gp) continue;
        if (mode === "padL") {
          ax = gp.axes[0] || 0;
          ay = gp.axes[1] || 0;
        } else if (mode === "padR") {
          ax = gp.axes[2] || 0;
          ay = gp.axes[3] || 0;
        } else {
          if (gp.buttons[14] && gp.buttons[14].pressed) ax -= 1;
          if (gp.buttons[15] && gp.buttons[15].pressed) ax += 1;
          if (gp.buttons[12] && gp.buttons[12].pressed) ay -= 1;
          if (gp.buttons[13] && gp.buttons[13].pressed) ay += 1;
        }
        break;
      }
      if (Math.abs(ax) < 0.22) ax = 0;
      if (Math.abs(ay) < 0.22) ay = 0;
    }
    const m = hypot(ax, ay);
    if (m > 1) {
      ax /= m;
      ay /= m;
    } else if (m < 0.05) {
      return { x: 0, y: 0 };
    }
    return { x: ax, y: ay };
  }

  function screenToWorld(sx, sy) {
    return {
      x: (sx - originX) / viewScale,
      y: (sy - originY) / viewScale
    };
  }

  function updatePlayer(dt) {
    const axis = getMoveAxis();
    const spd = player.baseSpeed * player.speedMul;
    player.vx = axis.x * spd;
    player.vy = axis.y * spd;
    player.x = clamp(player.x + player.vx * dt, playerR(), WORLD - playerR());
    player.y = clamp(player.y + player.vy * dt, playerR(), WORLD - playerR());
    if (axis.x || axis.y) player.facing = Math.atan2(axis.y, axis.x);
    player.iframe = Math.max(0, player.iframe - dt);
    player.hitFlash = Math.max(0, player.hitFlash - dt);

    history.push({ x: player.x, y: player.y, t: elapsed });
    if (history.length > 180) history.shift();

    if (player.regenLv > 0 && player.hp < player.maxHp) {
      player.regenT -= dt;
      if (player.regenT <= 0) {
        player.hp += 1;
        player.regenT = regenInterval();
        spawnFloat(player.x, player.y - 24, "+1", "#a9c4b8");
      }
    }
  }

  function historySnap(delay) {
    for (let k = history.length - 1; k >= 0; k--) {
      if (elapsed - history[k].t >= delay) return history[k];
    }
    return history[0] || null;
  }

  function updateEnemy(e, dt) {
    e.t += dt;
    e.slow = 1;
    e.hitFlash = Math.max(0, e.hitFlash - dt);
    e.thornCd = Math.max(0, e.thornCd - dt);
    const p = player;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const dist = hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;
    let ax = nx;
    let ay = ny;
    const spd = e.spd;

    switch (e.id) {
      case "chaser":
        break;
      case "swarm":
        ax = nx + Math.sin(e.t * 9 + e.phase) * 0.55;
        ay = ny + Math.cos(e.t * 8 + e.phase) * 0.55;
        break;
      case "drifter": {
        const want = Math.atan2(ny, nx);
        e.rot = lerpAngle(e.rot, want, 1.6 * dt);
        ax = Math.cos(e.rot);
        ay = Math.sin(e.rot);
        break;
      }
      case "dasher":
        e.dashCd -= dt;
        if (e.dash > 0) {
          e.dash -= dt;
          ax = Math.cos(e.rot);
          ay = Math.sin(e.rot);
          moveEnemy(e, ax, ay, spd * 3.4, dt);
          clampEnemy(e);
          collidePlayer(e);
          return;
        }
        if (e.dashCd <= 0) {
          e.rot = Math.atan2(dy, dx);
          e.dash = 0.28;
          e.dashCd = rand(1.3, 2.2);
        } else {
          ax = nx * 0.25;
          ay = ny * 0.25;
        }
        break;
      case "predictor": {
        const look = 0.55;
        const tx = p.x + p.vx * look - e.x;
        const ty = p.y + p.vy * look - e.y;
        const td = hypot(tx, ty) || 1;
        ax = tx / td;
        ay = ty / td;
        break;
      }
      case "orbiter": {
        const tang = dist > 220 ? 0.25 : dist > 90 ? 1 : 0.15;
        const inward = dist > 140 ? 0.85 : dist < 70 ? -0.4 : 0.2;
        ax = -ny * tang * (e.phase > Math.PI ? 1 : -1) + nx * inward;
        ay = nx * tang * (e.phase > Math.PI ? 1 : -1) + ny * inward;
        break;
      }
      case "zigzag": {
        const s = Math.sin(e.t * 7);
        ax = nx + -ny * s * 1.1;
        ay = ny + nx * s * 1.1;
        break;
      }
      case "rook":
        if (e.axis === "x") {
          if (Math.abs(dx) < 10) e.axis = "y";
          ax = Math.sign(dx) || nx;
          ay = 0;
        } else {
          if (Math.abs(dy) < 10) e.axis = "x";
          ax = 0;
          ay = Math.sign(dy) || ny;
        }
        break;
      case "spiral": {
        const a = Math.atan2(dy, dx) + 0.9 + Math.sin(e.t) * 0.2;
        ax = Math.cos(a);
        ay = Math.sin(a);
        break;
      }
      case "interceptor": {
        const look = dist / Math.max(80, spd);
        const tx = p.x + p.vx * Math.min(1.1, look) - e.x;
        const ty = p.y + p.vy * Math.min(1.1, look) - e.y;
        const td = hypot(tx, ty) || 1;
        ax = tx / td;
        ay = ty / td;
        break;
      }
      case "blinker":
        e.blink -= dt;
        if (e.blink <= 0) {
          const step = Math.min(90, dist * 0.4);
          e.x += nx * step;
          e.y += ny * step;
          e.blink = rand(2.2, 4.2);
          burst(e.x, e.y, 12, "#c17f79", 8);
        }
        break;
      case "tank":
        ax = nx * 0.85;
        ay = ny * 0.85;
        break;
    }

    const m = hypot(ax, ay) || 1;
    moveEnemy(e, ax / m, ay / m, spd, dt);
    clampEnemy(e);
    collidePlayer(e);
  }

  function lerpAngle(a, b, t) {
    let d = b - a;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    return a + d * Math.min(1, t);
  }

  function moveEnemy(e, ax, ay, spd, dt) {
    const s = spd * e.slow;
    e.vx = ax * s;
    e.vy = ay * s;
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.rot = Math.atan2(ay, ax);
  }

  function clampEnemy(e) {
    e.x = clamp(e.x, e.r, WORLD - e.r);
    e.y = clamp(e.y, e.r, WORLD - e.r);
  }

  function collidePlayer(e) {
    const r = playerR() + e.r * 0.82;
    const dx = e.x - player.x;
    const dy = e.y - player.y;
    if (dx * dx + dy * dy < r * r) {
      if (player.thornsLv > 0 && e.thornCd <= 0) {
        const dmg = hitDmg(player.thornsLv);
        hurtEnemy(e, dmg, player.x, player.y);
        e.thornCd = 0.28;
      }
      if (player.iframe <= 0) {
        const d = hypot(dx, dy) || 1;
        player.x -= dx / d * 28;
        player.y -= dy / d * 28;
        player.x = clamp(player.x, playerR(), WORLD - playerR());
        player.y = clamp(player.y, playerR(), WORLD - playerR());
        playerDamage();
      }
    }
  }

  function updateCombat(dt) {
    const p = player;
    const rm = p.rateMul;
    const rg = p.rangeMul;

    p.shotT -= dt;
    if (p.shotT <= 0) {
      const reach = 480 * rg;
      const tgt = nearestEnemy(p.x, p.y, reach);
      const ang = tgt ? Math.atan2(tgt.y - p.y, tgt.x - p.x) : p.facing;
      const dmg = hitDmg(1 + p.shotLv);
      const n = shotCount();
      const spread = n === 1 ? 0 : 0.14;
      const muzzle = playerR() + 8;
      for (let i = 0; i < n; i++) {
        const off = n === 1 ? 0 : (i - (n - 1) / 2) * spread;
        const a = ang + off;
        fireBullet(
          p.x + Math.cos(a) * muzzle,
          p.y + Math.sin(a) * muzzle,
          a,
          400 + p.shotLv * 12,
          dmg,
          1.05,
          4.2,
          "shot"
        );
      }
      p.shotT = shotInterval();
    }

    if (p.pulseLv > 0) {
      p.pulseT -= dt;
      if (p.pulseT <= 0) {
        const rad = (88 + p.pulseLv * 10) * rg;
        const dmg = hitDmg(p.pulseLv);
        for (const e of enemies) {
          if (hypot(e.x - p.x, e.y - p.y) < rad + e.r) hurtEnemy(e, dmg, p.x, p.y);
        }
        zones.push({ x: p.x, y: p.y, r: rad, life: 0.28, max: 0.28, dmg: 0, slow: 0, tick: 99, ring: true });
        p.pulseT = 1.35 / rm;
      }
    }

    if (p.orbitLv > 0) {
      p.orbitAng += (1.7 + p.orbitLv * 0.12) * dt;
      const n = orbitCount();
      const rad = (46 + p.orbitLv * 7) * rg;
      const dmg = hitDmg(p.orbitLv);
      for (let i = 0; i < n; i++) {
        const a = p.orbitAng + i * TAU / n;
        const bx = p.x + Math.cos(a) * rad;
        const by = p.y + Math.sin(a) * rad;
        for (const e of enemies) {
          if (hypot(e.x - bx, e.y - by) < e.r + 10) {
            if ((e._orbHit || 0) <= elapsed) {
              hurtEnemy(e, dmg, bx, by);
              e._orbHit = elapsed + 0.16;
            }
          }
        }
      }
    }

    if (p.trailLv > 0) {
      p.trailT -= dt;
      if (p.trailT <= 0) {
        addZone(p.x, p.y, (18 + p.trailLv * 3) * rg, 0.45 + p.trailLv * 0.08, hitDmg(p.trailLv), 0);
        p.trailT = 0.07;
      }
    }

    if (p.chainLv > 0) {
      p.chainT -= dt;
      if (p.chainT <= 0) {
        const first = nearestEnemy(p.x, p.y, 210 * rg);
        if (first) {
          const hops = p.chainLv;
          const dmg = hitDmg(p.chainLv);
          let cur = first;
          let fromX = p.x;
          let fromY = p.y;
          const used = new Set();
          for (let i = 0; i < hops && cur; i++) {
            used.add(cur);
            hurtEnemy(cur, dmg, fromX, fromY);
            bolts.push({ x1: fromX, y1: fromY, x2: cur.x, y2: cur.y, life: 0.12 });
            fromX = cur.x;
            fromY = cur.y;
            let nxt = null;
            let best = 170 * rg;
            for (const e of enemies) {
              if (used.has(e) || e.hp <= 0) continue;
              const d = hypot(e.x - cur.x, e.y - cur.y);
              if (d < best) {
                best = d;
                nxt = e;
              }
            }
            cur = nxt;
          }
        }
        p.chainT = 1.05 / rm;
      }
    }

    if (p.crossLv > 0) {
      p.crossT -= dt;
      if (p.crossT <= 0) {
        const dmg = hitDmg(p.crossLv);
        for (let i = 0; i < 4; i++) fireBullet(p.x, p.y, i * Math.PI / 2, 380, dmg, 0.9, 4);
        p.crossT = Math.max(0.05, 0.62 / rm);
      }
    }

    if (p.forwardLv > 0) {
      p.forwardT -= dt;
      if (p.forwardT <= 0) {
        const dmg = hitDmg(p.forwardLv);
        fireBullet(p.x, p.y, p.facing, 440, dmg, 0.85, 4.2);
        const extra = Math.floor(p.forwardLv / 4);
        for (let k = 1; k <= extra; k++) {
          const spr = 0.18 * k;
          fireBullet(p.x, p.y, p.facing - spr, 420, dmg, 0.75, 3.5);
          fireBullet(p.x, p.y, p.facing + spr, 420, dmg, 0.75, 3.5);
        }
        p.forwardT = Math.max(0.05, 0.4 / rm);
      }
    }

    if (p.slowLv > 0) {
      p.slowT -= dt;
      const rad = (92 + p.slowLv * 12) * rg;
      const dmg = hitDmg(p.slowLv);
      for (const e of enemies) {
        if (hypot(e.x - p.x, e.y - p.y) < rad + e.r) {
          e.slow = Math.min(e.slow, Math.max(0.1, 1 - 0.1 * p.slowLv));
        }
      }
      if (p.slowT <= 0) {
        for (const e of enemies) {
          if (hypot(e.x - p.x, e.y - p.y) < rad + e.r) hurtEnemy(e, dmg, p.x, p.y);
        }
        p.slowT = 0.45 / rm;
      }
    }

    if (p.novaLv > 0) {
      p.novaT -= dt;
      if (p.novaT <= 0) {
        const rad = (150 + p.novaLv * 18) * rg;
        const dmg = hitDmg(p.novaLv);
        for (const e of enemies) {
          if (hypot(e.x - p.x, e.y - p.y) < rad + e.r) hurtEnemy(e, dmg, p.x, p.y);
        }
        zones.push({ x: p.x, y: p.y, r: rad, life: 0.32, max: 0.32, dmg: 0, slow: 0, tick: 99, ring: true });
        p.novaT = 3.1 / rm;
      }
    }

    if (p.beamLv > 0) {
      p.beamAng += (1.15 + p.beamLv * 0.08) * dt;
      const len = (240 + p.beamLv * 28) * rg;
      const thick = 6 + p.beamLv * 1.4;
      const dmg = tickDps(p.beamLv) * dt;
      const c = Math.cos(p.beamAng);
      const s = Math.sin(p.beamAng);
      for (const e of enemies) {
        const px = e.x - p.x;
        const py = e.y - p.y;
        const proj = px * c + py * s;
        if (proj < 0 || proj > len) continue;
        const ox = px - c * proj;
        const oy = py - s * proj;
        if (hypot(ox, oy) < e.r + thick) hurtEnemy(e, dmg, p.x, p.y);
      }
    }

    if (p.echoLv > 0 && history.length > 8) {
      const n = echoCount();
      for (let i = 1; i <= n; i++) {
        const snap = historySnap(0.18 * i);
        if (!snap) continue;
        const dmg = tickDps(p.echoLv) * dt;
        for (const e of enemies) {
          if (hypot(e.x - snap.x, e.y - snap.y) < e.r + 16) hurtEnemy(e, dmg, snap.x, snap.y);
        }
      }
    }
  }


  function updateBullets(dt) {
    for (const b of bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;
      for (const e of enemies) {
        if (e.hp <= 0) continue;
        if (hypot(e.x - b.x, e.y - b.y) < e.r + b.r) {
          hurtEnemy(e, b.dmg, b.x, b.y);
          b.life = 0;
          break;
        }
      }
      if (b.x < 0 || b.y < 0 || b.x > WORLD || b.y > WORLD) b.life = 0;
    }
    bullets = bullets.filter((b) => b.life > 0);
    if (bullets.length > 220) bullets.splice(0, bullets.length - 180);
  }

  function updateZones(dt) {
    for (const z of zones) {
      z.life -= dt;
      z.tick -= dt;
      if (z.dmg && z.tick <= 0) {
        for (const e of enemies) {
          if (hypot(e.x - z.x, e.y - z.y) < z.r + e.r) hurtEnemy(e, z.dmg, z.x, z.y);
        }
        z.tick = 0.12;
      }
    }
    zones = zones.filter((z) => z.life > 0);
    if (zones.length > 90) zones.splice(0, 20);
  }

  function updateFx(dt) {
    for (const p of particles) {
      if (p.kind === "ring" || p.kind === "ghost" || p.kind === "core") {
        p.life -= dt;
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.86;
      p.vy *= 0.86;
      if (p.spin) p.rot = (p.rot || 0) + p.spin * dt;
      p.life -= dt;
    }
    particles = particles.filter((p) => p.life > 0);
    for (const f of floats) {
      f.y -= (f.vy || 28) * dt;
      f.life -= dt;
    }
    floats = floats.filter((f) => f.life > 0);
    for (const b of bolts) b.life -= dt;
    bolts = bolts.filter((b) => b.life > 0);
    shake = Math.max(0, shake - dt * 28);
    flash = Math.max(0, flash - dt);
    killFlash = Math.max(0, killFlash - dt * 4.2);
  }

  function openUpgrade() {
    state = "upgrade";
    const src = UPGRADES.slice();
    const choices = [];
    while (choices.length < UPGRADE_PICKS && src.length) {
      const i = (Math.random() * src.length) | 0;
      choices.push(src.splice(i, 1)[0]);
    }
    while (choices.length < UPGRADE_PICKS) choices.push(choices[0]);
    upgradeSlots = choices.map((u) => ({ id: u.id }));
    renderUpgradeCards();
    $("upgrade-modal").classList.remove("hidden");
    syncVpad();
    audio.over();
  }

  function pickUpgrade(index) {
    const slot = upgradeSlots[index];
    if (!slot) return;
    applyUpgrade(slot.id);
    player.shotT = 0;
    if (slot.id === "shot" || slot.id === "power") {
      const d = hitDmg(1 + player.shotLv);
      for (const b of bullets) if (b.kind === "shot") b.dmg = d;
    }
    audio.pick();
    $("upgrade-modal").classList.add("hidden");
    state = "playing";
    upgradeIn = UPGRADE_EVERY;
    syncVpad();
  }

  function renderUpgradeCards() {
    const root = $("upgrade-cards");
    root.innerHTML = "";
    upgradeSlots.forEach((slot, i) => {
      const def = UMAP[slot.id] || { kind: "能力", name: "体力", desc: () => "最大残数が1増え、1回復します。" };
      const lv = owned[slot.id] || 0;
      const el = document.createElement("div");
      el.className = "up-card";
      el.innerHTML = `
        <div class="up-kind">${i + 1}　${def.kind}</div>
        <div class="up-name">${def.name}</div>
        <div class="up-lv">${lv ? `レベル ${lv} → ${lv + 1}` : "新規"}</div>
        <div class="up-desc">${def.desc(lv)}</div>
      `;
      el.addEventListener("click", () => pickUpgrade(i));
      root.appendChild(el);
    });
  }

  function drawShape(c, shape, x, y, r, rot, fill, stroke) {
    c.save();
    c.translate(x, y);
    c.rotate(rot || 0);
    c.beginPath();
    if (shape === "circle") {
      c.arc(0, 0, r, 0, TAU);
    } else if (shape === "square") {
      c.rect(-r, -r, r * 2, r * 2);
    } else if (shape === "triangle") {
      c.moveTo(r, 0);
      c.lineTo(-r * 0.7, r * 0.78);
      c.lineTo(-r * 0.7, -r * 0.78);
      c.closePath();
    } else if (shape === "diamond") {
      c.moveTo(0, -r);
      c.lineTo(r, 0);
      c.lineTo(0, r);
      c.lineTo(-r, 0);
      c.closePath();
    } else if (shape === "hex") {
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * TAU;
        i ? c.lineTo(Math.cos(a) * r, Math.sin(a) * r) : c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      c.closePath();
    } else if (shape === "penta") {
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i / 5 * TAU;
        i ? c.lineTo(Math.cos(a) * r, Math.sin(a) * r) : c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      c.closePath();
    } else if (shape === "star") {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i / 10 * TAU;
        const rr = i % 2 ? r * 0.42 : r;
        i ? c.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : c.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
      }
      c.closePath();
    } else if (shape === "plus") {
      const t = r * 0.38;
      c.moveTo(-t, -r);
      c.lineTo(t, -r);
      c.lineTo(t, -t);
      c.lineTo(r, -t);
      c.lineTo(r, t);
      c.lineTo(t, t);
      c.lineTo(t, r);
      c.lineTo(-t, r);
      c.lineTo(-t, t);
      c.lineTo(-r, t);
      c.lineTo(-r, -t);
      c.lineTo(-t, -t);
      c.closePath();
    } else if (shape === "chevron") {
      c.moveTo(r, 0);
      c.lineTo(-r * 0.3, r);
      c.lineTo(-r, r * 0.45);
      c.lineTo(-r * 0.15, 0);
      c.lineTo(-r, -r * 0.45);
      c.lineTo(-r * 0.3, -r);
      c.closePath();
    } else if (shape === "trap") {
      c.moveTo(-r, r * 0.7);
      c.lineTo(r, r);
      c.lineTo(r * 0.55, -r);
      c.lineTo(-r * 0.55, -r * 0.7);
      c.closePath();
    } else {
      c.rect(-r, -r, r * 2, r * 2);
    }
    c.fillStyle = fill;
    c.fill();
    if (stroke) {
      c.strokeStyle = stroke;
      c.lineWidth = 2;
      c.stroke();
    }
    c.restore();
  }

  function layoutField() {
    const padT = 64;
    const padB = 18;
    const padX = 14;
    const availW = Math.max(220, viewW - padX * 2);
    const availH = Math.max(220, viewH - padT - padB);
    viewScale = Math.min(availW, availH) / WORLD;
    const drawn = WORLD * viewScale;
    originX = (viewW - drawn) / 2;
    originY = padT + (availH - drawn) / 2;
  }

  function resize() {
    viewW = window.innerWidth;
    viewH = window.innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.floor(viewW * dpr);
    canvas.height = Math.floor(viewH * dpr);
    canvas.style.width = viewW + "px";
    canvas.style.height = viewH + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    layoutField();
  }

  function render() {
    const c = ctx;
    const sx = (Math.random() * 2 - 1) * shake;
    const sy = (Math.random() * 2 - 1) * shake;

    c.fillStyle = "#1c1d1b";
    c.fillRect(0, 0, viewW, viewH);
    c.save();
    c.translate(originX + sx, originY + sy);
    c.scale(viewScale, viewScale);

    c.fillStyle = "#232421";
    c.fillRect(0, 0, WORLD, WORLD);
    c.strokeStyle = "rgba(214, 209, 196, 0.06)";
    c.lineWidth = 1;
    const step = 64;
    for (let x = 0; x <= WORLD; x += step) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, WORLD);
      c.stroke();
    }
    for (let y = 0; y <= WORLD; y += step) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(WORLD, y);
      c.stroke();
    }
    c.strokeStyle = "rgba(193, 127, 121, 0.38)";
    c.lineWidth = 6;
    c.strokeRect(3, 3, WORLD - 6, WORLD - 6);

    for (const z of zones) {
      const a = Math.max(0, z.life / z.max);
      c.beginPath();
      c.arc(z.x, z.y, z.r, 0, TAU);
      if (z.ring) {
        c.strokeStyle = `rgba(138,169,164,${0.4 * a})`;
        c.lineWidth = 3;
        c.stroke();
      } else {
        c.fillStyle = `rgba(138,169,164,${0.1 * a})`;
        c.fill();
      }
    }

    if (player && player.slowLv > 0) {
      const rad = (92 + player.slowLv * 12) * player.rangeMul;
      c.beginPath();
      c.arc(player.x, player.y, rad, 0, TAU);
      c.strokeStyle = "rgba(138, 169, 164, 0.28)";
      c.setLineDash([6, 8]);
      c.stroke();
      c.setLineDash([]);
      c.fillStyle = "rgba(138, 169, 164, 0.06)";
      c.fill();
    }

    if (player && player.beamLv > 0) {
      const len = (240 + player.beamLv * 28) * player.rangeMul;
      c.strokeStyle = "rgba(176, 204, 198, 0.55)";
      c.lineWidth = 6 + player.beamLv * 1.2;
      c.beginPath();
      c.moveTo(player.x, player.y);
      c.lineTo(
        player.x + Math.cos(player.beamAng) * len,
        player.y + Math.sin(player.beamAng) * len
      );
      c.stroke();
    }

    if (player && player.echoLv > 0 && history.length > 8) {
      const n = echoCount();
      for (let i = 1; i <= n; i++) {
        const snap = historySnap(0.18 * i);
        if (!snap) continue;
        c.globalAlpha = 0.28;
        drawShape(c, "square", snap.x, snap.y, playerR(), 0, "#8aa9a4");
        c.globalAlpha = 1;
      }
    }

    if (player && player.orbitLv > 0) {
      const n = orbitCount();
      const rad = (46 + player.orbitLv * 7) * player.rangeMul;
      for (let i = 0; i < n; i++) {
        const a = player.orbitAng + i * TAU / n;
        drawShape(c, "diamond", player.x + Math.cos(a) * rad, player.y + Math.sin(a) * rad, 8, a, "#c5d6d2");
      }
    }

    for (const b of bullets) {
      c.fillStyle = "#c5d6d2";
      c.beginPath();
      c.arc(b.x, b.y, b.r, 0, TAU);
      c.fill();
    }

    for (const e of enemies) {
      if (e.hp <= 0) continue;
      const col = e.dash > 0 || (e.id === "dasher" && e.dashCd < 0.25)
        ? "#e2c4c0"
        : (e.hitFlash > 0 ? "#d4a09b" : "#c17f79");
      drawShape(c, e.shape, e.x, e.y, e.r, e.rot, col, "rgba(240, 236, 228, 0.1)");
      c.fillStyle = "#f0ece4";
      c.font = `bold ${Math.max(10, Math.min(18, e.r))}px Segoe UI, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(formatNum(e.hp), e.x, e.y + 0.5);
    }

    if (player) {
      const r = playerR();
      const blink = player.iframe > 0 && ((elapsed * 18) | 0) % 2 === 0;
      c.globalAlpha = blink ? 0.4 : 1;
      drawShape(c, "square", player.x, player.y, r, 0, player.hitFlash > 0 ? "#f0ece4" : "#8aa9a4", "#b7c9c4");
      c.globalAlpha = 1;
      c.fillStyle = "#2a2f2e";
      c.font = `bold ${Math.max(12, r)}px Segoe UI, sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(String(player.hp), player.x, player.y + 0.5);
    }

    for (const b of bolts) {
      c.strokeStyle = `rgba(176,204,198,${Math.max(0, b.life * 8)})`;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(b.x1, b.y1);
      c.lineTo(b.x2, b.y2);
      c.stroke();
    }

    for (const p of particles) {
      const a = Math.max(0, p.life / (p.max || 0.7));
      if (p.kind === "ghost") {
        const k = 1 - a;
        c.globalAlpha = a * 0.85;
        drawShape(c, p.shape, p.x, p.y, p.r * (1 + k * ((p.grow || 2) - 1)), p.rot || 0, p.color);
      } else if (p.kind === "ring") {
        const k = 1 - a;
        c.globalAlpha = a * 0.9;
        c.strokeStyle = p.color;
        c.lineWidth = (p.lw || 3) * (1 - k * 0.55);
        c.beginPath();
        c.arc(p.x, p.y, p.r + k * (p.grow || 40), 0, TAU);
        c.stroke();
      } else if (p.kind === "core") {
        const k = 1 - a;
        c.globalAlpha = a;
        c.fillStyle = p.color;
        c.beginPath();
        c.arc(p.x, p.y, p.r * (1.15 - k * 0.25), 0, TAU);
        c.fill();
      } else if (p.kind === "shard") {
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot || 0);
        c.globalAlpha = a;
        c.fillStyle = p.color;
        c.fillRect(-p.r, -p.r * 0.32, p.r * 2, p.r * 0.64);
        c.restore();
      } else {
        c.globalAlpha = a;
        c.fillStyle = p.color;
        c.fillRect(p.x, p.y, p.r, p.r);
      }
      c.globalAlpha = 1;
    }

    for (const f of floats) {
      const max = f.max || 0.7;
      const t = 1 - Math.max(0, f.life / max);
      const pop = f.pop ? 1 + Math.sin(Math.min(1, t * 3.4) * Math.PI) * f.pop : 1;
      c.globalAlpha = Math.max(0, f.life / max);
      c.fillStyle = f.color;
      c.font = `bold ${Math.round(13 * pop)}px Segoe UI, sans-serif`;
      c.textAlign = "center";
      c.fillText(f.text, f.x, f.y);
      c.globalAlpha = 1;
    }

    c.restore();

    if (killFlash > 0) {
      c.fillStyle = `rgba(240,236,228,${killFlash * 0.22})`;
      c.fillRect(0, 0, viewW, viewH);
    }
    if (flash > 0) {
      c.fillStyle = `rgba(193,127,121,${flash * 0.18})`;
      c.fillRect(0, 0, viewW, viewH);
    }

    if (input.mode === "mouse" && state === "playing") {
      c.strokeStyle = "rgba(138,169,164,0.7)";
      c.beginPath();
      c.arc(input.mouse.x, input.mouse.y, 8, 0, TAU);
      c.stroke();
    }
  }

  function updateHud() {
    $("hud-time").textContent = formatTime(elapsed);
    $("hud-score").textContent = calcScore(elapsed).toLocaleString();
    $("hud-kills").textContent = String(kills);
    $("next-upgrade").textContent = `つぎの強化 ${upgradeIn.toFixed(1)}`;
  }

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    let simDt = dt;
    if (hitStop > 0) {
      hitStop = Math.max(0, hitStop - dt);
      simDt = dt * 0.08;
    }
    if (state === "playing") {
      elapsed += simDt;
      upgradeIn -= simDt;
      updatePlayer(simDt);
      spawnAcc -= simDt;
      while (spawnAcc <= 0 && enemies.filter((e) => e.hp > 0).length < maxEnemies()) {
        spawnEnemy(weightedSpawn());
        spawnAcc += spawnInterval();
      }
      if (spawnAcc < -1) spawnAcc = 0;
      for (const e of enemies) if (e.hp > 0) updateEnemy(e, simDt);
      enemies = enemies.filter((e) => e.hp > 0);
      if (state === "playing") {
        updateCombat(simDt);
        updateBullets(simDt);
        updateZones(simDt);
        updateFx(dt);
        updateHud();
        if (upgradeIn <= 0) openUpgrade();
      }
    } else if (state === "upgrade" || state === "paused" || state === "over") {
      updateFx(dt * 0.4);
    }
    if (state !== "title") render();
    requestAnimationFrame(loop);
  }

  function syncVpad() {
    $("vpad").classList.toggle("hidden", !(state === "playing" && input.mode === "vpad"));
    const hide = input.mode === "mouse" && state === "playing";
    canvas.style.cursor = hide ? "none" : "";
    document.body.style.cursor = "";
    document.documentElement.style.cursor = "";
  }

  function setMode(mode) {
    input.mode = mode;
    document.querySelectorAll(".ctrl-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
    saveSettings();
    syncVpad();
  }

  function buildControlGrid(root) {
    root.innerHTML = "";
    for (const m of CONTROL_MODES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ctrl-btn" + (input.mode === m.id ? " active" : "");
      b.dataset.mode = m.id;
      b.innerHTML = `${m.label}<small>${m.hint}</small>`;
      b.addEventListener("click", () => setMode(m.id));
      root.appendChild(b);
    }
  }

  function refreshBest() {
    const rec = loadBest();
    if (!rec) {
      $("best-score").textContent = "0";
      $("best-meta").textContent = "まだ記録はありません";
      return;
    }
    $("best-score").textContent = rec.score.toLocaleString();
    $("best-meta").textContent = `${formatTime(rec.time)}　撃破 ${rec.kills || 0}`;
  }

  function bindVpad() {
    const base = $("vpad-base");
    const knob = $("vpad-knob");
    const setFrom = (cx, cy, rect) => {
      const px = cx - rect.left - rect.width / 2;
      const py = cy - rect.top - rect.height / 2;
      const m = hypot(px, py);
      const max = rect.width * 0.5 - 8;
      const k = m > max ? max / m : 1;
      input.vpad.ax = (px * k) / max;
      input.vpad.ay = (py * k) / max;
      knob.style.transform = `translate(calc(-50% + ${px * k}px), calc(-50% + ${py * k}px))`;
    };
    const clear = () => {
      input.vpad.active = false;
      input.vpad.ax = 0;
      input.vpad.ay = 0;
      input.vpad.id = null;
      knob.style.transform = "translate(-50%, -50%)";
    };
    base.addEventListener("pointerdown", (e) => {
      if (input.mode !== "vpad") return;
      e.preventDefault();
      base.setPointerCapture(e.pointerId);
      input.vpad.active = true;
      input.vpad.id = e.pointerId;
      setFrom(e.clientX, e.clientY, base.getBoundingClientRect());
    });
    base.addEventListener("pointermove", (e) => {
      if (!input.vpad.active || input.vpad.id !== e.pointerId) return;
      setFrom(e.clientX, e.clientY, base.getBoundingClientRect());
    });
    base.addEventListener("pointerup", clear);
    base.addEventListener("pointercancel", clear);
  }

  function bindSwipe() {
    window.addEventListener("pointerdown", (e) => {
      audio.ensure();
      if (state !== "playing" || input.mode !== "swipe") return;
      if (e.target.closest("#btn-controls, #vpad, .modal")) return;
      input.swipe.active = true;
      input.swipe.id = e.pointerId;
      input.swipe.sx = e.clientX;
      input.swipe.sy = e.clientY;
    });
    window.addEventListener("pointermove", (e) => {
      if (!input.swipe.active || input.swipe.id !== e.pointerId) return;
      input.swipe.sx = e.clientX;
      input.swipe.sy = e.clientY;
    });
    const end = (e) => {
      if (input.swipe.id !== e.pointerId) return;
      input.swipe.active = false;
      input.swipe.sx = 0;
      input.swipe.sy = 0;
      input.swipe.id = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  window.addEventListener("keydown", (e) => {
    input.keys.add(e.code);
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(e.code)) e.preventDefault();
    if (e.code === "Escape") {
      if (e.repeat) return;
      if (state === "playing") {
        e.preventDefault();
        openPause();
      } else if (state === "paused") {
        e.preventDefault();
        closePause();
      }
      return;
    }
    if (state === "upgrade") {
      const n = e.code.startsWith("Digit") ? Number(e.code.slice(5))
        : e.code.startsWith("Numpad") ? Number(e.code.slice(6)) : 0;
      if (n >= 1 && n <= UPGRADE_PICKS) pickUpgrade(n - 1);
    }
    audio.ensure();
  });
  window.addEventListener("keyup", (e) => input.keys.delete(e.code));
  window.addEventListener("blur", () => input.keys.clear());
  window.addEventListener("mousemove", (e) => {
    input.mouse.x = e.clientX;
    input.mouse.y = e.clientY;
    input.mouse.on = true;
  });
  window.addEventListener("resize", resize);
  window.addEventListener("gamepadconnected", () => audio.ensure());
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  $("btn-start").addEventListener("click", startGame);
  $("btn-title").addEventListener("click", backToTitle);
  $("btn-controls").addEventListener("click", openPause);
  $("btn-control-close").addEventListener("click", closePause);
  $("btn-giveup").addEventListener("click", giveUp);
  $("control-modal").addEventListener("click", (e) => {
    if (e.target.id === "control-modal") closePause();
  });

  const settings = loadSettings();
  if (settings.mode && CONTROL_MODES.some((m) => m.id === settings.mode)) input.mode = settings.mode;
  buildControlGrid($("control-grid"));
  setMode(input.mode);
  refreshBest();
  bindVpad();
  bindSwipe();
  resize();
  requestAnimationFrame(loop);
})();
