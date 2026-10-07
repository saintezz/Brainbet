// Shared Rocket round. The server owns time, results and every payout.
let rocketBusy = false;
let rocketPollTimer = 0;
let rocketFrameHandle = 0;
let rocketClockOffset = 0;
let rocketListSignature = '';
let rocketLastCountdownTick = -1;
let rocketLastEngineUpdate = 0;
let rocketAutoCashoutEnabled = false;
let rocketState = {
  round_id: 0,
  status: 'betting',
  betting_ends_at: 0,
  started_at: null,
  current_multiplier: 1,
  final_multiplier: null,
  total_bet: 0,
  player_count: 0,
  players: [],
  user_bet: null,
  recent: []
};

function rocketErrorText(code) {
  return {
    invalid_bet: 'Ставка должна быть от 1 до 1 000 000',
    invalid_auto_cashout: 'Автовывод должен быть от x1.01 до x100',
    insufficient_balance: 'Недостаточно мозгов на балансе',
    round_closed: 'Приём ставок уже закрыт',
    already_bet: 'Ты уже участвуешь в этом раунде',
    no_bet: 'В этом раунде у тебя нет ставки',
    not_flying: 'Ракетка ещё не взлетела',
    bet_finished: 'Эта ставка уже завершена',
    no_tg_id: 'Открой игру через Telegram'
  }[code] || 'Не удалось выполнить действие';
}

async function rocketRequest(path, options = {}) {
  await ensureTelegramAuth();
  const response = await fetch(`${API}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {'Content-Type': 'application/json', ...(options.headers || {})}
  });
  let data = {};
  try { data = await response.json(); } catch (error) {}
  if (!response.ok) {
    const requestError = new Error(rocketErrorText(data.error));
    requestError.code = data.error;
    throw requestError;
  }
  return data;
}

function rocketFormatMultiplier(value) {
  return `x${Math.max(1, Math.min(100, Number(value) || 1)).toFixed(2)}`;
}

function rocketSyncAutoCashoutControls(inputLocked = null) {
  const group = document.getElementById('rocket-auto-group');
  const input = document.getElementById('rocket-auto');
  const toggle = document.getElementById('rocket-auto-toggle');
  const state = document.getElementById('rocket-auto-state');
  const note = document.getElementById('rocket-auto-note');
  if (!group || !input || !toggle) return;

  const locked = inputLocked === null
    ? rocketBusy || rocketState.status !== 'betting' || Boolean(rocketState.user_bet)
    : Boolean(inputLocked);
  const currentValue = Number(input.value);

  group.classList.toggle('is-enabled', rocketAutoCashoutEnabled);
  toggle.classList.toggle('is-enabled', rocketAutoCashoutEnabled);
  toggle.setAttribute('aria-pressed', String(rocketAutoCashoutEnabled));
  toggle.disabled = locked;
  input.disabled = locked || !rocketAutoCashoutEnabled;
  if (state) state.textContent = rocketAutoCashoutEnabled ? 'ВКЛ' : 'ВЫКЛ';
  if (note) {
    note.textContent = rocketAutoCashoutEnabled
      ? `Выигрыш автоматически заберётся на ${rocketFormatMultiplier(currentValue)}`
      : 'Выигрыш забирается вручную';
  }

  document.querySelectorAll('[data-rocket-auto]').forEach(button => {
    const preset = Number(button.dataset.rocketAuto);
    button.disabled = locked;
    button.classList.toggle(
      'active',
      rocketAutoCashoutEnabled && Number.isFinite(currentValue) && Math.abs(currentValue - preset) < 0.001
    );
  });
}

function rocketToggleAutoCashout() {
  rocketAutoCashoutEnabled = !rocketAutoCashoutEnabled;
  const input = document.getElementById('rocket-auto');
  if (!rocketAutoCashoutEnabled) input.value = '';
  else if (!Number.isFinite(Number(input.value)) || Number(input.value) < 1.01) input.value = '2.00';
  rocketSyncAutoCashoutControls();
}

function rocketSetAutoCashoutPreset(value) {
  const multiplier = Number(value);
  if (!Number.isFinite(multiplier) || multiplier < 1.01 || multiplier > 100) return;
  rocketAutoCashoutEnabled = true;
  document.getElementById('rocket-auto').value = multiplier.toFixed(2);
  rocketSyncAutoCashoutControls();
}

function rocketServerNow() {
  return Date.now() / 1000 + rocketClockOffset;
}

function rocketLiveMultiplier() {
  if (rocketState.status === 'finished') return Number(rocketState.final_multiplier || 1);
  if (rocketState.status !== 'flying' || !rocketState.started_at) return 1;
  const elapsed = Math.max(0, rocketServerNow() - Number(rocketState.started_at));
  return Math.min(100, Math.floor(Math.exp(0.14 * elapsed) * 100) / 100);
}

function rocketPlayerStatus(player) {
  if (player.status === 'active') return 'ЛЕТИТ';
  if (player.status === 'lost') return `НЕ УСПЕЛ x${Number(player.cashout_multiplier || 1).toFixed(2)}`;
  return `ЗАБРАЛ x${Number(player.cashout_multiplier || 1).toFixed(2)}`;
}

function rocketRenderLists() {
  const signature = JSON.stringify({
    round: rocketState.round_id,
    status: rocketState.status,
    players: rocketState.players,
    recent: rocketState.recent
  });
  if (signature === rocketListSignature) return;
  rocketListSignature = signature;

  const recent = document.getElementById('rocket-recent');
  if (recent) {
    recent.innerHTML = (rocketState.recent || []).length
      ? rocketState.recent.map(item => {
          const mult = Number(item.multiplier || 1);
          const tone = mult >= 10 ? 'high' : (mult >= 2 ? 'mid' : 'low');
          return `<b class="${tone}">${rocketFormatMultiplier(mult)}</b>`;
        }).join('')
      : '<span>НЕТ ИСТОРИИ</span>';
  }

  const list = document.getElementById('rocket-player-list');
  if (list) {
    list.innerHTML = (rocketState.players || []).length
      ? rocketState.players.map(player => `
          <div class="rocket-player-row ${player.status !== 'active' ? 'is-done' : ''}">
            <span class="rocket-player-avatar">${escHtml(String(player.name || '?').slice(0, 1).toUpperCase())}</span>
            <span class="rocket-player-name">${playerProfileLink(player.tg_id, player.name || `Player ${player.tg_id}`)}</span>
            <em>${Number(player.bet || 0)} 🧠</em>
            <strong>${rocketPlayerStatus(player)}</strong>
          </div>`).join('')
      : '<div class="rocket-empty">В этом раунде пока нет ставок</div>';
  }
}

function rocketRenderFrame() {
  rocketFrameHandle = 0;
  const screen = document.getElementById('screen-rocket');
  if (!screen?.classList.contains('active')) return;
  const stage = document.getElementById('rocket-stage');
  const multiplier = rocketLiveMultiplier();
  document.getElementById('rocket-multiplier').textContent = rocketFormatMultiplier(multiplier);
  stage.classList.toggle('is-betting', rocketState.status === 'betting');
  stage.classList.toggle('is-flying', rocketState.status === 'flying');
  stage.classList.toggle('is-finished', rocketState.status === 'finished');

  const phase = document.getElementById('rocket-phase');
  const rigCounter = stage.querySelector('.rocket-launch-rig b');
  const rigLabel = stage.querySelector('.rocket-launch-rig span');
  if (rocketState.status === 'betting') {
    const left = Math.max(0, Number(rocketState.betting_ends_at || 0) - rocketServerNow());
    phase.textContent = `ЗАПУСК ЧЕРЕЗ ${left.toFixed(1)} С`;
    const duration = Math.max(1, Number(rocketState.betting_seconds || 12));
    stage.style.setProperty('--rocket-countdown', String(Math.min(1, left / duration)));
    if (rigCounter) rigCounter.textContent = String(Math.max(0, Math.ceil(left))).padStart(2, '0');
    if (rigLabel) rigLabel.textContent = 'ДО СТАРТА';
    const countdownTick = Math.ceil(left);
    if (countdownTick > 0 && countdownTick <= 3 && countdownTick !== rocketLastCountdownTick) {
      rocketLastCountdownTick = countdownTick;
      SND.play('rocketCountdown');
    } else if (countdownTick > 3) {
      rocketLastCountdownTick = -1;
    }
  } else if (rocketState.status === 'flying') {
    phase.textContent = 'РАКЕТА НАБИРАЕТ ВЫСОТУ';
    if (rigCounter) rigCounter.textContent = 'GO';
    if (rigLabel) rigLabel.textContent = 'В ПОЛЁТЕ';
    const now = performance.now();
    if (now - rocketLastEngineUpdate >= 100) {
      rocketLastEngineUpdate = now;
      SND.rocketEngineUpdate(multiplier);
    }
  } else {
    phase.textContent = `ПОЛЁТ ЗАВЕРШЁН НА ${rocketFormatMultiplier(multiplier)}`;
    if (rigCounter) rigCounter.textContent = 'XX';
    if (rigLabel) rigLabel.textContent = 'ФИНИШ';
  }

  const progress = Math.max(0, Math.min(1, Math.log(Math.max(1, multiplier)) / Math.log(100)));
  stage.style.setProperty('--rocket-progress', String(progress));
  stage.style.setProperty('--rocket-y', `${14 + progress * 52}%`);
  stage.style.setProperty('--rocket-mobile-y', `${58 + progress * 136}px`);
  stage.style.setProperty('--rocket-scale', String(1 - progress * 0.2));
  const altitude = document.getElementById('rocket-altitude');
  if (altitude) altitude.textContent = `${Math.round(progress * 1000).toLocaleString('ru-RU')} КМ`;
  rocketRenderAction(multiplier);
  rocketFrameHandle = requestAnimationFrame(rocketRenderFrame);
}

function rocketRenderAction(multiplier) {
  const userBet = rocketState.user_bet;
  const action = document.getElementById('rocket-action');
  const text = action.querySelector('span');
  const note = document.getElementById('rocket-action-note');
  const inputLocked = rocketBusy || rocketState.status !== 'betting' || Boolean(userBet);
  document.getElementById('rocket-bet').disabled = inputLocked;
  rocketSyncAutoCashoutControls(inputLocked);
  document.querySelectorAll('.rocket-qbet').forEach(button => { button.disabled = inputLocked; });
  action.classList.remove('is-cashout', 'is-locked', 'is-won');

  if (rocketBusy) {
    action.disabled = true;
    text.textContent = 'ОТПРАВЛЯЕМ КОМАНДУ...';
    note.textContent = 'Сервер фиксирует команду';
  } else if (rocketState.status === 'betting' && !userBet) {
    action.disabled = false;
    text.textContent = 'СДЕЛАТЬ СТАВКУ';
    note.textContent = 'Ставки принимаются до старта';
  } else if (rocketState.status === 'betting') {
    action.disabled = true;
    action.classList.add('is-locked');
    text.textContent = `СТАВКА ${Number(userBet.bet || 0)} 🧠 ПРИНЯТА`;
    note.textContent = userBet.auto_cashout
      ? `Автовывод на x${Number(userBet.auto_cashout).toFixed(2)}`
      : 'Забери выигрыш вручную во время полёта';
  } else if (rocketState.status === 'flying' && userBet?.status === 'active') {
    action.disabled = false;
    action.classList.add('is-cashout');
    text.textContent = `ЗАБРАТЬ ${Math.floor(Number(userBet.bet || 0) * multiplier)} 🧠`;
    note.textContent = `Зафиксировать выигрыш на ${rocketFormatMultiplier(multiplier)}`;
  } else if (userBet && !['active', 'lost'].includes(userBet.status)) {
    action.disabled = true;
    action.classList.add('is-won');
    text.textContent = `ПОЛУЧЕНО ${Number(userBet.payout || 0)} 🧠`;
    note.textContent = rocketPlayerStatus(userBet);
  } else {
    action.disabled = true;
    action.classList.add('is-locked');
    text.textContent = rocketState.status === 'finished' ? 'СЛЕДУЮЩИЙ ПОЛЁТ СКОРО' : 'РАКЕТА УЖЕ ЛЕТИТ';
    note.textContent = rocketState.status === 'finished'
      ? 'Дождись нового раунда'
      : 'Дождись следующего запуска';
  }
}

function rocketApplyState(data) {
  const previousRound = Number(rocketState.round_id || 0);
  const previousStatus = rocketState.status;
  const previousUserStatus = rocketState.user_bet?.status;
  rocketClockOffset = Number(data.server_time || Date.now() / 1000) - Date.now() / 1000;
  rocketState = {...rocketState, ...data};
  if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
  document.getElementById('rocket-player-count').textContent = Number(data.player_count || 0);
  document.getElementById('rocket-total-bet').textContent = `${Number(data.total_bet || 0)} 🧠`;
  document.getElementById('rocket-roster-count').textContent = Number(data.player_count || 0);
  if (data.user_bet?.bet) document.getElementById('rocket-bet').value = data.user_bet.bet;
  if (data.user_bet?.auto_cashout) {
    rocketAutoCashoutEnabled = true;
    document.getElementById('rocket-auto').value = Number(data.user_bet.auto_cashout).toFixed(2);
  } else if (data.user_bet) {
    rocketAutoCashoutEnabled = false;
    document.getElementById('rocket-auto').value = '';
  }

  if (previousRound && previousRound !== Number(data.round_id)) {
    rocketLastCountdownTick = -1;
    SND.playUi('tap');
  } else if (previousStatus === 'betting' && data.status === 'flying') {
    SND.play('rocketLaunch');
    SND.rocketEngineStart(1);
  } else if (previousStatus === 'flying' && data.status === 'finished') {
    SND.rocketEngineStop(0.08);
    SND.play('rocketCrash');
  } else if (
    previousUserStatus === 'active'
    && data.user_bet
    && !['active', 'lost'].includes(data.user_bet.status)
  ) {
    SND.play('rocketEject');
  }
  rocketRenderLists();
  if (!rocketFrameHandle) rocketFrameHandle = requestAnimationFrame(rocketRenderFrame);
}

async function rocketLoad() {
  try {
    rocketApplyState(await rocketRequest(`/api/rocket/state?tg_id=${tg_id}&_=${Date.now()}`));
  } catch (error) {
    console.error('[rocket] load failed', error);
  }
}

function rocketStartPolling() {
  rocketStopPolling();
  rocketLoad();
  rocketPollTimer = window.setInterval(rocketLoad, 500);
  rocketFrameHandle = requestAnimationFrame(rocketRenderFrame);
}

function rocketStopPolling() {
  if (rocketPollTimer) clearInterval(rocketPollTimer);
  if (rocketFrameHandle) cancelAnimationFrame(rocketFrameHandle);
  SND.rocketEngineStop();
  rocketPollTimer = 0;
  rocketFrameHandle = 0;
  rocketLastEngineUpdate = 0;
}

async function rocketPlaceBet() {
  const bet = Number.parseInt(document.getElementById('rocket-bet').value, 10);
  const autoRaw = document.getElementById('rocket-auto').value.trim();
  const autoCashout = rocketAutoCashoutEnabled ? Number(autoRaw) : null;
  if (!Number.isInteger(bet) || bet < 1 || bet > 1000000) {
    showToast('Введи ставку от 1 до 1 000 000', 'lose');
    return;
  }
  if (autoCashout !== null && (!Number.isFinite(autoCashout) || autoCashout < 1.01 || autoCashout > 100)) {
    showToast('Автовывод должен быть от x1.01 до x100', 'lose');
    return;
  }
  rocketBusy = true;
  try {
    const data = await rocketRequest('/api/rocket/bet', {
      method: 'POST',
      body: JSON.stringify({tg_id, bet, auto_cashout: autoCashout})
    });
    rocketApplyState(data);
    SND.play('bet');
    showToast(`Ставка ${bet} 🧠 принята`, 'win');
  } catch (error) {
    showToast(error.message, 'lose');
    await rocketLoad();
  } finally {
    rocketBusy = false;
  }
}

async function rocketCashout() {
  rocketBusy = true;
  try {
    const data = await rocketRequest('/api/rocket/cashout', {
      method: 'POST',
      body: JSON.stringify({tg_id})
    });
    rocketApplyState(data);
    showToast(`Забрано ${Number(data.payout || data.user_bet?.payout || 0)} 🧠`, 'win');
  } catch (error) {
    showToast(error.message, 'lose');
    await rocketLoad();
  } finally {
    rocketBusy = false;
  }
}

function rocketPrimaryAction() {
  if (rocketBusy) return;
  if (rocketState.status === 'betting' && !rocketState.user_bet) rocketPlaceBet();
  else if (rocketState.status === 'flying' && rocketState.user_bet?.status === 'active') rocketCashout();
}

// Inline controls must also work inside Telegram WebView's isolated script world.
Object.assign(window, {
  rocketPrimaryAction,
  rocketSetAutoCashoutPreset,
  rocketSyncAutoCashoutControls,
  rocketToggleAutoCashout
});
