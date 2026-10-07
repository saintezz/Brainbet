/* Brain Slots presentation. The server owns every result and every balance change. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = {
    config: null, ready: false, symbols: new Map(), grid: null, result: null, pending: null,
    owner: 0, loading: null, loadFailed: false, requesting: false, animating: false, active: false,
    mounted: false, speed: 'normal', animations: [], lineTimer: 0, awardTimer: 0,
    counterFrame: 0, counterResolve: null, finishMotion: null, generation: 0,
    observer: null, resizeObserver: null, lineWins: [], selectedLine: -1,
    skipPresentation: false, pauseTimer: 0, pauseResolve: null, displayedFrame: null,
    bonusReels: [],
  };
  const storagePrefix = 'bb_brain_slots_pending_v1:';
  const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.hidden;
  const identity = () => typeof tg_id !== 'undefined' ? Number(tg_id) || 0 : 0;
  const apiBase = () => window.location.origin;
  const key = () => `${storagePrefix}${state.owner}`;
  const storage = () => {
    try { return window.localStorage; } catch (_) { return null; }
  };
  const status = (message, error = false) => {
    if (!$('bs-status')) return;
    $('bs-status').textContent = message;
    $('bs-status').classList.toggle('is-error', error);
  };
  const sound = name => {
    if (!state.active || document.hidden) return;
    try { if (typeof SND !== 'undefined') SND.playSlot(name); } catch (_) {}
  };
  const currentBet = () => Number($('bs-bet')?.value);
  const validBet = bet => Number.isSafeInteger(bet) && bet >= state.config.min_bet && bet <= state.config.max_bet;
  const bankAllowsBet = () => !Number.isFinite(Number(state.config?.max_available_bet)) || currentBet() <= Number(state.config.max_available_bet);

  function readPending() {
    try {
      const target = storage();
      if (!target) return null;
      const records = new Map();
      const keys = [key()];
      // Each request owns a separate journal entry: concurrent tabs cannot
      // overwrite one another's recovery ID, even without Web Locks support.
      for (let i = 0; i < target.length; i++) {
        const candidate = target.key(i);
        if (candidate?.startsWith(`${key()}:`)) keys.push(candidate);
      }
      for (const recordKey of keys) {
        const raw = target.getItem(recordKey);
        if (!raw) continue;
        const entry = JSON.parse(raw);
        if (!entry || entry.user_id !== state.owner || !Number.isSafeInteger(entry.bet) || !/^[0-9a-f-]{36}$/i.test(entry.request_id || '')) throw new Error('invalid_pending');
        records.set(entry.request_id, entry);
      }
      return [...records.values()].sort((a,b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0))[0] || null;
    } catch (_) { throw new Error('pending_unreadable'); }
  }

  function savePending(entry) {
    const target = storage();
    if (!target) throw new Error('storage_unavailable');
    const journalKey = `${key()}:${entry.request_id}`;
    target.setItem(journalKey, JSON.stringify(entry));
    if (target.getItem(journalKey) !== JSON.stringify(entry)) throw new Error('storage_unavailable');
    state.pending = entry;
    // Legacy pointer is convenient for inspection; recovery relies on the journal.
    try { target.setItem(key(), JSON.stringify(entry)); } catch (_) {}
  }

  function clearPending() {
    const old = state.pending;
    // Another tab's newer request is not ours to erase.
    try {
      const target = storage();
      const saved = JSON.parse(target?.getItem(key()) || 'null');
      if (saved?.request_id === old?.request_id) target?.removeItem(key());
      if (old?.request_id) target?.removeItem(`${key()}:${old.request_id}`);
    } catch (_) {}
    state.pending = null;
    try { state.pending = readPending(); } catch (_) {}
  }

  function newRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (!window.crypto?.getRandomValues) throw new Error('secure_context_required');
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      // Absolute same-origin URLs pass through the app's signed Telegram/CSRF wrapper.
      const response = await fetch(`${apiBase()}/api/brain-slots/${path}`, {
        cache: 'no-store', credentials: 'same-origin', ...init, signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      });
      let payload;
      try { payload = await response.json(); } catch (_) { throw new Error('invalid_response'); }
      if (!response.ok || payload.error) {
        const error = new Error(payload.error || 'request_failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    } finally { clearTimeout(timeout); }
  }

  function syncControls() {
    if (!$('bs-spin')) return;
    const locked = !state.ready || !state.config || state.requesting || state.animating || Boolean(state.pending);
    document.querySelectorAll('#screen-brain-slots [data-bs-lock]').forEach(el => { el.disabled = locked; });
    $('bs-spin').disabled = locked || !validBet(currentBet()) || !bankAllowsBet();
    $('bs-spin-label').textContent = state.requesting ? 'ПРОВЕРЯЕМ…' : state.animating ? 'ИДЁТ СЕРИЯ…' : 'КРУТИТЬ';
    $('bs-skip').hidden = !state.animating;
    $('bs-retry').hidden = !(state.pending || state.loadFailed) || state.requesting || state.animating;
    $('bs-retry').textContent = state.config && state.pending ? 'Проверить эту прокрутку' : 'Повторить загрузку';
    $('bs-retry').disabled = state.requesting;
    $('bs-window').setAttribute('aria-busy', String(state.requesting || state.animating));
    syncBet();
  }

  function syncBet() {
    const bet = currentBet();
    const valid = state.config && validBet(bet);
    $('bs-line-bet').textContent = valid ? `${number(bet / (state.config.line_bet_divisor || 10))} 🧠` : '—';
    $('bs-spin-bet').textContent = valid ? `${number(bet)} 🧠` : '—';
    document.querySelectorAll('[data-bs-bet]').forEach(button => button.classList.toggle('is-selected', Number(button.dataset.bsBet) === bet));
    if (!state.requesting && !state.animating && !state.pending) $('bs-spin').disabled = !state.ready || !valid || !bankAllowsBet();
  }

  function setBet(value) {
    if (!state.config || state.pending || state.requesting || state.animating) return;
    $('bs-bet').value = String(Math.min(state.config.max_bet, Math.max(state.config.min_bet, Math.round(value))));
    syncBet();
  }

  function imageMarkup(symbol, paytable = false) {
    if (!symbol) return '<span class="bs-symbol-fallback">🧠</span>';
    let url = '';
    try {
      const candidate = new URL(symbol.image || `/static/${encodeURIComponent(symbol.name)}.webp`, window.location.href);
      if (candidate.origin === window.location.origin && /^https?:$/.test(candidate.protocol)) url = candidate.href;
    } catch (_) {}
    return url
      ? `<img src="${escape(url)}" alt="${paytable ? escape(symbol.name) : ''}" width="100" height="100" loading="${paytable ? 'lazy' : 'eager'}" decoding="async" draggable="false" data-bs-fallback="${escape(symbol.emoji || '🧠')}">`
      : `<span class="bs-symbol-fallback">${escape(symbol.emoji || '🧠')}</span>`;
  }

  function symbolMarkup(id, row = -1, wild = null) {
    const symbol = state.symbols.get(id);
    const multiplier = wild ? Math.max(1, Math.min(99, Number(wild.multiplier) || 1)) : 1;
    return `<div class="bs-symbol${symbol?.wild ? ' is-wild' : ''}${symbol?.scatter ? ' is-scatter' : ''}${wild?.sticky ? ' is-sticky' : ''}" data-symbol="${escape(id)}" data-row="${row}">${imageMarkup(symbol)}${symbol?.wild || symbol?.scatter ? `<span class="bs-symbol-tag">${symbol.wild ? 'WILD' : 'BONUS'}${symbol.wild && multiplier > 1 ? ` ×${multiplier}` : ''}</span>` : ''}${wild?.sticky ? '<span class="bs-pin" aria-hidden="true">◆</span>' : ''}</div>`;
  }

  function safeCells(cells) {
    return (Array.isArray(cells) ? cells : []).filter(cell => Number.isInteger(cell.row) && cell.row >= 0 && cell.row < 3 && Number.isInteger(cell.reel) && cell.reel >= 0 && cell.reel < 5);
  }

  function drawSticky(cells = []) {
    const wildId = state.config.symbols.find(symbol => symbol.wild)?.id || 'wild';
    $('bs-sticky-layer').innerHTML = safeCells(cells).map(cell => `<div class="bs-sticky-cell" style="grid-column:${cell.reel + 1};grid-row:${cell.row + 1}" data-reel="${cell.reel}" data-row="${cell.row}">${symbolMarkup(wildId, cell.row, {...cell,sticky:true})}</div>`).join('');
  }

  function sizeReels() {
    if (!$('bs-window')) return;
    const height = $('bs-window').getBoundingClientRect().height;
    if (height > 0) $('bs-window').style.setProperty('--bs-row', `${height / 3}px`);
  }

  function drawGrid(grid, frame = null) {
    if (!Array.isArray(grid)) return;
    sizeReels();
    document.querySelectorAll('#bs-window .bs-reel').forEach((reel, column) => {
      const strip = reel.firstElementChild;
      strip.style.transform = 'translate3d(0,0,0)';
      strip.innerHTML = grid.map((row, index) => symbolMarkup(row[column], index, safeCells(frame?.wild_cells).find(cell => cell.reel === column && cell.row === index))).join('');
      reel.classList.remove('is-rolling');
    });
    state.grid = grid.map(row => row.slice());
    state.displayedFrame = frame;
    drawSticky(frame?.sticky_cells);
    $('bs-window').setAttribute('aria-label', grid.map((row, index) => `Ряд ${index + 1}: ${row.map(id => state.symbols.get(id)?.name || id).join(', ')}`).join('. '));
  }

  function validateResult(result, expectedId = '') {
    if (!result || (expectedId && result.request_id !== expectedId) || !Number.isFinite(result.payout) || result.payout < 0) throw new Error('invalid_response');
    if (!Array.isArray(result.grid) || result.grid.length !== 3 || result.grid.some(row => !Array.isArray(row) || row.length !== 5 || row.some(id => !state.symbols.has(id)))) throw new Error('invalid_response');
    if (result.frames != null) {
      if (!Array.isArray(result.frames) || !result.frames.length || result.frames.length > 28) throw new Error('invalid_response');
      for (const frame of result.frames) {
        if (!Number.isFinite(frame.payout) || frame.payout < 0 || !Array.isArray(frame.grid) || frame.grid.length !== 3 || frame.grid.some(row => !Array.isArray(row) || row.length !== 5 || row.some(id => !state.symbols.has(id)))) throw new Error('invalid_response');
      }
      if (result.frames.reduce((total,frame) => total + frame.payout,0) !== result.payout) throw new Error('invalid_response');
      if (result.frames.length > 1 && !result.bonus?.triggered) throw new Error('invalid_response');
      if (result.bonus?.triggered && (!Array.isArray(result.bonus.wheel_options) || !Number.isInteger(result.bonus.wheel_index) || result.bonus.wheel_index < 0 || result.bonus.wheel_index >= result.bonus.wheel_options.length || result.bonus.wheel_options[result.bonus.wheel_index] !== result.bonus.spins_awarded || result.frames.length !== result.bonus.spins_awarded + 1)) throw new Error('invalid_response');
    }
    return result;
  }

  function stopHighlights() {
    clearInterval(state.lineTimer);
    clearTimeout(state.awardTimer);
    state.lineTimer = state.awardTimer = 0;
    $('bs-big-win').hidden = true;
  }

  function clearHighlights() {
    stopHighlights();
    clearBonusEffects();
    state.lineWins = [];
    state.selectedLine = -1;
    $('bs-win-lines').innerHTML = '';
    $('bs-win-list').hidden = true;
    $('bs-win-list').innerHTML = '';
    document.querySelectorAll('#bs-window .is-winning').forEach(cell => cell.classList.remove('is-winning'));
    document.querySelectorAll('.bs-reel-baseline i').forEach(dot => dot.classList.remove('is-stopped'));
    document.querySelectorAll('#bs-line-buttons button').forEach(button => { button.classList.remove('is-selected', 'is-winning-line'); button.setAttribute('aria-pressed','false'); });
  }

  function drawLinePath(cells, preview = false) {
    const points = safeCells(cells);
    $('bs-win-lines').classList.toggle('is-preview',preview);
    $('bs-win-lines').innerHTML = `<polyline points="${points.map(cell => `${cell.reel * 100 + 50},${cell.row * 100 + 50}`).join(' ')}"></polyline>${points.map(cell => `<circle cx="${cell.reel * 100 + 50}" cy="${cell.row * 100 + 50}" r="4"></circle>`).join('')}`;
  }

  function previewLine(index) {
    if (state.animating || !state.config?.paylines[index]) return;
    clearInterval(state.lineTimer);
    state.lineTimer = 0;
    drawLinePath(state.config.paylines[index],true);
    document.querySelectorAll('#bs-window .is-winning').forEach(cell => cell.classList.remove('is-winning'));
    document.querySelectorAll('#bs-line-buttons button').forEach((button,i) => { button.classList.toggle('is-selected',i === index); button.setAttribute('aria-pressed',String(i === index)); });
    $('bs-line-hint').textContent = `Линия ${index + 1} · ряды ${state.config.paylines[index].map(cell => cell.row + 1).join(' → ')}`;
  }

  function showLine(index) {
    const win = state.lineWins[index];
    if (!win) return;
    state.selectedLine = index;
    document.querySelectorAll('#bs-window .is-winning, #bs-sticky-layer .is-winning').forEach(cell => cell.classList.remove('is-winning'));
    const cells = (win.cells || []).filter(cell => Number.isInteger(cell.row) && cell.row >= 0 && cell.row < 3 && Number.isInteger(cell.reel) && cell.reel >= 0 && cell.reel < 5);
    cells.forEach(cell => document.querySelector(`#bs-window .bs-reel[data-reel="${cell.reel}"] .bs-symbol[data-row="${cell.row}"]`)?.classList.add('is-winning'));
    if (win.scatter) $('bs-win-lines').innerHTML = ''; else drawLinePath(cells);
    cells.forEach(cell => document.querySelector(`#bs-sticky-layer .bs-sticky-cell[data-reel="${cell.reel}"][data-row="${cell.row}"] .bs-symbol`)?.classList.add('is-winning'));
    document.querySelectorAll('#bs-line-buttons button').forEach((button,i) => { button.classList.toggle('is-selected',!win.scatter && i === win.line_index); button.setAttribute('aria-pressed',String(!win.scatter && i === win.line_index)); });
    document.querySelectorAll('#bs-win-list button').forEach((button, i) => {
      button.classList.toggle('is-selected', i === index);
      button.setAttribute('aria-pressed', String(i === index));
    });
  }

  function showWins(result, cycle = true) {
    clearInterval(state.lineTimer);
    state.lineTimer = 0;
    state.lineWins = (result.line_wins || []).filter(win => Number(win.payout) > 0);
    if (result.scatter_win?.payout > 0) state.lineWins.push({ ...result.scatter_win, scatter: true });
    const list = $('bs-win-list');
    list.hidden = !state.lineWins.length;
    list.innerHTML = state.lineWins.map((win, index) => `<button type="button" data-bs-win="${index}" aria-pressed="false">${win.scatter ? 'BONUS' : `Линия ${Number(win.line_index) + 1}`}${Number(win.wild_multiplier) > 1 ? ` · WILD ×${number(win.wild_multiplier)}` : ''} · ${number(win.payout)} 🧠</button>`).join('');
    document.querySelectorAll('#bs-line-buttons button').forEach((button,index) => button.classList.toggle('is-winning-line', state.lineWins.some(win => win.line_index === index)));
    if (state.lineWins.length) showLine(0);
    if (cycle && state.lineWins.length > 1 && state.active && !reducedMotion()) {
      state.lineTimer = setInterval(() => {
        if (state.active && !document.hidden) showLine((state.selectedLine + 1) % state.lineWins.length);
      }, 1700);
    }
  }

  function stopCounter() {
    cancelAnimationFrame(state.counterFrame);
    state.counterFrame = 0;
    if (state.counterResolve) { const done = state.counterResolve; state.counterResolve = null; done(); }
  }

  function countAmount(value, animate, target = $('bs-result-amount'), from = 0) {
    stopCounter();
    if (!animate || reducedMotion() || !state.active) { target.textContent = `${number(value)} 🧠`; return Promise.resolve(); }
    return new Promise(resolve => {
      state.counterResolve = resolve;
      const started = performance.now();
      const tick = now => {
        const progress = Math.min(1, (now - started) / 650);
        target.textContent = `${number(Math.floor(from + (value - from) * (1 - Math.pow(1 - progress, 3))))} 🧠`;
        if (progress < 1) state.counterFrame = requestAnimationFrame(tick);
        else { target.textContent = `${number(value)} 🧠`; state.counterFrame = 0; state.counterResolve = null; resolve(); }
      };
      state.counterFrame = requestAnimationFrame(tick);
    });
  }

  function skipPresentation() {
    try { SND.stopSlotSounds(); } catch (_) {}
    state.skipPresentation = true;
    clearBonusEffects();
    state.finishMotion?.();
    clearTimeout(state.pauseTimer);
    state.pauseTimer = 0;
    if (state.pauseResolve) { const done = state.pauseResolve; state.pauseResolve = null; done(); }
    stopCounter();
  }

  function presentationDelay(milliseconds) {
    if (state.skipPresentation || reducedMotion() || !state.active) return Promise.resolve();
    return new Promise(resolve => {
      state.pauseResolve = resolve;
      state.pauseTimer = setTimeout(() => { state.pauseTimer = 0; state.pauseResolve = null; resolve(); },milliseconds);
    });
  }

  function clearBonusEffects() {
    const layer = $('bs-bonus-effects');
    if (layer) { layer.innerHTML = ''; layer.dataset.level = '0'; }
    if ($('bs-bonus-callout')) $('bs-bonus-callout').hidden = true;
    state.bonusReels = [];
  }

  function revealReelBonus(result, reel) {
    if (state.skipPresentation || !state.active || reducedMotion() || state.bonusReels.includes(reel)) return;
    const cells = result.grid.map((row,index)=>({row:index,symbol:state.symbols.get(row[reel])}))
      .filter(cell=>cell.symbol?.scatter);
    const layer = $('bs-bonus-effects');
    if (!cells.length || !layer) return;
    state.bonusReels.push(reel);
    const count = state.bonusReels.length;
    layer.dataset.level = String(count);
    layer.dataset.speed = state.speed;
    cells.forEach(cell=>{
      const sparks = Array.from({length:12},(_,index)=>`<i style="--bs-ray:${index*30}deg;--bs-ray-delay:${index%3*35}ms"></i>`).join('');
      layer.insertAdjacentHTML('beforeend',`<div class="bs-bonus-impact" style="grid-column:${reel+1};grid-row:${cell.row+1}" data-reel="${reel}" data-row="${cell.row}"><span class="bs-bonus-shock"></span><span class="bs-bonus-shock bs-bonus-shock--outer"></span><span class="bs-bonus-rays">${sparks}</span><div class="bs-bonus-impact-art">${imageMarkup(cell.symbol)}</div><b>BONUS</b></div>`);
    });
    const callout = $('bs-bonus-callout');
    if (callout) { callout.hidden = false; callout.innerHTML = `<span>BONUS</span><b>${count} / 3</b>`; }
    sound('award');
    status(count === 3 ? 'Три BONUS — открывается бонусная серия!' : `BONUS найден · ${count} из 3`);
  }

  async function animateGrid(result) {
    clearBonusEffects();
    if (state.skipPresentation || reducedMotion() || !state.active || !Element.prototype.animate) { drawGrid(result.grid,result); return; }
    const oldGrid = state.grid;
    const symbolIds = state.config.symbols.map(symbol => symbol.id);
    const held = state.displayedFrame?.sticky_cells || [];
    sizeReels();
    const height = $('bs-window').getBoundingClientRect().height / 3;
    if (!height) { drawGrid(result.grid,result); return; }
    drawSticky(held);
    sound('spin');
    const quick = state.speed === 'quick';
    const generation = ++state.generation;
    let finish;
    const skipped = new Promise(resolve => { finish = resolve; });
    state.finishMotion = () => {
      state.animations.forEach(animation => { try { animation.finish(); } catch (_) {} });
      finish();
    };
    const completed = Array.from(document.querySelectorAll('#bs-window .bs-reel')).map((reel, column) => {
      const strip = reel.firstElementChild;
      // Decorative filler only. All five final columns come from the settled server response.
      const fillerCount = quick ? 5 + column : 9 + column * 2;
      const filler = Array.from({ length:fillerCount }, (_, i) => symbolIds[(i * 3 + column * 2) % symbolIds.length]);
      const final = result.grid.map(row => row[column]);
      const previous = oldGrid ? oldGrid.map(row => row[column]) : final;
      strip.innerHTML = [...final, ...filler, ...previous].map((id, i) => symbolMarkup(id, i < 3 ? i : -1,i < 3 ? safeCells(result.wild_cells).find(cell => cell.reel === column && cell.row === i) : null)).join('');
      reel.classList.add('is-rolling');
      reel.classList.remove('is-settled');
      const distance = (final.length + filler.length) * height;
      const duration = quick ? 390 + column * 75 : result.kind === 'free' ? 980 + column * 150 : 1700 + column * 210;
      const animation = strip.animate([
        { transform:`translate3d(0,${-distance}px,0)` },
        { transform:'translate3d(0,0,0)' },
      ], { duration, easing:'cubic-bezier(.20,.38,.32,1)', fill:'forwards' });
      state.animations.push(animation);
      return animation.finished.catch(() => {}).then(() => {
        if (generation !== state.generation) return;
        reel.classList.remove('is-rolling');
        if (!state.skipPresentation && state.active) reel.classList.add('is-settled');
        document.querySelectorAll('.bs-reel-baseline i')[column]?.classList.add('is-stopped');
        if (state.finishMotion && state.active) sound('stop');
        revealReelBonus(result,column);
      });
    });
    await Promise.race([Promise.all(completed), skipped]);
    try { SND.stopSlotSounds('motion'); } catch (_) {}
    state.finishMotion = null;
    state.animations.forEach(animation => animation.cancel());
    state.animations = [];
    drawGrid(result.grid,result);
    // Also handles a browser that completed/cancelled its reel motions early.
    result.grid[0].forEach((_,reel)=>revealReelBonus(result,reel));
  }

  async function bonusWheel(bonus) {
    if (state.skipPresentation || reducedMotion() || !state.active) return;
    const stage = $('bs-bonus-wheel-stage');
    const wheel = $('bs-bonus-wheel');
    const options = bonus.wheel_options;
    const segment = 360 / options.length;
    wheel.innerHTML = options.map((value,index) => `<span style="--bs-wheel-angle:${index * segment}deg"><b>${number(value)}</b></span>`).join('');
    $('bs-wheel-award').textContent = '?';
    $('bs-wheel-caption').textContent = 'Липкие WILD остаются до конца серии';
    wheel.style.transform = 'rotate(0deg)';
    stage.hidden = false;
    await presentationDelay(480);
    if (state.skipPresentation || !state.active) { stage.hidden = true; return; }
    // The chosen segment is server data. This rotation never chooses an award.
    const rotation = 360 * 4 - bonus.wheel_index * segment;
    sound('wheel');
    if (Element.prototype.animate) {
      const motion = wheel.animate([{transform:'rotate(0deg)'},{transform:`rotate(${rotation}deg)`}],{duration:state.speed === 'quick' ? 1300 : 2300,easing:'cubic-bezier(.13,.55,.18,1)',fill:'forwards'});
      state.animations.push(motion);
      state.finishMotion = () => { try { motion.finish(); } catch (_) {} };
      await motion.finished.catch(() => {});
      state.finishMotion = null;
      motion.cancel();
      state.animations = state.animations.filter(animation => animation !== motion);
    }
    wheel.style.transform = `rotate(${rotation}deg)`;
    $('bs-wheel-award').textContent = number(bonus.spins_awarded);
    $('bs-wheel-caption').textContent = `${number(bonus.spins_awarded)} бесплатных вращений · без новой ставки`;
    try { SND.stopSlotSounds('motion'); } catch (_) {}
    if (!state.skipPresentation) sound('award');
    await presentationDelay(state.speed === 'quick' ? 650 : 1100);
    stage.hidden = true;
  }

  function bonusProgress(played,total,payout,finished = false) {
    $('bs-bonus-progress').hidden = false;
    $('bs-free-remaining').textContent = finished ? `${total} / ${total} · ГОТОВО` : `${played} / ${total}`;
    $('bs-free-total').textContent = `${number(payout)} 🧠`;
    $('bs-free-meter').style.transform = `scaleX(${total ? Math.max(0,Math.min(1,played / total)) : 0})`;
  }

  async function presentFrameAwards(frame, running, result, frameIndex) {
    const wins = (frame.line_wins || []).filter(win => Number(win.payout) > 0);
    if (Number(frame.scatter_win?.payout) > 0) wins.push({...frame.scatter_win,scatter:true});
    // Older saved results may contain only a frame total. They still display
    // the credited total, without inventing individual line payments.
    const entries = wins.reduce((sum, win) => sum + Number(win.payout), 0) === Number(frame.payout)
      ? wins : Number(frame.payout) > 0 ? [{payout:Number(frame.payout)}] : [];
    showWins({line_wins:[]},false);
    $('bs-result-amount').textContent = `${number(running)} 🧠`;
    if (!entries.length) $('bs-result-detail').textContent = 'В этом вращении нет выигрышной комбинации';
    for (let index = 0; index < entries.length; index++) {
      if (state.skipPresentation || !state.active) break;
      const win = entries[index];
      showWins({line_wins:entries.slice(0,index + 1)},false);
      showLine(index);
      const label = win.scatter ? 'BONUS' : Number.isInteger(win.line_index) ? `Линия ${win.line_index + 1}` : 'Выплата';
      $('bs-result-detail').textContent = `Комбинация ${index + 1} из ${entries.length} · ${label} · +${number(win.payout)} 🧠`;
      $('bs-line-hint').textContent = `${label} · +${number(win.payout)} 🧠`;
      sound('line');
      const next = running + Number(win.payout);
      await countAmount(next,true,$('bs-result-amount'),running);
      if (state.skipPresentation || !state.active) break;
      running = next;
      if (result.bonus?.triggered) bonusProgress(Math.max(0,frameIndex - 1),result.bonus.spins_awarded,running);
      await presentationDelay(state.speed === 'quick' ? 250 : 650);
    }
    return running;
  }

  async function playSeries(result) {
    const frames = result.frames?.length ? result.frames : [result];
    state.animating = true;
    state.skipPresentation = false;
    state.displayedFrame = null;
    $('bs-readout').classList.remove('is-win');
    $('bs-result-label').textContent = 'ОСНОВНОЕ ВРАЩЕНИЕ';
    $('bs-result-amount').textContent = '—';
    $('bs-result-detail').textContent = 'Барабаны останавливаются…';
    $('bs-line-hint').textContent = `Все ${state.config.paylines.length} линий участвуют в этой прокрутке`;
    drawSticky();
    $('bs-bonus-progress').hidden = true;
    $('bs-bonus-wheel-stage').hidden = true;
    document.querySelector('#screen-brain-slots .bs-machine').classList.remove('is-bonus');
    syncControls();
    let running = 0;
    for (let index = 0; index < frames.length; index++) {
      if (state.skipPresentation || !state.active || reducedMotion()) break;
      const frame = frames[index];
      clearHighlights();
      if (index > 0) {
        $('bs-line-hint').textContent = `Бесплатное вращение ${index} из ${result.bonus.spins_awarded}`;
        bonusProgress(index - 1,result.bonus.spins_awarded,running);
        status(`Бесплатное вращение ${index} из ${result.bonus.spins_awarded}. Новая ставка не списывается.`);
      }
      await animateGrid(frame);
      if (state.skipPresentation || !state.active) break;
      if (state.bonusReels.length) {
        await presentationDelay(state.speed === 'quick' ? 480 : 900);
        clearBonusEffects();
        if (state.skipPresentation || !state.active) break;
      }
      $('bs-result-label').textContent = index ? 'ВЫПЛАТА СЕРИИ' : 'ОСНОВНОЕ ВРАЩЕНИЕ';
      running = await presentFrameAwards(frame,running,result,index);
      if (state.skipPresentation || !state.active) break;
      if (index > 0) bonusProgress(index,result.bonus.spins_awarded,running);
      if (index === 0 && result.bonus?.triggered) {
        safeCells(result.bonus.trigger_cells).forEach(cell => document.querySelector(`#bs-window .bs-reel[data-reel="${cell.reel}"] .bs-symbol[data-row="${cell.row}"]`)?.classList.add('is-winning'));
        status('BONUS на барабанах 1, 3 и 5 — открывается бонусное колесо!');
        sound('bonus');
        await presentationDelay(700);
        stopHighlights();
        document.querySelector('#screen-brain-slots .bs-machine').classList.add('is-bonus');
        await bonusWheel(result.bonus);
      } else if (index < frames.length - 1) await presentationDelay(Number(frame.payout) > 0 ? state.speed === 'quick' ? 220 : 530 : 120);
    }
    $('bs-bonus-wheel-stage').hidden = true;
  }

  async function displayResult(result, animate = false, outerBalance) {
    validateResult(result);
    // Never reveal the final series balance before its presentation. Settlement
    // already happened on the server; fetch fresh account state afterwards.
    if (!animate) {
      const balance = outerBalance ?? result.current_balance ?? result.balance;
      if (Number.isFinite(Number(balance)) && identity() === state.owner && typeof updateBalanceDisplay === 'function') updateBalanceDisplay(Number(balance));
    }
    clearHighlights();
    state.result = result;
    if (animate) await playSeries(result);
    const finalFrame = result.frames?.length ? result.frames[result.frames.length - 1] : result;
    clearHighlights();
    drawGrid(finalFrame.grid,finalFrame);
    $('bs-bonus-wheel-stage').hidden = true;
    $('bs-bonus-progress').hidden = !result.bonus?.triggered;
    document.querySelector('#screen-brain-slots .bs-machine').classList.toggle('is-bonus',Boolean(result.bonus?.triggered));
    if (result.bonus?.triggered) bonusProgress(result.bonus.spins_awarded,result.bonus.spins_awarded,result.payout,true);
    const payout = Number(result.payout);
    const profit = Number(result.profit) || 0;
    const readout = $('bs-readout');
    readout.classList.toggle('is-win', profit > 0);
    $('bs-result-label').textContent = profit > 0 ? 'ВЫИГРЫШ' : payout > 0 ? 'ВЫПЛАТА' : 'БЕЗ КОМБИНАЦИИ';
    const lines = (result.line_wins || []).length;
    $('bs-result-detail').textContent = payout > 0
      ? `${result.bonus?.triggered ? `Основная + ${result.bonus.spins_awarded} бесплатных` : lines ? `${lines} выигрышных линий` : 'Выплата'}${result.scatter_win?.payout > 0 ? ' + BONUS' : ''} · ${profit > 0 ? '+' : ''}${number(profit)} 🧠 к балансу${result.capped ? ` · предел сохранённой серии` : ''}`
      : 'В этой прокрутке выигрышных комбинаций нет';
    showWins(finalFrame);
    $('bs-line-hint').textContent = result.bonus?.triggered ? 'На поле — последнее бесплатное вращение' : 'Нажми на номер — увидишь путь';
    if (animate && state.active && !state.skipPresentation) {
      if (profit > 0) sound(result.tier === 'mega' ? 'mega' : result.tier === 'big' ? 'big' : 'win');
      else sound('end');
      if ((result.tier === 'big' || result.tier === 'mega') && !reducedMotion()) {
        $('bs-big-win').hidden = false;
        $('bs-big-win').querySelector('span').textContent = result.tier === 'mega' ? 'MEGA WIN' : 'BIG WIN';
        $('bs-big-win-value').textContent = number(payout);
        state.awardTimer = setTimeout(() => { $('bs-big-win').hidden = true; }, 1900);
      }
    }
    // Individual awards have already counted up. Never restart from zero.
    await countAmount(payout, false);
    $('bs-result-amount').textContent = `${number(payout)} 🧠`;
    state.animating = false;
    window.dispatchEvent(new CustomEvent('brain-slots:settled', { detail:result }));
  }

  function renderRules() {
    const config = state.config;
    $('bs-paytable').innerHTML = config.symbols.filter(symbol => !symbol.scatter).map(symbol => `<article class="bs-pay-card"><div class="bs-pay-art">${imageMarkup(symbol, true)}</div><b>${escape(symbol.name)}${symbol.wild ? ' · WILD' : ''}</b><div class="bs-pay-values">${[3,4,5].map(count => `<span><small>${count} ПОДРЯД</small>×${number(symbol.pays?.[count] || 0)}</span>`).join('')}</div></article>`).join('');
    $('bs-rule-specials').innerHTML = `<article><b>STICKY WILD / остаётся до финала</b><p>Во время бесплатных вращений WILD закрепляется в своей клетке до конца серии. Обычные символы вращаются за ним. WILD заменяет любой символ, кроме BONUS.</p></article><article><b>BONUS / три ключевых барабана</b><p>По одному BONUS на барабанах 1, 3 и 5 запускают бонусное колесо. Оно даёт ${escape((config.bonus?.wheel_options || [9,12,15,18,21,24,27]).join(', '))} бесплатных вращений. Положение символов по рядам не важно. Повторного запуска внутри серии нет.</p></article><article><b>Множители WILD / ×2 + ×3 = ×5</b><p>В бонусе WILD может получить ×2 или ×3. Множители участвующих в комбинации WILD складываются, затем усиливают выплату этой линии. В основной игре усиления WILD нет.</p></article><article><b>Одна ставка / вся серия</b><p>Бесплатные вращения не списывают новые ставки. Сервер сохраняет основное вращение и весь бонус вместе. «Показать итог серии» только пропускает анимацию. Выплата всей серии не превышает ставку плюс доступный банк. Выпадают только комбинации, которые укладываются в эту сумму. Если банк не покрывает минимальный выигрыш сверх ставки, вращение проигрышное.</p></article>`;
    $('bs-paylines').innerHTML = config.paylines.map((cells, index) => `<div class="bs-payline-card"><span>${String(index + 1).padStart(2,'0')}</span><svg viewBox="0 0 500 300" role="img" aria-label="Линия ${index + 1}: ряды ${cells.map(cell => cell.row + 1).join(', ')}">${Array.from({ length:15 }, (_, i) => `<circle cx="${(i % 5) * 100 + 50}" cy="${Math.floor(i / 5) * 100 + 50}" r="11"></circle>`).join('')}<polyline points="${cells.map(cell => `${cell.reel * 100 + 50},${cell.row * 100 + 50}`).join(' ')}"></polyline></svg></div>`).join('');
    $('bs-line-buttons').innerHTML = config.paylines.map((cells,index) => `<button type="button" data-bs-line="${index}" aria-label="Показать линию ${index + 1}" aria-pressed="false"><b>${index + 1}</b><svg viewBox="0 0 500 300" aria-hidden="true"><polyline points="${cells.map(cell => `${cell.reel * 100 + 50},${cell.row * 100 + 50}`).join(' ')}"></polyline></svg></button>`).join('');
    const footnote = document.querySelector('#bs-rules .bs-rules-footnote');
    footnote.textContent = `Три и больше одинаковых символа подряд засчитываются с любой позиции на линии: 1–3, 2–4 или 3–5. Три одинаковых символа сверху вниз на одном барабане тоже оплачиваются. На каждой линии оплачивается одна наибольшая комбинация из 3, 4 или 5 символов. WILD не заменяет BONUS. Общая выплата округляется вниз один раз. Предел выплаты — ставка плюс доступный банк на момент вращения, включая весь бонус. Коэффициенты обозначают выплату, включая ставку.`;
  }

  function idleStatus() {
    if (state.pending) { status('Сохранена ещё одна прокрутка. Нажми «Проверить эту прокрутку».'); return; }
    const maximum = Number(state.config?.max_available_bet);
    if (Number.isFinite(maximum) && maximum < Number(state.config?.min_bet)) status('Банк временно не принимает ставки. Попробуй позже.');
    else status(`Все ${state.config.paylines.length} линий включены${Number.isFinite(maximum) ? ` · сейчас ставка до ${number(maximum)} 🧠` : ''}`);
  }

  async function refreshAccount() {
    // Reuse the application's account pipeline for wagering, achievements,
    // profile rights and game history after an actual settled/recovered spin.
    // A slow ancillary refresh must never lock an already settled spin. Abort
    // init too, so a late response cannot overwrite a later game's balance.
    const controller = new AbortController();
    const tasks = [];
    if (typeof loadInit === 'function') tasks.push(Promise.resolve().then(() => loadInit({ background:true, signal:controller.signal })));
    if (typeof refreshDesktopGameHub === 'function') tasks.push(Promise.resolve().then(() => refreshDesktopGameHub('brain-slots', true)));
    let timer;
    const deadline = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(); }, 8000);
    });
    try {
      await Promise.race([Promise.allSettled(tasks), deadline]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function recoverPending() {
    const entry = state.pending;
    if (!entry) return false;
    const data = await request(`state?request_id=${encodeURIComponent(entry.request_id)}`);
    if (identity() !== state.owner) throw new Error('account_changed');
    if (!data.last) return false;
    const result = validateResult(data.last, entry.request_id);
    await displayResult(result, false, data.balance);
    state.ready = true;
    state.loadFailed = false;
    $('bs-start-cover').hidden = true;
    clearPending();
    await refreshAccount();
    status('Результат восстановлен. Выплата уже учтена в балансе.');
    return true;
  }

  async function submit(retry = false) {
    if (!state.config || state.requesting || state.animating || !state.active || (!state.ready && !state.pending)) return;
    if (!retry && state.pending) return;
    if (identity() !== state.owner) { status('Аккаунт изменился. Открой режим заново.', true); return; }
    if (!state.pending && !validBet(currentBet())) { status(`Ставка — целое число от ${number(state.config.min_bet)} до ${number(state.config.max_bet)}.`, true); return; }
    state.requesting = true;
    syncControls();
    try {
      if (!state.pending) {
        const existing = readPending();
        if (existing) { state.pending = existing; retry = true; }
      }
      if (retry && state.pending) {
        status('Проверяем сохранённую прокрутку…');
        if (await recoverPending()) return;
      }
      if (!state.pending) {
        savePending({ request_id:newRequestId(), bet:currentBet(), user_id:state.owner, created_at:Date.now() });
        sound('bet');
      }
      const entry = { ...state.pending };
      $('bs-bet').value = String(entry.bet);
      syncControls();
      status('Подтверждаем ставку…');
      const result = validateResult(await request('spin', { method:'POST', body:JSON.stringify({ request_id:entry.request_id, bet:entry.bet }) }), entry.request_id);
      if (identity() !== state.owner) throw new Error('account_changed');
      state.requesting = false;
      status('Барабаны останавливаются…');
      await displayResult(result, true);
      state.ready = true;
      state.loadFailed = false;
      $('bs-start-cover').hidden = true;
      state.requesting = true;
      clearPending();
      await refreshAccount();
      idleStatus();
    } catch (error) {
      const rejected = ['invalid_bet','invalid_request_id','insufficient_balance','bank_limit','spin_cooldown'];
      if (Number(error.status) >= 400 && Number(error.status) < 500 && rejected.includes(error.message)) {
        clearPending();
        const messages = {
          invalid_bet:`Выбери целую ставку от ${number(state.config.min_bet)} до ${number(state.config.max_bet)}.`,
          invalid_request_id:'Не удалось подготовить прокрутку. Повтори ещё раз.',
          insufficient_balance:'На балансе не хватает мозгов для этой ставки.',
          bank_limit:'Для такой ставки сейчас недостаточно средств в банке. Уменьши ставку.',
          spin_cooldown:'Подожди секунду перед следующей прокруткой.',
        };
        if (error.message === 'bank_limit') {
          try {
            const fresh = await request('config');
            state.config.max_available_bet = fresh.max_available_bet;
          } catch (_) {}
        }
        status(`${messages[error.message]} Ставка не списана.`, true);
      } else if (error.message === 'storage_unavailable' || error.message === 'pending_unreadable' || error.message === 'secure_context_required') {
        status(error.message === 'pending_unreadable' ? 'Не удалось прочитать сохранённую прокрутку. Перезайди в этот же браузер.' : 'Браузер не разрешает сохранить прокрутку. Разреши данные сайта и обнови страницу.', true);
      } else {
        status(state.pending ? 'Ответ не получен. Нажми «Проверить эту прокрутку» — повторного списания не будет.' : 'Не удалось связаться с сервером. Попробуй ещё раз.', true);
      }
    } finally {
      state.requesting = false;
      state.animating = false;
      syncControls();
    }
  }

  function toggleRules(open) {
    $('bs-rules').hidden = !open;
    $('bs-rules-open').setAttribute('aria-expanded', String(open));
    if (open) $('bs-rules').scrollIntoView({ behavior:reducedMotion() ? 'auto' : 'smooth', block:'start' });
    else $('bs-rules-open').focus({ preventScroll:true });
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    try {
      SND.prepareSamples(['bet','spin','stop','line','bonus','wheel','award','win','big','mega','end'].map(name=>'slot_'+name)).catch(() => {});
    } catch (_) {}
    const screen = $('screen-brain-slots');
    screen.addEventListener('error', event => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || !image.dataset.bsFallback) return;
      const fallback = document.createElement('span');
      fallback.className = 'bs-symbol-fallback';
      fallback.textContent = image.dataset.bsFallback;
      image.replaceWith(fallback);
    }, true);
    $('bs-spin').addEventListener('click', () => submit(false));
    $('bs-retry').addEventListener('click', () => state.config && state.pending ? submit(true) : load());
    $('bs-skip').addEventListener('click', skipPresentation);
    $('bs-wheel-skip').addEventListener('click', skipPresentation);
    $('bs-bet').addEventListener('input', syncBet);
    $('bs-bet-minus').addEventListener('click', () => setBet((currentBet() || state.config.min_bet) / 2));
    $('bs-bet-plus').addEventListener('click', () => setBet((currentBet() || state.config.min_bet) * 2));
    screen.addEventListener('click', event => {
      const bet = event.target.closest('[data-bs-bet]');
      if (bet && !bet.disabled) setBet(Number(bet.dataset.bsBet));
      const speed = event.target.closest('[data-bs-speed]');
      if (speed && !speed.disabled) {
        state.speed = speed.dataset.bsSpeed;
        screen.querySelectorAll('[data-bs-speed]').forEach(button => {
          button.classList.toggle('is-selected', button === speed);
          button.setAttribute('aria-pressed', String(button === speed));
        });
      }
      const line = event.target.closest('[data-bs-win]');
      if (line && !state.animating) { clearInterval(state.lineTimer); state.lineTimer = 0; showLine(Number(line.dataset.bsWin)); }
      const preview = event.target.closest('[data-bs-line]');
      if (preview) previewLine(Number(preview.dataset.bsLine));
    });
    $('bs-rules-open').addEventListener('click', () => toggleRules($('bs-rules').hidden));
    $('bs-rules-close').addEventListener('click', () => toggleRules(false));
    if (window.ResizeObserver) {
      state.resizeObserver = new ResizeObserver(() => {
        if (!state.active) return;
        if (state.animating) state.finishMotion?.();
        sizeReels();
      });
      state.resizeObserver.observe($('bs-window'));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pause(false);
      else if ($('screen-brain-slots').classList.contains('active')) { state.active = true; sizeReels(); }
    });
    window.addEventListener('storage', event => {
      if (!(event.key === key() || event.key?.startsWith(`${key()}:`)) || state.requesting || state.animating || state.pending) return;
      if (event.newValue) { try { state.pending = readPending(); syncControls(); status('Есть незавершённая прокрутка. Проверь её результат.'); } catch (_) {} }
    });
  }

  async function load() {
    if (!$('screen-brain-slots')) return;
    state.active = true;
    mount();
    sizeReels();
    if (state.requesting || state.animating) return;
    if (state.loading) return state.loading;
    state.loading = (async () => {
      state.ready = false;
      state.loadFailed = false;
      state.requesting = true;
      syncControls();
      status('Загружаем правила и последний результат…');
      try {
        if (typeof ensureTelegramAuth === 'function' && !await ensureTelegramAuth()) throw new Error('auth_required');
        const owner = identity();
        if (!owner) throw new Error('auth_required');
        if (state.owner !== owner) {
          state.owner = owner;
          state.pending = null;
          state.result = null;
          state.grid = null;
          clearHighlights();
        }
        const config = await request('config');
        if (!Array.isArray(config.symbols) || !config.symbols.length || !Array.isArray(config.paylines) || ![10, 15].includes(config.paylines.length)) throw new Error('invalid_response');
        state.config = config;
        state.symbols = new Map([...(config.legacy_symbols || []),...config.symbols].map(symbol => [symbol.id,symbol]));
        $('bs-bet').min = String(config.min_bet);
        $('bs-bet').max = String(config.max_bet);
        if (!validBet(currentBet())) $('bs-bet').value = String(config.min_bet);
        renderRules();
        state.pending = readPending();
        if (state.pending) {
          $('bs-bet').value = String(state.pending.bet);
          if (!await recoverPending()) status('Прокрутка ещё не подтверждена. Нажми «Проверить эту прокрутку».');
        } else {
          const data = await request('state');
          if (identity() !== state.owner) throw new Error('account_changed');
          if (data.last) await displayResult(validateResult(data.last), false, data.balance);
          else {
            // Neutral display before the first game; never presented as a paid result.
            const ordinary = config.symbols.filter(symbol => !symbol.wild && !symbol.scatter).map(symbol => symbol.id);
            const choices = ordinary.length ? ordinary : config.symbols.map(symbol => symbol.id);
            drawGrid(Array.from({ length:3 }, (_, row) => Array.from({ length:5 }, (_, col) => choices[(row * 2 + col) % choices.length])));
          }
          idleStatus();
        }
        $('bs-start-cover').hidden = true;
        state.ready = true;
      } catch (error) {
        state.loadFailed = true;
        status(state.pending ? 'Не удалось получить ответ. Сохранённую прокрутку можно проверить снова.' : 'Не удалось загрузить слоты. Проверь подключение и нажми «Повторить загрузку».', true);
        $('bs-start-cover').querySelector('b').textContent = 'Нет связи с сервером';
        $('bs-retry').textContent = state.config && state.pending ? 'Проверить эту прокрутку' : 'Повторить загрузку';
      } finally {
        state.requesting = false;
        state.loading = null;
        syncControls();
        if (!$('bs-start-cover').hidden && !state.pending) $('bs-retry').hidden = false;
        sizeReels();
      }
    })();
    return state.loading;
  }

  function pause(leave = true) {
    state.active = false;
    skipPresentation();
    stopHighlights();
    stopCounter();
    if (state.result) $('bs-result-amount').textContent = `${number(state.result.payout)} 🧠`;
    // Requests intentionally continue: leaving a screen cannot erase a paid spin.
  }

  window.brainSlotsLoad = load;
  window.brainSlotsPause = pause;
})();
