// Караоке-фортуна: лента обложек -> караоке -> снова лента.
// Список песен лежит в tracks/tracks.json.

const $ = (id) => document.getElementById(id);

const audio = $('audio');
const reelBox = $('reel');
const strip = $('strip');
const linesCanvas = $('lines');
const spinBtn = $('spin');

const COLORS = ['#7b2ff7', '#f72585', '#ff7a00', '#06a77d', '#2d7dd2', '#d7263d', '#8f2d56', '#218380'];
const SPIN_MS = 9000;   // сколько крутится лента
const SPIN_ITEMS = 30;  // сколько обложек пролетает за вращение
const OVERSHOOT = 0.13;  // на какую долю обложки выпавшая медленно сползает ниже центра
const SNAP_BACK = 0.09;  // на сколько она подскакивает выше центра при рывке обратно
const LINES_COUNT = 34;   // сколько полосок скорости на экране одновременно
const IDLE_SPEED = 0.22; // медленная прокрутка на стартовом экране, обложек в секунду
const COUNTDOWN_S = 5;  // отсчёт перед началом песни, секунды

let tracks = [];
let reel = [];   // номера треков в ленте, сверху вниз
let pos = 2;     // какая позиция ленты сейчас в центре (дробная во время вращения)
let size = { s: 0, step: 0, vh: 0, gap: 0 };
let lastIndex = -1;
let state = 'wheel'; // wheel | spinning | result | karaoke
let lines = [];
let activeLine = -2;
let rafId = 0;
let wakeLock = null;
let audioCtx = null;
let countdownTimer = 0;
let counting = false;
let idleRaf = 0;
let chosen = null; // выпавшая песня, ждёт кнопки «петь»: { track, index, lyricsPromise }

const tg = () => (window.Telegram && window.Telegram.WebApp) || null;

function haptic(kind) {
  try {
    const t = tg();
    const h = t && t.HapticFeedback;
    // вне Telegram и в старых клиентах вибрации нет — молча пропускаем
    if (!h || (t.isVersionAtLeast && !t.isVersionAtLeast('6.1'))) return;
    if (kind === 'success') h.notificationOccurred('success');
    else h.impactOccurred(kind);
  } catch (e) { /* не в Telegram */ }
}

function initTelegram() {
  const t = tg();
  if (!t) {
    // Скрипт Telegram ещё не загрузился: сообщаем приложению напрямую,
    // что страница готова, иначе оно держит белую заглушку.
    try {
      if (window.TelegramWebviewProxy) {
        window.TelegramWebviewProxy.postEvent('web_app_ready', '');
        window.TelegramWebviewProxy.postEvent('web_app_expand', '');
      }
    } catch (e) { /* не в Telegram */ }
    return;
  }
  try {
    t.ready();
    t.expand();
    if (t.disableVerticalSwipes) t.disableVerticalSwipes();
    if (t.setHeaderColor) t.setHeaderColor('#12101c');
    if (t.setBackgroundColor) t.setBackgroundColor('#12101c');
  } catch (e) { /* старая версия клиента */ }
}

// ---------- Лента обложек ----------

function colorFor(i) {
  return COLORS[i % COLORS.length];
}

function fallbackCover(i) {
  const t = tracks[i];
  const box = document.createElement('div');
  box.className = 'cover-fallback';
  box.style.background = `linear-gradient(150deg, ${colorFor(i)}, #1d1930)`;
  const note = document.createElement('div');
  note.className = 'cover-note';
  note.textContent = '♪';
  const text = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'cover-title';
  title.textContent = t.title;
  const artist = document.createElement('div');
  artist.className = 'cover-artist';
  artist.textContent = t.artist || '';
  text.append(title, artist);
  box.append(note, text);
  return box;
}

// Обложка трека; если картинки нет или она не загрузилась — цветная плитка с названием.
function coverEl(i) {
  const t = tracks[i];
  const el = document.createElement('div');
  el.className = 'cover';
  if (t.cover && !t.coverBroken) {
    const img = document.createElement('img');
    img.alt = t.title;
    img.draggable = false;
    img.onerror = () => { t.coverBroken = true; img.replaceWith(fallbackCover(i)); };
    img.src = t.cover;
    el.appendChild(img);
  } else {
    el.appendChild(fallbackCover(i));
  }
  return el;
}

function randomOther(prev) {
  const n = tracks.length;
  if (n === 1) return 0;
  let i;
  do { i = Math.floor(Math.random() * n); } while (i === prev);
  return i;
}

function measure() {
  const first = strip.firstElementChild;
  if (!first) return;
  // дробная высота: округлённая копила бы ошибку на длинной ленте
  const s = parseFloat(getComputedStyle(first).height) || first.offsetHeight;
  const gap = parseFloat(getComputedStyle(first).marginBottom) || 0;
  size = { s, step: s + gap, vh: reelBox.clientHeight, gap };
}

function place() {
  // Лента прижата к низу и растёт вверх: первая обложка внизу, следующие над ней.
  // Чем больше pos, тем ниже съезжает лента — обложки едут сверху вниз.
  strip.style.transform = `translateY(${-size.vh / 2 + size.gap + size.s / 2 + pos * size.step}px)`;
}

function renderReel() {
  strip.innerHTML = '';
  for (const i of reel) strip.appendChild(coverEl(i));
  measure();
  place();
}

// Пока кнопка не нажата, лента медленно и плавно листает обложки.
function startIdle() {
  cancelAnimationFrame(idleRaf);
  let last = performance.now();
  const step = (now) => {
    if (state !== 'wheel') return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    pos += IDLE_SPEED * dt;

    // сверху всегда должны быть готовые обложки
    while (reel.length < pos + 4) {
      const next = randomOther(reel[reel.length - 1]);
      reel.push(next);
      strip.appendChild(coverEl(next));
    }
    // уехавшие вниз убираем, чтобы лента не росла бесконечно
    if (pos >= 5) {
      reel.splice(0, 2);
      strip.firstElementChild.remove();
      strip.firstElementChild.remove();
      pos -= 2;
    }
    place();
    idleRaf = requestAnimationFrame(step);
  };
  idleRaf = requestAnimationFrame(step);
}

function stopIdle() {
  cancelAnimationFrame(idleRaf);
}

function initReel() {
  reel = [];
  let prev = -1;
  for (let k = 0; k < 5; k++) { prev = randomOther(prev); reel.push(prev); }
  pos = 2;
  renderReel();
}

// Полоски скорости: тонкие светлые клинья от краёв экрана к центру.
// Каждый вызов рисует новый случайный набор — при частой перерисовке они «мерцают».
function drawLines() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = linesCanvas.clientWidth;
  const h = linesCanvas.clientHeight;
  if (linesCanvas.width !== Math.round(w * dpr) || linesCanvas.height !== Math.round(h * dpr)) {
    linesCanvas.width = Math.round(w * dpr);
    linesCanvas.height = Math.round(h * dpr);
  }
  const ctx = linesCanvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;

  for (let i = 0; i < LINES_COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    // расстояние от центра до края экрана в этом направлении
    const edge = Math.min(Math.abs(cx / (dx || 1e-6)), Math.abs(cy / (dy || 1e-6)));
    const outer = edge * 1.08;
    const inner = edge * (0.5 + Math.random() * 0.32); // острый конец, не доходит до центра
    const half = 1.5 + Math.random() * 5.5;            // полуширина у края
    const px = -dy;
    const py = dx;
    ctx.beginPath();
    ctx.moveTo(cx + dx * inner, cy + dy * inner);
    ctx.lineTo(cx + dx * outer + px * half, cy + dy * outer + py * half);
    ctx.lineTo(cx + dx * outer - px * half, cy + dy * outer - py * half);
    ctx.closePath();
    ctx.fillStyle = `rgba(255,255,255,${(0.1 + Math.random() * 0.22).toFixed(2)})`;
    ctx.fill();
  }
}

function tickSound() {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'triangle';
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.1, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    o.connect(g);
    g.connect(audioCtx.destination);
    o.start(t);
    o.stop(t + 0.07);
  } catch (e) { /* без звука */ }
}

function onTick(trackIndex) {
  reelBox.classList.remove('tick');
  void reelBox.offsetWidth; // перезапуск анимации
  reelBox.classList.add('tick');
  tickSound();
  haptic('light');
}

// Выпасть может только песня, у которой есть аудио.
// Записи без аудио показываются на ленте, но не выигрывают.
function pickIndex() {
  const playable = [];
  tracks.forEach((t, i) => { if (t.audio) playable.push(i); });
  if (!playable.length) return -1;
  if (playable.length === 1) return playable[0];
  let i;
  do { i = playable[Math.floor(Math.random() * playable.length)]; } while (i === lastIndex);
  return i;
}

function spin() {
  // крутить можно и со стартового экрана, и повторно — если выпавшая песня не понравилась
  if ((state !== 'wheel' && state !== 'result') || !tracks.some((t) => t.audio)) return;
  state = 'spinning';
  chosen = null;
  spinBtn.disabled = true;
  spinBtn.textContent = 'Вращаем…';
  $('sing').classList.remove('show');
  $('result').classList.remove('show');
  reelBox.classList.remove('done');
  haptic('medium');

  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx && AC) audioCtx = new AC();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* без щелчков */ }

  const index = pickIndex();
  if (index < 0) return;
  lastIndex = index;
  const track = tracks[index];

  const lyricsPromise = loadLyrics(track);

  // Собираем новую ленту: 5 видимых сейчас обложек, затем случайные,
  // затем выпавшая песня и ещё две после неё.
  // (лента могла остановиться между обложками — продолжаем с того же места)
  stopIdle();
  const base = Math.floor(pos);
  const frac = pos - base;
  const seq = reel.slice(base - 2, base + 4);
  let prev = seq[seq.length - 1];
  while (seq.length < 2 + SPIN_ITEMS) { prev = randomOther(prev); seq.push(prev); }
  if (tracks.length > 1 && seq[seq.length - 1] === index) seq.pop();
  seq.push(index);
  const target = seq.length - 1;
  const after = randomOther(index);
  seq.push(after, randomOther(after));
  reel = seq;
  pos = 2 + frac;
  renderReel();

  // Концовка как в примере с записи экрана:
  // 1) лента долго замедляется, выпавшая обложка медленно сползает чуть ниже центра;
  // 2) резкий рывок вверх — обложка подскакивает немного выше центра;
  // 3) мягко опускается и встаёт точно по центру.
  const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
  const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
  const phases = [
    { to: target + OVERSHOOT, ms: SPIN_MS, ease: (p) => 1 - Math.pow(1 - p, 4) },
    { to: target - SNAP_BACK, ms: 220, delay: 80, ease: easeOutCubic },
    { to: target, ms: 380, ease: easeInOut },
  ];

  let ph = 0;
  let phFrom = pos;
  let t0 = performance.now();
  let lastSlot = Math.round(pos);
  let prevPos = pos;
  let prevNow = t0;
  let linesAt = 0;

  function frame(now) {
    const cur = phases[ph];
    const p = Math.max(0, Math.min(1, (now - t0) / cur.ms));
    pos = phFrom + (cur.to - phFrom) * cur.ease(p);
    place();

    // полоски скорости: чем быстрее лента, тем ярче; к остановке гаснут
    const dt = Math.max(1, now - prevNow) / 1000;
    const speed = Math.abs(pos - prevPos) / dt; // обложек в секунду
    prevPos = pos;
    prevNow = now;
    if (ph === 0) {
      if (now - linesAt > 70) { drawLines(); linesAt = now; }
      linesCanvas.style.opacity = Math.min(1, speed / 4).toFixed(2);
    } else {
      linesCanvas.style.opacity = '0';
    }

    const slot = Math.round(pos);
    if (slot !== lastSlot) {
      lastSlot = slot;
      onTick(reel[slot]);
    }

    if (p < 1) {
      requestAnimationFrame(frame);
      return;
    }
    phFrom = cur.to;
    ph += 1;
    if (ph < phases.length) {
      t0 = now + (phases[ph].delay || 0);
      requestAnimationFrame(frame);
    } else {
      pos = target;
      place();
      showResult(track, index, lyricsPromise);
    }
  }
  requestAnimationFrame(frame);
}

function showResult(track, index, lyricsPromise) {
  state = 'result';
  linesCanvas.style.opacity = '0';
  haptic('success');
  reelBox.classList.add('done');
  if (strip.children[pos]) strip.children[pos].classList.add('win');
  $('result-title').textContent = track.title;
  $('result-artist').textContent = track.artist || '';
  $('result').classList.add('show');

  // Караоке само не стартует: ждём кнопку «петь» или повторное вращение.
  chosen = { track, index, lyricsPromise };
  $('sing').classList.add('show');
  spinBtn.disabled = false;
  spinBtn.textContent = 'Вращать';
}

async function sing() {
  if (state !== 'result' || !chosen) return;
  const { track, index, lyricsPromise } = chosen;
  chosen = null;
  // Готовим звук прямо в обработчике нажатия: иначе телефон
  // не даст запустить музыку после отсчёта.
  primeAudio(track);
  state = 'starting';
  const parsed = await lyricsPromise;
  startKaraoke(track, index, parsed);
}

// ---------- Звук и текст ----------

function primeAudio(track) {
  audio.src = track.audio;
  audio.muted = true;
  const p = audio.play();
  if (p && p.then) {
    p.then(() => {
      // до конца отсчёта звук должен молчать
      if (state !== 'karaoke' || counting) {
        audio.pause();
        audio.currentTime = 0;
      }
    }).catch(() => {});
  }
}

async function loadLyrics(track) {
  // в версии «архивом» текст уже встроен в data.js
  if (typeof track.lrcText === 'string') return parseLrc(track.lrcText);
  if (!track.lrc) return [];
  try {
    const res = await fetch(track.lrc, { cache: 'no-store' });
    if (!res.ok) return [];
    return parseLrc(await res.text());
  } catch (e) {
    return [];
  }
}

// Формат LRC: [мм:сс.сс]строка текста
function parseLrc(text) {
  const out = [];
  const stamp = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
  for (const raw of text.split(/\r?\n/)) {
    const times = [];
    let m;
    let last = 0;
    stamp.lastIndex = 0;
    while ((m = stamp.exec(raw)) !== null) {
      times.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
      last = stamp.lastIndex;
    }
    if (!times.length) continue;
    const words = raw.slice(last).replace(/<\d{1,3}:\d{1,2}(?:\.\d{1,3})?>/g, '').trim();
    for (const t of times) out.push({ time: t, text: words || '♪' });
  }
  return out.sort((a, b) => a.time - b.time);
}

// ---------- Караоке ----------

function fmt(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function startKaraoke(track, index, parsed) {
  state = 'karaoke';
  lines = parsed;
  activeLine = -2;

  document.documentElement.style.setProperty('--track', colorFor(index));
  const kc = $('k-cover');
  kc.textContent = '';
  if (track.cover && !track.coverBroken) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = track.cover;
    kc.appendChild(img);
  } else {
    kc.textContent = '♪';
  }
  $('k-title').textContent = track.title;
  $('k-artist').textContent = track.artist || '';
  $('t-cur').textContent = '0:00';
  $('t-dur').textContent = '0:00';
  $('bar-fill').style.width = '0%';

  const inner = $('lyrics-inner');
  inner.innerHTML = '';
  inner.style.transform = 'translateY(0)';
  if (!lines.length) {
    const el = document.createElement('div');
    el.className = 'line active';
    el.textContent = 'Текста нет — пой по памяти 🎤';
    inner.appendChild(el);
  } else {
    lines.forEach((ln, i) => {
      const el = document.createElement('div');
      el.className = 'line';
      el.textContent = ln.text;
      el.addEventListener('click', () => { audio.currentTime = lines[i].time; });
      inner.appendChild(el);
    });
  }

  $('wheel-screen').classList.remove('active');
  $('karaoke-screen').classList.add('active');
  startCountdown();
  requestWakeLock();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

// Отсчёт 5…1, чтобы успеть приготовиться; музыка стартует после него.
function startCountdown() {
  const box = $('countdown');
  const num = $('countdown-num');
  let left = COUNTDOWN_S;
  clearTimeout(countdownTimer);
  counting = true;
  box.classList.add('show');

  const step = () => {
    if (state !== 'karaoke') return;
    if (left <= 0) {
      counting = false;
      box.classList.remove('show');
      play();
      return;
    }
    num.textContent = left;
    num.classList.remove('pop');
    void num.offsetWidth; // перезапуск анимации
    num.classList.add('pop');
    tickSound();
    haptic('light');
    left -= 1;
    countdownTimer = setTimeout(step, 1000);
  };
  step();
}

function play() {
  audio.muted = false;
  try { audio.currentTime = 0; } catch (e) { /* ещё не загрузилось */ }
  const p = audio.play();
  // если телефон не дал запустить звук сам — кнопка останется в виде «плей»
  if (p && p.catch) p.catch(() => updateToggle());
}

// Кнопка пауза/плей
function togglePlay() {
  if (state !== 'karaoke' || counting) return;
  if (audio.paused) {
    audio.muted = false;
    const p = audio.play();
    if (p && p.catch) p.catch(() => updateToggle());
  } else {
    audio.pause();
  }
}

function updateToggle() {
  const btn = $('toggle');
  const paused = audio.paused || audio.muted;
  btn.classList.toggle('paused', paused);
  btn.setAttribute('aria-label', paused ? 'Продолжить' : 'Пауза');
}

function tick() {
  if (state !== 'karaoke') return;
  const t = audio.currentTime || 0;
  const d = audio.duration;

  $('t-cur').textContent = fmt(t);
  if (isFinite(d) && d > 0) {
    $('t-dur').textContent = fmt(d);
    $('bar-fill').style.width = `${Math.min(100, (t / d) * 100)}%`;
  }

  if (lines.length) {
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= t + 0.15) idx = i; else break;
    }
    if (idx !== activeLine) setActiveLine(idx);
  }

  rafId = requestAnimationFrame(tick);
}

function setActiveLine(idx) {
  activeLine = idx;
  const inner = $('lyrics-inner');
  const els = inner.children;
  for (let i = 0; i < els.length; i++) {
    els[i].classList.toggle('active', i === idx);
    els[i].classList.toggle('past', i < idx);
  }
  const target = els[Math.max(idx, 0)];
  if (!target) return;
  const first = els[0];
  const offset = idx < 0 ? 0 : target.offsetTop - first.offsetTop;
  inner.style.transform = `translateY(${-offset}px)`;
}

function backToWheel() {
  if (state !== 'karaoke') return;
  state = 'wheel';
  cancelAnimationFrame(rafId);
  clearTimeout(countdownTimer);
  counting = false;
  $('countdown').classList.remove('show');
  audio.pause();
  releaseWakeLock();

  $('karaoke-screen').classList.remove('active');
  $('wheel-screen').classList.add('active');
  $('result').classList.remove('show');
  $('sing').classList.remove('show');
  reelBox.classList.remove('done');
  reel = reel.slice(pos - 2, pos + 3);
  pos = 2;
  renderReel();
  startIdle();
  spinBtn.disabled = false;
  spinBtn.textContent = 'Вращать';
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* не поддерживается */ }
}

function releaseWakeLock() {
  try { if (wakeLock) wakeLock.release(); } catch (e) { /* уже отпущен */ }
  wakeLock = null;
}

// ---------- Запуск ----------

async function init() {
  initTelegram();
  window.addEventListener('load', initTelegram);

  spinBtn.addEventListener('click', spin);
  $('sing').addEventListener('click', sing);
  $('exit').addEventListener('click', backToWheel);
  $('toggle').addEventListener('click', togglePlay);
  audio.addEventListener('play', updateToggle);
  audio.addEventListener('pause', updateToggle);
  // К ленте возвращаемся только когда песня действительно доиграла.
  // Встроенный браузер Telegram может прислать «конец» или «ошибку» ещё
  // во время подготовки звука — такие события не должны сбрасывать экран.
  audio.addEventListener('ended', () => {
    if (state !== 'karaoke' || counting) return;
    const d = audio.duration;
    if (audio.currentTime < 5 || (isFinite(d) && audio.currentTime < d - 3)) return;
    backToWheel();
  });
  audio.addEventListener('error', () => {
    if (state !== 'karaoke' || counting) return;
    const code = audio.error ? audio.error.code : 0;
    $('lyrics-inner').innerHTML = '';
    const el = document.createElement('div');
    el.className = 'line active';
    el.textContent = `Не удалось загрузить трек (код ${code}). Нажми ✕ и выбери другую песню.`;
    $('lyrics-inner').appendChild(el);
    $('lyrics-inner').style.transform = 'translateY(0)';
  });

  // Версия «архивом» открывается двойным щелчком, без сервера: там список песен
  // и тексты лежат в data.js. На сервере читаем tracks/tracks.json.
  if (window.KARAOKE_DATA) {
    tracks = window.KARAOKE_DATA.tracks;
  } else {
    try {
      const res = await fetch('tracks/tracks.json', { cache: 'no-store' });
      tracks = await res.json();
    } catch (e) {
      tracks = [];
    }
  }

  if (!tracks.length) {
    spinBtn.disabled = true;
    return;
  }
  initReel();
  startIdle();
  window.addEventListener('resize', () => { measure(); place(); });
}

init();
