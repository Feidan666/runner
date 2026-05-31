const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const scoreEl = document.getElementById("score");
const bestScoreEl = document.getElementById("bestScore");
const statusTextEl = document.getElementById("statusText");
const volumeFillEl = document.getElementById("volumeFill");
const volumePercentEl = document.getElementById("volumePercent");
const overlayEl = document.getElementById("overlay");
const overlayTitleEl = document.getElementById("overlayTitle");
const overlayMessageEl = document.getElementById("overlayMessage");
const startButton = document.getElementById("startButton");
const restartButton = document.getElementById("restartButton");

const W = canvas.width;
const H = canvas.height;
const GROUND_Y = 555;
const PLAYER_X = 230;
const PLAYER_W = 52;
const PLAYER_H = 78;
const GRAVITY = 2200;
const START_SPEED = 330;
const MAX_SPEED = 620;
const VOLUME_THRESHOLD = 0.08;
const VOLUME_CAP = 0.45;
const MIN_JUMP = 760;
const MAX_JUMP = 1180;
const VOICE_REARM_VOLUME = VOLUME_THRESHOLD * 0.9;

let audioContext;
let analyser;
let audioData;
let micStream;
let volume = 0;
let smoothedVolume = 0;
let peakWindow = 0;

let bestScore = Number(localStorage.getItem("voiceRunnerBest") || 0);
let state = "ready";
let lastTime = 0;
let score = 0;
let distance = 0;
let speed = START_SPEED;
let spawnTimer = 0;
let failReason = "";
let shoutArmed = true;
let spaceHeld = false;
let sceneryOffset = 0;

const player = {
  x: PLAYER_X,
  y: GROUND_Y - PLAYER_H,
  w: PLAYER_W,
  h: PLAYER_H,
  vy: 0,
  grounded: true,
  runPhase: 0,
};

let obstacles = [];
let pits = [];
let clouds = [];
let groundMarks = [];

bestScoreEl.textContent = bestScore;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function resetGame() {
  state = "running";
  lastTime = performance.now();
  score = 0;
  distance = 0;
  speed = START_SPEED;
  spawnTimer = 1.1;
  failReason = "";
  shoutArmed = true;
  spaceHeld = false;
  sceneryOffset = 0;
  peakWindow = 0;
  obstacles = [];
  pits = [];
  clouds = [
    { x: 130, y: 92, s: 0.8 },
    { x: 520, y: 130, s: 1.1 },
    { x: 940, y: 78, s: 0.9 },
  ];
  groundMarks = Array.from({ length: 18 }, (_, i) => ({
    x: i * 92,
    w: 34 + Math.random() * 36,
  }));

  player.y = GROUND_Y - PLAYER_H;
  player.vy = 0;
  player.grounded = true;
  player.runPhase = 0;

  scoreEl.textContent = "0";
  statusTextEl.textContent = "奔跑中";
  hideOverlay();
}

async function ensureMicrophone() {
  if (analyser) return true;

  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.18;
    audioData = new Uint8Array(analyser.fftSize);
    source.connect(analyser);
    return true;
  } catch (error) {
    showOverlay("无法开始", "需要开启麦克风才能游玩。你也可以刷新页面后重新授权。", false);
    statusTextEl.textContent = "麦克风未开启";
    return false;
  }
}

function readVolume() {
  if (!analyser) {
    updateVolumeUi(0);
    return 0;
  }

  analyser.getByteTimeDomainData(audioData);
  let sum = 0;
  for (let i = 0; i < audioData.length; i += 1) {
    const centered = (audioData[i] - 128) / 128;
    sum += centered * centered;
  }

  volume = Math.sqrt(sum / audioData.length);
  smoothedVolume = lerp(smoothedVolume, volume, volume > smoothedVolume ? 0.35 : 0.12);
  peakWindow = Math.max(peakWindow * 0.88, volume);
  updateVolumeUi(smoothedVolume);
  return volume;
}

function updateVolumeUi(value) {
  const visual = clamp(value / VOLUME_CAP, 0, 1);
  volumeFillEl.style.width = `${Math.round(visual * 100)}%`;
  volumePercentEl.textContent = `${Math.round(visual * 100)}%`;
}

function volumeToJumpPower(value) {
  const t = clamp((value - VOLUME_THRESHOLD) / (VOLUME_CAP - VOLUME_THRESHOLD), 0, 1);
  return lerp(MIN_JUMP, MAX_JUMP, Math.pow(t, 0.72));
}

function jump(power) {
  if (state !== "running" || !player.grounded) return;

  player.vy = -power;
  player.grounded = false;

  statusTextEl.textContent = power > 1040 ? "高跳" : power > 880 ? "普通跳" : "小跳";
}

function updateAirControl(currentVolume) {
  if (currentVolume < VOICE_REARM_VOLUME) {
    shoutArmed = true;
  }

  if (player.grounded) {
    if (shoutArmed && currentVolume > VOLUME_THRESHOLD) {
      const jumpPower = volumeToJumpPower(Math.max(currentVolume, peakWindow));
      shoutArmed = false;
      jump(jumpPower);
    }
    return false;
  }

  const wantsHover = currentVolume > VOLUME_THRESHOLD || spaceHeld;
  // 到顶点后只要持续发声就一直悬停，无时间上限（人声本身有限，停声即落）；上升阶段保持正常重力
  if (!wantsHover || player.vy < 0) return false;

  statusTextEl.textContent = "悬停中";
  return true;
}

function spawnSegment() {
  const gap = 500 + Math.random() * 340 + (speed - START_SPEED) * 0.25;
  const x = W + gap;
  const roll = Math.random();

  if (roll < 0.45) {
    const width = 118 + Math.random() * 80;
    pits.push({ x, y: GROUND_Y, w: width, h: H - GROUND_Y });
    spawnTimer = (width + 470 + Math.random() * 210) / speed;
    return;
  }

  const isTall = roll > 0.78;
  const w = isTall ? 54 : 46 + Math.random() * 24;
  const h = isTall ? 92 : 54 + Math.random() * 32;
  obstacles.push({
    x,
    y: GROUND_Y - h,
    w,
    h,
    color: isTall ? "#ff5a69" : "#5d5fef",
  });
  spawnTimer = (w + 430 + Math.random() * 260) / speed;
}

function updateGame(dt) {
  const currentVolume = readVolume();
  const hovering = updateAirControl(currentVolume);

  speed = Math.min(MAX_SPEED, speed + dt * 7.8);
  distance += speed * dt;
  score = Math.floor(distance / 10);
  scoreEl.textContent = String(score);

  sceneryOffset = (sceneryOffset + speed * dt) % 96;
  player.runPhase += dt * (9 + speed / 90);

  if (hovering) {
    // 悬停：声音持续时停在最高点，垂直方向完全静止，松口才开始下落
    player.vy = 0;
  } else {
    player.vy += GRAVITY * dt;
  }
  player.y += player.vy * dt;

  if (player.y + player.h >= GROUND_Y) {
    player.y = GROUND_Y - player.h;
    player.vy = 0;
    if (!player.grounded) {
      statusTextEl.textContent = "奔跑中";
    }
    player.grounded = true;
  }

  spawnTimer -= dt;
  if (spawnTimer <= 0) spawnSegment();

  for (const obstacle of obstacles) obstacle.x -= speed * dt;
  for (const pit of pits) pit.x -= speed * dt;
  for (const cloud of clouds) {
    cloud.x -= speed * dt * 0.13 * cloud.s;
    if (cloud.x < -150) {
      cloud.x = W + 80 + Math.random() * 360;
      cloud.y = 70 + Math.random() * 90;
    }
  }
  for (const mark of groundMarks) {
    mark.x -= speed * dt;
    if (mark.x < -120) {
      mark.x += 18 * 92;
      mark.w = 34 + Math.random() * 36;
    }
  }

  obstacles = obstacles.filter((obstacle) => obstacle.x + obstacle.w > -80);
  pits = pits.filter((pit) => pit.x + pit.w > -80);

  checkCollisions();
}

function checkCollisions() {
  const playerBox = {
    x: player.x + 8,
    y: player.y + 8,
    w: player.w - 16,
    h: player.h - 8,
  };

  for (const obstacle of obstacles) {
    if (rectsOverlap(playerBox, obstacle)) {
      endGame("撞到障碍物");
      return;
    }
  }

  const footX = player.x + player.w * 0.5;
  const footY = player.y + player.h;
  for (const pit of pits) {
    if (footX > pit.x + 12 && footX < pit.x + pit.w - 12 && footY >= GROUND_Y - 2) {
      endGame("掉进坑里");
      return;
    }
  }
}

function endGame(reason) {
  if (state !== "running") return;

  state = "gameover";
  failReason = reason;
  statusTextEl.textContent = "游戏结束";

  if (score > bestScore) {
    bestScore = score;
    localStorage.setItem("voiceRunnerBest", String(bestScore));
    bestScoreEl.textContent = String(bestScore);
  }

  showOverlay("游戏结束", `${reason}。本局分数 ${score}，喊准时机再来一次。`, true);
}

function drawSky() {
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, "#72d8ff");
  sky.addColorStop(1, "#d9f8ff");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, GROUND_Y);

  ctx.fillStyle = "rgba(255, 255, 255, 0.86)";
  for (const cloud of clouds) drawCloud(cloud.x, cloud.y, cloud.s);

  ctx.fillStyle = "#7ab16b";
  drawHills(0.18, 430, 82);
  ctx.fillStyle = "#4f995f";
  drawHills(0.32, 475, 72);
}

function drawCloud(x, y, s) {
  ctx.beginPath();
  ctx.arc(x, y, 28 * s, Math.PI * 0.5, Math.PI * 1.6);
  ctx.arc(x + 30 * s, y - 22 * s, 32 * s, Math.PI, Math.PI * 1.9);
  ctx.arc(x + 68 * s, y, 30 * s, Math.PI * 1.2, Math.PI * 2.2);
  ctx.rect(x, y - 8 * s, 88 * s, 32 * s);
  ctx.fill();
}

function drawHills(rate, baseY, height) {
  const offset = (distance * rate) % 420;
  ctx.beginPath();
  ctx.moveTo(-offset - 100, GROUND_Y);
  for (let x = -offset - 100; x < W + 520; x += 210) {
    ctx.quadraticCurveTo(x + 105, baseY - height, x + 210, GROUND_Y);
  }
  ctx.lineTo(W, GROUND_Y);
  ctx.closePath();
  ctx.fill();
}

function drawGround() {
  ctx.fillStyle = "#243044";
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);

  ctx.fillStyle = "#30c77c";
  ctx.fillRect(0, GROUND_Y - 20, W, 24);

  ctx.fillStyle = "#1f8f58";
  for (let x = -sceneryOffset; x < W + 96; x += 96) {
    ctx.fillRect(x, GROUND_Y - 7, 44, 7);
  }

  ctx.fillStyle = "#394761";
  for (const mark of groundMarks) {
    ctx.fillRect(mark.x, GROUND_Y + 58, mark.w, 8);
  }
}

function drawPits() {
  for (const pit of pits) {
    ctx.fillStyle = "#10141c";
    ctx.fillRect(pit.x, pit.y - 20, pit.w, H - pit.y + 20);

    ctx.fillStyle = "#162033";
    ctx.fillRect(pit.x + 10, pit.y + 30, pit.w - 20, H - pit.y);

    ctx.fillStyle = "#ffcf56";
    ctx.fillRect(pit.x - 8, pit.y - 22, 8, 26);
    ctx.fillRect(pit.x + pit.w, pit.y - 22, 8, 26);
  }
}

function drawObstacles() {
  for (const obstacle of obstacles) {
    ctx.fillStyle = obstacle.color;
    ctx.fillRect(obstacle.x, obstacle.y, obstacle.w, obstacle.h);
    ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
    ctx.fillRect(obstacle.x + 8, obstacle.y + 10, obstacle.w - 16, 8);
    ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
    ctx.fillRect(obstacle.x, obstacle.y + obstacle.h - 10, obstacle.w, 10);
  }
}

function drawPlayer() {
  const bob = player.grounded ? Math.sin(player.runPhase) * 3 : 0;
  const x = player.x;
  const y = player.y + bob;
  const legSwing = Math.sin(player.runPhase) * 11;

  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
  ctx.beginPath();
  ctx.ellipse(player.w / 2, player.h + 8 - bob, 34, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#ffcf56";
  ctx.fillRect(12, 26, 31, 36);
  ctx.fillStyle = "#10141c";
  ctx.fillRect(16, 31, 23, 6);

  ctx.fillStyle = "#ffe3a1";
  ctx.fillRect(13, 0, 28, 26);
  ctx.fillStyle = "#10141c";
  ctx.fillRect(21, 10, 5, 5);
  ctx.fillRect(34, 10, 5, 5);

  ctx.strokeStyle = "#25d4a7";
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(16, 40);
  ctx.lineTo(4, 51 + legSwing * 0.2);
  ctx.moveTo(40, 40);
  ctx.lineTo(52, 50 - legSwing * 0.2);
  ctx.stroke();

  ctx.strokeStyle = "#2b3447";
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(20, 61);
  ctx.lineTo(12 + legSwing, 78);
  ctx.moveTo(36, 61);
  ctx.lineTo(44 - legSwing, 78);
  ctx.stroke();

  ctx.restore();
}

function drawHudHints() {
  if (state !== "running") return;

  ctx.fillStyle = "rgba(16, 20, 28, 0.72)";
  ctx.fillRect(26, 26, 310, 52);
  ctx.fillStyle = "#f4f7fb";
  ctx.font = "700 22px system-ui, sans-serif";
  ctx.fillText("看到坑或障碍就喊一声", 44, 58);

  ctx.fillStyle = "#10141c";
  ctx.fillRect(W - 236, 26, 210, 52);
  ctx.fillStyle = "#ffcf56";
  ctx.font = "800 18px system-ui, sans-serif";
  ctx.fillText(`速度 ${Math.round(speed)}`, W - 212, 58);
}

function drawGameOverFreeze() {
  if (state !== "gameover") return;

  ctx.fillStyle = "rgba(255, 90, 105, 0.2)";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "rgba(16, 20, 28, 0.75)";
  ctx.fillRect(W / 2 - 210, 92, 420, 62);
  ctx.fillStyle = "#fff";
  ctx.font = "800 27px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(failReason, W / 2, 132);
  ctx.textAlign = "left";
}

function render() {
  ctx.clearRect(0, 0, W, H);
  drawSky();
  drawGround();
  drawPits();
  drawObstacles();
  drawPlayer();
  drawHudHints();
  drawGameOverFreeze();
}

function loop(now) {
  const dt = Math.min((now - lastTime) / 1000 || 0, 0.033);
  lastTime = now;

  if (state === "running") {
    updateGame(dt);
  } else {
    readVolume();
  }

  render();
  requestAnimationFrame(loop);
}

function showOverlay(title, message, gameOver) {
  overlayTitleEl.textContent = title;
  overlayMessageEl.textContent = message;
  overlayEl.classList.remove("hidden");
  startButton.classList.toggle("hidden", gameOver);
  restartButton.classList.toggle("hidden", !gameOver);
}

function hideOverlay() {
  overlayEl.classList.add("hidden");
}

async function startGame() {
  const ok = await ensureMicrophone();
  if (!ok) return;

  if (audioContext && audioContext.state === "suspended") {
    await audioContext.resume();
  }

  resetGame();
}

startButton.addEventListener("click", startGame);
restartButton.addEventListener("click", startGame);

window.addEventListener("keydown", (event) => {
  if (event.code !== "Space") return;
  event.preventDefault();
  spaceHeld = true;

  if (state === "running" && !event.repeat) {
    jump(930);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code !== "Space") return;
  event.preventDefault();
  spaceHeld = false;
});

window.addEventListener("beforeunload", () => {
  if (micStream) {
    for (const track of micStream.getTracks()) track.stop();
  }
});

render();
requestAnimationFrame((now) => {
  lastTime = now;
  requestAnimationFrame(loop);
});
