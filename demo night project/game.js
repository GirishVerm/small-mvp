// ============================================================
//  Asteroid Dodge — Game Loop (TES-21)
//  requestAnimationFrame loop with delta time, parallax
//  starfield, FPS tracking, and pause/resume.
//  Ship, asteroids, and collision added in TES-22+.
// ============================================================

// ---------- Canvas & context ----------
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

// ---------- Screen elements ----------
const screens = {
  menu:     document.getElementById('screen-menu'),
  game:     document.getElementById('screen-game'),
  gameover: document.getElementById('screen-gameover'),
};

// ---------- HUD elements ----------
const hudScore = document.getElementById('hud-score');
const hudLives = document.getElementById('hud-lives');
const hudLevel = document.getElementById('hud-level');

// ---------- Game over screen elements ----------
const goScore     = document.getElementById('go-score');
const goHighScore = document.getElementById('go-high-score');
const goLevel     = document.getElementById('go-level');

// ---------- Menu elements ----------
const menuHighScore = document.getElementById('menu-high-score');

// ---------- Buttons ----------
document.getElementById('btn-start').addEventListener('click',   startGame);
document.getElementById('btn-restart').addEventListener('click', startGame);
document.getElementById('btn-menu').addEventListener('click',    showMenu);

// ---------- Constants ----------
const GAME_WIDTH  = 480;
const GAME_HEIGHT = 640;
const DT_MAX      = 0.05;   // cap delta at 50 ms to survive tab-wake stutter
const FPS_SMOOTH  = 0.9;    // exponential smoothing factor for FPS display

// ---------- Game state ----------
const state = {
  screen:    'menu',
  score:     0,
  lives:     3,
  level:     1,
  highScore: 0,
  running:   false,
  paused:    false,
  rafId:     null,
};

// ---------- Loop internals ----------
let lastTimestamp = 0;
let smoothedFps   = 60;

// ---------- Canvas sizing ----------
function resizeCanvas() {
  canvas.width  = GAME_WIDTH;
  canvas.height = GAME_HEIGHT;
}

// ---------- Screen management ----------
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
  state.screen = name;
}

function showMenu() {
  cancelAnimationFrame(state.rafId);
  state.running = false;
  state.paused  = false;
  menuHighScore.textContent = state.highScore;
  showScreen('menu');
  startBackgroundLoop();
}

function showGameOver() {
  state.running = false;
  state.paused  = false;
  cancelAnimationFrame(state.rafId);

  if (state.score > state.highScore) {
    state.highScore = state.score;
  }

  goScore.textContent     = state.score;
  goHighScore.textContent = state.highScore;
  goLevel.textContent     = state.level;

  showScreen('gameover');
  startBackgroundLoop();
}

// ---------- Background loop (menu / gameover) ----------
// Runs the starfield animation even when not in-game.
function startBackgroundLoop() {
  if (state.running) return;  // game loop takes over when playing
  lastTimestamp = 0;
  state.rafId = requestAnimationFrame(backgroundLoop);
}

function backgroundLoop(timestamp) {
  if (state.running) return;  // hand off to game loop

  const dt = lastTimestamp === 0
    ? 0
    : Math.min((timestamp - lastTimestamp) / 1000, DT_MAX);
  lastTimestamp = timestamp;

  scrollStarfield(dt);
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
  drawStarfield();

  state.rafId = requestAnimationFrame(backgroundLoop);
}

// ---------- Game initialisation ----------
function startGame() {
  state.score   = 0;
  state.lives   = 3;
  state.level   = 1;
  state.running = true;
  state.paused  = false;

  updateHUD();
  showScreen('game');

  // Reset loop timing so the first frame has dt ≈ 0
  lastTimestamp = 0;
  state.rafId = requestAnimationFrame(gameLoop);
}

// ---------- Pause / resume ----------
function togglePause() {
  if (!state.running) return;
  state.paused = !state.paused;

  if (!state.paused) {
    // Resume: reset lastTimestamp so we don't get a huge dt spike
    lastTimestamp = 0;
    state.rafId = requestAnimationFrame(gameLoop);
  }
}

// ---------- HUD update ----------
function updateHUD() {
  hudScore.textContent = state.score;
  hudLives.textContent = '△'.repeat(Math.max(0, state.lives));
  hudLevel.textContent = state.level;
}

// ===========================================================
//  GAME LOOP
// ===========================================================

function gameLoop(timestamp) {
  // Guard: don't schedule another frame when paused
  if (state.paused) return;

  // Calculate delta time in seconds; handle first frame and tab-wake spikes
  const dt = lastTimestamp === 0
    ? 0
    : Math.min((timestamp - lastTimestamp) / 1000, DT_MAX);
  lastTimestamp = timestamp;

  // Exponential moving average for FPS display
  if (dt > 0) {
    smoothedFps = smoothedFps * FPS_SMOOTH + (1 / dt) * (1 - FPS_SMOOTH);
  }

  update(dt);
  render();

  if (state.running) {
    state.rafId = requestAnimationFrame(gameLoop);
  }
}

// ---------- Update ----------
function update(dt) {
  scrollStarfield(dt);
  // Ship, asteroid, collision logic added in TES-22+
}

// ---------- Render ----------
function render() {
  ctx.clearRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  drawStarfield();
  drawFps();

  if (state.paused) {
    drawPauseOverlay();
  }

  // Entity rendering hooks added in TES-22 (ship) and TES-25 (asteroids)
}

// ===========================================================
//  PARALLAX STARFIELD
//  Three layers scrolling at different speeds to give depth.
// ===========================================================

const STAR_LAYERS = [
  { count: 50, speed: 20,  minR: 0.3, maxR: 0.7,  minA: 0.2, maxA: 0.4 },  // far
  { count: 30, speed: 50,  minR: 0.7, maxR: 1.2,  minA: 0.4, maxA: 0.7 },  // mid
  { count: 15, speed: 100, minR: 1.2, maxR: 2.0,  minA: 0.7, maxA: 1.0 },  // near
];

let stars = [];  // array of { x, y, r, a, speed }

function initStarfield() {
  stars = [];
  for (const layer of STAR_LAYERS) {
    for (let i = 0; i < layer.count; i++) {
      stars.push(makestar(layer));
    }
  }
}

function makestar(layer, startY = null) {
  return {
    x:     Math.random() * GAME_WIDTH,
    y:     startY !== null ? startY : Math.random() * GAME_HEIGHT,
    r:     Math.random() * (layer.maxR - layer.minR) + layer.minR,
    a:     Math.random() * (layer.maxA - layer.minA) + layer.minA,
    speed: layer.speed,
    layer,
  };
}

function scrollStarfield(dt) {
  for (const star of stars) {
    star.y += star.speed * dt;
    if (star.y > GAME_HEIGHT + star.r) {
      // Recycle at top
      star.x = Math.random() * GAME_WIDTH;
      star.y = -star.r;
    }
  }
}

function drawStarfield() {
  for (const star of stars) {
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(200, 220, 255, ${star.a})`;
    ctx.fill();
  }
}

// ===========================================================
//  DEBUG OVERLAY — FPS counter (top-right corner)
// ===========================================================

function drawFps() {
  ctx.save();
  ctx.font      = '11px monospace';
  ctx.fillStyle = 'rgba(150, 200, 255, 0.5)';
  ctx.textAlign = 'right';
  ctx.fillText(`${Math.round(smoothedFps)} FPS`, GAME_WIDTH - 6, 14);
  ctx.restore();
}

// ---------- Pause overlay ----------
function drawPauseOverlay() {
  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);

  ctx.font      = 'bold 32px monospace';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.fillText('PAUSED', GAME_WIDTH / 2, GAME_HEIGHT / 2 - 10);

  ctx.font      = '14px monospace';
  ctx.fillStyle = 'rgba(200, 220, 255, 0.7)';
  ctx.fillText('press P to resume', GAME_WIDTH / 2, GAME_HEIGHT / 2 + 20);
  ctx.restore();
}

// ===========================================================
//  INPUT
// ===========================================================

document.addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'P') {
    if (state.screen === 'game') togglePause();
  }
  // Arrow / WASD input for ship movement added in TES-23 (input handling)
});

// ===========================================================
//  BOOTSTRAP
// ===========================================================

resizeCanvas();
initStarfield();
showMenu();  // calls startBackgroundLoop internally
