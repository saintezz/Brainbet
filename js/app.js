// Identity can come from signed Telegram Mini App initData or from a protected
// browser session that was approved in the same Telegram bot.
let tg_id = 0;
let TG_INIT_DATA = '';
let telegramAuthPromise = null;
let browserSessionPromise = null;
let browserAuthPollTimer = null;
const RAW_FETCH = window.fetch.bind(window);
const browserAuth = {
  authenticated: false,
  csrfToken: '',
  pending: false,
  launching: false,
  botUrl: '',
  expiresAt: 0,
  userName: '',
};
try {
  browserAuth.botUrl = String(sessionStorage.getItem('bb_browser_login_url') || '');
  browserAuth.expiresAt = Number(sessionStorage.getItem('bb_browser_login_expires') || 0);
  if (browserAuth.expiresAt <= Math.floor(Date.now() / 1000)) {
    browserAuth.botUrl = '';
    browserAuth.expiresAt = 0;
    sessionStorage.removeItem('bb_browser_login_url');
    sessionStorage.removeItem('bb_browser_login_expires');
  }
} catch (error) {}
let termsAccepted = false;
let termsVersion = '';
let termsStatusPromise = null;
let appConsentBootPromise = null;
let brainBetBootFinished = false;

function brainBetBootStatus(title, detail = '') {
  if (brainBetBootFinished) return;
  const titleElement = document.getElementById('bb-boot-title');
  const detailElement = document.getElementById('bb-boot-detail');
  if (titleElement && title) titleElement.textContent = title;
  if (detailElement && detail) detailElement.textContent = detail;
}

function completeBrainBetBoot() {
  if (brainBetBootFinished) return;
  brainBetBootFinished = true;
  clearTimeout(window.__bbBootSlowTimer);
  clearTimeout(window.__bbBootRetryTimer);
  const root = document.documentElement;
  const screen = document.getElementById('bb-boot-screen');
  root.classList.remove('bb-booting');
  if (!screen) return;
  screen.classList.add('is-leaving');
  setTimeout(() => {
    screen.hidden = true;
    screen.classList.remove('is-leaving');
  }, 300);
}

function failBrainBetBoot(message = 'Сервер не успел ответить. Обнови страницу и попробуй ещё раз.') {
  if (brainBetBootFinished || document.documentElement.classList.contains('telegram-auth-error')) return;
  brainBetBootStatus('НЕ УДАЛОСЬ ЗАПУСТИТЬ', message);
  document.getElementById('bb-boot-retry')?.classList.add('is-visible');
}

function retryBrainBetBoot() {
  window.location.reload();
}

brainBetBootStatus('ПРОВЕРЯЕМ ДОСТУП', 'Определяем Telegram-аккаунт и защищённую сессию…');

function telegramLaunchDetected() {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    return Boolean(tg && (tg.initData || (tg.initDataUnsafe && tg.initDataUnsafe.user)));
  } catch (e) {
    return false;
  }
}

function setAuthRoot(mode) {
  const root = document.documentElement;
  root.classList.remove('auth-checking', 'terms-checking', 'telegram-auth-error', 'browser-auth-required', 'browser-authenticated', 'telegram-authenticated');
  if (mode === 'browser') root.classList.add('browser-authenticated');
  if (mode === 'telegram') root.classList.add('telegram-authenticated');
}

function syncTelegramAuth() {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    const user = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    if (tg && tg.initData) TG_INIT_DATA = tg.initData;
    if (user && Number(user.id) > 0) tg_id = Number(user.id);
  } catch (e) {}
  const authenticated = Boolean(TG_INIT_DATA && tg_id > 0);
  if (authenticated) setAuthRoot('telegram');
  return authenticated;
}

// Background API calls must never run before the server has a verified
// identity. `initDataUnsafe.user` is only a client-side hint; the signed
// initData or the protected browser session is what actually authenticates
// the request.
function hasClientIdentity() {
  return Number(tg_id) > 0 && Boolean(TG_INIT_DATA || browserAuth.authenticated);
}

function ensureTelegramAuth(timeoutMs = 2500) {
  if (syncTelegramAuth()) return Promise.resolve(true);
  if (telegramAuthPromise) return telegramAuthPromise;

  if (!telegramLaunchDetected()) return ensureBrowserSession();

  telegramAuthPromise = new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (syncTelegramAuth() || Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        if (TG_INIT_DATA && tg_id > 0) {
          resolve(true);
        } else {
          // A Mini App opened inside Telegram must never fall back to the
          // browser-login flow. That flow belongs to ordinary web tabs and
          // can make a valid Telegram launch look like a second login.
          showTelegramAuthError('Telegram не передал подтверждение входа. Закрой Mini App и открой его из актуального бота.');
          resolve(false);
        }
      }
    }, 50);
  });
  return telegramAuthPromise;
}

syncTelegramAuth();

// The Mini App and API are served by the same Flask instance. Keeping this
// relative to the opened origin also makes temporary Cloudflare URLs work
// without rebuilding the frontend for every new tunnel.
const API = window.location.origin;

function termsConsentElements() {
  return {
    screen: document.getElementById('terms-consent-screen'),
    button: document.getElementById('terms-consent-accept'),
    status: document.getElementById('terms-consent-status'),
    ageCheck: document.getElementById('terms-consent-age-check'),
    rulesCheck: document.getElementById('terms-consent-rules-check'),
  };
}

function syncTermsConsentButton() {
  const { button, ageCheck, rulesCheck } = termsConsentElements();
  if (!button) return;
  const confirmed = Boolean(ageCheck?.checked && rulesCheck?.checked);
  const busy = button.dataset.busy === 'true';
  button.disabled = !confirmed || busy;
  button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
  if (!busy) {
    termsConsentStatus(
      confirmed
        ? 'Подтверждения отмечены. Можно продолжить.'
        : 'Отметьте оба подтверждения, чтобы продолжить',
    );
  }
}

function termsConsentStatus(message, tone = '') {
  const { status } = termsConsentElements();
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', tone === 'error');
}

function showTermsConsentScreen(payload = {}) {
  if (payload.terms_version) termsVersion = String(payload.terms_version);
  termsAccepted = false;
  const { screen } = termsConsentElements();
  document.documentElement.classList.remove('terms-checking', 'terms-accepted');
  document.documentElement.classList.add('terms-required');
  if (screen) screen.hidden = false;
  syncTermsConsentButton();
  completeBrainBetBoot();
}

function markTermsAccepted() {
  termsAccepted = true;
  document.documentElement.classList.remove('terms-checking', 'terms-required');
  document.documentElement.classList.add('terms-accepted');
  const { screen } = termsConsentElements();
  if (screen) screen.hidden = true;
}

function termsAuthHeaders(includeWriteProtection = false) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (TG_INIT_DATA) headers.set('X-Telegram-Init-Data', TG_INIT_DATA);
  if (includeWriteProtection && browserAuth.authenticated && browserAuth.csrfToken) {
    headers.set('X-BrainBet-CSRF', browserAuth.csrfToken);
  }
  return headers;
}

async function ensureTermsAccepted(force = false) {
  if (termsAccepted && !force) return true;
  if (termsStatusPromise && !force) return termsStatusPromise;
  termsStatusPromise = (async () => {
    const authenticated = await ensureTelegramAuth();
    if (!authenticated || !(tg_id > 0)) return false;
    try {
      const response = await RAW_FETCH(`${API}/api/terms/status`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: termsAuthHeaders(false),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload.accepted && payload.age_confirmed) {
        termsVersion = String(payload.terms_version || termsVersion);
        markTermsAccepted();
        return true;
      }
      if (response.status === 401) {
        if (telegramLaunchDetected()) {
          showTelegramAuthError('Telegram открыл Mini App, но сервер не подтвердил этот аккаунт. Открой Mini App из актуального бота и попробуй ещё раз.');
        } else {
          showBrowserAuthScreen('Сессия закончилась. Подтверди новый вход через Telegram.');
        }
        return false;
      }
      showTermsConsentScreen(payload);
      return false;
    } catch (error) {
      showTermsConsentScreen({message: 'Не удалось проверить согласие. Проверь подключение и повтори.'});
      termsConsentStatus('Не удалось проверить согласие. Проверь подключение и повтори.', 'error');
      return false;
    }
  })().finally(() => {
    termsStatusPromise = null;
  });
  return termsStatusPromise;
}

async function acceptTermsAndAge() {
  const { button, ageCheck, rulesCheck } = termsConsentElements();
  if (!ageCheck?.checked || !rulesCheck?.checked) {
    termsConsentStatus('Сначала подтвердите возраст и принятие условий.', 'error');
    syncTermsConsentButton();
    return;
  }
  if (button) button.dataset.busy = 'true';
  syncTermsConsentButton();
  termsConsentStatus('Сохраняем подтверждение…');
  try {
    if (!termsVersion) await ensureTermsAccepted(true);
    if (!termsVersion) throw new Error('terms_unavailable');
    const response = await RAW_FETCH(`${API}/api/terms/accept`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: termsAuthHeaders(true),
      body: JSON.stringify({
        age_confirmed: ageCheck.checked,
        terms_accepted: rulesCheck.checked,
        terms_version: termsVersion,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.accepted) {
      if (payload.terms_version) termsVersion = String(payload.terms_version);
      throw new Error(payload.error || 'acceptance_failed');
    }
    markTermsAccepted();
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch (e) {}
    await startBrainBetAfterConsent();
  } catch (error) {
    termsConsentStatus(
      error.message === 'terms_version_mismatch'
        ? 'Условия обновились. Нажми кнопку ещё раз.'
        : 'Не удалось сохранить подтверждение. Попробуй ещё раз.',
      'error',
    );
  } finally {
    if (button) delete button.dataset.busy;
    syncTermsConsentButton();
  }
}

function browserAuthElements() {
  return {
    screen: document.getElementById('browser-auth-screen'),
    card: document.querySelector('#browser-auth-screen .browser-auth-card'),
    button: document.getElementById('browser-auth-button'),
    status: document.getElementById('browser-auth-status'),
  };
}

function browserAuthSetStep(step) {
  ['open', 'confirm', 'ready'].forEach((name, index) => {
    const el = document.getElementById(`browser-auth-step-${name}`);
    if (!el) return;
    el.classList.toggle('active', index === step);
    el.classList.toggle('done', index < step);
  });
}

function showBrowserAuthScreen(message = '') {
  if (telegramLaunchDetected()) {
    showTelegramAuthError(message || 'Telegram не подтвердил этот сеанс. Открой Mini App заново из бота.');
    return;
  }
  const { screen, status } = browserAuthElements();
  document.documentElement.classList.remove('auth-checking', 'browser-authenticated');
  document.documentElement.classList.add('browser-auth-required');
  if (screen) screen.hidden = false;
  if (status && message) status.textContent = message;
  completeBrainBetBoot();
}

function showTelegramAuthError(message = '') {
  const { screen } = browserAuthElements();
  if (screen) screen.hidden = true;
  document.documentElement.classList.remove('auth-checking', 'terms-checking', 'terms-required', 'browser-auth-required', 'browser-authenticated', 'telegram-authenticated');
  document.documentElement.classList.add('telegram-auth-error');
  brainBetBootStatus('НЕ УДАЛОСЬ ПОДТВЕРДИТЬ TELEGRAM', message || 'Открой Mini App заново из бота.');
  document.getElementById('bb-boot-retry')?.classList.add('is-visible');
}

function setBrowserSession(payload, hideScreen = true) {
  const user = payload && payload.user || {};
  browserAuth.authenticated = true;
  browserAuth.csrfToken = String(payload.csrf_token || '');
  browserAuth.expiresAt = Number(payload.expires_at || 0);
  browserAuth.userName = String(user.name || `user${Number(user.tg_id || 0)}`);
  tg_id = Number(user.tg_id || 0);
  if (!(tg_id > 0) || !browserAuth.csrfToken) return false;
  setAuthRoot('browser');
  const screen = document.getElementById('browser-auth-screen');
  if (screen && hideScreen) screen.hidden = true;
  const panel = document.getElementById('browser-session-panel');
  if (panel) panel.hidden = false;
  const sessionName = document.getElementById('browser-session-name');
  if (sessionName) sessionName.textContent = browserAuth.userName;
  return true;
}

async function ensureBrowserSession() {
  if (browserAuth.authenticated && tg_id > 0) return true;
  if (browserSessionPromise) return browserSessionPromise;
  browserSessionPromise = RAW_FETCH(`${API}/api/browser-auth/session`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store',
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.authenticated && setBrowserSession(payload)) return true;
    if (!telegramLaunchDetected() && await resumeBrowserLogin()) return browserAuth.authenticated;
    showBrowserAuthScreen('Вход подтверждается только в личном чате с ботом');
    return false;
  }).catch(() => {
    showBrowserAuthScreen('Не удалось проверить вход. Проверь подключение и попробуй снова.');
    return false;
  }).finally(() => {
    browserSessionPromise = null;
  });
  return browserSessionPromise;
}

function browserAuthStatus(message, tone = '') {
  const status = document.getElementById('browser-auth-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', tone === 'error');
  status.classList.toggle('is-success', tone === 'success');
}

function clearBrowserLoginPointer() {
  browserAuth.botUrl = '';
  try {
    sessionStorage.removeItem('bb_browser_login_url');
    sessionStorage.removeItem('bb_browser_login_expires');
  } catch (error) {}
}

function resetBrowserLoginRequest() {
  browserAuth.pending = false;
  browserAuth.launching = false;
  browserAuth.expiresAt = 0;
  clearBrowserLoginPointer();
  if (browserAuthPollTimer) clearInterval(browserAuthPollTimer);
  browserAuthPollTimer = null;
  const { card } = browserAuthElements();
  if (card) card.classList.remove('is-pending', 'is-success');
  setBrowserAuthButtonMode('idle');
  browserAuthSetStep(0);
}

function setBrowserAuthButtonMode(mode = 'idle') {
  const button = document.getElementById('browser-auth-button');
  if (!button) return;
  const telegramIcon = '<span class="browser-auth-button-icon browser-auth-telegram-logo" aria-hidden="true">'
    + '<svg viewBox="0 0 32 32"><path d="M27.7 5.3 23.8 26c-.3 1.5-1.1 1.9-2.3 1.2l-6-4.4-2.9 2.8c-.3.3-.6.6-1.2.6l.4-6.1L23 10c.5-.4-.1-.7-.7-.3L8.5 18.4l-5.9-1.9c-1.3-.4-1.3-1.3.3-1.9l23-8.9c1.1-.4 2.1.3 1.8 1.6Z"/></svg></span>';
  button.disabled = mode === 'opening';
  if (mode === 'opening') {
    button.innerHTML = telegramIcon
      + '<span><b>ОТКРЫВАЕМ TELEGRAM…</b><small>Создаём защищённый одноразовый запрос</small></span><i>···</i>';
  } else if (mode === 'pending') {
    button.innerHTML = telegramIcon
      + '<span><b>ОТКРЫТЬ TELEGRAM ЕЩЁ РАЗ</b><small>Затем нажми «Разрешить вход» в боте</small></span><i>→</i>';
  } else {
    button.innerHTML = telegramIcon
      + '<span><b>ВОЙТИ ЧЕРЕЗ TELEGRAM</b><small>Бот откроется для подтверждения</small></span><i>→</i>';
  }
}

function startBrowserLoginPolling() {
  if (browserAuthPollTimer) clearInterval(browserAuthPollTimer);
  browserAuthPollTimer = setInterval(() => { void pollBrowserLogin(); }, 1800);
}

async function pollBrowserLogin({ quietMissing = false } = {}) {
  try {
    const response = await RAW_FETCH(`${API}/api/browser-auth/status`, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.status === 'authenticated' && setBrowserSession(payload, false)) {
      browserAuth.pending = false;
      clearBrowserLoginPointer();
      if (browserAuthPollTimer) clearInterval(browserAuthPollTimer);
      browserAuthPollTimer = null;
      const { card } = browserAuthElements();
      if (card) { card.classList.remove('is-pending'); card.classList.add('is-success'); }
      browserAuthSetStep(2);
      browserAuthStatus('ВХОД ПОДТВЕРЖДЁН · ЗАПУСКАЕМ BRAINBET', 'success');
      setTimeout(() => {
        const screen = document.getElementById('browser-auth-screen');
        if (screen) screen.hidden = true;
        startBrainBetAfterConsent();
      }, 650);
      return true;
    }
    const status = String(
      payload.status || payload.error || (response.ok ? 'pending' : 'request_failed'),
    );
    if (status === 'pending' || status === 'confirmation_required') {
      browserAuth.pending = true;
      showBrowserAuthScreen();
      const { card } = browserAuthElements();
      if (card) card.classList.add('is-pending');
      browserAuthSetStep(1);
      setBrowserAuthButtonMode(browserAuth.botUrl ? 'pending' : 'opening');
      browserAuthStatus(
        status === 'confirmation_required'
          ? 'Запрос найден. Нажми «Разрешить вход» в сообщении бота.'
          : 'Открой Telegram, нажми START и затем разреши вход.',
      );
      return true;
    }
    if (status === 'denied') {
      resetBrowserLoginRequest();
      browserAuthStatus('Вход отклонён в Telegram. Можно создать новый запрос.', 'error');
      return false;
    }
    if (status === 'expired' || status === 'consumed' || status === 'not_found') {
      resetBrowserLoginRequest();
      if (!quietMissing) browserAuthStatus('Запрос входа закончился. Нажми кнопку и попробуй ещё раз.', 'error');
      return false;
    }
    if (status === 'browser_mismatch' || status === 'login_request_missing') {
      resetBrowserLoginRequest();
      if (!quietMissing) {
        browserAuthStatus(
          status === 'browser_mismatch'
            ? 'Запрос создан в другом браузере. Здесь войти по нему нельзя.'
            : 'Запрос входа не найден. Нажми кнопку и открой Telegram ещё раз.',
          'error',
        );
      }
      return false;
    }
    if (!response.ok) {
      if (!quietMissing) browserAuthStatus('Сервис входа временно недоступен. Попробуй ещё раз.', 'error');
      return false;
    }
    return false;
  } catch (error) {
    if (!quietMissing) browserAuthStatus('Связь прервалась — продолжаем ждать подтверждение…');
    return false;
  }
}

async function resumeBrowserLogin() {
  const active = await pollBrowserLogin({ quietMissing: true });
  if (active && !browserAuth.authenticated) startBrowserLoginPolling();
  return active;
}

function isMobileBrowserLogin() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    || Boolean(window.matchMedia?.('(pointer: coarse)').matches);
}

function prepareTelegramLoginWindow() {
  if (isMobileBrowserLogin()) return null;
  const popup = window.open('about:blank', 'brainbetTelegramLogin', 'popup=yes,width=520,height=760');
  if (!popup) return null;
  try {
    popup.opener = null;
    popup.document.title = 'BrainBet · Telegram';
    popup.document.body.style.cssText = 'margin:0;display:grid;place-items:center;min-height:100vh;background:#07100d;color:#dfffea;font:16px sans-serif';
    popup.document.body.textContent = 'Открываем Telegram…';
  } catch (error) {}
  return popup;
}

function openTelegramLogin(botUrl, preparedWindow = null) {
  if (isMobileBrowserLogin()) {
    window.location.assign(botUrl);
    return;
  }
  if (preparedWindow && !preparedWindow.closed) {
    preparedWindow.location.replace(botUrl);
    return;
  }
  const opened = window.open(botUrl, 'brainbetTelegramLogin', 'noopener,noreferrer');
  if (!opened) window.location.assign(botUrl);
}

async function startBrowserLogin() {
  if (browserAuth.launching) return;
  if (browserAuth.botUrl && browserAuth.pending) {
    openTelegramLogin(browserAuth.botUrl);
    browserAuthStatus('В Telegram нажми START, проверь аккаунт и разреши вход.');
    return;
  }
  const preparedWindow = prepareTelegramLoginWindow();
  browserAuth.launching = true;
  const { card } = browserAuthElements();
  setBrowserAuthButtonMode('opening');
  browserAuthStatus('Создаём одноразовый защищённый запрос…');
  try {
    const response = await RAW_FETCH(`${API}/api/browser-auth/start`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.bot_url) {
      throw new Error(payload.error || 'request_failed');
    }
    browserAuth.pending = true;
    browserAuth.botUrl = String(payload.bot_url);
    browserAuth.expiresAt = Number(payload.expires_at || 0);
    try {
      sessionStorage.setItem('bb_browser_login_url', browserAuth.botUrl);
      sessionStorage.setItem('bb_browser_login_expires', String(browserAuth.expiresAt));
    } catch (error) {}
    if (card) card.classList.add('is-pending');
    browserAuthSetStep(1);
    setBrowserAuthButtonMode('pending');
    browserAuthStatus('В Telegram нажми START, проверь аккаунт и выбери «Разрешить вход».');
    startBrowserLoginPolling();
    void pollBrowserLogin();
    openTelegramLogin(browserAuth.botUrl, preparedWindow);
  } catch (error) {
    if (preparedWindow && !preparedWindow.closed) preparedWindow.close();
    resetBrowserLoginRequest();
    browserAuthStatus(
      error.message === 'rate_limited'
        ? 'Слишком много попыток. Подожди несколько минут.'
        : 'Не удалось создать вход. Попробуй ещё раз.',
      'error',
    );
  } finally {
    browserAuth.launching = false;
    if (browserAuth.pending) setBrowserAuthButtonMode('pending');
  }
}

async function logoutBrowserSession() {
  if (!browserAuth.authenticated) return;
  try {
    await RAW_FETCH(`${API}/api/browser-auth/logout`, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-BrainBet-CSRF': browserAuth.csrfToken },
      body: '{}',
    });
  } finally {
    window.location.reload();
  }
}

function navIconMarkup(name) {
  return `<svg class="nav-icon" aria-hidden="true"><use href="#bb-icon-${name}"></use></svg>`;
}

const UI_THEME_KEY = 'bb_ui_theme';
// ULTRA is the released «Старый 2.0». Migrate older saved names rather
// than exposing a third skin in the appearance settings.
function normalizeUiTheme(theme) {
  return ['classic', 'classic-refresh', 'ultra'].includes(theme) ? 'ultra' : 'modern';
}
let uiThemeChoice = normalizeUiTheme(document.documentElement.dataset.uiDesign
  || (document.documentElement.dataset.classicVariant === 'refresh' || document.documentElement.dataset.uiTheme === 'classic' ? 'classic-refresh' : 'modern'));
let uiTheme = uiThemeChoice === 'modern' ? 'modern' : 'classic';

function updateUiThemeControls() {
  ['modern', 'ultra'].forEach(name => {
    const button = document.getElementById(`ui-theme-${name}`);
    if (!button) return;
    const active = uiThemeChoice === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function applyUiTheme(theme, persist = true, announce = false) {
  uiThemeChoice = normalizeUiTheme(theme);
  uiTheme = uiThemeChoice === 'modern' ? 'modern' : 'classic';
  document.documentElement.dataset.uiTheme = uiTheme;
  document.documentElement.dataset.uiDesign = uiThemeChoice;
  if (uiTheme !== 'modern') {
    document.documentElement.dataset.classicVariant = 'refresh';
  } else {
    delete document.documentElement.dataset.classicVariant;
  }

  const classic = uiTheme === 'classic';
  const maximalStyles = document.getElementById('ui-theme-modern-maximal');
  const modernStyles = document.getElementById('ui-theme-modern-v4');
  if (maximalStyles) maximalStyles.disabled = classic;
  if (modernStyles) modernStyles.disabled = classic;

  if (persist) {
    try { localStorage.setItem(UI_THEME_KEY, uiThemeChoice); } catch (e) {}
  }
  updateUiThemeControls();

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try { tg.setHeaderColor(uiThemeChoice === 'ultra' ? '#090f1e' : classic ? '#050507' : '#120704'); } catch (e) {}
    try { tg.setBackgroundColor(uiThemeChoice === 'ultra' ? '#060b16' : classic ? '#050507' : '#050302'); } catch (e) {}
  }
  // Both visual themes share the original sound engine; changing the skin
  // must not interrupt a live rocket's audio.
  window.dispatchEvent(new Event('resize'));
  if (document.documentElement.classList.contains('exchange-active')) {
    sendExchangeTheme();
  }
  if (persist && typeof redrawThemeGameSurfaces === 'function') {
    requestAnimationFrame(redrawThemeGameSurfaces);
  }
  if (announce && typeof showToast === 'function') {
    const message = uiThemeChoice === 'ultra' ? 'Включён Старый 2.0' : 'Включён Новый дизайн';
    showToast(message, 'win');
  }
}

function setUiTheme(theme) {
  document.documentElement.dataset.uiThemeChosen = 'true';
  applyUiTheme(theme, true, true);
  if (typeof refreshDesktopGameHub === 'function') {
    refreshDesktopGameHub(activeGameName() || 'coin', true);
  }
  if (typeof queueClientMetrics === 'function') queueClientMetrics();
}

function chooseInitialUiTheme(theme) {
  document.documentElement.dataset.uiThemeChosen = 'true';
  applyUiTheme(theme, true, false);
  if (typeof queueClientMetrics === 'function') queueClientMetrics();
}

applyUiTheme(uiThemeChoice, false, false);

// ── Подпись Telegram WebApp — сервер проверяет её, а не голый tg_id ──
// Сырая строка initData (не initDataUnsafe!) — только её можно проверить HMAC-подписью на бэке.
syncTelegramAuth();

const DISPLAY_MODE_KEY = 'bb_display_mode';
let telegramDisplayMode = 'fullscreen';
try {
  const savedMode = localStorage.getItem(DISPLAY_MODE_KEY);
  if (savedMode === 'normal' || savedMode === 'fullscreen') telegramDisplayMode = savedMode;
} catch (e) {}

function telegramSupports(version) {
  const tg = window.Telegram && window.Telegram.WebApp;
  return Boolean(tg && (typeof tg.isVersionAtLeast !== 'function' || tg.isVersionAtLeast(version)));
}

function updateTelegramDisplayControls(message = '') {
  const tg = window.Telegram && window.Telegram.WebApp;
  const normalBtn = document.getElementById('display-mode-normal');
  const fullBtn = document.getElementById('display-mode-fullscreen');
  if (normalBtn) {
    normalBtn.classList.toggle('active', telegramDisplayMode === 'normal');
    normalBtn.setAttribute('aria-pressed', telegramDisplayMode === 'normal' ? 'true' : 'false');
  }
  if (fullBtn) {
    fullBtn.classList.toggle('active', telegramDisplayMode === 'fullscreen');
    fullBtn.setAttribute('aria-pressed', telegramDisplayMode === 'fullscreen' ? 'true' : 'false');
  }

  const status = document.getElementById('display-mode-status');
  if (!status) return;
  if (message) status.textContent = message;
  else if (!tg) status.textContent = 'Режим применяется внутри Telegram';
  else if (tg.isFullscreen) status.textContent = 'Сейчас приложение занимает весь экран';
  else if (telegramDisplayMode === 'fullscreen' && !telegramSupports('8.0')) {
    status.textContent = 'Клиент Telegram поддерживает только максимальную высоту';
  } else status.textContent = 'Сейчас видна системная шапка Telegram';
}

function applyTelegramDisplayMode(mode = telegramDisplayMode, announce = false) {
  telegramDisplayMode = mode === 'normal' ? 'normal' : 'fullscreen';
  document.documentElement.dataset.telegramDisplayMode = telegramDisplayMode;
  try { localStorage.setItem(DISPLAY_MODE_KEY, telegramDisplayMode); } catch (e) {}

  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    try {
      if (telegramDisplayMode === 'fullscreen') {
        if (telegramSupports('8.0') && typeof tg.requestFullscreen === 'function') {
          if (!tg.isFullscreen) tg.requestFullscreen();
        } else if (typeof tg.expand === 'function') tg.expand();
      } else {
        if (telegramSupports('8.0') && typeof tg.exitFullscreen === 'function' && tg.isFullscreen) {
          tg.exitFullscreen();
        }
        if (typeof tg.expand === 'function') tg.expand();
      }
    } catch (e) {}
  }

  updateTelegramDisplayControls();
  if (announce && typeof showToast === 'function') {
    showToast(telegramDisplayMode === 'fullscreen' ? 'Полный экран включён' : 'Обычный режим включён', 'win');
  }
}

function setTelegramDisplayMode(mode) {
  applyTelegramDisplayMode(mode, true);
  if (typeof queueClientMetrics === 'function') queueClientMetrics();
}

function initTelegramViewport() {
  const tg = window.Telegram && window.Telegram.WebApp;
  const root = document.documentElement;
  root.classList.toggle(
    'is-telegram-webapp',
    Boolean(tg && (tg.initData || (tg.initDataUnsafe && tg.initDataUnsafe.user)))
  );
  const syncViewportMetrics = () => {
    const viewport = window.visualViewport;
    const currentHeight = Number(viewport && viewport.height) || Number(tg && tg.viewportHeight) || window.innerHeight;
    const stableHeight = Number(tg && tg.viewportStableHeight) || window.innerHeight || currentHeight;
    root.style.setProperty('--tg-viewport-height', `${Math.max(320, Math.round(currentHeight))}px`);
    root.style.setProperty('--tg-viewport-stable-height', `${Math.max(320, Math.round(stableHeight))}px`);

    const safe = (tg && tg.safeAreaInset) || {};
    const contentSafe = (tg && tg.contentSafeAreaInset) || {};
    ['top', 'right', 'bottom', 'left'].forEach(side => {
      root.style.setProperty(`--tg-safe-area-inset-${side}`, `${Math.max(0, Number(safe[side]) || 0)}px`);
      root.style.setProperty(`--tg-content-safe-area-inset-${side}`, `${Math.max(0, Number(contentSafe[side]) || 0)}px`);
    });
  };

  syncViewportMetrics();
  window.addEventListener('resize', syncViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener('resize', syncViewportMetrics, { passive: true });
  window.visualViewport?.addEventListener('scroll', syncViewportMetrics, { passive: true });
  if (!tg) {
    updateTelegramDisplayControls();
    return;
  }

  try { tg.ready(); } catch (e) {}
  if (telegramSupports('6.1')) {
    try { tg.setHeaderColor('#120704'); } catch (e) {}
    try { tg.setBackgroundColor('#050302'); } catch (e) {}
  }

  applyTelegramDisplayMode(telegramDisplayMode, false);
  document.addEventListener('pointerdown', () => {
    if (telegramDisplayMode === 'fullscreen' && !tg.isFullscreen) {
      applyTelegramDisplayMode('fullscreen', false);
    }
  }, { once: true, capture: true });

  if (typeof tg.onEvent === 'function') {
    tg.onEvent('viewportChanged', syncViewportMetrics);
    tg.onEvent('safeAreaChanged', syncViewportMetrics);
    tg.onEvent('contentSafeAreaChanged', syncViewportMetrics);
    tg.onEvent('fullscreenChanged', () => updateTelegramDisplayControls());
    tg.onEvent('fullscreenFailed', event => {
      if (telegramDisplayMode === 'fullscreen') {
        try { if (typeof tg.expand === 'function') tg.expand(); } catch (e) {}
      }
      updateTelegramDisplayControls(event && event.error === 'UNSUPPORTED'
        ? 'Полный экран не поддерживается этой версией Telegram'
        : 'Telegram не смог изменить режим экрана');
    });
  }
}

initTelegramViewport();

let accountBanTimer = null;
let accountBanReloadQueued = false;

function formatBanRemaining(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days) return `${days} дн. ${hours} ч. ${minutes} мин.`;
  if (hours) return `${hours} ч. ${minutes} мин. ${secs} сек.`;
  return `${minutes} мин. ${secs} сек.`;
}

function showAccountBanScreen(payload = {}) {
  const ban = payload.ban || payload;
  if (!ban || !ban.banned) return;

  const screen = document.getElementById('account-ban-screen');
  if (!screen) return;
  const reason = document.getElementById('account-ban-reason');
  const until = document.getElementById('account-ban-until');
  const countdown = document.getElementById('account-ban-countdown');
  const permanent = Boolean(ban.permanent) || Number(ban.banned_until || 0) === 0;
  const expiresAt = Number(ban.banned_until || 0);
  const serverAtOpen = Number(payload.server_time || Math.floor(Date.now() / 1000));
  const clientAtOpen = Date.now();

  reason.textContent = String(ban.reason || 'Причина не указана');
  until.textContent = permanent
    ? 'БЕССРОЧНО'
    : new Date(expiresAt * 1000).toLocaleString('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
  screen.hidden = false;
  document.documentElement.classList.add('account-banned');
  completeBrainBetBoot();

  clearInterval(accountBanTimer);
  if (permanent) {
    countdown.textContent = 'Без автоматического снятия';
    return;
  }

  const renderCountdown = () => {
    const serverNow = serverAtOpen + Math.floor((Date.now() - clientAtOpen) / 1000);
    const remaining = expiresAt - serverNow;
    if (remaining > 0) {
      countdown.textContent = `Осталось: ${formatBanRemaining(remaining)}`;
      return;
    }
    countdown.textContent = 'Срок закончился. Обновляем доступ...';
    clearInterval(accountBanTimer);
    if (!accountBanReloadQueued) {
      accountBanReloadQueued = true;
      setTimeout(() => window.location.reload(), 1200);
    }
  };
  renderCountdown();
  accountBanTimer = setInterval(renderCountdown, 1000);
}

// Автоматически прикрепляем init_data к каждому запросу на наш API,
// чтобы не переписывать вручную все fetch() по всему файлу.
(function patchFetchWithInitData() {
  window.fetch = async function(input, init = {}) {
    const url = (typeof input === 'string') ? input : (input && input.url) || '';
    let pathname = '';
    try { pathname = new URL(url, window.location.href).pathname; } catch (e) {}
    const browserAuthRoute = pathname.startsWith('/api/browser-auth/');
    if (url.startsWith(API)) {
      if (!browserAuthRoute) await ensureTelegramAuth();
      const method = (init.method || 'GET').toUpperCase();
      const headers = new Headers(init.headers || {});
      if (TG_INIT_DATA) {
        headers.set('X-Telegram-Init-Data', TG_INIT_DATA);
      }
      if (browserAuth.authenticated && browserAuth.csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
        headers.set('X-BrainBet-CSRF', browserAuth.csrfToken);
      }
      init = { ...init, headers, credentials: init.credentials || 'same-origin' };
      if (method !== 'GET' && method !== 'HEAD' && init.body) {
        try {
          const body = JSON.parse(init.body);
          if (TG_INIT_DATA) body.init_data = TG_INIT_DATA;
          init = { ...init, body: JSON.stringify(body) };
        } catch (e) { /* тело не JSON — не трогаем */ }
      }
    }
    const response = await RAW_FETCH(input, init);
    if (response.status === 403 && url.startsWith(API)) {
      response.clone().json().then(data => {
        if (data && data.error === 'user_banned') showAccountBanScreen(data);
      }).catch(() => {});
    }
    if (response.status === 428 && url.startsWith(API)) {
      response.clone().json().then(data => {
        if (data && data.error === 'terms_required') showTermsConsentScreen(data);
      }).catch(() => {});
    }
    if (response.status === 401 && url.startsWith(API) && !browserAuthRoute && browserAuth.authenticated) {
      browserAuth.authenticated = false;
      browserAuth.csrfToken = '';
      tg_id = 0;
      showBrowserAuthScreen('Сессия закончилась. Подтверди новый вход через Telegram.');
    }
    return response;
  };
})();

// ── Состояние ─────────────────────────────
let selectedColors = { r1: 'red', ffa: 'red' };
let isPlaying = false;
let _canTikTok = false;
let _tiktokStatus = null;
let _tiktokStatusBusy = false;
let _tiktokClaimBusy = false;
let _tiktokCountdownTimer = null;
let _tiktokCinematicTimers = [];
let _tiktokDigitTimer = null;

// Состояние монетки (пошаговая игра)
let coinState = {
  active: false,      // идёт ли сессия
  bet: 0,             // начальная ставка
  step: 0,            // текущий шаг (0 = ещё не крутили)
  currentPayout: 0,   // сколько можно забрать прямо сейчас
  sessionId: null     // id сессии (для backend)
};
let coinLoading = false;
let coinHydrated = false;

// Состояние комнат — переживает переключение вкладок
let roomState = {
  r1:  { room_id: null, bet: 0, waiting: false },  // 1v1
  ffa: { room_id: null, waiting: false }            // FFA очередь
};

// ── Инициализация ──────────────────────────
let _adminToken = null;   // хранится в памяти, не в localStorage
let _modToken   = null;   // mod-токен (только у модераторов/админов)
let _canRaffle  = false;  // доступ к розыгрышу (lucky_draw), не требует admin_token
 
// Глобальное состояние отыгрыша (обновляется при loadInit)
let wagerState = { required: 0, done: 0, remaining: 0, unlocked: true };

// Только визуальная частота карточек в прокрутке кейса за угадывание.
// Эти веса НЕ влияют на настоящий приз: результат уже выбран сервером.
// 0 полностью убирает предмет из фоновых карточек прокрутки.
const DEPOSIT_GUESS_REEL_WEIGHTS = Object.freeze({
  'Noobini Pizzanini': 6.11,
  'Lirili Larila': 6.11,
  'Fluriflura': 6.11,
  'Tim Cheese': 6.11,
  'Mastodontico Telepiedone': 6.11,
  'Jhon Pork': 16.11,
  'Skibidi Toilet': 16.11,
  'Meowl': 16.11,
  'Strawberry Elephant': 26.11,
});
let depositGuessBusy = false;
let depositGuessVisible = false;

function depositGuessImage(name) {
  return `${IMG_BASE}${caseSlug(name)}.webp`;
}

function presentDepositGuess(status) {
  if (!status?.pending || depositGuessVisible || depositGuessBusy) return;
  const overlay = document.getElementById('deposit-guess-overlay');
  if (!overlay) return;
  depositGuessVisible = true;
  document.getElementById('deposit-guess-form').hidden = false;
  document.getElementById('deposit-guess-lose').hidden = true;
  document.getElementById('deposit-guess-win').hidden = true;
  document.getElementById('deposit-guess-error').textContent = '';
  const input = document.getElementById('deposit-guess-input');
  input.value = '';
  overlay.hidden = false;
  setTimeout(() => input.focus(), 120);
}

function closeDepositGuess() {
  if (depositGuessBusy) return;
  const overlay = document.getElementById('deposit-guess-overlay');
  if (overlay) overlay.hidden = true;
  depositGuessVisible = false;
}

function depositGuessReelCard(item) {
  return `<article><img src="${depositGuessImage(item.name)}" alt=""><b>${escHtml(item.name)}</b></article>`;
}

function depositGuessVisualPick(pool) {
  if (!Array.isArray(pool) || !pool.length) return null;
  const weighted = pool.map(item => {
    const configured = Number(DEPOSIT_GUESS_REEL_WEIGHTS[item.name]);
    return {
      item,
      weight: Number.isFinite(configured) && configured >= 0 ? configured : 1,
    };
  });
  const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
  if (!(total > 0)) return pool[Math.floor(Math.random() * pool.length)];
  let roll = Math.random() * total;
  for (const entry of weighted) {
    roll -= entry.weight;
    if (roll < 0) return entry.item;
  }
  return weighted[weighted.length - 1].item;
}

function playDepositGuessCase(reward, rewardPool) {
  const win = document.getElementById('deposit-guess-win');
  const intro = document.getElementById('deposit-guess-case-intro');
  const status = document.getElementById('deposit-guess-win-status');
  const reel = document.getElementById('deposit-guess-reel');
  const reelWindow = document.getElementById('deposit-guess-reel-window');
  const prize = document.getElementById('deposit-guess-prize');
  const close = document.getElementById('deposit-guess-close-win');
  const pool = Array.isArray(rewardPool) && rewardPool.length ? rewardPool : [reward];
  const target = pool.find(item => item.name === reward.name) || reward;
  const sequence = Array.from({ length: 36 }, (_, index) => (
    index === 31 ? target : depositGuessVisualPick(pool)
  ));
  win.hidden = false;
  intro.hidden = false;
  intro.classList.remove('is-opening', 'is-burst');
  status.textContent = 'Секретный ящик разблокирован';
  reelWindow.hidden = true;
  prize.hidden = true;
  close.hidden = true;
  reel.classList.remove('spinning');
  reel.style.transform = 'translateX(0)';
  reel.innerHTML = sequence.map(depositGuessReelCard).join('');
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    intro.classList.add('is-opening');
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('heavy'); } catch (e) {}
  }, reduceMotion ? 20 : 160);
  setTimeout(() => intro.classList.add('is-burst'), reduceMotion ? 60 : 940);
  setTimeout(() => {
    intro.hidden = true;
    reelWindow.hidden = false;
    status.textContent = 'Ящик открыт — запускаем прокрутку';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const targetCenter = 8 + 31 * 104 + 48;
      const offset = targetCenter - reelWindow.clientWidth / 2;
      reel.classList.add('spinning');
      reel.style.transform = `translateX(${-Math.max(0, offset)}px)`;
    }));
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch (e) {}
    setTimeout(() => {
      prize.innerHTML = `<img src="${depositGuessImage(reward.name)}" alt=""><b>${escHtml(reward.name)}</b><small>${Number(reward.value || target.value || 0).toLocaleString('ru-RU')} 🧠 · предмет добавлен в инвентарь</small>`;
      prize.hidden = false;
      close.hidden = false;
      status.textContent = 'Твой предмет';
      depositGuessBusy = false;
    }, reduceMotion ? 350 : 3550);
  }, reduceMotion ? 120 : 1220);
}

async function submitDepositGuess(event) {
  event.preventDefault();
  if (depositGuessBusy) return;
  const input = document.getElementById('deposit-guess-input');
  const error = document.getElementById('deposit-guess-error');
  const raw = String(input.value || '').replace(/[\s\u00a0]/g, '');
  const amount = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(amount) || amount <= 0 || amount > 100000000) {
    error.textContent = 'Введи целое количество мозгов от 1 до 100 000 000.';
    input.focus();
    return;
  }
  depositGuessBusy = true;
  error.textContent = '';
  const submit = document.getElementById('deposit-guess-submit');
  submit.disabled = true;
  try {
    const response = await fetch(`${API}/api/deposit-guess/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.error === 'no_pending_guess') { depositGuessBusy = false; closeDepositGuess(); return; }
      throw new Error(data.error || 'guess_failed');
    }
    document.getElementById('deposit-guess-form').hidden = true;
    if (!data.won) {
      document.getElementById('deposit-guess-lose').hidden = false;
      depositGuessBusy = false;
      try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error'); } catch (e) {}
      return;
    }
    playDepositGuessCase(data.reward, data.rewardPool);
  } catch (requestError) {
    error.textContent = 'Не удалось проверить ответ. Попробуй ещё раз.';
    depositGuessBusy = false;
  } finally {
    submit.disabled = depositGuessBusy;
  }
}

document.getElementById('deposit-guess-form')?.addEventListener('submit', submitDepositGuess);
document.getElementById('deposit-guess-close-lose')?.addEventListener('click', closeDepositGuess);
document.getElementById('deposit-guess-close-win')?.addEventListener('click', closeDepositGuess);

async function loadInit({ background = false, signal } = {}) {
  try {
    if (signal?.aborted) return false;
    if (!background) brainBetBootStatus('СИНХРОНИЗИРУЕМ АККАУНТ', 'Загружаем баланс, права и настройки профиля…');
    // A settled game's background refresh must not restart login/consent or
    // the loading screen. The API still validates the existing credentials.
    const authenticated = background
      ? Boolean(tg_id > 0 && (TG_INIT_DATA || browserAuth.authenticated))
      : await ensureTelegramAuth();
    if (!authenticated || !(tg_id > 0)) return false;
    if (background ? !termsAccepted : !await ensureTermsAccepted()) return false;
    if (signal?.aborted) return false;
    const initUserId = Number(tg_id);
    const res  = await fetch(`${API}/api/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id }),
      signal
    });
    const data = await res.json();
    if (signal?.aborted || (background && Number(tg_id) !== initUserId)) return false;

    if (data?.error === 'user_banned') {
      showAccountBanScreen(data);
      return false;
    }

    if (!res.ok || !data || !data.user) {
      if (res.status === 401 || data?.error === 'no_tg_id') return false;
      throw new Error(data?.error || `Init failed: HTTP ${res.status}`);
    }
 
    // Баланс — только это показываем всем
    tg_id = Number(data.user.tg_id || tg_id || 0);
    updateBalanceDisplay(data.user.balance);

    // Сохраняем статус отыгрыша глобально
    if (data.wager) {
      wagerState = data.wager;
      updateWagerUI();
    }
    presentDepositGuess(data.depositGuess);
 
    // Если сервер вернул admin_token — мы админ
    if (data.admin_token) {
      _adminToken = data.admin_token;
      // Показываем кнопку "Игроки" только у нас
      const tab = document.getElementById('tab-admin');
      if (tab) tab.style.display = '';
      const analyticsTab = document.getElementById('tab-analytics');
      if (analyticsTab) analyticsTab.style.display = '';
    }

    if (data.can_tiktok) {
      _canTikTok = true;
      const tiktokTab = document.getElementById('tab-tiktok');
      if (tiktokTab) tiktokTab.style.display = '';
    }

    // Если сервер вернул mod_token — мы модератор/админ
    if (data.mod_token) {
      _modToken = data.mod_token;
      if (!document.getElementById('tab-tickets')) {
        const nav = document.querySelector('.nav');
        const btn = document.createElement('button');
        btn.className = 'nav-btn';
        btn.id = 'tab-tickets';
        btn.innerHTML = navIconMarkup('ticket') + '<span>Тикеты</span>';
        btn.onclick = () => showGame('tickets');
        nav.appendChild(btn);
        // Добавляем screen-tickets в showGame
      } else {
        document.getElementById('tab-tickets').style.display = '';
      }
    }

    // Право запуска розыгрыша отдельно от общей админки. Само колесо видно всем.
    if (data.can_raffle) {
      _canRaffle = true;
    }

    if (!background) {
      // Кнопка фри-слотов для whitelist: только при инициализации приложения.
      fsInit();
      brainBetBootStatus('ГОТОВО', 'Запускаем игровые режимы…');
      completeBrainBetBoot();
    }
    return true;
  } catch (e) {
    if (signal?.aborted) return false;
    console.error('Init error', e);
    if (!background) failBrainBetBoot('Сервер временно не ответил. Баланс и данные не были изменены.');
    return false;
  }
}

async function startBrainBetAfterConsent() {
  if (appConsentBootPromise) return appConsentBootPromise;
  appConsentBootPromise = (async () => {
    if (!await ensureTermsAccepted()) return false;
    const initialized = await loadInit();
    if (!initialized) return false;
    sendExchangeAuth();
    queueClientMetrics(true);
    if (!coinHydrated && activeGameName() === 'coin') coinLoad();
    return true;
  })().finally(() => {
    appConsentBootPromise = null;
  });
  return appConsentBootPromise;
}

function updateWagerUI() {
  const bar = document.getElementById('wager-bar-wrap');
  if (!bar) return;
  if (!wagerState.required || wagerState.unlocked) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'block';
  const pct = Math.min(100, Math.round((wagerState.done / wagerState.required) * 100));
  document.getElementById('wager-bar-fill').style.width = pct + '%';
  document.getElementById('wager-bar-text').textContent =
    `🎰 Отыгрыш: ${wagerState.done} / ${wagerState.required} 🧠  (осталось ${wagerState.remaining} 🧠)`;
}

// ── Навигация ──────────────────────────────
function activeGameName() {
  const active = document.querySelector('.screen.active');
  return active && active.id ? active.id.replace(/^screen-/, '') : '';
}

function isGameActive(name) {
  return !document.hidden && activeGameName() === name;
}

let exchangeFrameReady = false;
let exchangeFrameFallbackStarted = false;
let exchangeFrameFallbackTimer = null;

function exchangeFramePostOrigin(frame) {
  return isActiveExchangeFallback(frame) ? '*' : window.location.origin;
}

function isActiveExchangeFallback(frame) {
  if (!frame || frame.dataset.exchangeFallback !== '1') return false;
  try {
    return frame.contentDocument?.URL === 'about:srcdoc';
  } catch (error) {
    return false;
  }
}

function sendExchangeAuth() {
  const frame = document.getElementById('exchange-frame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({
    type: 'brainbet-exchange-auth',
    initData: TG_INIT_DATA || '',
    browserSession: Boolean(browserAuth.authenticated),
    csrfToken: browserAuth.csrfToken || '',
    parentTheme: uiTheme,
    ui_design: uiThemeChoice
  }, exchangeFramePostOrigin(frame));
}

function sendExchangeTheme() {
  const frame = document.getElementById('exchange-frame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({type: 'brainbet-exchange-theme', ui_design: uiThemeChoice, parentTheme: uiTheme}, exchangeFramePostOrigin(frame));
}

function sendExchangeNavigation(target = 'market') {
  const frame = document.getElementById('exchange-frame');
  if (!frame || !frame.contentWindow) return;
  frame.contentWindow.postMessage({
    type: 'brainbet-exchange-navigate',
    target
  }, exchangeFramePostOrigin(frame));
}

function rewriteExchangeDocumentAssets(html) {
  return String(html || '').replace(
    /(\b(?:href|src)=["'])(?!\/?\/|\/|#|data:|blob:|https?:)([^"']+)/gi,
    '$1/exchange/$2'
  );
}

async function loadExchangeFrameFallback() {
  if (exchangeFrameReady || exchangeFrameFallbackStarted) return;
  const frame = document.getElementById('exchange-frame');
  if (!frame) return;
  exchangeFrameFallbackStarted = true;
  try {
    const source = frame.getAttribute('src') || '/exchange/index.html';
    const response = await fetch(source, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    frame.dataset.exchangeFallback = '1';
    frame.srcdoc = rewriteExchangeDocumentAssets(await response.text());
  } catch (error) {
    exchangeFrameFallbackStarted = false;
    console.error('Не удалось загрузить резервное окно биржи:', error);
    showToast('Биржа временно недоступна — обнови окно', 'error');
  }
}

function ensureExchangeFrameAvailable() {
  if (exchangeFrameReady || exchangeFrameFallbackStarted) return;
  if (exchangeFrameFallbackTimer) clearTimeout(exchangeFrameFallbackTimer);
  exchangeFrameFallbackTimer = setTimeout(() => {
    exchangeFrameFallbackTimer = null;
    loadExchangeFrameFallback();
  }, 1200);
}

let exchangeReturnGame = 'coin';
let exchangeGatewayTimer = null;

function openExchangeGateway() {
  const gateway = document.getElementById('exchange-gateway');
  if (!gateway || gateway.classList.contains('is-opening')) return;

  gateway.classList.add('is-opening');
  if (exchangeGatewayTimer) clearTimeout(exchangeGatewayTimer);
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  exchangeGatewayTimer = setTimeout(() => {
    gateway.classList.remove('is-opening');
    exchangeGatewayTimer = null;
    showGame('exchange');
  }, reduceMotion ? 0 : 360);
}

window.addEventListener('message', (event) => {
  const exchangeFrame = document.getElementById('exchange-frame');
  const fromExchangeFrame = Boolean(exchangeFrame && event.source === exchangeFrame.contentWindow);
  const trustedExchangeOrigin = event.origin === window.location.origin
    || (isActiveExchangeFallback(exchangeFrame) && event.origin === 'null');
  if (!fromExchangeFrame || !trustedExchangeOrigin) return;
  if (event.data && event.data.type === 'brainbet-exchange-ready') {
    exchangeFrameReady = true;
    if (exchangeFrameFallbackTimer) clearTimeout(exchangeFrameFallbackTimer);
    exchangeFrameFallbackTimer = null;
    sendExchangeAuth();
    if (activeGameName() === 'exchange') sendExchangeNavigation('market');
  }
  if (event.data && event.data.type === 'brainbet-open-public-profile') {
    openPublicProfile(event.data.targetId);
  }
  if (event.data && event.data.type === 'brainbet-exchange-exit') {
    showGame(exchangeReturnGame || 'coin');
  }
});

function showGame(name) {
  if (name === 'analytics' && !_adminToken) return;
  if (name === 'tiktok' && !_canTikTok) return;
  if (name === 'exchange') {
    const currentGame = activeGameName();
    if (currentGame && currentGame !== 'exchange') exchangeReturnGame = currentGame;
  }
  if (name !== 'mr' && typeof mrPause === 'function') mrPause();
  if (name !== 'rocket' && typeof rocketStopPolling === 'function') rocketStopPolling();
  if (name !== 'brain-slots') window.brainSlotsPause?.();
  const exchangeActive = name === 'exchange';
  const rocketActive = name === 'rocket';
  document.documentElement.classList.toggle('exchange-active', exchangeActive);
  document.body.classList.toggle('exchange-active', exchangeActive);
  document.documentElement.classList.toggle('rocket-screen-active', rocketActive);
  document.body.classList.toggle('rocket-screen-active', rocketActive);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const targetScreen = document.getElementById(`screen-${name}`);
  if (!targetScreen) return;
  targetScreen.classList.add('active');
  const targetTab = document.getElementById(`tab-${name}`);
  if (targetTab) targetTab.classList.add('active');
  window.scrollTo({ top: 0, left: 0, behavior: 'auto' });

  if (name === 'roulette1v1') { drawWheel('r1-canvas', []); loadRooms1v1(); restoreR1State(); }
  if (name === 'rouletteFFA') { drawWheel('ffa-canvas', []); loadFFAStatus(); }
  if (name === 'shop')        { loadShop(); }
  if (name === 'inventory')   { loadInventory(); }
  if (name === 'exchange')    { ensureExchangeFrameAvailable(); sendExchangeAuth(); sendExchangeNavigation('market'); }
  if (name === 'cases')       { loadDailyLevelCase(); loadDepositRewardCases(); loadEventRelicCase(); loadCasePendingDrops(); mimikiCardRainInit(); }
  if (name === 'upgrader')    { ensureUpgraderWheelTheme(); upgLoad(); }
  if (name === 'craft')       { craftLoad(); }
  if (name === 'coin')        { coinLoad(); }
  if (name === 'resonance')   { resonanceLoad(); }
  if (name === 'mines')       { minesLoad(); }
  if (name === 'rocket')      { rocketStartPolling(); }
  if (name === 'freeslots')   { prismBuildArena(fsCount); }
  if (name === 'admin')   { loadAdminPanel(); loadPlayersScreen(); startOnlineCountPolling(); }
  else                    { stopOnlineCountPolling(); }
  if (name === 'analytics') { loadClientAnalytics(); }
  if (name === 'dice')    { diceBuildReels(); }
  if (name === 'brain-slots') { window.brainSlotsLoad?.(); }
  if (name === 'profile') { loadProfile(); }
  if (name === 'leaders') { lbLoad(); }
  if (name === 'faq')     { faqInit(); }
  if (name === 'tickets') { loadAllTickets(); }
  if (name === 'mr')      { mrInit(); }
  if (name === 'players') { loadPlayersScreen(); }
  if (name === 'tiktok') { loadTikTokCreator(); }
  if (typeof refreshDesktopGameHub === 'function') refreshDesktopGameHub(name);
}

const TIKTOK_CLAIM_STATUS = Object.freeze({
  checking: 'ПРОВЕРКА',
  paid: 'ВЫПЛАЧЕНО',
  cooldown: 'КУЛДАУН',
  below_minimum: 'МЕНЬШЕ 30',
  owner_mismatch: 'ЧУЖОЙ АККАУНТ',
  invalid_link: 'НЕВЕРНАЯ ССЫЛКА',
  offline: 'НЕ В ЭФИРЕ',
  age_restricted: 'ОГРАНИЧЕНИЕ',
  tiktok_blocked: 'ОШИБКА TIKTOK',
  timeout: 'ТАЙМАУТ',
  lookup_failed: 'ОШИБКА ПРОВЕРКИ',
  config_changed: 'НАСТРОЙКИ ИЗМЕНЕНЫ'
});

function tiktokNumber(value, maximumFractionDigits = 3) {
  return Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits });
}

function tiktokDuration(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(value / 3600);
  value %= 3600;
  const minutes = Math.floor(value / 60);
  const secs = value % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function tiktokDate(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return '—';
  return new Date(value * 1000).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function tiktokStatusClass(status) {
  if (status === 'paid') return 'is-paid';
  if (status === 'checking') return '';
  return 'is-error';
}

function tiktokHistoryRow(claim, admin = false) {
  const status = String(claim?.status || 'lookup_failed');
  const statusText = TIKTOK_CLAIM_STATUS[status] || status.toUpperCase();
  const viewerText = claim?.viewer_count == null ? '—' : tiktokNumber(claim.viewer_count, 0);
  const rewardText = status === 'paid'
    ? `+${tiktokNumber(claim.reward, 0)} 🧠 · отыгрыш ${tiktokNumber(claim.wager_added, 0)}`
    : statusText;
  const first = admin
    ? `#${Number(claim.id || 0)} · ID ${Number(claim.creator_tg_id || 0)}`
    : tiktokDate(claim.created_at);
  return `<article class="tiktok-history-row">
    <span title="${escHtml(first)}"><b>${escHtml(first)}</b></span>
    <span>👁 ${viewerText}</span>
    <span>×${tiktokNumber(Number(claim.coefficient_milli || 0) / 1000)}</span>
    <span class="${tiktokStatusClass(status)}">${escHtml(rewardText)}</span>
  </article>`;
}

function renderTikTokHistory(targetId, claims, admin = false) {
  const target = document.getElementById(targetId);
  if (!target) return;
  const rows = Array.isArray(claims) ? claims : [];
  target.innerHTML = rows.length
    ? rows.map(row => tiktokHistoryRow(row, admin)).join('')
    : '<div class="tiktok-history-empty">Проверок пока нет</div>';
}

function updateTikTokCountdown() {
  clearInterval(_tiktokCountdownTimer);
  const creator = _tiktokStatus?.creator;
  if (!creator) return;
  const cooldown = document.getElementById('tiktok-cooldown');
  const badge = document.getElementById('tiktok-ready-badge');
  const button = document.getElementById('tiktok-claim-button');
  const render = () => {
    const remaining = Math.max(0, Number(creator.cooldown_until || 0) - Math.floor(Date.now() / 1000));
    if (cooldown) cooldown.textContent = remaining ? tiktokDuration(remaining) : 'СЕЙЧАС';
    if (badge) {
      badge.textContent = remaining ? 'ОЖИДАНИЕ' : 'ГОТОВО';
      badge.classList.toggle('is-cooldown', Boolean(remaining));
    }
    if (button && !_tiktokClaimBusy) button.disabled = Boolean(remaining);
    if (!remaining) clearInterval(_tiktokCountdownTimer);
  };
  render();
  if (Number(creator.cooldown_until || 0) > Math.floor(Date.now() / 1000)) {
    _tiktokCountdownTimer = setInterval(render, 1000);
  }
}

function renderTikTokCreator(data) {
  _tiktokStatus = data;
  const loading = document.getElementById('tiktok-loading');
  const creatorCard = document.getElementById('tiktok-creator-card');
  const adminCard = document.getElementById('tiktok-admin-card');
  if (loading) loading.hidden = true;

  const creator = data?.creator;
  if (creatorCard) creatorCard.hidden = !creator || !creator.active;
  if (creator && creator.active) {
    document.getElementById('tiktok-account-name').textContent = `@${creator.tiktok_username}`;
    document.getElementById('tiktok-rate').textContent = `${tiktokNumber(creator.reward_per_viewer)} 🧠`;
    document.getElementById('tiktok-limit').textContent = tiktokNumber(creator.viewer_limit, 0);
    document.getElementById('tiktok-minimum').textContent = tiktokNumber(data.rules?.minimum_viewers || 30, 0);
    renderTikTokHistory('tiktok-own-history', data.claims, false);
    updateTikTokCountdown();
  }

  const admin = data?.admin;
  if (adminCard) adminCard.hidden = !data?.is_admin;
  if (data?.is_admin && admin) {
    document.getElementById('tiktok-admin-creators').textContent = tiktokNumber(admin.creator_count, 0);
    document.getElementById('tiktok-admin-paid').textContent = `${tiktokNumber(admin.total_paid, 0)} 🧠`;
    document.getElementById('tiktok-admin-paid-day').textContent = `${tiktokNumber(admin.paid_24h, 0)} 🧠`;
    document.getElementById('tiktok-admin-claims').textContent = tiktokNumber(admin.successful_claims, 0);
    renderTikTokHistory('tiktok-admin-history', admin.recent_claims, true);
  }
}

async function loadTikTokCreator(force = false) {
  if (!_canTikTok || _tiktokStatusBusy) return;
  if (!force && _tiktokStatus && Date.now() - Number(_tiktokStatus.loadedAt || 0) < 12000) {
    renderTikTokCreator(_tiktokStatus);
    return;
  }
  _tiktokStatusBusy = true;
  const loading = document.getElementById('tiktok-loading');
  if (loading && !_tiktokStatus) {
    loading.hidden = false;
    loading.textContent = 'ПРОВЕРЯЕМ ДОСТУП…';
  }
  try {
    const response = await fetch(`${API}/api/tiktok/status`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'status_failed');
    data.loadedAt = Date.now();
    renderTikTokCreator(data);
  } catch (error) {
    if (loading) {
      loading.hidden = false;
      loading.textContent = 'НЕ УДАЛОСЬ ЗАГРУЗИТЬ TIKTOK. НАЖМИ ↻';
    }
  } finally {
    _tiktokStatusBusy = false;
  }
}

function tiktokReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function tiktokWait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, tiktokReducedMotion() ? 0 : milliseconds));
}

function clearTikTokCinematicTimers() {
  _tiktokCinematicTimers.forEach(timer => clearTimeout(timer));
  _tiktokCinematicTimers = [];
  clearInterval(_tiktokDigitTimer);
  _tiktokDigitTimer = null;
}

function setTikTokStageText(kicker, title, unit) {
  const kickerNode = document.getElementById('tiktok-stage-kicker');
  const titleNode = document.getElementById('tiktok-stage-title');
  const unitNode = document.getElementById('tiktok-stage-unit');
  if (kickerNode) kickerNode.textContent = kicker;
  if (titleNode) {
    titleNode.textContent = title;
    titleNode.dataset.text = title;
  }
  if (unitNode) unitNode.textContent = unit;
}

function setTikTokStageStep(activeIndex, completedThrough = activeIndex - 1) {
  document.querySelectorAll('#tiktok-live-stage [data-tt-step]').forEach((step, index) => {
    step.classList.toggle('is-active', index === activeIndex);
    step.classList.toggle('is-done', index <= completedThrough);
  });
}

function hideTikTokCinematic(immediate = false) {
  clearTikTokCinematicTimers();
  const stage = document.getElementById('tiktok-live-stage');
  const form = document.getElementById('tiktok-claim-form');
  if (!stage) return;
  const finish = () => {
    stage.hidden = true;
    stage.className = 'tiktok-live-stage';
    if (form) form.classList.remove('is-suspended');
  };
  if (immediate || tiktokReducedMotion()) {
    finish();
    return;
  }
  stage.classList.add('is-leaving');
  const timer = setTimeout(finish, 350);
  _tiktokCinematicTimers.push(timer);
}

function startTikTokClaimAnimation() {
  clearTikTokCinematicTimers();
  const stage = document.getElementById('tiktok-live-stage');
  const form = document.getElementById('tiktok-claim-form');
  const number = document.getElementById('tiktok-stage-number');
  const particles = document.getElementById('tiktok-stage-particles');
  if (!stage) return;
  stage.hidden = false;
  stage.className = 'tiktok-live-stage is-checking';
  if (form) form.classList.add('is-suspended');
  if (particles) particles.replaceChildren();
  if (number) number.textContent = '000';

  const phases = [
    ['SECURITY // OWNER MATCH', 'ПРОВЕРЯЕМ АККАУНТ', 'СВЕРЯЕМ ВЛАДЕЛЬЦА', 0],
    ['TIKTOK // LIVE SIGNAL', 'ИЩЕМ ПРЯМОЙ ЭФИР', 'ПОДКЛЮЧЕНИЕ К КОМНАТЕ', 1],
    ['AUDIENCE // REALTIME', 'СЧИТАЕМ ЗРИТЕЛЕЙ', 'ЖИВАЯ АУДИТОРИЯ', 2],
  ];
  const applyPhase = index => {
    const phase = phases[Math.min(index, phases.length - 1)];
    setTikTokStageText(phase[0], phase[1], phase[2]);
    setTikTokStageStep(phase[3], phase[3] - 1);
  };
  applyPhase(0);
  phases.slice(1).forEach((_, index) => {
    const timer = setTimeout(() => applyPhase(index + 1), (index + 1) * 1350);
    _tiktokCinematicTimers.push(timer);
  });
  if (!tiktokReducedMotion()) {
    _tiktokDigitTimer = setInterval(() => {
      if (number) number.textContent = String(Math.floor(Math.random() * 1000)).padStart(3, '0');
    }, 74);
  }
}

function animateTikTokStageNumber(to, duration = 900, prefix = '') {
  const node = document.getElementById('tiktok-stage-number');
  const target = Math.max(0, Math.floor(Number(to || 0)));
  if (!node || tiktokReducedMotion()) {
    if (node) node.textContent = `${prefix}${tiktokNumber(target, 0)}`;
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const start = performance.now();
    const frame = now => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);
      node.textContent = `${prefix}${tiktokNumber(Math.round(target * eased), 0)}`;
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}

function buildTikTokRewardParticles() {
  const container = document.getElementById('tiktok-stage-particles');
  if (!container || tiktokReducedMotion()) return;
  container.replaceChildren();
  const total = 38;
  for (let index = 0; index < total; index += 1) {
    const particle = document.createElement('i');
    const angle = (Math.PI * 2 * index / total) + (Math.random() - .5) * .34;
    const distance = 90 + Math.random() * 190;
    particle.textContent = index % 4 === 0 ? '🧠' : index % 3 === 0 ? '+' : '◆';
    particle.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
    particle.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
    particle.style.setProperty('--r', `${Math.round((Math.random() - .5) * 520)}deg`);
    particle.style.setProperty('--size', `${10 + Math.round(Math.random() * 14)}px`);
    particle.style.setProperty('--duration', `${.9 + Math.random() * .75}s`);
    particle.style.setProperty('--delay', `${Math.random() * .13}s`);
    if (index % 3 === 1) particle.style.color = 'var(--tt-pink)';
    if (index % 3 === 2) particle.style.color = '#fbffae';
    container.appendChild(particle);
  }
}

async function playTikTokSuccessAnimation(data) {
  clearTikTokCinematicTimers();
  const stage = document.getElementById('tiktok-live-stage');
  const claim = data?.claim || {};
  if (!stage) return;
  stage.hidden = false;
  stage.className = 'tiktok-live-stage is-success';
  setTikTokStageStep(3, 2);
  setTikTokStageText(
    `LIVE // @${claim.resolved_username || _tiktokStatus?.creator?.tiktok_username || 'CREATOR'}`,
    'ЭФИР ПОДТВЕРЖДЁН',
    Number(claim.viewer_count || 0) > Number(claim.eligible_viewers || 0)
      ? `ЗРИТЕЛЕЙ · ЛИМИТ ${tiktokNumber(claim.eligible_viewers, 0)}`
      : 'ЗРИТЕЛЕЙ В ЭФИРЕ'
  );
  await animateTikTokStageNumber(claim.viewer_count, 880);
  try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium'); } catch (e) {}
  await tiktokWait(380);

  stage.classList.add('is-reward');
  setTikTokStageStep(3, 3);
  setTikTokStageText('BRAINBET // PAYOUT COMPLETE', 'ВЫПЛАТА РАЗБЛОКИРОВАНА', 'МОЗГОВ ЗАЧИСЛЕНО');
  buildTikTokRewardParticles();
  await animateTikTokStageNumber(data.reward, 1050, '+');
  try {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('heavy');
    setTimeout(() => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'), 140);
  } catch (e) {}
  await tiktokWait(1050);
  hideTikTokCinematic();
  await tiktokWait(360);
}

async function playTikTokErrorAnimation(data) {
  clearTikTokCinematicTimers();
  const stage = document.getElementById('tiktok-live-stage');
  if (!stage) return;
  const error = String(data?.error || 'lookup_failed');
  const titles = {
    owner_mismatch: 'АККАУНТ НЕ СОВПАЛ',
    offline: 'ЭФИР НЕ НАЙДЕН',
    below_minimum: 'МАЛО ЗРИТЕЛЕЙ',
    cooldown: 'ВЫПЛАТА НА ПАУЗЕ',
    invalid_link: 'ССЫЛКА НЕ ПОДОШЛА',
    tiktok_user_not_found: 'АККАУНТ НЕ НАЙДЕН',
    tiktok_timeout: 'СИГНАЛ ПОТЕРЯН',
    lookup_rate_limited: 'СЛИШКОМ МНОГО ПРОВЕРОК'
  };
  stage.hidden = false;
  stage.className = 'tiktok-live-stage is-error';
  setTikTokStageText('SIGNAL // VERIFICATION FAILED', titles[error] || 'ПРОВЕРКА НЕ ПРОШЛА', 'ВЫПЛАТА НЕ НАЧИСЛЕНА');
  const number = document.getElementById('tiktok-stage-number');
  if (number) number.textContent = error === 'below_minimum' && data?.claim?.viewer_count != null
    ? tiktokNumber(data.claim.viewer_count, 0)
    : 'ERR';
  try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('error'); } catch (e) {}
  await tiktokWait(920);
  hideTikTokCinematic();
  await tiktokWait(360);
}

function tiktokClaimErrorMessage(data) {
  const error = String(data?.error || 'lookup_failed');
  const claim = data?.claim || {};
  const viewers = claim.viewer_count == null ? null : Number(claim.viewer_count);
  const messages = {
    invalid_link: 'Нужна ссылка именно на активную трансляцию вида tiktok.com/@username/live.',
    tiktok_user_not_found: 'TikTok-аккаунт из ссылки не найден.',
    owner_mismatch: 'Это трансляция другого аккаунта. Выплата доступна только за привязанный аккаунт.',
    offline: 'Привязанный аккаунт сейчас не ведёт трансляцию.',
    below_minimum: viewers == null ? 'Для выплаты нужно минимум 30 зрителей.' : `Сейчас ${tiktokNumber(viewers, 0)} зрителей. Для выплаты нужно минимум 30.`,
    cooldown: 'Выплата уже была получена. Следующая станет доступна после окончания таймера.',
    claim_in_progress: 'Проверка уже выполняется. Подожди её завершения.',
    age_restricted: 'TikTok ограничил доступ к этой трансляции по возрасту.',
    tiktok_blocked: 'TikTok временно не дал проверить эфир. Попробуй позже.',
    tiktok_timeout: 'TikTok слишком долго отвечает. Попробуй ещё раз через минуту.',
    lookup_rate_limited: `Слишком много проверок. Повтори через ${tiktokDuration(data?.retry_after || 60)}.`,
    config_changed: 'Настройки автора изменились во время проверки. Обнови раздел и повтори.',
    lookup_failed: 'Не удалось проверить трансляцию. Попробуй чуть позже.'
  };
  return messages[error] || 'Не удалось выполнить выплату.';
}

async function claimTikTokReward(event) {
  event.preventDefault();
  if (_tiktokClaimBusy) return;
  const input = document.getElementById('tiktok-live-url');
  const resultBox = document.getElementById('tiktok-result');
  const button = document.getElementById('tiktok-claim-button');
  const liveUrl = String(input?.value || '').trim();
  if (!/^https?:\/\/(?:[^/]+\.)?tiktok\.com\//i.test(liveUrl)) {
    resultBox.hidden = false;
    resultBox.className = 'tiktok-result is-error';
    resultBox.textContent = 'Вставь полную ссылку на TikTok-трансляцию.';
    return;
  }

  _tiktokClaimBusy = true;
  button.disabled = true;
  button.classList.add('is-busy');
  button.querySelector('span').textContent = 'СЧИТАЕМ ЗРИТЕЛЕЙ…';
  resultBox.hidden = true;
  resultBox.className = 'tiktok-result';
  startTikTokClaimAnimation();
  const requestId = (window.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, '_');
  try {
    const response = await fetch(`${API}/api/tiktok/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ live_url: liveUrl, request_id: requestId })
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      await playTikTokErrorAnimation(data);
      resultBox.hidden = false;
      resultBox.className = 'tiktok-result is-error';
      resultBox.textContent = tiktokClaimErrorMessage(data);
    } else {
      const claim = data.claim || {};
      const capped = Number(claim.viewer_count || 0) > Number(claim.eligible_viewers || 0);
      const wagerAdded = Number(data.wager_added ?? claim.wager_added ?? 0);
      await playTikTokSuccessAnimation(data);
      resultBox.hidden = false;
      resultBox.className = 'tiktok-result is-success';
      resultBox.innerHTML = `<b>+${tiktokNumber(data.reward, 0)} 🧠 начислено</b><br>` +
        `Назначен отыгрыш: <b>${tiktokNumber(wagerAdded, 0)} 🧠</b><br>` +
        `Зрителей: ${tiktokNumber(claim.viewer_count, 0)}${capped ? ` · в расчёт вошло ${tiktokNumber(claim.eligible_viewers, 0)}` : ''}.`;
      if (data.balance != null) updateBalanceDisplay(data.balance);
      if (input) input.value = '';
    }
    await loadTikTokCreator(true);
  } catch (error) {
    await playTikTokErrorAnimation({ error: 'lookup_failed' });
    resultBox.hidden = false;
    resultBox.className = 'tiktok-result is-error';
    resultBox.textContent = 'Соединение прервалось. Если выплата прошла, она уже записана в истории.';
  } finally {
    _tiktokClaimBusy = false;
    button.classList.remove('is-busy');
    button.querySelector('span').textContent = 'ПРОВЕРИТЬ И ПОЛУЧИТЬ';
    updateTikTokCountdown();
  }
}

// ══════════════════════════════════════════════════════════════════════
// DESKTOP PLAYER DECK — useful lower layer for the wide classic preview.
// All values come from protected history/achievement endpoints; the panel
// never invents progress merely to fill the screen.
// ══════════════════════════════════════════════════════════════════════
const DESKTOP_GAME_HUB_MODES = Object.freeze({
  coin:          { label: 'МОНЕТКА', types: ['coin'] },
  resonance:     { label: 'РОТДЕК', types: ['resonance'] },
  mines:         { label: 'МИНЫ', types: ['mines'] },
  rocket:        { label: 'РАКЕТКА', types: ['rocket'] },
  cases:         { label: 'КЕЙСЫ', prefix: 'case_' },
  upgrader:      { label: 'АПГРЕЙДЕР', types: ['upgrader'] },
  craft:         { label: 'КРАФТ', types: ['craft', 'event_craft'] },
  roulette1v1:   { label: '1VS1', types: ['duel_1v1'] },
  rouletteFFA:   { label: 'JACKPOT', types: ['ffa_roulette', 'ffa_queue'] },
  mr:            { label: 'РУЛЕТКА', types: ['mr'] },
  dice:          { label: 'DICE', types: ['slots'] },
  'brain-slots': { label: 'СЛОТЫ', types: ['brain_slots'] },
  freeslots:     { label: 'ПРИЗМА', types: ['freeslots'] }
});

let desktopGameHubCache = { history: [], achievements: null, loadedAt: 0 };
let desktopGameHubRequest = null;
let desktopGameHubTimer = null;

function desktopGameHubConfig(name) {
  return DESKTOP_GAME_HUB_MODES[String(name || '')] || null;
}

function desktopGameHubHistoryFor(name, history) {
  const config = desktopGameHubConfig(name);
  if (!config) return [];
  return (Array.isArray(history) ? history : []).filter(item => {
    const type = String(item?.game_type || '');
    if (config.prefix) return type.startsWith(config.prefix);
    return config.types.includes(type);
  });
}

function desktopGameHubNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function desktopGameHubFormat(value, signed = false) {
  const number = desktopGameHubNumber(value);
  const prefix = signed && number > 0 ? '+' : '';
  return `${prefix}${Math.round(number).toLocaleString('ru-RU')}`;
}

function desktopGameHubIsWin(item) {
  return ['win', 'jackpot', 'craft_up', 'event_craft_success'].includes(String(item?.result || ''));
}

function desktopGameHubTime(value) {
  let date;
  if (typeof value === 'number') date = new Date(value * 1000);
  else if (/^\d+(?:\.\d+)?$/.test(String(value || ''))) date = new Date(Number(value) * 1000);
  else date = new Date(value || 0);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function desktopGameHubNearestAchievements(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const unfinished = items.filter(item => !item.completed && desktopGameHubNumber(item.target) > 0);
  unfinished.sort((a, b) => {
    const progressA = desktopGameHubNumber(a.value) / Math.max(1, desktopGameHubNumber(a.target));
    const progressB = desktopGameHubNumber(b.value) / Math.max(1, desktopGameHubNumber(b.target));
    return progressB - progressA || desktopGameHubNumber(a.target) - desktopGameHubNumber(b.target);
  });
  return unfinished.slice(0, 3);
}

function desktopGameHubEnsure(name) {
  const config = desktopGameHubConfig(name);
  const screen = document.getElementById(`screen-${name}`);
  if (!config || !screen) return null;
  let hub = document.getElementById('desktop-game-hub');
  if (!hub) {
    hub = document.createElement('section');
    hub.id = 'desktop-game-hub';
    hub.className = 'desktop-game-hub';
    hub.setAttribute('aria-live', 'polite');
  }
  if (hub.parentElement !== screen) screen.appendChild(hub);
  hub.dataset.mode = name;
  return hub;
}

function desktopGameHubLoading(hub, label) {
  hub.innerHTML = `<header class="game-hub-heading"><div><small>PLAYER DECK // ${escHtml(label)}</small><b>ИГРОВОЙ ЦЕНТР</b></div><span>СИНХРОНИЗАЦИЯ...</span></header><div class="game-hub-loading"><i></i><i></i><i></i></div>`;
}

function desktopGameHubUnavailable(hub, label) {
  hub.innerHTML = `<header class="game-hub-heading"><div><small>PLAYER DECK // ${escHtml(label)}</small><b>ИГРОВОЙ ЦЕНТР</b></div><button type="button" onclick="refreshDesktopGameHub(activeGameName(),true)">ОБНОВИТЬ</button></header><div class="game-hub-empty"><b>ДАННЫЕ ПОЯВЯТСЯ В TELEGRAM</b><span>Здесь будут ближайшие достижения, показатели режима и последние ставки.</span></div>`;
}

function renderDesktopGameHub(name, cache = desktopGameHubCache) {
  const config = desktopGameHubConfig(name);
  const hub = desktopGameHubEnsure(name);
  if (!config || !hub) return;

  const achievements = cache.achievements || {};
  const nearest = desktopGameHubNearestAchievements(achievements);
  const history = desktopGameHubHistoryFor(name, cache.history).slice(0, 30);
  const recent = history.slice(0, 4);
  const wins = history.filter(desktopGameHubIsWin).length;
  const turnover = history.reduce((sum, item) => sum + desktopGameHubNumber(item.bet), 0);
  const bestMultiplier = history.reduce((best, item) => Math.max(best, desktopGameHubNumber(item.multiplier)), 0);
  const achievementCards = nearest.length ? nearest.map(item => {
    const value = Math.max(0, desktopGameHubNumber(item.value));
    const target = Math.max(1, desktopGameHubNumber(item.target));
    const progress = Math.max(0, Math.min(100, value / target * 100));
    return `<article class="game-hub-achievement"><strong>${escHtml(item.icon || 'AP')}</strong><div><b>${escHtml(item.title || 'Достижение')}</b><span>${escHtml(item.description || '')}</span><i><u style="width:${progress.toFixed(2)}%"></u></i><small>${desktopGameHubFormat(value)} / ${desktopGameHubFormat(target)}</small></div><em>+${desktopGameHubFormat(item.points)} AP</em></article>`;
  }).join('') : '<div class="game-hub-card-empty"><b>ВСЁ ВЫПОЛНЕНО</b><span>Новых целей пока нет</span></div>';
  const recentRows = recent.length ? recent.map(item => {
    const won = desktopGameHubIsWin(item);
    const multiplier = desktopGameHubNumber(item.multiplier);
    return `<article class="game-hub-history-row ${won ? 'is-win' : 'is-lose'}"><i>${won ? 'W' : 'L'}</i><div><b>${desktopGameHubFormat(item.bet)} 🧠</b><span>${desktopGameHubTime(item.created_at)}${multiplier > 0 ? ` · x${multiplier.toFixed(multiplier >= 10 ? 1 : 2).replace(/\.0+$/, '')}` : ''}</span></div><strong>${desktopGameHubFormat(item.profit, true)} 🧠</strong></article>`;
  }).join('') : '<div class="game-hub-card-empty"><b>НЕТ ИГР</b><span>Первая ставка появится здесь</span></div>';

  hub.innerHTML = `<header class="game-hub-heading"><div><small>PLAYER DECK // ${escHtml(config.label)}</small><b>ИГРОВОЙ ЦЕНТР</b></div><div class="game-hub-heading-actions"><span>${desktopGameHubFormat(achievements.completed)} / ${desktopGameHubFormat(achievements.total)} ДОСТИЖЕНИЙ · ${desktopGameHubFormat(achievements.points)} AP</span><button type="button" onclick="showGame('profile')">ОТКРЫТЬ ПРОФИЛЬ</button></div></header><div class="game-hub-grid"><section class="game-hub-card game-hub-achievements"><header><span>БЛИЖАЙШИЕ ДОСТИЖЕНИЯ</span><b>ПРОГРЕСС</b></header><div>${achievementCards}</div></section><section class="game-hub-card game-hub-mode-stats"><header><span>${escHtml(config.label)}</span><b>НЕДАВНИЕ</b></header><div class="game-hub-kpis"><article><small>ИГРЫ</small><b>${desktopGameHubFormat(history.length)}</b></article><article><small>ПОБЕДЫ</small><b>${desktopGameHubFormat(wins)}</b></article><article><small>ОБОРОТ</small><b>${desktopGameHubFormat(turnover)}</b></article><article><small>ЛУЧШИЙ X</small><b>${bestMultiplier > 0 ? `x${bestMultiplier.toFixed(bestMultiplier >= 10 ? 1 : 2).replace(/\.0+$/, '')}` : '—'}</b></article></div></section><section class="game-hub-card game-hub-history"><header><span>ПОСЛЕДНИЕ РЕЗУЛЬТАТЫ</span><b>LIVE</b></header><div>${recentRows}</div></section></div>`;
}

async function refreshDesktopGameHub(name = activeGameName(), force = false) {
  const config = desktopGameHubConfig(name);
  if (!config || !['classic-refresh', 'ultra'].includes(uiThemeChoice)) {
    document.getElementById('desktop-game-hub')?.remove();
    return;
  }
  const hub = desktopGameHubEnsure(name);
  if (!hub) return;
  if (!hasClientIdentity() || !termsAccepted) {
    desktopGameHubUnavailable(hub, config.label);
    return;
  }
  if (!force && desktopGameHubCache.loadedAt && Date.now() - desktopGameHubCache.loadedAt < 15000) {
    renderDesktopGameHub(name);
    return;
  }
  if (desktopGameHubRequest) {
    try {
      await desktopGameHubRequest;
      renderDesktopGameHub(name);
    } catch (_) {
      desktopGameHubUnavailable(hub, config.label);
    }
    return;
  }
  desktopGameHubLoading(hub, config.label);
  desktopGameHubRequest = Promise.all([
    fetch(`${API}/api/history?limit=100`, { headers: { 'X-Telegram-Init-Data': TG_INIT_DATA } }),
    fetch(`${API}/api/profile/achievements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': TG_INIT_DATA },
      body: JSON.stringify({ init_data: TG_INIT_DATA })
    })
  ]).then(async ([historyResponse, achievementResponse]) => {
    if (!historyResponse.ok || !achievementResponse.ok) throw new Error('hub_load_failed');
    const [history, achievements] = await Promise.all([historyResponse.json(), achievementResponse.json()]);
    desktopGameHubCache = {
      history: Array.isArray(history) ? history : [],
      achievements: achievements && !achievements.error ? achievements : null,
      loadedAt: Date.now()
    };
  }).finally(() => { desktopGameHubRequest = null; });
  try {
    await desktopGameHubRequest;
    renderDesktopGameHub(name);
  } catch (_) {
    desktopGameHubUnavailable(hub, config.label);
  }
}

function scheduleDesktopGameHubRefresh() {
  if (!['classic-refresh', 'ultra'].includes(uiThemeChoice) || window.innerWidth < 1280 || !document.getElementById('desktop-game-hub')) return;
  if (desktopGameHubCache.loadedAt && Date.now() - desktopGameHubCache.loadedAt < 2500) return;
  if (desktopGameHubTimer) clearTimeout(desktopGameHubTimer);
  desktopGameHubTimer = setTimeout(() => {
    desktopGameHubTimer = null;
    desktopGameHubCache.loadedAt = 0;
    refreshDesktopGameHub(activeGameName(), true);
  }, 700);
}

setTimeout(() => refreshDesktopGameHub(activeGameName() || 'coin'), 900);

// ── Виджет онлайна — создаётся программно, если его нет в HTML ─────
function ensureOnlineWidget() {
  if (document.getElementById('adm-online-count')) return; // уже есть

  const list = document.getElementById('admin-players-list');
  if (!list || !list.parentNode) return;

  const box = document.createElement('div');
  box.style.cssText = `
    background:var(--surface);border:1px solid var(--border);
    border-radius:12px;padding:12px 14px;margin-bottom:12px;
    display:flex;justify-content:space-between;align-items:center;
  `;
  box.innerHTML = `
    <span style="font-size:13px;color:var(--text-dim)">🟢 Сейчас в мини-аппе</span>
    <span id="adm-online-count" style="font-family:'Orbitron',sans-serif;font-size:18px;color:var(--green)">...</span>
  `;
  list.parentNode.insertBefore(box, list);
}

// ── Живой счётчик онлайна (только пока открыта вкладка admin) ──────
let _onlineCountInterval = null;

async function fetchOnlineCount() {
  if (!_adminToken) return;
  try {
    const res = await fetch(`${API}/api/admin/online_count?tg_id=${tg_id}`, {
      headers: { 'X-Admin-Token': _adminToken }
    });
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('adm-online-count');
    if (el) el.textContent = `${data.online_count ?? 0}`;
  } catch (e) { /* тихо игнорируем */ }
}

function startOnlineCountPolling() {
  if (_onlineCountInterval) return; // уже запущено
  fetchOnlineCount();
  _onlineCountInterval = setInterval(fetchOnlineCount, 7000);
}

function stopOnlineCountPolling() {
  if (_onlineCountInterval) {
    clearInterval(_onlineCountInterval);
    _onlineCountInterval = null;
  }
}

let faqActiveSection = 'start';

function faqInit() {
  const screen = document.getElementById('screen-faq');
  if (!screen || screen.dataset.faqReady === '1') return;
  screen.dataset.faqReady = '1';

  const items = [...screen.querySelectorAll('.faq-item')];
  items.forEach((item, index) => {
    const question = item.querySelector('.faq-q');
    if (!question) return;
    const answer = item.querySelector('.faq-a');
    const answerId = `faq-answer-${index + 1}`;
    if (answer) answer.id = answerId;
    question.setAttribute('role', 'button');
    question.setAttribute('tabindex', '0');
    question.setAttribute('aria-expanded', 'false');
    if (answer) question.setAttribute('aria-controls', answerId);
    question.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      faqToggle(question);
    });
  });

  screen.querySelectorAll('.faq-tab').forEach(tab => {
    const match = String(tab.getAttribute('onclick') || '').match(/faqTab\('([^']+)'/);
    const section = match ? document.getElementById(`faqsec-${match[1]}`) : null;
    const count = section ? section.querySelectorAll('.faq-item').length : 0;
    const badge = tab.querySelector('small');
    if (badge) badge.textContent = String(count);
  });

  const total = items.length;
  const totalEl = document.getElementById('faq-total-count');
  const visibleEl = document.getElementById('faq-visible-count');
  if (totalEl) totalEl.textContent = String(total);
  if (visibleEl) visibleEl.textContent = String(total);
}

function faqTab(name, btn) {
  faqInit();
  const input = document.getElementById('faq-search-input');
  if (input && input.value) {
    input.value = '';
    faqSearch('');
  }
  faqActiveSection = name;
  document.querySelectorAll('#screen-faq .faq-section').forEach(section => {
    section.hidden = false;
    section.classList.toggle('active', section.id === `faqsec-${name}`);
  });
  document.querySelectorAll('#screen-faq .faq-tab').forEach(tab => {
    const active = tab === btn;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  if (window.innerWidth < 900) btn?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
}

function faqToggle(el) {
  const item = el?.closest('.faq-item');
  if (!item) return;
  const open = !item.classList.contains('open');
  item.classList.toggle('open', open);
  el.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function faqSearch(value) {
  faqInit();
  const screen = document.getElementById('screen-faq');
  if (!screen) return;
  const query = String(value || '').trim().toLocaleLowerCase('ru-RU');
  const searching = query.length > 0;
  const sections = [...screen.querySelectorAll('.faq-section')];
  let visible = 0;

  screen.classList.toggle('faq-searching', searching);
  sections.forEach(section => {
    let sectionMatches = 0;
    section.querySelectorAll('.faq-item').forEach(item => {
      const matches = !searching || item.textContent.toLocaleLowerCase('ru-RU').includes(query);
      item.hidden = !matches;
      if (matches) {
        visible += 1;
        sectionMatches += 1;
      }
    });
    section.hidden = searching && sectionMatches === 0;
    section.classList.toggle('active', searching || section.id === `faqsec-${faqActiveSection}`);
  });

  const total = screen.querySelectorAll('.faq-item').length;
  const clear = document.getElementById('faq-search-clear');
  const empty = document.getElementById('faq-empty');
  const status = document.getElementById('faq-search-status');
  const visibleEl = document.getElementById('faq-visible-count');
  if (clear) clear.hidden = !searching;
  if (empty) empty.hidden = !searching || visible > 0;
  if (visibleEl) visibleEl.textContent = String(searching ? visible : total);
  if (status) status.textContent = searching
    ? `По запросу «${String(value).trim()}» найдено: ${visible}`
    : 'Показываем все ответы';
}

function faqClearSearch() {
  const input = document.getElementById('faq-search-input');
  if (input) input.value = '';
  faqSearch('');
  input?.focus();
}
// Функция для вызова кастомного окна подтверждения
function showConfirm(title, text) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('custom-confirm-overlay');
    document.getElementById('confirm-title').innerText = title;
    document.getElementById('confirm-text').innerText = text;
    
    overlay.style.display = 'flex';
    
    document.getElementById('confirm-btn-ok').onclick = () => {
      overlay.style.display = 'none';
      resolve(true);
    };
    
    document.getElementById('confirm-btn-cancel').onclick = () => {
      overlay.style.display = 'none';
      resolve(false);
    };
  });
}
// ── Быстрые ставки ─────────────────────────
function setQuickBet(inputId, val) {
  document.getElementById(inputId).value = val;
}

// ── Обновление баланса на экране ────────────
function formatCompactBalance(balance) {
  const value = Math.floor(Number(balance));
  if (!Number.isFinite(value)) return '—';
  const absolute = Math.abs(value);
  const units = [
    [1e15, 'Q'],
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ];
  for (const [threshold, suffix] of units) {
    if (absolute < threshold) continue;
    const scaled = value / threshold;
    const precision = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
    return `${scaled.toFixed(precision).replace(/\.?0+$/, '')}${suffix}`;
  }
  return value.toLocaleString('ru-RU');
}

function updateBalanceDisplay(balance) {
  const el = document.getElementById('balance');
  const value = Math.floor(Number(balance));
  if (!el || !Number.isFinite(value)) return;
  const fullBalance = `${value.toLocaleString('ru-RU')} мозгов`;
  el.dataset.balance = String(value);
  el.innerText = `${formatCompactBalance(value)} 🧠`;
  el.title = fullBalance;
  el.setAttribute('aria-label', fullBalance);
  if (typeof scheduleDesktopGameHubRefresh === 'function') {
    scheduleDesktopGameHubRefresh();
  }
}

function getDisplayedBalance() {
  const el = document.getElementById('balance');
  const exact = Number(el?.dataset.balance);
  return Number.isFinite(exact) ? exact : (parseInt(el?.innerText, 10) || 0);
}

// ── Тост ───────────────────────────────────
function showToast(msg, type = '') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast ${type} show`;
  setTimeout(() => t.classList.remove('show'), 3000);
}

// ── Результат ──────────────────────────────
function showResult(boxId, { win, title, detail, detailHtml = false, amount }) {
  const box = document.getElementById(boxId);
  box.style.display = 'block';
  box.className = `result-box ${win ? 'result-win' : 'result-lose'}`;
  box.innerHTML = `
    <div class="result-title">${escHtml(title)}</div>
    <div class="result-detail">${detailHtml ? detail : escHtml(detail)}</div>
    ${amount !== undefined ? `<div class="result-amount">${amount > 0 ? '+' : ''}${amount} 🧠</div>` : ''}
  `;
}

// ══════════════════════════════════════════
// МОНЕТКА — пошаговая
// ══════════════════════════════════════════

const COIN_MULTS = [2, 4, 8, 16, 32];
const COIN_MIN_SPIN_MS = 700;

function coinMinimumSpinMs() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 320;
  return uiThemeChoice === 'classic-refresh' ? 820 : COIN_MIN_SPIN_MS;
}

function coinBeginSpin(coin) {
  coin.classList.remove('spinning', 'coin-win', 'coin-lose');
  void coin.offsetWidth;
  coin.classList.add('spinning');
  return performance.now();
}

async function coinFinishSpin(coin, result, startedAt) {
  const remaining = coinMinimumSpinMs() - (performance.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
  coin.classList.remove('spinning', 'coin-win', 'coin-lose');
  void coin.offsetWidth;
  coin.classList.add(result === 'lose' ? 'coin-lose' : 'coin-win');
  const settleMs = uiThemeChoice === 'classic-refresh'
    ? (result === 'lose' ? 220 : 180)
    : (result === 'lose' ? 420 : 300);
  await sleep(settleMs);
}

function resetCoinUI({ keepResult = false } = {}) {
  for (let i = 1; i <= 5; i++) {
    document.getElementById(`step-${i}`).className = 'step';
  }
  if (!keepResult) document.getElementById('coin-result').style.display = 'none';
  document.getElementById('coin-bet').disabled = false;
  document.querySelectorAll('.qbet').forEach(b => b.disabled = false);

  document.getElementById('coin')?.classList.remove('spinning', 'coin-win', 'coin-lose');

  const btn = document.getElementById('coin-btn');
  btn.style.display = 'block';
  btn.innerHTML = '<span>БРОСИТЬ</span>';
  btn.onclick = playCoin;
  btn.disabled = false;
}

function showCoinActions() {
  const step = coinState.step;
  const payout = coinState.currentPayout;
  const isLast = step >= 5;

  // Показываем текущий результат с кнопками
  const box = document.getElementById('coin-result');
  box.style.display = 'block';
  box.className = 'result-box result-win';
  box.innerHTML = `
    <div class="result-title">✅ x${COIN_MULTS[step - 1]} — можно забрать!</div>
    <div class="result-detail">Ставка: ${coinState.bet} 🧠 · Шаг: ${step}/5</div>
    <div class="result-amount">+${payout} 🧠</div>
    ${!isLast ? `
    <div style="display:flex;gap:10px;margin-top:14px">
      <button onclick="coinTakePayout()" style="flex:1;padding:13px;background:var(--green);border:none;border-radius:10px;color:#000;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:900;letter-spacing:2px;cursor:pointer">💰 ЗАБРАТЬ</button>
      <button onclick="coinNextStep()" style="flex:1;padding:13px;background:var(--accent);border:none;border-radius:10px;color:#000;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:900;letter-spacing:2px;cursor:pointer">🎲 ДАЛЬШЕ x${COIN_MULTS[step]}</button>
    </div>` : `
    <div style="margin-top:14px">
      <button onclick="coinTakePayout()" style="width:100%;padding:13px;background:var(--gold);border:none;border-radius:10px;color:#000;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:900;letter-spacing:2px;cursor:pointer">🏆 ЗАБРАТЬ x32!</button>
    </div>`}
  `;

  // Прячем основную кнопку броска
  document.getElementById('coin-btn').style.display = 'none';
  document.getElementById('coin-bet').disabled = true;
  document.querySelectorAll('.qbet').forEach(button => { button.disabled = true; });
}

function coinApplySessionState(data = {}) {
  const active = Boolean(data.active && Number(data.step) > 0);
  if (!active) {
    coinState = { active: false, bet: 0, step: 0, currentPayout: 0, sessionId: null };
    resetCoinUI();
    return;
  }
  const step = Math.max(1, Math.min(5, Number(data.step || 1)));
  coinState = {
    active: true,
    bet: Number(data.bet || 0),
    step,
    currentPayout: Number(data.current_payout ?? data.payout ?? 0),
    sessionId: data.session_id || data.history_id || null,
  };
  document.getElementById('coin-bet').value = String(coinState.bet);
  for (let index = 1; index <= 5; index += 1) {
    document.getElementById(`step-${index}`).className = index <= step ? 'step done' : 'step';
  }
  document.getElementById('coin')?.classList.remove('spinning', 'coin-lose');
  document.getElementById('coin')?.classList.add('coin-win');
  showCoinActions();
}

async function coinLoad(force = false) {
  if (coinLoading || (isPlaying && !force)) return;
  coinLoading = true;
  let authenticated = false;
  try {
    authenticated = await ensureTelegramAuth();
    if (!authenticated || !hasClientIdentity() || !termsAccepted) return;
    const response = await fetch(`${API}/api/coin/state?tg_id=${tg_id}&_=${Date.now()}`, {
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'coin_state_failed');
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
    if (data.status === 'processing') {
      const retryAfter = Math.max(300, Math.min(3000, Number(data.retry_after_ms || 900)));
      setTimeout(() => coinLoad(true), retryAfter);
      return;
    }
    coinApplySessionState(data);
    if (data.recovered) showToast(`Сессия восстановлена · возвращено ${Number(data.refund || 0)} 🧠`, 'win');
  } catch (error) {
    console.error('[coin] state restore failed', error);
    if (force) showToast('Не удалось восстановить монетку. Повторяем…', 'lose');
    if (!coinState.active) resetCoinUI();
  } finally {
    coinLoading = false;
    // Keep this false when the call was skipped before authentication so the
    // first post-login boot can hydrate the active coin game normally.
    coinHydrated = authenticated && hasClientIdentity() && termsAccepted;
  }
}

async function playCoin() {
  if (isPlaying || coinState.active) return;
  const bet = parseInt(document.getElementById('coin-bet').value);
  if (!bet || bet < 1) { showToast('Введи ставку!'); return; }

  isPlaying = true;
  const btn = document.getElementById('coin-btn');
  btn.disabled = true;
  document.getElementById('coin-bet').disabled = true;
  document.querySelectorAll('.qbet').forEach(b => b.disabled = true);

  // Сбрасываем шаги
  for (let i = 1; i <= 5; i++) {
    document.getElementById(`step-${i}`).className = 'step';
  }
  document.getElementById('coin-result').style.display = 'none';

  const coin = document.getElementById('coin');
  const spinStarted = coinBeginSpin(coin);

  try {
    const res = await fetch(`${API}/api/coin/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, bet, step: 1 })
    });
    const data = await res.json();

    if (data.error) {
      coin.classList.remove('spinning');
      if (data.error === 'active_session' || data.error === 'session_busy') {
        await coinLoad(true);
      } else {
        showToast(data.error === 'insufficient_balance' ? 'Недостаточно баланса!' : data.error, 'lose');
        resetCoinUI();
      }
      isPlaying = false;
      return;
    }

    if (data.resumed) {
      coin.classList.remove('spinning');
      coinApplySessionState(data);
      showToast('Незавершённый раунд восстановлен', 'win');
      isPlaying = false;
      return;
    }

    await coinFinishSpin(coin, data.result, spinStarted);

    // Подсвечиваем шаг 1
    document.getElementById('step-1').className = 'step active';

    if (data.result === 'lose') {
      await sleep(400);
      document.getElementById('step-1').className = 'step';
      showResult('coin-result', {
        win: false,
        title: '💀 ПРОИГРЫШ на x2',
        detail: `Ставка: ${bet} 🧠 — не повезло с первого броска`,
        amount: -bet
      });
      showToast(`-${bet} 🧠`, 'lose');
      btn.style.display = 'block';
      resetCoinUI({ keepResult: true });
      loadInit();
    } else {
      // Выиграли первый шаг
      document.getElementById('step-1').className = 'step done';
      coinState = { active: true, bet, step: 1, currentPayout: data.payout, sessionId: data.session_id || null };
      showCoinActions();
      loadInit();
    }
  } catch (e) {
    console.error(e);
    coin.classList.remove('spinning');
    await coinLoad(true);
  }

  isPlaying = false;
}

async function coinNextStep() {
  if (isPlaying || !coinState.active) return;
  if (coinState.step >= 5) return;

  isPlaying = true;
  const nextStep = coinState.step + 1;

  // Прячем кнопки в боксе пока крутим
  document.getElementById('coin-result').querySelector('div[style]')?.remove();
  const btn = document.getElementById('coin-btn');

  const coin = document.getElementById('coin');
  const spinStarted = coinBeginSpin(coin);

  try {
    const res = await fetch(`${API}/api/coin/step`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, bet: coinState.bet, step: nextStep, session_id: coinState.sessionId })
    });
    const data = await res.json();

    if (data.error) {
      coin.classList.remove('spinning');
      await coinLoad(true);
      isPlaying = false;
      return;
    }

    await coinFinishSpin(coin, data.result, spinStarted);

    // Подсвечиваем текущий шаг
    document.getElementById(`step-${nextStep}`).className = 'step active';
    await sleep(300);

    if (data.result === 'lose') {
      // Проигрыш — всё потеряно
      document.getElementById(`step-${nextStep}`).className = 'step';
      const box = document.getElementById('coin-result');
      box.style.display = 'block';
      box.className = 'result-box result-lose';
      box.innerHTML = `
        <div class="result-title">💀 ПРОИГРЫШ на x${COIN_MULTS[nextStep - 1]}</div>
        <div class="result-detail">Ставка: ${coinState.bet} 🧠 — было x${COIN_MULTS[coinState.step - 1]}, рискнул и проиграл</div>
        <div class="result-amount">-${coinState.bet} 🧠</div>
      `;
      showToast(`-${coinState.bet} 🧠`, 'lose');
      coinState.active = false;
      btn.style.display = 'block';
      resetCoinUI({ keepResult: true });
      loadInit();
    } else {
      // Выиграли следующий шаг
      document.getElementById(`step-${nextStep}`).className = 'step done';
      coinState.step = nextStep;
      coinState.currentPayout = data.payout;
      showCoinActions();
      loadInit();
    }
  } catch (e) {
    console.error(e);
    coin.classList.remove('spinning');
    await coinLoad(true);
  }

  isPlaying = false;
}

async function coinTakePayout() {
  if (isPlaying || !coinState.active) return;
  isPlaying = true;

  try {
    const response = await fetch(`${API}/api/coin/cashout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, payout: coinState.currentPayout, bet: coinState.bet, session_id: coinState.sessionId })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'cashout_failed');

    const payout = Number(data.payout || coinState.currentPayout);
    const mult = COIN_MULTS[coinState.step - 1];

    const box = document.getElementById('coin-result');
    box.style.display = 'block';
    box.className = 'result-box result-win';
    box.innerHTML = `
      <div class="result-title">🎉 ВЫИГРЫШ x${mult}!</div>
      <div class="result-detail">Ставка: ${coinState.bet} 🧠 · Забрал на шаге ${coinState.step}/5</div>
      <div class="result-amount">+${payout} 🧠</div>
    `;
    showToast(`+${payout} 🧠`, 'win');

    coinState.active = false;
    resetCoinUI({ keepResult: true });
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
    loadInit();
  } catch (error) {
    console.error('[coin] cashout failed', error);
    await coinLoad(true);
  } finally {
    isPlaying = false;
  }
}

// ══════════════════════════════════════════
// РЕЗОНАНС — три карты и один серверный сигнал
// ══════════════════════════════════════════

const RESONANCE_DEFAULT_PAYTABLE = {
  0: 0, 1: 1, 2: 1.4, 3: 1.75, 4: 2.7, 5: 4.6
};
const RESONANCE_SCRATCH_REVEAL_THRESHOLD = 0.75;
let resonanceBusy = false;
let resonanceState = {
  active: false,
  status: 'idle',
  bet: 0,
  cards: [],
  replacement_used: false,
  replaced_index: null,
  paytable: RESONANCE_DEFAULT_PAYTABLE
};
const resonanceScratch = {
  sessionId: null,
  initializedFor: null,
  pointerDown: false,
  lastPoint: null,
  moveCount: 0,
  progress: 0,
  revealPromise: null,
  payload: null,
  locking: false,
  quick: false,
  completing: false,
};

function resonanceApplyState(data = {}) {
  const active = Boolean(data.active);
  const status = String(data.status || (active ? 'active' : 'idle'));
  const resolved = status === 'resolved';
  const revealed = Boolean(resolved && data.revealed && data.signal);
  resonanceState = {
    ...resonanceState,
    ...data,
    active,
    status,
    bet: Number(data.bet || 0),
    cards: Array.isArray(data.cards) ? data.cards : [],
    replacement_used: Boolean(data.replacement_used),
    replaced_index: data.replaced_index != null ? Number(data.replaced_index) : null,
    scratch_ready: Boolean(resolved && data.scratch_ready),
    revealed,
    signal: revealed ? data.signal : null,
    score: revealed ? Number(data.score || 0) : null,
    multiplier: revealed ? Number(data.multiplier || 0) : null,
    payout: revealed ? Number(data.payout || 0) : null,
    result: revealed ? String(data.result || 'lose') : null,
  };
}

function resonanceErrorText(error) {
  return {
    insufficient_balance: 'Недостаточно баланса',
    invalid_bet: 'Ставка должна быть от 1 до 100 000 000',
    active_session: 'Сначала заверши текущий раунд',
    invalid_card: 'Выбери одну из трёх карт',
    replacement_used: 'Замена в этом раунде уже использована',
    no_active_session: 'Этот раунд уже завершён',
    scratch_pending: 'Сначала сотри защитный слой текущего билета',
    no_scratch_ticket: 'Билет для стирания не найден',
    session_busy: 'Раунд уже обрабатывается',
    bank_unavailable: 'Код временно недоступен',
    no_tg_id: 'Открой игру через Telegram'
  }[error] || 'Не удалось выполнить действие';
}

async function resonanceRequest(path, options = {}) {
  await ensureTelegramAuth();
  const response = await fetch(`${API}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let data = {};
  try { data = await response.json(); } catch (e) {}
  if (!response.ok) {
    const error = new Error(resonanceErrorText(data.error));
    error.code = data.error;
    throw error;
  }
  return data;
}

function resonanceMultiplier(value) {
  const number = Number(value || 0);
  return `x${Number.isInteger(number) ? number.toFixed(0) : number.toFixed(2).replace(/0$/, '')}`;
}

function resonanceCardMatch(card, signal) {
  if (!signal) return '';
  const faction = card.faction === signal.faction;
  const frequency = Number(card.frequency) === Number(signal.frequency);
  if (faction && frequency) return 'is-match-exact';
  if (faction) return 'is-match-faction';
  if (frequency) return 'is-match-frequency';
  return 'is-match-none';
}

function resonanceMatchBadge(matchClass) {
  return ({
    'is-match-exact': '<span class="resonance-match-badge exact">+3 ТОЧНО</span>',
    'is-match-faction': '<span class="resonance-match-badge suit">+1 МАСТЬ</span>',
    'is-match-frequency': '<span class="resonance-match-badge rank">+1 ЦИФРА</span>',
    'is-match-none': '<span class="resonance-match-badge none">0</span>'
  })[matchClass] || '';
}

function resonanceCardMarkup(card, index) {
  const replaced = resonanceState.replaced_index != null
    && Number(resonanceState.replaced_index) === index;
  const canReplace = resonanceState.active && !resonanceState.replacement_used && !resonanceScratch.locking;
  const matchClass = resonanceState.revealed
    ? resonanceCardMatch(card, resonanceState.signal) : '';
  const classes = ['resonance-card', `faction-${card.faction}`, matchClass];
  if (replaced) classes.push('is-replaced');
  const replaceControl = replaced && resonanceState.active
    ? '<span class="resonance-card-replace is-used"><span>✓</span><b>ЗАМЕНЕНА</b></span>'
    : `<button type="button" class="resonance-card-replace ${canReplace ? '' : 'is-unavailable'}"
         onclick="resonanceReplace(${index})" ${canReplace && !resonanceBusy ? '' : 'disabled'}
         aria-label="Заменить карту ${index + 1}"><span>↻</span><b>ЗАМЕНИТЬ</b></button>`;
  return `<article class="${classes.filter(Boolean).join(' ')}"
      data-faction="${escHtml(card.faction)}">
    <span class="resonance-suit-mark" aria-hidden="true">${escHtml(card.faction_icon)}</span>
    <span class="resonance-card-frequency"><i>ЦИФРА</i><b>${Number(card.frequency)}</b></span>
    <span class="resonance-card-art"><img src="${escHtml(card.image_url)}" data-case-name="${escHtml(card.name)}" alt="" onerror="imgFail(this)"></span>
    <strong>${escHtml(card.name)}</strong>
    ${replaceControl}
    <span class="resonance-card-faction"><i>${escHtml(card.faction_icon)}</i>${escHtml(card.faction_label)}</span>
    ${resonanceMatchBadge(matchClass)}
    ${replaced ? '<em>НОВАЯ</em>' : ''}
  </article>`;
}

function resonanceSignalMarkup() {
  const signal = resonanceScratch.payload?.signal || resonanceState.signal;
  if (!signal) {
    return '<span class="resonance-signal-glyph">?</span><small>НЕИЗВЕСТЕН</small>';
  }
  return `<span class="resonance-suit-mark" aria-hidden="true">${escHtml(signal.faction_icon)}</span>
    <span class="resonance-signal-frequency"><i>ЦИФРА</i><b>${Number(signal.frequency)}</b></span>
    <span class="resonance-signal-art"><img src="${escHtml(signal.image_url)}" data-case-name="${escHtml(signal.name)}" alt="" onerror="imgFail(this)"></span>
    <span class="resonance-signal-name">${escHtml(signal.name)}</span>
    <strong>${escHtml(signal.faction_icon)} ${escHtml(signal.faction_label)}</strong>`;
}

function resonanceRenderPaytable() {
  const grid = document.getElementById('resonance-paytable-grid');
  if (!grid) return;
  const table = resonanceState.paytable || RESONANCE_DEFAULT_PAYTABLE;
  grid.innerHTML = Array.from({ length: 6 }, (_, score) =>
    `<span><b>${score}</b>${resonanceMultiplier(table[String(score)] ?? table[score])}</span>`
  ).join('');
}

function resonanceScratchIsPending() {
  return Boolean(
    !resonanceState.revealed
    && (resonanceState.active || resonanceState.scratch_ready)
  );
}

function resonanceResetScratch(sessionId = null) {
  resonanceScratch.sessionId = sessionId;
  resonanceScratch.initializedFor = null;
  resonanceScratch.pointerDown = false;
  resonanceScratch.lastPoint = null;
  resonanceScratch.moveCount = 0;
  resonanceScratch.progress = 0;
  resonanceScratch.revealPromise = null;
  resonanceScratch.payload = null;
  resonanceScratch.locking = false;
  resonanceScratch.quick = false;
  resonanceScratch.completing = false;
}

function resonanceUpdateScratchProgress(value) {
  resonanceScratch.progress = Math.max(0, Math.min(1, Number(value || 0)));
  const percent = Math.round(resonanceScratch.progress * 100);
  const bar = document.getElementById('resonance-scratch-progress');
  const label = document.getElementById('resonance-scratch-percent');
  if (bar) bar.style.width = `${percent}%`;
  if (label) label.textContent = `${percent}%`;
}

function resonanceDrawScratchFoil(canvas) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // The cover is a RotDeck neural seal rather than generic silver foil.
  const ultraFoil = uiThemeChoice === 'ultra';
  const cover = ctx.createLinearGradient(0, 0, rect.width, rect.height);
  cover.addColorStop(0, '#06151a');
  cover.addColorStop(.34, '#0b2d31');
  cover.addColorStop(.62, ultraFoil ? '#122b49' : '#15142c');
  cover.addColorStop(1, ultraFoil ? '#0c182d' : '#24160d');
  ctx.fillStyle = cover;
  ctx.fillRect(0, 0, rect.width, rect.height);

  const cyanGlow = ctx.createRadialGradient(
    rect.width * .18, rect.height * .18, 0,
    rect.width * .18, rect.height * .18, rect.width * .82
  );
  cyanGlow.addColorStop(0, 'rgba(61, 238, 222, .28)');
  cyanGlow.addColorStop(.45, 'rgba(42, 172, 183, .08)');
  cyanGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = cyanGlow;
  ctx.fillRect(0, 0, rect.width, rect.height);

  const goldGlow = ctx.createRadialGradient(
    rect.width * .9, rect.height * .9, 0,
    rect.width * .9, rect.height * .9, rect.width * .72
  );
  goldGlow.addColorStop(0, ultraFoil ? 'rgba(130, 207, 255, .28)' : 'rgba(244, 201, 79, .24)');
  goldGlow.addColorStop(.48, ultraFoil ? 'rgba(130, 207, 255, .06)' : 'rgba(213, 127, 37, .06)');
  goldGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = goldGlow;
  ctx.fillRect(0, 0, rect.width, rect.height);

  // Circuit traces and scan lines make the seal part of RotDeck's code theme.
  ctx.globalAlpha = .46;
  ctx.strokeStyle = '#238f98';
  ctx.lineWidth = Math.max(.6, rect.width * .004);
  for (let x = -rect.height; x < rect.width + rect.height; x += 22) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + rect.height, rect.height);
    ctx.stroke();
  }
  ctx.globalAlpha = .18;
  ctx.strokeStyle = '#b9ffff';
  ctx.lineWidth = 1;
  for (let y = 5; y < rect.height; y += 6) {
    ctx.beginPath();
    ctx.moveTo(0, y + .5);
    ctx.lineTo(rect.width, y + .5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const centerX = rect.width / 2;
  const centerY = rect.height * .42;
  const sealRadius = Math.max(25, rect.width * .22);
  ctx.strokeStyle = 'rgba(94, 246, 226, .82)';
  ctx.lineWidth = Math.max(1.5, rect.width * .012);
  ctx.beginPath();
  ctx.arc(centerX, centerY, sealRadius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = ultraFoil ? 'rgba(130, 207, 255, .64)' : 'rgba(244, 210, 91, .64)';
  ctx.lineWidth = Math.max(1, rect.width * .006);
  ctx.beginPath();
  ctx.arc(centerX, centerY, sealRadius * .76, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = 'rgba(5, 12, 17, .74)';
  ctx.beginPath();
  ctx.arc(centerX, centerY, sealRadius * .62, 0, Math.PI * 2);
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#79fff0';
  ctx.shadowColor = 'rgba(76, 238, 221, .7)';
  ctx.shadowBlur = Math.max(5, rect.width * .05);
  ctx.font = `900 ${Math.max(21, rect.width * .19)}px "IBM Plex Mono", monospace`;
  ctx.fillText('◈', centerX, centerY + 1);
  ctx.shadowBlur = 0;

  const nodeY = rect.height * .7;
  const nodeColors = ultraFoil ? ['#72f3cc', '#82cfff', '#c4a5ff'] : ['#59e9dc', '#b66cff', '#f1c95d'];
  nodeColors.forEach((color, index) => {
    const nodeX = centerX + (index - 1) * rect.width * .16;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(nodeX, nodeY, Math.max(2, rect.width * .018), 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#d9fffb';
  ctx.font = `900 ${Math.max(11, rect.width * .075)}px "IBM Plex Mono", monospace`;
  ctx.fillText('СТИРАЙ', centerX, rect.height * .66);

  ctx.strokeStyle = 'rgba(103, 247, 229, .52)';
  ctx.lineWidth = Math.max(1, rect.width * .006);
  ctx.setLineDash([Math.max(3, rect.width * .025), Math.max(3, rect.width * .02)]);
  ctx.strokeRect(7, 7, rect.width - 14, rect.height - 14);
  ctx.setLineDash([]);

  canvas.dataset.cssWidth = String(Math.round(rect.width));
  canvas.dataset.cssHeight = String(Math.round(rect.height));
  resonanceScratch.initializedFor = Number(resonanceState.session_id || 0);
  resonanceUpdateScratchProgress(0);
}

function resonancePrepareScratchCanvas() {
  if (!resonanceScratchIsPending()) return;
  const canvas = document.getElementById('resonance-scratch-canvas');
  if (!canvas || canvas.hidden) return;
  const sessionId = Number(resonanceState.session_id || 0);
  if (resonanceScratch.initializedFor !== sessionId || !canvas.width) {
    resonanceDrawScratchFoil(canvas);
  }
  if (canvas.dataset.bound === '1') return;
  canvas.dataset.bound = '1';
  canvas.addEventListener('pointerdown', resonanceScratchPointerDown);
  canvas.addEventListener('pointermove', resonanceScratchPointerMove);
  canvas.addEventListener('pointerup', resonanceScratchPointerUp);
  canvas.addEventListener('pointercancel', resonanceScratchPointerUp);
  canvas.addEventListener('pointerleave', resonanceScratchPointerUp);
}

function resonanceScratchPoint(event) {
  const canvas = document.getElementById('resonance-scratch-canvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    width: rect.width,
    height: rect.height,
  };
}

function resonanceMoveScratchCoin(point, visible = true) {
  const coin = document.getElementById('resonance-scratch-coin');
  if (!coin || !point) return;
  coin.hidden = !visible;
  coin.style.left = `${point.x}px`;
  coin.style.top = `${point.y}px`;
}

function resonanceEraseScratchSegment(from, to) {
  const canvas = document.getElementById('resonance-scratch-canvas');
  if (!canvas || !from || !to) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  ctx.fillStyle = 'rgba(0,0,0,1)';
  ctx.lineWidth = Math.max(28, to.width * .17);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(to.x, to.y, ctx.lineWidth * .34, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  resonanceSpawnScratchDust(to);
}

function resonanceSpawnScratchDust(point) {
  const stage = document.getElementById('resonance-scratch-stage');
  if (!stage || resonanceScratch.moveCount % 2) return;
  const dust = document.createElement('i');
  dust.className = 'resonance-scratch-dust';
  dust.style.left = `${point.x + (Math.random() - .5) * 15}px`;
  dust.style.top = `${point.y + (Math.random() - .5) * 12}px`;
  dust.style.setProperty('--dust-x', `${(Math.random() - .5) * 34}px`);
  dust.style.setProperty('--dust-y', `${10 + Math.random() * 25}px`);
  stage.appendChild(dust);
  setTimeout(() => dust.remove(), 650);
}

function resonanceMeasureScratchProgress() {
  const canvas = document.getElementById('resonance-scratch-canvas');
  if (!canvas || !canvas.width || !canvas.height) return 0;
  const pixels = canvas.getContext('2d', { willReadFrequently: true })
    .getImageData(0, 0, canvas.width, canvas.height).data;
  let clear = 0;
  let sampled = 0;
  for (let index = 3; index < pixels.length; index += 4 * 10) {
    sampled += 1;
    if (pixels[index] < 32) clear += 1;
  }
  const progress = sampled ? clear / sampled : 0;
  resonanceUpdateScratchProgress(progress);
  if (progress >= RESONANCE_SCRATCH_REVEAL_THRESHOLD && resonanceScratch.payload) {
    resonanceCompleteScratchReveal();
  }
  return progress;
}

async function resonanceBeginScratchReveal() {
  if (resonanceScratch.payload) return resonanceScratch.payload;
  if (resonanceScratch.revealPromise) return resonanceScratch.revealPromise;
  resonanceScratch.locking = true;
  resonanceRender();
  resonanceScratch.revealPromise = resonanceRequest('/api/resonance/scratch', {
    method: 'POST', body: JSON.stringify({ tg_id })
  }).then(data => {
    resonanceScratch.payload = data;
    const signal = document.getElementById('resonance-signal');
    if (signal) {
      signal.innerHTML = resonanceSignalMarkup();
      signal.className = `resonance-signal-card faction-${data.signal?.faction || 'hidden'} is-revealed is-under-scratch`;
    }
    if (resonanceScratch.progress >= RESONANCE_SCRATCH_REVEAL_THRESHOLD || resonanceScratch.quick) {
      resonanceCompleteScratchReveal();
    }
    return data;
  }).catch(error => {
    resonanceScratch.revealPromise = null;
    resonanceScratch.pointerDown = false;
    resonanceScratch.locking = false;
    resonanceScratch.quick = false;
    resonanceDrawScratchFoil(document.getElementById('resonance-scratch-canvas'));
    resonanceRender();
    showToast(error.message, 'lose');
    throw error;
  });
  return resonanceScratch.revealPromise;
}

function resonanceScratchPointerDown(event) {
  if (!resonanceScratchIsPending() || resonanceScratch.quick) return;
  event.preventDefault();
  const canvas = event.currentTarget;
  if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
  resonanceScratch.pointerDown = true;
  resonanceScratch.lastPoint = resonanceScratchPoint(event);
  resonanceMoveScratchCoin(resonanceScratch.lastPoint, true);
  resonanceBeginScratchReveal().catch(() => {});
  resonanceEraseScratchSegment(resonanceScratch.lastPoint, resonanceScratch.lastPoint);
  resonanceScratch.moveCount += 1;
  resonanceMeasureScratchProgress();
  SND.playUi('tap');
}

function resonanceScratchPointerMove(event) {
  if (!resonanceScratch.pointerDown || resonanceScratch.quick) return;
  event.preventDefault();
  const point = resonanceScratchPoint(event);
  resonanceEraseScratchSegment(resonanceScratch.lastPoint || point, point);
  resonanceScratch.lastPoint = point;
  resonanceScratch.moveCount += 1;
  resonanceMoveScratchCoin(point, true);
  if (resonanceScratch.moveCount % 3 === 0) resonanceMeasureScratchProgress();
}

function resonanceScratchPointerUp(event) {
  if (!resonanceScratch.pointerDown) return;
  resonanceScratch.pointerDown = false;
  resonanceScratch.lastPoint = null;
  resonanceMoveScratchCoin(resonanceScratchPoint(event), false);
  resonanceMeasureScratchProgress();
}

function resonancePresentResult(data) {
  const bet = Number(data.bet || 0);
  const payout = Number(data.payout || 0);
  const net = payout - bet;
  const isWin = data.result === 'win';
  const isPush = data.result === 'push';
  showResult('resonance-result', {
    win: isWin || isPush,
    title: isWin ? 'БРЕЙНРОТ НАЙДЕН' : (isPush ? 'СТАВКА ВЕРНУЛАСЬ' : 'СЛОЙ ПУСТ'),
    detail: `${Number(data.score || 0)} очков · ${resonanceMultiplier(data.multiplier)} · выплата ${payout} 🧠`,
    amount: net
  });
  if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
  showToast(isWin ? `+${net} 🧠` : (isPush ? 'Ставка вернулась' : `${net} 🧠`), isWin || isPush ? 'win' : 'lose');
  SND.play(isWin ? (Number(data.multiplier) >= 4 ? 'bigwin' : 'win') : (isPush ? 'cash' : 'lose'));
}

async function resonanceCompleteScratchReveal() {
  if (resonanceScratch.completing || !resonanceScratch.payload) return;
  resonanceScratch.completing = true;
  const canvas = document.getElementById('resonance-scratch-canvas');
  const stage = document.getElementById('resonance-scratch-stage');
  if (canvas) canvas.classList.add('is-cleared');
  if (stage) stage.classList.add('is-revealed');
  resonanceUpdateScratchProgress(1);
  await sleep(360);
  const data = resonanceScratch.payload;
  resonanceApplyState(data);
  resonanceResetScratch(Number(data.session_id || 0));
  resonanceRender();
  resonancePresentResult(data);
}

async function resonanceQuickScratch() {
  if (!resonanceScratchIsPending() || resonanceScratch.quick) return;
  resonanceScratch.quick = true;
  const button = document.getElementById('resonance-quick-scratch');
  if (button) button.disabled = true;
  SND.playUi('tap');
  const canvas = document.getElementById('resonance-scratch-canvas');
  const rect = canvas?.getBoundingClientRect();
  if (!canvas || !rect?.width) return;
  const reveal = resonanceBeginScratchReveal().catch(() => null);
  const rows = 7;
  for (let row = 0; row < rows; row += 1) {
    const y = rect.height * ((row + .5) / rows);
    const reverse = row % 2 === 1;
    const from = { x: reverse ? rect.width : 0, y, width: rect.width, height: rect.height };
    const to = { x: reverse ? 0 : rect.width, y, width: rect.width, height: rect.height };
    resonanceMoveScratchCoin(from, true);
    resonanceEraseScratchSegment(from, to);
    resonanceUpdateScratchProgress((row + 1) / rows);
    await sleep(72);
  }
  resonanceMoveScratchCoin({ x: rect.width / 2, y: rect.height / 2 }, false);
  await reveal;
  resonanceCompleteScratchReveal();
}

function resonanceSyncScratchUi() {
  const pending = resonanceScratchIsPending();
  const sessionId = Number(resonanceState.session_id || 0);
  if (pending && resonanceScratch.sessionId !== sessionId) resonanceResetScratch(sessionId);
  if (!pending && !resonanceState.revealed && resonanceScratch.sessionId !== sessionId) {
    resonanceResetScratch(sessionId || null);
  }
  const stage = document.getElementById('resonance-scratch-stage');
  const tools = document.getElementById('resonance-scratch-tools');
  const canvas = document.getElementById('resonance-scratch-canvas');
  const coin = document.getElementById('resonance-scratch-coin');
  if (stage) stage.classList.toggle('is-scratch-ready', pending);
  if (stage) stage.classList.toggle(
    'is-hand-editable',
    Boolean(resonanceState.active && !resonanceScratch.locking)
  );
  if (tools) tools.hidden = !pending;
  if (canvas) {
    canvas.hidden = !pending;
    if (!pending) canvas.classList.remove('is-cleared');
  }
  if (coin && !pending) coin.hidden = true;
  const quick = document.getElementById('resonance-quick-scratch');
  if (quick) quick.disabled = !pending || resonanceScratch.quick;
  if (pending) requestAnimationFrame(resonancePrepareScratchCanvas);
}

function resonanceRender() {
  const cards = document.getElementById('resonance-cards');
  if (!cards) return;
  const hasCards = Array.isArray(resonanceState.cards) && resonanceState.cards.length === 3;
  cards.innerHTML = hasCards
    ? resonanceState.cards.map(resonanceCardMarkup).join('')
    : Array.from({ length: 3 }, (_, index) =>
      `<button type="button" class="resonance-card is-empty" disabled><span>0${index + 1}</span><b>КАРТА</b></button>`
    ).join('');
  cards.setAttribute('aria-busy', String(resonanceBusy));

  const signal = document.getElementById('resonance-signal');
  const visibleSignal = resonanceScratch.payload?.signal || resonanceState.signal;
  signal.innerHTML = resonanceSignalMarkup();
  signal.className = `resonance-signal-card faction-${visibleSignal?.faction || 'hidden'} ${visibleSignal ? 'is-revealed' : 'is-hidden'}`;

  const score = document.querySelector('#resonance-score-display strong');
  score.textContent = resonanceState.revealed
    ? `${Number(resonanceState.score || 0)} / 5` : '—';

  const panelTitle = document.getElementById('resonance-panel-title');
  panelTitle.textContent = resonanceScratch.locking
    ? 'TICKET // LOCKING'
    : resonanceBusy ? 'DECK // SYNCING'
      : resonanceState.active ? 'TICKET // READY'
      : resonanceScratchIsPending() ? 'TICKET // SCRATCH'
        : resonanceState.revealed ? 'CODE // OPEN' : 'CODE // LOCKED';

  const help = document.getElementById('resonance-hand-help');
  if (resonanceScratch.locking) help.textContent = 'Касание принято — тройка заблокирована, открываем брейнрота…';
  else if (resonanceState.active && resonanceState.replacement_used) help.textContent = 'Замена использована — стирай слой монеткой';
  else if (resonanceState.active) help.textContent = 'До первого касания слоя можно заменить одну карту';
  else if (resonanceScratchIsPending()) help.textContent = 'Билет готов — сотри металлический слой монеткой или открой его мгновенно';
  else if (resonanceState.revealed) help.textContent = 'Билет открыт — можно собрать новую тройку';
  else help.textContent = 'Сделай ставку, чтобы получить три карты';

  const betInput = document.getElementById('resonance-bet');
  if (resonanceState.active && resonanceState.bet) betInput.value = resonanceState.bet;
  betInput.disabled = resonanceBusy || resonanceState.active;
  document.querySelectorAll('.resonance-qbet').forEach(button => {
    button.disabled = resonanceBusy || resonanceState.active;
  });

  const start = document.getElementById('resonance-start-btn');
  start.style.display = resonanceState.active || resonanceScratchIsPending() ? 'none' : '';
  start.disabled = resonanceBusy;
  start.querySelector('span').textContent = resonanceBusy
    ? 'СИНХРОНИЗАЦИЯ...' : (resonanceState.revealed ? 'НОВЫЙ РАУНД' : 'ПОЛУЧИТЬ КАРТЫ');

  resonanceRenderPaytable();
  resonanceSyncScratchUi();
}

async function resonanceLoad(force = false) {
  if (resonanceBusy && !force) return;
  try {
    const data = await resonanceRequest(`/api/resonance/state?tg_id=${tg_id}&_=${Date.now()}`);
    resonanceApplyState(data);
    resonanceRender();
  } catch (error) {
    console.error('[resonance] load failed', error);
    showToast(error.message, 'lose');
  }
}

async function resonanceStart() {
  if (resonanceBusy || resonanceState.active) return;
  const bet = Number.parseInt(document.getElementById('resonance-bet').value, 10);
  if (!Number.isInteger(bet) || bet < 1 || bet > 100000000) {
    showToast('Введи ставку от 1 до 100 000 000', 'lose');
    return;
  }
  resonanceBusy = true;
  const stateBeforeStart = resonanceState;
  resonanceState = {
    ...resonanceState,
    status: 'starting',
    scratch_ready: false,
    revealed: false,
    signal: null,
    score: null,
    multiplier: null,
    payout: null,
    result: null,
  };
  resonanceResetScratch(null);
  document.getElementById('resonance-result').style.display = 'none';
  resonanceRender();
  SND.play('bet');
  try {
    const data = await resonanceRequest('/api/resonance/start', {
      method: 'POST', body: JSON.stringify({ tg_id, bet })
    });
    resonanceApplyState(data);
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
  } catch (error) {
    console.error('[resonance] start failed', error);
    showToast(error.message, 'lose');
    if (error.code === 'active_session' || error.code === 'scratch_pending') await resonanceLoad(true);
    else resonanceState = stateBeforeStart;
  } finally {
    resonanceBusy = false;
    resonanceRender();
  }
}

async function resonanceReplace(cardIndex) {
  const selectedIndex = Number(cardIndex);
  if (resonanceBusy || resonanceScratch.locking || !resonanceState.active || resonanceState.replacement_used
      || !Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex > 2) return;
  resonanceBusy = true;
  resonanceRender();
  SND.playUi('tap');
  try {
    const data = await resonanceRequest('/api/resonance/replace', {
      method: 'POST', body: JSON.stringify({ tg_id, card_index: selectedIndex })
    });
    resonanceApplyState(data);
    showToast('Карта заменена', 'win');
  } catch (error) {
    console.error('[resonance] replace failed', error);
    showToast(error.message, 'lose');
    if (error.code === 'replacement_used' || error.code === 'no_active_session') await resonanceLoad(true);
  } finally {
    resonanceBusy = false;
    resonanceRender();
  }
}

// ══════════════════════════════════════════
// МИНЫ — серверная сессия 5×5
// ══════════════════════════════════════════

const MINES_BOARD_SIZE = 25;
let minesSelectedCount = 3;
let minesBusy = false;
let minesState = {
  active: false,
  status: 'idle',
  bet: 0,
  mine_count: 3,
  revealed: [],
  safe_picks: 0,
  multiplier: 1,
  payout: 0,
  next_multiplier: null,
  mine_cells: [],
  exploded_cell: null
};

function minesMultiplier(mineCount, safePicks) {
  if (safePicks <= 0) return 1;
  let probability = 1;
  for (let pick = 0; pick < safePicks; pick++) {
    probability *= (MINES_BOARD_SIZE - mineCount - pick) / (MINES_BOARD_SIZE - pick);
  }
  return probability > 0 ? Math.floor((0.97 / probability) * 10000) / 10000 : 0;
}

function minesFormatMultiplier(value) {
  const number = Number(value || 0);
  return `x${number.toFixed(number >= 10 ? 2 : 3).replace(/0+$/, '').replace(/\.$/, '')}`;
}

function minesSetCount(value) {
  if (minesState.active || minesBusy) return;
  minesSelectedCount = Math.max(2, Math.min(24, Number(value) || 2));
  minesState.mine_count = minesSelectedCount;
  minesState.next_multiplier = minesMultiplier(minesSelectedCount, 1);
  minesRender();
}

function minesAdjustCount(delta) {
  minesSetCount(minesSelectedCount + Number(delta || 0));
}

function minesErrorText(error) {
  if (error === 'invalid_mine_count') {
    return '\u0412\u044b\u0431\u0435\u0440\u0438 \u043e\u0442 2 \u0434\u043e 24 \u043c\u0438\u043d';
  }
  return {
    insufficient_balance: 'Недостаточно баланса',
    invalid_bet: 'Ставка должна быть от 1 до 1 000 000',
    invalid_mine_count: 'Выбери от 1 до 24 мин',
    reveal_first: 'Сначала открой хотя бы одну ячейку',
    no_active_session: 'Эта игра уже завершена',
    session_busy: 'Игра обновляется, попробуй ещё раз',
    no_tg_id: 'Открой игру через Telegram'
  }[error] || 'Не удалось выполнить действие';
}

async function minesRequest(path, options = {}) {
  await ensureTelegramAuth();
  const response = await fetch(`${API}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  let data = {};
  try { data = await response.json(); } catch (e) {}
  if (!response.ok && data.error !== 'active_session') {
    const error = new Error(minesErrorText(data.error));
    error.code = data.error;
    error.data = data;
    throw error;
  }
  return data;
}

async function minesLoad() {
  if (minesBusy) return;
  minesState = {
    ...minesState,
    mine_count: minesState.active ? minesState.mine_count : minesSelectedCount,
    next_multiplier: minesState.active
      ? minesState.next_multiplier
      : minesMultiplier(minesSelectedCount, 1)
  };
  minesRender();
  try {
    const data = await minesRequest(`/api/mines/state?tg_id=${tg_id}&_=${Date.now()}`);
    if (data.active) {
      minesSelectedCount = Number(data.mine_count) || 3;
      minesState = { ...minesState, ...data };
    } else if (minesState.status === 'idle' || minesState.active) {
      minesState = {
        ...minesState,
        active: false,
        status: 'idle',
        bet: 0,
        mine_count: minesSelectedCount,
        revealed: [],
        safe_picks: 0,
        multiplier: 1,
        payout: 0,
        next_multiplier: minesMultiplier(minesSelectedCount, 1),
        mine_cells: [],
        exploded_cell: null
      };
    }
    minesRender();
  } catch (error) {
    console.error('[mines] load failed', error);
    showToast(error.message || 'Ошибка загрузки мин', 'lose');
  }
}

function minesCellMarkup(cell, revealedSet, mineSet) {
  const isRevealed = revealedSet.has(cell);
  const isMine = mineSet.has(cell);
  const exploded = minesState.exploded_cell != null
    && Number(minesState.exploded_cell) === cell;
  const finished = !minesState.active && minesState.status !== 'idle';
  const classes = ['mine-cell'];
  if (isRevealed) classes.push('is-safe');
  if (finished && isMine) classes.push('is-mine');
  if (exploded) classes.push('is-exploded');

  let content = '<span class="mine-cell-cover"><i></i></span>';
  if (isRevealed) {
    content = '<span class="mine-gem" aria-hidden="true"><i></i></span>';
  } else if (finished && isMine) {
    content = '<span class="mine-bomb" aria-hidden="true"><i></i></span>';
  }

  const disabled = minesBusy || !minesState.active || isRevealed;
  const label = isRevealed ? `Ячейка ${cell + 1}, безопасно`
    : (finished && isMine ? `Ячейка ${cell + 1}, мина` : `Открыть ячейку ${cell + 1}`);
  return `<button type="button" role="gridcell" class="${classes.join(' ')}"
    onclick="minesReveal(${cell})" ${disabled ? 'disabled' : ''} aria-label="${label}">${content}</button>`;
}

function minesUpdateCellElement(button, cell, revealedSet, mineSet) {
  const isRevealed = revealedSet.has(cell);
  const isMine = mineSet.has(cell);
  const exploded = minesState.exploded_cell != null
    && Number(minesState.exploded_cell) === cell;
  const finished = !minesState.active && minesState.status !== 'idle';
  const visual = isRevealed ? 'safe' : (finished && isMine ? 'mine' : 'cover');
  const currentVisual = button.dataset.visual
    || (button.classList.contains('is-safe') ? 'safe'
      : (button.classList.contains('is-mine') ? 'mine' : 'cover'));

  if (currentVisual !== visual) {
    if (visual === 'safe') {
      button.innerHTML = '<span class="mine-gem" aria-hidden="true"><i></i></span>';
    } else if (visual === 'mine') {
      button.innerHTML = '<span class="mine-bomb" aria-hidden="true"><i></i></span>';
    } else {
      button.innerHTML = '<span class="mine-cell-cover"><i></i></span>';
    }
  }

  button.dataset.visual = visual;
  button.classList.toggle('is-safe', isRevealed);
  button.classList.toggle('is-mine', finished && isMine);
  button.classList.toggle('is-exploded', exploded);
  button.disabled = minesBusy || !minesState.active || isRevealed;
}

function minesRender() {
  const board = document.getElementById('mines-board');
  if (!board) return;

  const revealedSet = new Set((minesState.revealed || []).map(Number));
  const mineSet = new Set((minesState.mine_cells || []).map(Number));
  if (board.children.length !== MINES_BOARD_SIZE) {
    board.innerHTML = Array.from(
      { length: MINES_BOARD_SIZE },
      (_, cell) => minesCellMarkup(cell, revealedSet, mineSet)
    ).join('');
  }
  Array.from(board.children).forEach((button, cell) => {
    minesUpdateCellElement(button, cell, revealedSet, mineSet);
  });
  board.classList.toggle('is-live', Boolean(minesState.active));
  board.classList.toggle('is-lost', minesState.status === 'lost');
  board.classList.toggle('is-cleared', minesState.status === 'cashed_out');
  board.setAttribute('aria-busy', String(minesBusy));

  const mineCount = Number(minesState.mine_count || minesSelectedCount);
  const safeTotal = MINES_BOARD_SIZE - mineCount;
  const safePicks = Number(minesState.safe_picks || revealedSet.size);
  const current = safePicks ? Number(minesState.multiplier || 1) : 1;
  const next = minesState.active
    ? minesState.next_multiplier
    : minesMultiplier(minesSelectedCount, 1);

  document.getElementById('mines-count').textContent = mineCount;
  document.getElementById('mines-safe-count').textContent = `${safePicks} / ${safeTotal}`;
  document.getElementById('mines-multiplier').textContent = minesFormatMultiplier(current);
  document.getElementById('mines-next-multiplier').textContent =
    next == null ? 'МАКС.' : minesFormatMultiplier(next);
  document.getElementById('mines-payout').textContent =
    `${Math.floor(Number(minesState.payout || 0))} 🧠`;

  const status = document.getElementById('mines-board-status');
  if (minesBusy) status.textContent = 'ПРОВЕРКА ЯЧЕЙКИ...';
  else if (minesState.active && safePicks === 0) status.textContent = 'ПОЛЕ ЗАЛОЖЕНО — ВЫБЕРИ ЯЧЕЙКУ';
  else if (minesState.active) status.textContent = 'МОЖНО ЗАБРАТЬ ИЛИ РИСКНУТЬ';
  else if (minesState.status === 'lost') status.textContent = 'ПОЛЕ ВЗОРВАНО';
  else if (minesState.status === 'cashed_out') status.textContent = 'ВЫИГРЫШ ЗАФИКСИРОВАН';
  else status.textContent = 'ВЫБЕРИ СТАВКУ И ЧИСЛО МИН';

  document.querySelectorAll('#mines-presets button').forEach(button => {
    button.classList.toggle('active', Number(button.dataset.count) === mineCount);
    button.disabled = minesBusy || minesState.active;
  });
  document.querySelectorAll('.mines-count-stepper button').forEach(button => {
    button.disabled = minesBusy || minesState.active;
  });

  const betInput = document.getElementById('mines-bet');
  if (minesState.active && minesState.bet) betInput.value = minesState.bet;
  betInput.disabled = minesBusy || minesState.active;
  document.querySelectorAll('.mines-qbet').forEach(button => {
    button.disabled = minesBusy || minesState.active;
  });

  const startButton = document.getElementById('mines-start-btn');
  startButton.disabled = minesBusy || minesState.active;
  startButton.querySelector('span').textContent = minesState.active
    ? 'ПОЛЕ АКТИВНО'
    : (minesBusy ? 'ЗАПУСК...' : 'ЗАЛОЖИТЬ ПОЛЕ');

  const cashoutButton = document.getElementById('mines-cashout-btn');
  cashoutButton.disabled = minesBusy || !minesState.active || safePicks < 1;
  cashoutButton.querySelector('span').textContent = safePicks > 0
    ? `ЗАБРАТЬ ${Math.floor(Number(minesState.payout || 0))} 🧠`
    : 'ЗАБРАТЬ';
}

async function minesStart() {
  if (minesBusy || minesState.active) return;
  const bet = Number.parseInt(document.getElementById('mines-bet').value, 10);
  if (!Number.isInteger(bet) || bet < 1 || bet > 1000000) {
    showToast('Введи ставку от 1 до 1 000 000', 'lose');
    return;
  }

  minesBusy = true;
  minesState = {
    ...minesState,
    status: 'idle',
    mine_count: minesSelectedCount,
    revealed: [],
    safe_picks: 0,
    multiplier: 1,
    payout: 0,
    next_multiplier: minesMultiplier(minesSelectedCount, 1),
    mine_cells: [],
    exploded_cell: null
  };
  document.getElementById('mines-result').style.display = 'none';
  minesRender();
  SND.play('bet');

  try {
    const data = await minesRequest('/api/mines/start', {
      method: 'POST',
      body: JSON.stringify({ tg_id, bet, mine_count: minesSelectedCount })
    });
    minesSelectedCount = Number(data.mine_count) || minesSelectedCount;
    minesState = { ...minesState, ...data };
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
    showToast(data.started ? 'Поле заложено' : 'Игра восстановлена', 'win');
  } catch (error) {
    console.error('[mines] start failed', error);
    showToast(error.message, 'lose');
    SND.play('lose');
  } finally {
    minesBusy = false;
    minesRender();
  }
}

async function minesReveal(cell) {
  if (minesBusy || !minesState.active || (minesState.revealed || []).includes(cell)) return;
  minesBusy = true;
  minesRender();
  SND.playUi('tap');

  try {
    const data = await minesRequest('/api/mines/reveal', {
      method: 'POST',
      body: JSON.stringify({ tg_id, cell })
    });
    minesState = { ...minesState, ...data };
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);

    if (data.status === 'lost') {
      SND.play('mineExplode');
      showResult('mines-result', {
        win: false,
        title: 'ВЗРЫВ',
        detail: `${minesState.mine_count} мин · открыто безопасных ячеек: ${minesState.safe_picks}`,
        amount: -Number(minesState.bet || 0)
      });
      showToast(`-${Number(minesState.bet || 0)} 🧠`, 'lose');
    } else if (data.auto_cashout) {
      SND.play('bigwin');
      showResult('mines-result', {
        win: true,
        title: 'ПОЛЕ ЗАЧИЩЕНО',
        detail: `${minesFormatMultiplier(data.multiplier)} · открыты все безопасные ячейки`,
        amount: Number(data.payout || 0)
      });
      showToast(`+${Number(data.payout || 0)} 🧠`, 'win');
    } else {
      SND.play('mineSafe');
    }
  } catch (error) {
    console.error('[mines] reveal failed', error);
    showToast(error.message, 'lose');
    if (error.code === 'no_active_session') await minesLoad();
  } finally {
    minesBusy = false;
    minesRender();
  }
}

async function minesCashout() {
  if (minesBusy || !minesState.active || Number(minesState.safe_picks || 0) < 1) return;
  minesBusy = true;
  minesRender();
  SND.play('cash');

  try {
    const data = await minesRequest('/api/mines/cashout', {
      method: 'POST',
      body: JSON.stringify({ tg_id })
    });
    minesState = { ...minesState, ...data };
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
    showResult('mines-result', {
      win: true,
      title: 'ВЫИГРЫШ ЗАБРАН',
      detail: `${minesFormatMultiplier(data.multiplier)} · безопасных ячеек: ${data.safe_picks}`,
      amount: Number(data.payout || 0)
    });
    showToast(`+${Number(data.payout || 0)} 🧠`, 'win');
    SND.play('win');
  } catch (error) {
    console.error('[mines] cashout failed', error);
    showToast(error.message, 'lose');
    if (error.code === 'no_active_session') await minesLoad();
  } finally {
    minesBusy = false;
    minesRender();
  }
}

// ══════════════════════════════════════════
// КЕЙСЫ
// ══════════════════════════════════════════

// Полные данные кейсов для анимации (клиентская сторона)
// Используется только для заполнения трека — сортировка по шансу убыванием
const CASES_CLIENT = {
  sixseven: {
    label: 'СИКС-СЕВЕН', price: 67,
    items: [
      {"name": "Talpa Di Fero",             "value": 5,     "chance": 3.706422},
      {"name": "Pipi Kiwi",                 "value": 7,     "chance": 4.829194},
      {"name": "Los Chicleteiras",          "value": 11,    "chance": 3.530372},
      {"name": "Six Seven",                 "value": 13,    "chance": 4.570882},
      {"name": "Arcadopus",                 "value": 16,    "chance": 4.188772},
      {"name": "Spaghetti Tualetti",        "value": 20,    "chance": 3.497958},
      {"name": "Money Money Puggy",         "value": 23,    "chance": 4.507016},
      {"name": "John Doe",                  "value": 26,    "chance": 3.451925},
      {"name": "Ketupat Kepat",             "value": 29,    "chance": 4.341345},
      {"name": "Los Mobilis",               "value": 33,    "chance": 3.524578},
      {"name": "Los bros",                  "value": 38,    "chance": 3.571406},
      {"name": "Las Sis",                   "value": 41,    "chance": 4.320855},
      {"name": "Tang Tang Keletang",        "value": 42,    "chance": 5.224157},
      {"name": "Ketchuru and Musturu",      "value": 48,    "chance": 3.645696},
      {"name": "Los Candies",               "value": 50,    "chance": 3.868948},
      {"name": "La Secret Combinasion",     "value": 80,    "chance": 4.77643},
      {"name": "Garama And Madundung",      "value": 99,    "chance": 5.4955},
      {"name": "Burguro And Fryro",         "value": 150,   "chance": 4.66343},
      {"name": "Celestial Pegasus",         "value": 170,   "chance": 4.258353},
      {"name": "Capitano Moby",             "value": 200,   "chance": 5.559591},
      {"name": "Reinito Sleighito",         "value": 500,   "chance": 3.472327},
      {"name": "La Casa Boo",               "value": 1000,  "chance": 5.713249},
      {"name": "Hydra Dragon Cannelloni",   "value": 1700,  "chance": 5.281594},
    ]
  },
  nubini: {
    label: 'НУБИНИ', price: 29,
    items: [
      {"name": "Lirili Larila",          "value": 3,    "chance": 3.588805},
            {"name": "Tim Cheese",             "value": 4,    "chance": 4.011818},
            {"name": "Talpa Di Fero",          "value": 5,    "chance": 5.137946},
            {"name": "Pipi Kiwi",              "value": 7,    "chance": 3.728414},
            {"name": "Los Chicleteiras",       "value": 11,   "chance": 4.617686},
            {"name": "Six Seven",              "value": 13,   "chance": 4.744826},
            {"name": "Arcadopus",              "value": 16,   "chance": 4.153605},
            {"name": "Spaghetti Tualetti",     "value": 20,   "chance": 4.542583},
            {"name": "Money Money Puggy",      "value": 23,   "chance": 3.466789},
            {"name": "John Doe",               "value": 26,   "chance": 3.459718},
            {"name": "Ketupat Kepat",          "value": 29,   "chance": 3.784388},
            {"name": "Los Mobilis",            "value": 33,   "chance": 4.836857},
            {"name": "Los bros",               "value": 38,   "chance": 4.276045},
            {"name": "Las Sis",                "value": 41,   "chance": 4.024386},
            {"name": "Tang Tang Keletang",     "value": 42,   "chance": 4.626475},
            {"name": "Ketchuru and Musturu",   "value": 48,   "chance": 4.332817},
            {"name": "Los Candies",            "value": 50,   "chance": 3.992486},
            {"name": "La Secret Combinasion",  "value": 80,   "chance": 5.089702},
            {"name": "Garama And Madundung",   "value": 99,   "chance": 4.878106},
            {"name": "Burguro And Fryro",      "value": 150,  "chance": 3.86899},
            {"name": "Celestial Pegasus",      "value": 170,  "chance": 4.601766},
            {"name": "Capitano Moby",          "value": 200,  "chance": 5.110353},
            {"name": "Cerberus",               "value": 250,  "chance": 5.125439},
        ]
    },
    "sahur": {
        "name": "Сахур",
        "price": 99,
        "items": [
            {"name": "Los Chicleteiras",       "value": 11,   "chance": 3.754884},
            {"name": "Six Seven",              "value": 13,   "chance": 5.208665},
            {"name": "Arcadopus",              "value": 16,   "chance": 3.398132},
            {"name": "Spaghetti Tualetti",     "value": 20,   "chance": 4.028288},
            {"name": "Money Money Puggy",      "value": 23,   "chance": 4.740266},
            {"name": "John Doe",               "value": 26,   "chance": 3.469366},
            {"name": "Ketupat Kepat",          "value": 29,   "chance": 4.177061},
            {"name": "Los Mobilis",            "value": 33,   "chance": 3.23252},
            {"name": "Los bros",               "value": 38,   "chance": 4.553513},
            {"name": "Las Sis",                "value": 41,   "chance": 4.75587},
            {"name": "Los Candies",            "value": 50,   "chance": 4.353603},
            {"name": "La Secret Combinasion",  "value": 80,   "chance": 4.988788},
            {"name": "Garama And Madundung",   "value": 99,   "chance": 3.809087},
            {"name": "Burguro And Fryro",      "value": 150,  "chance": 4.610383},
            {"name": "Spooky Lucky Block",     "value": 155,  "chance": 4.398428},
            {"name": "Cash Or Card",           "value": 160,  "chance": 4.368029},
            {"name": "Popcuru and Fizzuru",    "value": 165,  "chance": 4.108266},
            {"name": "Celestial Pegasus",      "value": 170,  "chance": 4.914213},
            {"name": "Capitano Moby",          "value": 200,  "chance": 5.134123},
            {"name": "Cerberus",               "value": 250,  "chance": 4.145843},
            {"name": "Fortunu and Cashuru",    "value": 300,  "chance": 4.544979},
            {"name": "Cookie and Milki",       "value": 350,  "chance": 3.671393},
            {"name": "Dragon Cannelloni",      "value": 1500, "chance": 5.6343},
        ]
    },
    "dragon": {
        "name": "Дракон",
        "price": 499,
        "items": [
            {"name": "La Secret Combinasion",    "value": 80,   "chance": 6.278713},
            {"name": "Garama And Madundung",     "value": 99,   "chance": 5.847628},
            {"name": "Burguro And Fryro",        "value": 150,  "chance": 4.494397},
            {"name": "Spooky Lucky Block",       "value": 155,  "chance": 4.749253},
            {"name": "Cash Or Card",             "value": 160,  "chance": 5.461622},
            {"name": "Popcuru and Fizzuru",      "value": 165,  "chance": 3.834483},
            {"name": "Celestial Pegasus",        "value": 170,  "chance": 4.940412},
            {"name": "Capitano Moby",            "value": 200,  "chance": 4.20088},
            {"name": "Fragola La La La",         "value": 225,  "chance": 4.072559},
            {"name": "Cerberus",                 "value": 250,  "chance": 3.926133},
            {"name": "Fortunu and Cashuru",      "value": 300,  "chance": 5.712409},
            {"name": "Cookie and Milki",         "value": 350,  "chance": 4.103396},
            {"name": "Spooky and Pumpky",        "value": 400,  "chance": 4.401263},
            {"name": "Reinito Sleighito",        "value": 500,  "chance": 4.762243},
            {"name": "Foxini Lanterini",         "value": 700,  "chance": 5.972284},
            {"name": "La Casa Boo",              "value": 1000, "chance": 3.980599},
            {"name": "Dragon Cannelloni",        "value": 1500, "chance": 4.908912},
            {"name": "Hydra Dragon Cannelloni",  "value": 1700, "chance": 5.161391},
            {"name": "Dragon Aquanini",          "value": 2000, "chance": 6.794294},
            {"name": "Dragon Gingerini",         "value": 5000, "chance": 6.397129},
    ] // Сумма шансов: 100.0%
  },
  mimiki: {
    label: 'MIMIKI', price: 30,
    items: [
      {name:'Mastodontico Telepiedone', value:5,     chance:13.337352},
      {name:'Mariachi Corazoni',        value:11,    chance:14.363856},
      {name:'Mieteteira Bicicleteira',  value:18,    chance:13.939941},
      {name:'Money Money Puggy',        value:23,    chance:17.880366},
      {name:'Money Money Man',          value:33,    chance:18.43187},
      {name:'Meowl',                    value:16666, chance:22.046615},
    ]
  },
  farm_headless: {
    label: 'ФАРМ ХЕЙДЛЕСС', price: 39,
    items: [
      {name:'Lirili Larila',      value:3,      chance:17.969177},
      {name:'Tim Cheese',         value:4,      chance:18.566704},
      {name:'Talpa Di Fero',      value:5,      chance:18.58149},
      {name:'Pipi Kiwi',          value:7,      chance:21.278945},
      {name:'Headless Horseman',  value:120000, chance:23.603684},
    ]
  },
  farm_skibidi: {
    label: 'ФАРМ СКИБИДИ', price: 19,
    items: [
      {name:'Lirili Larila',   value:3,     chance:18.650154},
      {name:'Tim Cheese',      value:4,     chance:15.913562},
      {name:'Talpa Di Fero',   value:5,     chance:20.302775},
      {name:'Pipi Kiwi',       value:7,     chance:19.777015},
      {name:'Skibidi Toilet',  value:13000, chance:25.356494},
    ]
  },
  farm_elephant: {
    label: 'ФАРМ СЛОНА', price: 25,
    items: [
      {name:'Lirili Larila',        value:3,     chance:20.888475},
      {name:'Tim Cheese',           value:4,     chance:18.652363},
      {name:'Talpa Di Fero',        value:5,     chance:17.162195},
      {name:'Pipi Kiwi',            value:7,     chance:18.031602},
      {name:'Strawberry Elephant',  value:45000, chance:25.265365},
    ]
  },
  cash_vault: {
    label: 'ДЕНЕЖНЫЙ СЕЙФ', price: 59,
    items: [
      {name:'Money Money Puggy', value:23, chance:6.434393},
      {name:'Ketupat Kepat', value:29, chance:9.9354},
      {name:'Money Money Man', value:33, chance:9.440339},
      {name:'Los Mobilis', value:33, chance:9.831802},
      {name:'Bandito Bobritto', value:34, chance:9.51447},
      {name:'Cupcake Koala', value:39, chance:7.835499},
      {name:'La Secret Combinasion', value:80, chance:7.862826},
      {name:'Garama And Madundung', value:99, chance:6.639533},
      {name:'Cash Or Card', value:160, chance:8.837143},
      {name:'Popcuru and Fizzuru', value:165, chance:6.468573},
      {name:'Fortunu and Cashuru', value:300, chance:6.489689},
      {name:'Clickerino Crabo', value:320, chance:10.710333},
    ]
  },
  night_raid: {
    label: 'НОЧНОЙ РЕЙД', price: 129,
    items: [
      {name:'Noobini Santanini', value:6, chance:7.743967},
      {name:'Frogo Elfo', value:43, chance:8.572031},
      {name:'Los Candies', value:50, chance:7.232793},
      {name:'La Secret Combinasion', value:80, chance:6.988952},
      {name:'Spooky Lucky Block', value:155, chance:7.692545},
      {name:'Penguin Tree', value:175, chance:7.460545},
      {name:'Mummio Rappitto', value:230, chance:8.68177},
      {name:'Cerberus', value:250, chance:7.106663},
      {name:'Spooky and Pumpky', value:400, chance:11.06101},
      {name:'Quackula', value:420, chance:9.848553},
      {name:'Reinito Sleighito', value:500, chance:7.679899},
      {name:'La Casa Boo', value:1000, chance:9.931272},
    ]
  },
  cosmic_signal: {
    label: 'КОСМИЧЕСКИЙ СИГНАЛ', price: 249,
    items: [
      {name:'Arcadopus', value:16, chance:7.946673},
      {name:'Las Sis', value:41, chance:8.018827},
      {name:'La Secret Combinasion', value:80, chance:6.980768},
      {name:'Gato Celesto', value:135, chance:10.104114},
      {name:'Celestial Pegasus', value:170, chance:10.724255},
      {name:'Cavallo Virtuso', value:240, chance:8.456839},
      {name:'Buho del Cielo', value:460, chance:8.533601},
      {name:'Odin Din Din Dun', value:550, chance:6.821792},
      {name:'Electro Quacko', value:580, chance:6.89192},
      {name:'La Vacca Saturno Saturnita', value:1800, chance:7.926225},
      {name:'Dragon Aquanini', value:2000, chance:7.591223},
      {name:'Girafa Celestre', value:3000, chance:10.003763},
    ]
  },
  cyber_cube: {
    label: 'КИБЕР-КУБ', price: 349,
    items: [
      {name:'Arcadopus', value:16, chance:6.740257},
      {name:'John Doe', value:26, chance:6.179017},
      {name:'La Secret Combinasion', value:80, chance:9.943355},
      {name:'Rhino Toasterino', value:140, chance:8.228397},
      {name:'Spooky Lucky Block', value:155, chance:6.680069},
      {name:'Capitano Moby', value:200, chance:8.288906},
      {name:'Clickerino Crabo', value:320, chance:6.195028},
      {name:'Cookie and Milki', value:350, chance:8.227797},
      {name:'Electro Quacko', value:580, chance:10.054982},
      {name:'Statutino Libertino', value:600, chance:9.587726},
      {name:'Brutto Gialutto', value:1100, chance:8.909707},
      {name:'Robo Grafito', value:20400, chance:10.964759},
    ]
  },
  dragon_forge: {
    label: 'ДРАКОНЬЯ КУЗНЯ', price: 699,
    items: [
      {name:'Tung Tung Tung Sahur', value:10, chance:7.263442},
      {name:'Tric Trac Baraboom', value:17, chance:6.486562},
      {name:'Garama And Madundung', value:99, chance:8.840248},
      {name:'Bombardiro Crocodilo', value:180, chance:7.908941},
      {name:'Cerberus', value:250, chance:8.867941},
      {name:'Buho de Fuego', value:620, chance:7.119338},
      {name:'Foxini Lanterini', value:700, chance:6.70446},
      {name:'Dragon Cannelloni', value:1500, chance:8.994231},
      {name:'Hydra Dragon Cannelloni', value:1700, chance:9.668998},
      {name:'Dragon Aquanini', value:2000, chance:9.154222},
      {name:'Dragon Gingerini', value:5000, chance:8.973092},
      {name:'Tortuginni Dragonfrutini', value:5500, chance:10.018525},
    ]
  },
  event_relic: {
    label: 'РЕЛИКТОВЫЙ КЕЙС', price: 240,
    items: [
      {name:'Holy Arepa', value:9, chance:21.064068, rarity:'archive'},
      {name:'Wombo Rollo', value:65, chance:16.238492, rarity:'archive'},
      {name:'Spioniro Golubiro', value:190, chance:18.974147, rarity:'archive'},
      {name:'Unclito Samito', value:540, chance:17.449961, rarity:'archive'},
      {name:'Los Matteos', value:1100, chance:26.273332, rarity:'archive'},
    ]
  },
  level_daily: {
    label: 'КЕЙС УРОВНЯ', price: 0,
    items: [
      {name:'Noobini Pizzanini', value:2, chance:11.058615},
      {name:'Lirili Larila', value:3, chance:8.655418},
      {name:'Fluriflura', value:4, chance:5.555232},
      {name:'Tim Cheese', value:4, chance:8.733608},
      {name:'Mastodontico Telepiedone', value:5, chance:6.174706},
      {name:'Svinina Bombardino', value:5, chance:7.866941},
      {name:'Talpa Di Fero', value:5, chance:9.801263},
      {name:'Noobini Santanini', value:6, chance:11.970286},
      {name:'Raccooni Jandelini', value:6, chance:10.367802},
      {name:'Pipi Kiwi', value:7, chance:8.988478},
      {name:'Dragon Cannelloni', value:1500, chance:9.827651},
    ]
  },
  deposit_daily_200: {
    label: 'СУТОЧНЫЙ ЗАПАС', price: 0,
    items: [
      {name:'Lirili Larila', value:3, chance:12.058615},
      {name:'Tim Cheese', value:4, chance:12.655418},
      {name:'Talpa Di Fero', value:5, chance:11.555232},
      {name:'Pipi Kiwi', value:7, chance:4.733608},
      {name:'Los Chicleteiras', value:11, chance:6.174706},
      {name:'Six Seven', value:13, chance:7.866941},
      {name:'Arcadopus', value:16, chance:9.801263},
      {name:'Spaghetti Tualetti', value:20, chance:11.970286},
      {name:'La Secret Combinasion', value:80, chance:4.367802},
      {name:'Garama And Madundung', value:99, chance:8.988478},
      {name:'Cerberus', value:250, chance:9.827651},
    ]
  },
  deposit_weekly_1000: {
    label: 'НЕДЕЛЬНЫЙ ГРУЗ', price: 0,
    items: [
      {name:'La Secret Combinasion', value:80, chance:8.85699},
      {name:'Garama And Madundung', value:99, chance:5.329411},
      {name:'Burguro And Fryro', value:150, chance:8.04169},
      {name:'Spooky Lucky Block', value:155, chance:3.974476},
      {name:'Cash Or Card', value:160, chance:5.115227},
      {name:'Popcuru and Fizzuru', value:165, chance:6.454777},
      {name:'Celestial Pegasus', value:170, chance:7.985957},
      {name:'Capitano Moby', value:200, chance:9.702924},
      {name:'Fragola La La La', value:225, chance:11.600763},
      {name:'Cerberus', value:250, chance:10.675252},
      {name:'Reinito Sleighito', value:500, chance:10.9227},
      {name:'Dragon Cannelloni', value:1500, chance:10.339833},
    ]
  },
  deposit_weekly_9000: {
    label: 'ДРАКОНИЙ РЕЗЕРВ', price: 0,
    items: [
      {name:'La Secret Combinasion', value:80, chance:7.437494},
      {name:'Garama And Madundung', value:99, chance:6.696041},
      {name:'Burguro And Fryro', value:150, chance:6.085859},
      {name:'Spooky Lucky Block', value:155, chance:2.596356},
      {name:'Cash Or Card', value:160, chance:3.22067},
      {name:'Popcuru and Fizzuru', value:165, chance:3.953781},
      {name:'Celestial Pegasus', value:170, chance:4.79177},
      {name:'Capitano Moby', value:200, chance:5.731435},
      {name:'Cerberus', value:250, chance:6.770089},
      {name:'Fortunu and Cashuru', value:300, chance:7.90542},
      {name:'Cookie and Milki', value:350, chance:9.135409},
      {name:'Reinito Sleighito', value:500, chance:10.458263},
      {name:'Dragon Cannelloni', value:1500, chance:7.87238},
      {name:'Hydra Dragon Cannelloni', value:1700, chance:8.376308},
      {name:'Dragon Gingerini', value:5000, chance:8.968725},
    ]
  },
};
const IMG_BASE = '/static/';
function caseSlug(name) {
  // Файлы названы точно как персонажи, просто URL-кодируем пробелы и спецсимволы
  const imageAliases = {
    'Strawbery Elephant': 'Strawberry elephant',
    'Strawberry Elephant': 'Strawberry elephant',
    'Meowl': 'meowl',
  };
  const imageName = imageAliases[name] || name;
  return encodeURIComponent(imageName);
}

// Имена, у которых картинки нет (404) — больше не запрашиваем в этой сессии
const IMG_FAILED = new Set();

function imgPlaceholder(size) {
  return `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;font-size:${Math.round(size * 0.55)}px;margin:0 auto">🧠</div>`;
}

function imgFail(el) {
  const name = el.dataset.caseName || '';
  IMG_FAILED.add(name);
  const wrap = document.createElement('div');
  wrap.innerHTML = imgPlaceholder(el.getAttribute('width') || 56);
  el.replaceWith(wrap.firstChild);
}

function caseImgHtml(name, size = 56) {
  if (IMG_FAILED.has(name)) return imgPlaceholder(size);
  const url = `${IMG_BASE}${caseSlug(name)}.webp`;
  // loading="lazy" — грузятся только видимые картинки, а не все 300+ сразу
  return `<img src="${url}" data-case-name="${escHtml(name)}" width="${size}" height="${size}" loading="lazy" decoding="async" style="object-fit:contain;border-radius:6px" onerror="imgFail(this)">`;
}

// Цвет редкости по цене
function caseRarityColor(value) {
  if (value >= 1000) return '#ff6b00';
  if (value >= 400)  return '#d4af37';
  if (value >= 150)  return '#b060ff';
  if (value >= 60)   return '#00aaff';
  if (value >= 20)   return '#00cc88';
  return '#888';
}

// ══════════════════════════════════════════
// МОДАЛЬНАЯ КАРТОЧКА ВЫБОРА КЕЙСА
// ══════════════════════════════════════════

let _csmType  = null;  // текущий тип кейса
let _csmCount = 1;     // выбранное количество
const CSM_META = {
  mimiki:         { icon: '🎭', tierClass: 'tier-mimiki',    glowColor: '#ff64c8', badgeClass: 'mimiki'    },
  nubini:         { icon: '🥚', tierClass: 'tier-common',    glowColor: '#00cc88', badgeClass: 'common'    },
  sixseven:       { icon: '7️⃣', tierClass: 'tier-rare',      glowColor: '#a656f0', badgeClass: 'rare'      },
  sahur:          { icon: '🌙', tierClass: 'tier-rare',      glowColor: '#00aaff', badgeClass: 'rare'      },
  dragon:         { icon: '🐉', tierClass: 'tier-legendary', glowColor: '#ffd700', badgeClass: 'legendary' },
  farm_headless:  { icon: '🎃', tierClass: 'tier-legendary', glowColor: '#ff4400', badgeClass: 'legendary' },
  farm_skibidi:   { icon: '🚽', tierClass: 'tier-rare',      glowColor: '#00ccff', badgeClass: 'rare'      },
  farm_elephant:  { icon: '🍓', tierClass: 'tier-rare',      glowColor: '#ff69b4', badgeClass: 'rare'      },
  cash_vault:     { tierClass: 'tier-vault',  glowColor: '#70f7a8', badgeClass: 'badge-vault',  artClass: 'case-art-themed--vault' },
  night_raid:     { tierClass: 'tier-night',  glowColor: '#bd5cff', badgeClass: 'badge-night',  artClass: 'case-art-themed--night' },
  cosmic_signal:  { tierClass: 'tier-cosmic', glowColor: '#5cecff', badgeClass: 'badge-cosmic', artClass: 'case-art-themed--cosmic' },
  cyber_cube:     { tierClass: 'tier-cyber',  glowColor: '#6c8cff', badgeClass: 'badge-cyber',  artClass: 'case-art-themed--cyber' },
  dragon_forge:   { tierClass: 'tier-forge',  glowColor: '#ff6828', badgeClass: 'badge-forge',  artClass: 'case-art-themed--forge' },
  event_relic:    { tierClass: 'tier-event',  glowColor: '#ffbd42', badgeClass: 'badge-event',  asset: `${IMG_BASE}event-relic-case.svg` },
};

const CSM_ART_CLASSES = {
  mimiki: 'case-art--mimiki',
  nubini: 'case-art--nubini',
  sixseven: 'case-art--sixseven',
  sahur: 'case-art--sahur',
  dragon: 'case-art--dragon',
  farm_headless: 'case-art--headless',
  farm_skibidi: 'case-art--skibidi',
  farm_elephant: 'case-art--elephant',
};

function csmCaseArtHtml(type, meta) {
  if (meta.asset) {
    return `<img class="csm-case-custom-art" src="${meta.asset}" alt="">`;
  }
  if (meta.artClass) {
    return `<span class="case-art case-art-themed csm-case-art ${meta.artClass}" aria-hidden="true"></span>`;
  }
  if (!meta.customArt) {
    const artClass = CSM_ART_CLASSES[type] || CSM_ART_CLASSES.nubini;
    return `<span class="case-art csm-case-art ${artClass}" aria-hidden="true"></span>`;
  }
  const art = meta.customArt;
  const mascot = `${IMG_BASE}${caseSlug(art.mascot)}.webp`;
  return `<span class="case-object case-object--showcase case-object--${art.variant}" aria-hidden="true">
    <span class="case-handle"></span><span class="case-lid"></span>
    <span class="case-body"><b>${art.mark}</b></span><span class="case-latch"></span>
    <img class="case-mascot${art.wide ? ' case-mascot--wide' : ''}" src="${mascot}" alt="">
  </span>`;
}

function showCaseModal(type) {
  _csmType  = type;
  _csmCount = 1;

  const caseData = CASES_CLIENT[type];
  const meta     = CSM_META[type] || CSM_META['nubini'];
  // Шапка
  const iconEl = document.getElementById('csm-icon');
  iconEl.innerHTML = csmCaseArtHtml(type, meta);
  document.getElementById('csm-name').textContent      = caseData.label;
  document.getElementById('csm-price-val').textContent = `${caseData.price} 🧠`;
  document.querySelector('.csm-price-label').textContent = 'за кейс';
  const countLabel = document.getElementById('csm-count-label');
  const countRow = document.getElementById('csm-count-row');
  if (countLabel) countLabel.style.display = '';
  if (countRow) countRow.style.display = '';
  const totalLabel = document.getElementById('csm-total-label');
  if (totalLabel) totalLabel.textContent = 'ИТОГО';
  const fastButton = document.getElementById('csm-btn-fast');
  if (fastButton) fastButton.style.display = '';

  // Tier line
  const tierEl = document.getElementById('csm-tier-line');
  tierEl.className = 'csm-tier-line ' + meta.tierClass;

  // Glow
  const glowEl = document.getElementById('csm-icon-glow');
  glowEl.style.background = meta.glowColor;
  glowEl.style.animation  = type === 'dragon' ? 'legendGlow 1.8s ease-in-out infinite' : '';

  // Сброс кнопок количества
  document.querySelectorAll('.csm-cnt').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.n) === 1);
  });

  // Итого
  _csmUpdateTotal();
  // Дроп-лист (сортируем по value по возрастанию)
  const sorted = [...caseData.items].sort((a, b) => a.value - b.value);
  const listEl = document.getElementById('csm-drop-list');
  listEl.innerHTML = sorted.map(item => {
    const rc  = caseRarityColor(item.value);
    const tag = csmRarityTag(item.value);
    const imgUrl = `${IMG_BASE}${caseSlug(item.name)}.webp`;
    return `
      <div class="csm-drop-item" style="--rc:${rc}">
        <img src="${imgUrl}" class="csm-drop-img"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="csm-drop-img-fallback" style="display:none">📦</div>
        <div class="csm-drop-info">
          <div class="csm-drop-name">${item.name}</div>
          <div class="csm-drop-val" style="color:${rc}">${item.value} 🧠</div>
        </div>
        <div class="csm-rarity-tag" style="background:${rc}22;color:${rc}">${tag}</div>
      </div>
    `;
  }).join('');

  // Показываем
  document.getElementById('case-select-modal').style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeCaseModal() {
  document.getElementById('case-select-modal').style.display = 'none';
  document.body.style.overflow = '';
}

function csmSetCount(n) {
  _csmCount = n;
  document.querySelectorAll('.csm-cnt').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.n) === n);
  });
  _csmUpdateTotal();
}

function _csmUpdateTotal() {
  const price = CASES_CLIENT[_csmType]?.price || 0;
  document.getElementById('csm-total-val').textContent = `${price * _csmCount} 🧠`;
}

function csmRarityTag(value) {
  if (value >= 1000) return 'LEGENDARY';
  if (value >= 400)  return 'EPIC';
  if (value >= 150)  return 'RARE';
  if (value >= 60)   return 'UNCOMMON';
  if (value >= 20)   return 'COMMON';
  return 'BASIC';
}

const caseDropBusy = new Set();
let casePendingRequestSeq = 0;

function caseDropActionsHtml(dropId, value) {
  const id = Number(dropId);
  if (!id) return '';
  return `
    <div class="case-drop-actions" data-case-drop-card="${id}">
      <button type="button" class="case-drop-btn case-drop-sell" data-case-drop="${id}"
              onclick="caseResolveDrop(${id},'sell',this)">
        <b>ПРОДАТЬ</b><span>+${Math.floor(value || 0)} 🧠</span>
      </button>
      <button type="button" class="case-drop-btn case-drop-keep" data-case-drop="${id}"
              onclick="caseResolveDrop(${id},'keep',this)">
        <b>ОСТАВИТЬ</b><span>в игровом инвентаре</span>
      </button>
    </div>`;
}

function caseMarkDropResolved(dropId, data) {
  const kept = data.status === 'kept';
  document.querySelectorAll(`[data-case-drop-card="${Number(dropId)}"]`).forEach(actions => {
    actions.classList.add('resolved', kept ? 'kept' : 'sold');
    actions.innerHTML = `
      <div class="case-drop-resolved-mark">
        <b>${kept ? 'В ИНВЕНТАРЕ' : 'ПРОДАНО'}</b>
        <span>${kept ? 'Предмет сохранён в игровом инвентаре' : `+${Math.floor(data.item_value || 0)} 🧠 на баланс`}</span>
      </div>`;
  });
}

function caseCloseResolvedOverlayIfDone() {
  const overlay = document.getElementById('case-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (overlay.querySelector('.case-drop-actions:not(.resolved)')) return;
  setTimeout(() => closeCaseOverlay(), 300);
}

async function caseResolveDrop(dropId, action, button = null, options = {}) {
  const id = Number(dropId);
  if (!id || caseDropBusy.has(id)) return null;
  caseDropBusy.add(id);
  document.querySelectorAll(`[data-case-drop="${id}"]`).forEach(btn => { btn.disabled = true; });
  try {
    const res = await fetch(`${API}/api/case/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, drop_id: id, action })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    caseMarkDropResolved(id, data);
    if (typeof data.balance === 'number') updateBalanceDisplay(data.balance);
    if (!options.silent) {
      if (data.already_resolved) {
        showToast(data.status === 'kept'
          ? 'Предмет сохранён в игровом инвентаре'
          : 'Этот предмет уже был продан', 'win');
      } else {
        showToast(data.status === 'kept'
          ? `${data.item_name} сохранён в игровом инвентаре`
          : `+${Math.floor(data.item_value || 0)} 🧠`, 'win');
      }
    }
    caseCloseResolvedOverlayIfDone();
    if (!options.deferRefresh) {
      loadInit();
      await loadCasePendingDrops();
    }
    return data;
  } catch (error) {
    if (!options.silent) showToast(error.message || 'Не удалось обработать дроп', 'lose');
    document.querySelectorAll(`[data-case-drop="${id}"]`).forEach(btn => { btn.disabled = false; });
    return null;
  } finally {
    caseDropBusy.delete(id);
  }
}

async function caseResolveMany(dropIds, action, button = null) {
  const ids = [...new Set((dropIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return;
  const bulk = button && button.closest('.case-drop-bulk');
  const bulkButtons = bulk ? bulk.querySelectorAll('button') : [];
  bulkButtons.forEach(btn => { btn.disabled = true; });
  let processed = 0;
  let alreadyResolved = 0;
  let failed = 0;
  let totalSold = 0;
  for (const id of ids) {
    const data = await caseResolveDrop(id, action, null, { silent: true, deferRefresh: true });
    if (!data) {
      failed += 1;
      continue;
    }
    if (data.already_resolved) {
      alreadyResolved += 1;
      continue;
    }
    const expectedStatus = action === 'keep' ? 'kept' : 'sold';
    if (data.status !== expectedStatus) {
      failed += 1;
      continue;
    }
    processed += 1;
    if (data.status === 'sold') totalSold += Number(data.item_value || 0);
  }
  await loadCasePendingDrops();
  if (processed) {
    showToast(action === 'keep'
      ? `${processed} шт. сохранено в игровом инвентаре`
      : `Продано: ${processed} шт. · +${Math.floor(totalSold)} 🧠`, 'win');
  } else if (alreadyResolved && !failed) {
    showToast('Эти дропы уже были обработаны', 'win');
  } else {
    showToast('Не удалось обработать дропы', 'lose');
  }
  loadInit();
}

function caseBulkActionsHtml(drops) {
  const ids = (drops || []).map(drop => Number(drop.drop_id || drop.id)).filter(Boolean);
  if (ids.length < 2) return '';
  const encoded = JSON.stringify(ids);
  return `
    <div class="case-drop-bulk">
      <button type="button" onclick="caseResolveMany(${encoded},'sell',this)">ПРОДАТЬ ВСЕ</button>
      <button type="button" onclick="caseResolveMany(${encoded},'keep',this)">ВСЕ В ИНВЕНТАРЬ</button>
    </div>`;
}

async function loadCasePendingDrops() {
  const panel = document.getElementById('case-pending-drops');
  if (!panel) return;
  const requestSeq = ++casePendingRequestSeq;
  try {
    const res = await fetch(`${API}/api/case/pending?tg_id=${tg_id}&_=${Date.now()}-${requestSeq}`, {
      cache: 'no-store'
    });
    const data = await res.json();
    if (requestSeq !== casePendingRequestSeq) return;
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    const drops = data.drops || [];
    if (!drops.length) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }
    panel.style.display = 'block';
    panel.innerHTML = `
      <div class="case-pending-head"><b>НЕРАЗОБРАННЫЕ ДРОПЫ</b><span>${drops.length}</span></div>
      ${caseBulkActionsHtml(drops)}
      <div class="case-pending-list">
        ${drops.map(drop => `
          <div class="case-pending-item">
            ${caseImgHtml(drop.item_name, 42)}
            <div class="case-pending-copy"><b>${escHtml(drop.item_name)}</b><span>${Math.floor(drop.item_value)} 🧠</span></div>
            ${caseDropActionsHtml(drop.id, drop.item_value)}
          </div>`).join('')}
      </div>`;
  } catch (error) {
    if (requestSeq === casePendingRequestSeq) panel.style.display = 'none';
  }
}

// Открытие: fast=false → анимация, fast=true → без анимации
async function csmDoOpen(fast) {
  if (isPlaying) return;
  if (!_csmType || !_csmCount) return;

  closeCaseModal();

  if (fast) {
    // Быстрое открытие: делаем N запросов и показываем итоговые результаты без рулетки
    await openCaseFast(_csmType, _csmCount);
  } else {
    // Классическое открытие: по одному, с анимацией
    await openCaseSequential(_csmType, _csmCount);
  }
}

async function openCaseSequential(type, count) {
  if (isPlaying) return;
  isPlaying = true;

  // Запросы строго последовательно — иначе race condition на UPDATE общего баланса в SQLite
  const responses = [];
  for (let i = 0; i < count; i++) {
    let data;
    try {
      const res = await fetch(`${API}/api/case/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tg_id, case_type: type })
      });
      data = await res.json();
    } catch (e) {
      showToast('Ошибка сервера', 'lose');
      isPlaying = false;
      return;
    }
    if (data.error) {
      const message = data.error === 'insufficient_balance'
        ? 'Недостаточно баланса!'
        : data.error === 'event_case_inactive'
          ? 'Ивентовый кейс уже закрыт'
          : data.error;
      showToast(message, 'lose');
      // Если уже открыли часть — всё равно показываем результаты
      if (responses.length > 0) break;
      isPlaying = false;
      return;
    }
    responses.push(data);
  }

  if (responses.length === 0) { isPlaying = false; return; }

  const animationCaseType = String(responses[0]?.case_type || type);
  await runMultiCaseAnimation(animationCaseType, responses);
  loadInit();
  isPlaying = false;
}

function caseTrackGeometry(track) {
  const firstItem = track && track.firstElementChild;
  if (!firstItem) return { itemWidth: 108, step: 116 };
  const trackStyle = window.getComputedStyle(track);
  const gap = Number.parseFloat(trackStyle.columnGap || trackStyle.gap || '0') || 0;
  const itemWidth = firstItem.getBoundingClientRect().width || firstItem.offsetWidth || 108;
  return { itemWidth, step: itemWidth + gap };
}

function caseUsesCompactMobileFlow() {
  return window.innerWidth <= 899;
}

function caseCountLabel(count) {
  const value = Math.abs(Number(count) || 0) % 100;
  const tail = value % 10;
  if (value >= 11 && value <= 14) return 'КЕЙСОВ';
  if (tail === 1) return 'КЕЙС';
  if (tail >= 2 && tail <= 4) return 'КЕЙСА';
  return 'КЕЙСОВ';
}

function caseSetOverlayVisible(overlay, visible) {
  if (!overlay) return;
  overlay.style.display = visible ? 'flex' : 'none';
  document.documentElement.classList.toggle('case-overlay-active', visible);
  document.body.style.overflow = visible ? 'hidden' : '';
  if (visible) {
    overlay.scrollTop = 0;
    requestAnimationFrame(() => { overlay.scrollTop = 0; });
  }
}

function caseOpeningIntroHtml(caseType, label, count = 1) {
  const meta = CSM_META[caseType] || CSM_META.nubini;
  return `
    <div class="case-opening-intro-card">
      <div class="case-opening-kicker">ПОДГОТОВКА ДРОПА</div>
      <div class="case-opening-crate">
        <div class="case-opening-crate-light"></div>
        <div class="case-opening-crate-lid"></div>
        <div class="case-opening-crate-body">
          <div class="case-opening-emblem">${csmCaseArtHtml(caseType, meta)}</div>
        </div>
      </div>
      <div class="case-opening-title">${escHtml(label)}${count > 1 ? ` × ${count}` : ''}</div>
      <div class="case-opening-subtitle">КЕЙС ОТКРЫВАЕТСЯ — ЛЕНТА ЗАПУСТИТСЯ СНИЗУ</div>
    </div>`;
}

async function casePlayOpeningIntro(overlay, caseType, label, count = 1) {
  overlay.querySelectorAll('.case-opening-intro').forEach(node => node.remove());
  overlay.classList.remove('case-phase-spin', 'case-phase-reveal', 'has-results');
  overlay.classList.add('case-phase-spin');
  if (overlay.classList.contains('case-many')) {
    overlay.scrollTop = 0;
    requestAnimationFrame(() => { overlay.scrollTop = 0; });
  }
}

async function runMobileCaseBatchAnimation(caseType, responses) {
  const caseData = CASES_CLIENT[caseType] || CASES_CLIENT['nubini'];
  const caseLabel = caseData.label || caseData.name || String(caseType || 'КЕЙС').toUpperCase();
  const overlay = document.getElementById('case-overlay');
  overlay.className = 'case-open-overlay case-open-overlay--multi case-many case-mobile-batch';
  overlay.dataset.caseCount = String(responses.length);
  overlay.innerHTML = `
    <div class="case-multi-header">📦 ${escHtml(caseLabel)} × ${responses.length}</div>
    <div class="case-mobile-batch-stage" aria-live="polite">
      <div class="case-mobile-batch-stack" aria-hidden="true"><i></i><i></i><i></i></div>
      <b>ОТКРЫВАЕМ ${responses.length} КЕЙСОВ</b>
      <span>РЕЗУЛЬТАТЫ ПОЯВЯТСЯ ОДНОЙ ЛЕНТОЙ</span>
    </div>`;
  caseSetOverlayVisible(overlay, true);

  await casePlayOpeningIntro(overlay, caseType, caseLabel, responses.length);
  if (caseType === 'mimiki') mimikiRain();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  await sleep(reduced ? 20 : 420);

  const totalProfit = responses.reduce((sum, data) => sum + Number(data.profit || 0), 0);
  const stage = overlay.querySelector('.case-mobile-batch-stage');
  if (stage) stage.remove();

  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'case-multi-results case-mobile-batch-results';
  const bulk = caseBulkActionsHtml(responses);
  const sorted = [...responses].sort((a, b) => Number(b.payout || 0) - Number(a.payout || 0));
  resultsDiv.innerHTML = `
    <div class="case-multi-summary">
      <span>ИТОГО ЗА ${responses.length} ${caseCountLabel(responses.length)}</span>
      <b style="color:${totalProfit >= 0 ? 'var(--win)' : 'var(--lose)'}">${totalProfit >= 0 ? '+' : ''}${totalProfit} 🧠</b>
    </div>
    ${bulk}
    <div class="case-mobile-drop-list">
      ${sorted.map((data, index) => {
        const value = Number(data.payout || 0);
        const profit = Number(data.profit || 0);
        const name = data.item?.name || '?';
        const color = caseRarityColor(value);
        return `
          <div class="case-multi-drop case-mobile-drop" style="--rc:${color};--case-delay:${Math.min(index * 55, 440)}ms">
            <div class="case-drop-main">
              <div class="case-drop-visual">${caseImgHtml(name, 64)}</div>
              <div class="case-mobile-drop-copy">
                <b>${escHtml(name)}</b>
                <span style="color:${color}">${value} 🧠</span>
              </div>
              <strong style="color:${profit >= 0 ? 'var(--win)' : 'var(--lose)'}">${profit >= 0 ? '+' : ''}${profit}</strong>
            </div>
            ${caseDropActionsHtml(data.drop_id, value)}
          </div>`;
      }).join('')}
    </div>`;
  overlay.appendChild(resultsDiv);
  overlay.classList.remove('case-phase-spin');
  overlay.classList.add('has-results', 'case-phase-reveal');
  overlay.scrollTo({ top: 0, behavior: 'auto' });

  if (totalProfit > 0) showToast(`+${totalProfit} 🧠`, 'win');
  else showToast(`${totalProfit} 🧠`, 'lose');
}

async function caseAnimatePrizeTransfer(sourceEl, targetEl, color) {
  // Прежний стиль: результат появляется на месте, без перелёта карточки.
}

// ── Параллельная анимация N кейсов ──────────────────────────────────────
async function runMultiCaseAnimation(caseType, responses) {
  if (responses.length > 1 && caseUsesCompactMobileFlow()) {
    await runMobileCaseBatchAnimation(caseType, responses);
    return;
  }
  const caseData = CASES_CLIENT[caseType] || CASES_CLIENT['nubini'];
  const caseLabel = caseData.label || caseData.name || String(caseType || 'КЕЙС').toUpperCase();
  const allItems = caseData.items;
  const compactMobile = caseUsesCompactMobileFlow();
  const TOTAL    = compactMobile ? 30 : 50;
  const WIN_POS  = compactMobile ? 22 : 38;
  // Строим оверлей с N рулетками
  const overlay = document.getElementById('case-overlay');
  overlay.className = `case-open-overlay case-open-overlay--multi${responses.length >= 5 ? ' case-many' : ''}`;
  overlay.dataset.caseCount = String(responses.length);
  overlay.innerHTML = '';
  overlay.scrollTop = 0;
  caseSetOverlayVisible(overlay, true);
  overlay.style.flexDirection = 'column';
  overlay.style.alignItems    = 'center';
  overlay.style.justifyContent = 'flex-start';
  overlay.style.padding = '16px 0 24px';
  overlay.style.overflowY = 'auto';
  overlay.style.gap = '0';

  // Шапка
  const header = document.createElement('div');
  header.className = 'case-multi-header';
  header.style.cssText = `
    font-family:'Bebas Neue',sans-serif;font-size:18px;letter-spacing:3px;
    color:var(--gold);margin-bottom:14px;flex-shrink:0;
    text-shadow:0 0 20px rgba(245,197,66,.5);
  `;
  header.textContent = `📦 ${caseLabel} × ${responses.length}`;
  overlay.appendChild(header);

  // Контейнер рулеток
  const reelsWrap = document.createElement('div');
  reelsWrap.className = 'case-multi-reels';
  reelsWrap.style.cssText = `
    display:flex;flex-direction:column;gap:8px;width:100%;
    padding:0 12px;flex-shrink:0;
  `;
  overlay.appendChild(reelsWrap);

  const trackRefs = []; // { track, targetX, winEl, winVal, winName, profit }

  responses.forEach((data, idx) => {
    const winName  = data.item?.name || '';
    const winVal   = data.payout || 0;
    const winData  = allItems.find(i => i.name === winName) || { name: winName, value: winVal, chance: 1 };

    // Строим трек
    const trackItems = [];
    for (let i = 0; i < TOTAL; i++) {
      trackItems.push(i === WIN_POS ? winData : weightedRandom(allItems));
    }

    // Обёртка рулетки
    const row = document.createElement('div');
    row.className = 'case-multi-reel';
    row.style.cssText = `position:relative;width:100%;`;

    // Стрелки
    const pTop = document.createElement('div');
    pTop.className = 'case-pointer case-pointer-top';
    const pBot = document.createElement('div');
    pBot.className = 'case-pointer case-pointer-bot';

    // Viewport
    const viewport = document.createElement('div');
    viewport.className = 'case-spin-viewport';
    viewport.style.height = '110px';

    // Центральная линия
    const centerLine = document.createElement('div');
    centerLine.className = 'case-center-line';

    // Трек
    const track = document.createElement('div');
    track.className = 'case-spin-track';
    track.style.transition = 'none';
    track.style.transform  = 'translateX(0)';

    trackItems.forEach((item, i) => {
      const isWin  = i === WIN_POS;
      const rColor = caseRarityColor(item.value);
      const el     = document.createElement('div');
      el.className = 'case-spin-item' + (isWin ? ' case-spin-item-win' : '');
      el.style.setProperty('--rc', rColor);
      el.innerHTML = `
        <div class="item-rarity-bar" style="background:${rColor}"></div>
        <div class="item-icon">${caseImgHtml(item.name, 44)}</div>
        <div class="item-name">${item.name}</div>
        <div class="item-val" style="color:${rColor}">${item.value} 🧠</div>
      `;
      track.appendChild(el);
    });

    viewport.appendChild(track);
    row.appendChild(pTop);
    row.appendChild(viewport);
    row.appendChild(centerLine);
    row.appendChild(pBot);
    reelsWrap.appendChild(row);

    trackRefs.push({
      track, winEl: null, winVal, winName, profit: data.profit || 0,
      dropId: data.drop_id, pTop, pBot
    });
  });

  // Даём браузеру отрисовать
  await sleep(80);

  trackRefs.forEach(ref => {
    const viewportW = ref.track.parentElement.offsetWidth;
    const halfView  = viewportW / 2;
    const geometry = caseTrackGeometry(ref.track);
    ref.targetX = -(WIN_POS * geometry.step - halfView + geometry.itemWidth / 2);
  });

  await casePlayOpeningIntro(overlay, caseType, caseLabel, responses.length);

  // Запускаем дождь только после вычисления позиций
  if (caseType === 'mimiki') mimikiRain();

  // Единая плавная кривая с tiny каскадом старта. На телефоне лента
  // короче, чтобы не держать GPU и десятки картинок лишние секунды.
  const spinDuration = compactMobile ? 3.6 : 6.2;
  trackRefs.forEach((ref, idx) => {
    setTimeout(() => {
      ref.track.style.transition = `transform ${spinDuration}s cubic-bezier(0.04, 0.94, 0.1, 1.0)`;
      ref.track.style.transform  = `translateX(${ref.targetX}px)`;
    }, idx * 40);
  });

  await sleep((compactMobile ? 3700 : 6300) + trackRefs.length * 40 + 60);

  // Подсвечиваем победные элементы
  trackRefs.forEach(ref => {
    const winEl = ref.track.children[WIN_POS];
    if (!winEl) return;
    ref.winEl = winEl;
    const rc = caseRarityColor(ref.winVal);
    winEl.classList.add('case-spin-item-landed');
    winEl.style.borderColor = rc;
    winEl.style.boxShadow   = `0 0 24px ${rc}aa, 0 0 8px ${rc}66`;
    ref.pTop.style.color      = rc;
    ref.pTop.style.textShadow = `0 0 12px ${rc}`;
    ref.pBot.style.color      = rc;
    ref.pBot.style.textShadow = `0 0 12px ${rc}`;
  });

  await sleep(500);

  // 3. Итоговая карточка — показываем все дропы + суммарный профит
  const totalProfit = trackRefs.reduce((s, r) => s + r.profit, 0);

  const resultsDiv = document.createElement('div');
  resultsDiv.className = 'case-multi-results';
  resultsDiv.style.cssText = `
    width:100%;padding:12px;display:flex;flex-direction:column;gap:6px;
    flex-shrink:0;margin-top:10px;
  `;

  // Строка с суммарным профитом
  const sumRow = document.createElement('div');
  sumRow.className = 'case-multi-summary';
  sumRow.style.cssText = `
    display:flex;align-items:center;justify-content:space-between;
    background:var(--surface2);border:1px solid var(--border);
    border-radius:12px;padding:10px 14px;margin-bottom:4px;
  `;
  sumRow.innerHTML = `
    <span style="font-family:'Space Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:2px">ИТОГО ЗА ${responses.length} ${caseCountLabel(responses.length)}</span>
    <span style="font-family:'Space Mono',monospace;font-size:18px;font-weight:700;color:${totalProfit>=0?'var(--win)':'var(--lose)'}">${totalProfit>=0?'+':''}${totalProfit} 🧠</span>
  `;
  resultsDiv.appendChild(sumRow);

  const bulkWrap = document.createElement('div');
  bulkWrap.innerHTML = caseBulkActionsHtml(responses);
  if (bulkWrap.firstElementChild) resultsDiv.appendChild(bulkWrap.firstElementChild);

  // Список дропов (компактно)
  const sortedRefs = [...trackRefs].sort((a, b) => b.winVal - a.winVal);
  const transferPairs = [];
  sortedRefs.forEach(ref => {
    const rc = caseRarityColor(ref.winVal);
    const item = document.createElement('div');
    item.className = 'case-multi-drop case-drop-receiving';
    item.style.cssText = `
      display:block;
      background:var(--surface2);border:1px solid ${rc}33;
      border-left:3px solid ${rc};border-radius:10px;padding:8px 10px;
      animation:caseResultIn .35s cubic-bezier(0.34,1.56,0.64,1) both;
    `;
    item.style.setProperty('--rc', rc);
    item.innerHTML = `
      <div class="case-drop-main">
        <div class="case-drop-visual">${caseImgHtml(ref.winName, 72)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Space Mono',monospace;font-size:9px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(ref.winName)}</div>
          <div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${rc}">${ref.winVal} 🧠</div>
        </div>
        <div style="font-family:'Space Mono',monospace;font-size:11px;font-weight:700;color:${ref.profit>=0?'var(--win)':'var(--lose)'}">${ref.profit>=0?'+':''}${ref.profit}</div>
      </div>
      ${caseDropActionsHtml(ref.dropId, ref.winVal)}
    `;
    resultsDiv.appendChild(item);
    transferPairs.push({ ref, item, target: item.querySelector('.case-drop-visual'), color: rc });
  });

  overlay.appendChild(resultsDiv);
  overlay.classList.remove('case-phase-spin');
  overlay.classList.add('has-results', 'case-phase-reveal');

  await sleep(80);
  if (window.innerWidth >= 900 && transferPairs.length <= 4) {
    await Promise.all(transferPairs.map(async (pair, index) => {
      await sleep(index * 90);
      await caseAnimatePrizeTransfer(pair.ref.winEl, pair.target, pair.color);
      pair.item.classList.remove('case-drop-receiving');
      pair.item.classList.add('case-drop-received');
    }));
  } else {
    transferPairs.forEach(pair => {
      pair.item.classList.remove('case-drop-receiving');
      pair.item.classList.add('case-drop-received');
    });
    const resultsTop = Math.max(0, resultsDiv.offsetTop - 58);
    overlay.scrollTo({ top: resultsTop, behavior: 'auto' });
  }

  if (totalProfit > 0) showToast(`+${totalProfit} 🧠`, 'win');
  else showToast(`${totalProfit} 🧠`, 'lose');
}

// Восстанавливает статический контент оверлея (для одиночного openCase)
function _restoreCaseOverlayHTML() {
  const overlay = document.getElementById('case-overlay');
  overlay.className = 'case-open-overlay case-open-overlay--single';
  delete overlay.dataset.caseCount;
  overlay.style.flexDirection  = '';
  overlay.style.alignItems     = '';
  overlay.style.justifyContent = 'center';  // одиночный кейс — по центру
  overlay.style.padding        = '';
  overlay.style.overflowY      = '';
  overlay.style.gap            = '';
  overlay.scrollTop            = 0;
  overlay.innerHTML = `
    <div class="case-overlay-header" id="case-overlay-header">
      <span id="case-overlay-title">ОТКРЫВАЕМ...</span>
    </div>
    <div class="case-open-anim">
      <div class="case-pointer case-pointer-top">▼</div>
      <div class="case-pointer case-pointer-bot">▲</div>
      <div class="case-spin-viewport">
        <div class="case-spin-track" id="case-track"></div>
      </div>
      <div class="case-center-line"></div>
    </div>
    <div class="case-open-result" id="case-open-result"></div>
  `;
}

async function openCaseFast(type, count) {
  if (isPlaying) return;
  isPlaying = true;

  const results  = [];
  let totalProfit = 0;

  // Запросы строго последовательно — иначе race condition на общий баланс
  for (let i = 0; i < count; i++) {
    let data;
    try {
      const res = await fetch(`${API}/api/case/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tg_id, case_type: type })
      });
      data = await res.json();
    } catch (e) {
      showToast('Ошибка сервера', 'lose');
      isPlaying = false;
      return;
    }
    if (data.error) {
      const message = data.error === 'insufficient_balance'
        ? 'Недостаточно баланса!'
        : data.error === 'event_case_inactive'
          ? 'Ивентовый кейс уже закрыт'
          : data.error;
      showToast(message, 'lose');
      if (results.length > 0) break;
      isPlaying = false;
      return;
    }
    results.push(data);
    totalProfit += data.profit || 0;
  }

  // Показываем компактный результат прямо в case-result
  const resultEl = document.getElementById('case-result');
  const sortedResults = [...results].sort((a, b) => (b.payout || 0) - (a.payout || 0));

  const itemsHtml = sortedResults.map(data => {
    const rc = caseRarityColor(data.payout || 0);
    const imgUrl = data.image_url || `${IMG_BASE}${caseSlug(data.item?.name || '')}.webp`;
    return `
      <div class="case-drop-result" style="border-color:${rc}44;border-left-color:${rc}">
        <div class="case-drop-main">
          <img src="${imgUrl}" width="36" height="36" style="object-fit:contain;border-radius:4px;flex-shrink:0" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0">
            <div style="font-family:'Space Mono',monospace;font-size:9px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(data.item?.name || '?')}</div>
            <div style="font-family:'Space Mono',monospace;font-size:12px;font-weight:700;color:${rc}">${data.payout} 🧠</div>
          </div>
          <div style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:${data.profit>0?'var(--win)':'var(--lose)'}">${data.profit>0?'+':''}${data.profit} 🧠</div>
        </div>
        ${caseDropActionsHtml(data.drop_id, data.payout)}
      </div>
    `;
  }).join('');

  resultEl.innerHTML = `
    <div style="font-family:'Space Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:2px;margin-bottom:10px">📦 ОТКРЫТО КЕЙСОВ: ${count}</div>
    ${caseBulkActionsHtml(results)}
    <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">${itemsHtml}</div>
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:10px 14px">
      <span style="font-family:'Space Mono',monospace;font-size:9px;color:var(--text-dim);letter-spacing:2px">ПО ЦЕННОСТИ</span>
      <span style="font-family:'Space Mono',monospace;font-size:16px;font-weight:700;color:${totalProfit>=0?'var(--win)':'var(--lose)'}">${totalProfit>=0?'+':''}${totalProfit} 🧠</span>
    </div>
  `;
  resultEl.className = `result-box ${totalProfit >= 0 ? 'result-win' : 'result-lose'}`;
  resultEl.style.display = 'block';

  // Скроллим страницу вниз к результатам
  setTimeout(() => resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);

  if (totalProfit > 0) showToast(`+${totalProfit} 🧠 за ${count} кейсов`, 'win');
  else showToast(`${totalProfit} 🧠 за ${count} кейсов`, 'lose');

  loadInit();
  isPlaying = false;
}

async function openCase(type) {
  if (isPlaying) return;
  isPlaying = true;

  document.getElementById('case-result').style.display = 'none';

  try {
    const res = await fetch(`${API}/api/case/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, case_type: type })
    });
    const data = await res.json();

    if (data.error) {
      showToast(data.error === 'insufficient_balance' ? 'Недостаточно баланса!' : data.error, 'lose');
      isPlaying = false;
      return;
    }

    // Восстанавливаем статический HTML оверлея (мог быть перезаписан multi-режимом)
    _restoreCaseOverlayHTML();
    // Устанавливаем заголовок оверлея
    const animationCaseType = String(data.case_type || type);
    const caseInfo = CASES_CLIENT[animationCaseType] || CASES_CLIENT['nubini'];
    const titleEl = document.getElementById('case-overlay-title');
    if (titleEl) titleEl.textContent = `📦 ${caseInfo.label}`;

    // Запускаем анимацию
    await runCaseAnimation(animationCaseType, data.item?.name, data.payout, data.image_url, data.drop_id);

    const profit = data.profit;
    showResult('case-result', {
      win: data.result === 'win',
      title: data.result === 'win' ? `📦 ${data.item?.name || 'предмет'}` : '📦 Не повезло',
      detail: `Стоимость: ${data.payout} 🧠`,
      amount: profit
    });

    if (profit > 0) showToast(`+${profit} 🧠`, 'win');
    else showToast(`${profit} 🧠`, 'lose');

    loadInit();
  } catch (e) {
    console.error(e);
    showToast('Ошибка сервера', 'lose');
  }

  isPlaying = false;
}

// These weights affect reel filler only. The actual prize always comes from the server.
function weightedRandom(items) {
  const available = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!available.length) return { name: '', value: 0, chance: 1 };
  const total = available.reduce((sum, item) => sum + Math.max(0, Number(item.chance || 0)), 0);
  if (total <= 0) return available[Math.floor(Math.random() * available.length)];
  let roll = Math.random() * total;
  for (const item of available) {
    roll -= Math.max(0, Number(item.chance || 0));
    if (roll <= 0) return item;
  }
  return available[available.length - 1];
}

async function runCaseAnimation(caseType, winName, winVal, winImageUrl, dropId) {
  const overlay  = document.getElementById('case-overlay');
  const track    = document.getElementById('case-track');
  const resultEl = document.getElementById('case-open-result');

  caseSetOverlayVisible(overlay, true);
  overlay.className = 'case-open-overlay case-open-overlay--single';
  overlay.classList.remove('has-results', 'case-phase-reveal');
  resultEl.style.display = 'none';
  resultEl.innerHTML = '';
  resultEl.classList.remove('case-result-appear', 'case-result-receiving', 'case-result-received');
  track.innerHTML = '';
  track.style.transition = 'none';
  track.style.transform = 'translateX(0)';

  const caseData  = CASES_CLIENT[caseType] || CASES_CLIENT['nubini'];
  const caseLabel = caseData.label || caseData.name || String(caseType || 'КЕЙС').toUpperCase();
  const allItems  = caseData.items;
  const compactMobile = caseUsesCompactMobileFlow();
  const TOTAL     = compactMobile ? 30 : 50;
  const WIN_POS   = compactMobile ? 22 : 38; // позиция выигрышного предмета

  // Ищем данные выигрышного предмета
  const winData = allItems.find(i => i.name === winName) || { name: winName, value: winVal, chance: 1 };

  // Предмет-обманка перед победным: близкой стоимости, рандомно выбирается
  // Иногда его нет (50% случаев) — чтобы не было предсказуемо
  const useDecoy = Math.random() < 0.5;
  const decoyPool = allItems.filter(i => i.name !== winName);
  const decoyItem = useDecoy
    ? weightedRandom(decoyPool.length ? decoyPool : allItems)
    : null;

  // Создаём трек: TOTAL предметов
  // WIN_POS — победный, WIN_POS-1 — обманка если есть
  const trackItems = [];
  for (let i = 0; i < TOTAL; i++) {
    if (i === WIN_POS) {
      trackItems.push(winData);
    } else if (i === WIN_POS - 1 && decoyItem) {
      trackItems.push(decoyItem);
    } else {
      trackItems.push(weightedRandom(allItems));
    }
  }

  // Строим DOM
  trackItems.forEach((item, idx) => {
    const isWin  = idx === WIN_POS;
    const rColor = caseRarityColor(item.value);
    const el     = document.createElement('div');
    el.className = 'case-spin-item' + (isWin ? ' case-spin-item-win' : '');
    el.style.setProperty('--rc', rColor);
    el.innerHTML = `
      <div class="item-rarity-bar" style="background:${rColor}"></div>
      <div class="item-icon">${caseImgHtml(item.name, 52)}</div>
      <div class="item-name">${item.name}</div>
      <div class="item-val" style="color:${rColor}">${item.value} 🧠</div>
    `;
    track.appendChild(el);
  });

  await sleep(60);

  // Запускаем дождь только после отрисовки трека
  if (caseType === 'mimiki') mimikiRain();

  const viewportW = track.parentElement.offsetWidth;
  const halfView  = viewportW / 2;
  const geometry = caseTrackGeometry(track);
  const targetX = -(WIN_POS * geometry.step - halfView + geometry.itemWidth / 2);

  const overlayTitle = document.getElementById('case-overlay-title');
  if (overlayTitle) overlayTitle.textContent = `📦 ${caseLabel}`;
  await casePlayOpeningIntro(overlay, caseType, caseLabel, 1);

  // Кривая: резкий старт, последние ~2с очень медленно ползёт к центру
  const spinDuration = compactMobile ? 3.6 : 6.2;
  track.style.transition = `transform ${spinDuration}s cubic-bezier(0.04, 0.94, 0.1, 1.0)`;
  track.style.transform  = `translateX(${targetX}px)`;

  await sleep(compactMobile ? 3700 : 6300);

  // Подсветка победного элемента
  const winEl = track.children[WIN_POS];
  if (winEl) {
    const rColor = caseRarityColor(winVal);
    winEl.classList.add('case-spin-item-landed');
    winEl.style.borderColor = rColor;
    winEl.style.boxShadow   = `0 0 24px ${rColor}aa, 0 0 8px ${rColor}66`;
    // Подсвечиваем стрелки тем же цветом
    document.querySelectorAll('.case-pointer').forEach(p => {
      p.style.color      = rColor;
      p.style.textShadow = `0 0 12px ${rColor}`;
    });
  }

  await sleep(420);

  // ── Показываем результат ──────────────────────────────────────────────────
  const rColor   = caseRarityColor(winVal);
  const imgUrl   = winImageUrl || `${IMG_BASE}${caseSlug(winName)}.webp`;
  const isProfit = winVal > (caseData.price || 0);
  const resultMeta = `<span class="${isProfit ? 'profit-pos' : 'profit-neg'}">${isProfit ? '+' : ''}${winVal - (caseData.price || 0)} 🧠</span>`;

  resultEl.classList.add('case-result-receiving');
  resultEl.innerHTML = `
    <div class="case-result-card" style="--rc:${rColor}">
      <div class="case-result-img-wrap">
        <img src="${imgUrl}" class="case-result-img"
             onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <div class="case-result-img-fallback" style="display:none">📦</div>
        <div class="case-result-glow" style="background:radial-gradient(ellipse,${rColor}55 0%,transparent 70%)"></div>
      </div>
      <div class="case-result-name">${escHtml(winName)}</div>
      <div class="case-result-val" style="color:${rColor}">${winVal} 🧠</div>
      <div class="case-result-profit">${resultMeta}</div>
      ${caseDropActionsHtml(dropId, winVal)}
    </div>
  `;
  resultEl.style.display = 'block';
  overlay.classList.remove('case-phase-spin');
  overlay.classList.add('has-results', 'case-phase-reveal');
  await sleep(80);
  await caseAnimatePrizeTransfer(winEl, resultEl.querySelector('.case-result-img-wrap'), rColor);
  resultEl.classList.remove('case-result-receiving');
  resultEl.classList.add('case-result-received', 'case-result-appear');
}

// В closeCaseOverlay — уже есть if (type === 'mimiki') mimikiRain();
// Замени на:
function closeCaseOverlay(type) {
  const overlay = document.getElementById('case-overlay');
  caseSetOverlayVisible(overlay, false);
  overlay.className = 'case-open-overlay case-open-overlay--single';
  delete overlay.dataset.caseCount;
  overlay.style.flexDirection  = '';
  overlay.style.alignItems     = '';
  overlay.style.justifyContent = '';
  overlay.style.padding        = '';
  overlay.style.overflowY      = '';
  overlay.style.gap            = '';
  overlay.querySelectorAll('.case-opening-intro').forEach(node => node.remove());
  document.querySelectorAll('.case-prize-transfer').forEach(node => node.remove());
  document.querySelectorAll('.case-pointer').forEach(p => {
    p.style.color = '';
    p.style.textShadow = '';
  });
  // Убираем дождь при закрытии
  const rain = document.getElementById('mimiki-rain-wrap');
  if (rain) {
    if (rain._autoStop) clearTimeout(rain._autoStop);
    rain.remove();
  }
  loadCasePendingDrops();
}
function mimikiRain() {
  // ── Удаляем старый враппер если есть ──
  const old = document.getElementById('mimiki-rain-wrap');
  if (old) old.remove();

  const words  = ['mimiki','мимики','🎭','mimiки','мими','mimik','MIMIKI'];
  const colors = ['#ff64c8','#c864ff','#ff8ae2','#e040fb','#ff4dd8','#fff'];

  // Inject CSS-анимации один раз
  if (!document.getElementById('mimiki-rain-style')) {
    const style = document.createElement('style');
    style.id = 'mimiki-rain-style';
    style.textContent = `
@keyframes mimiki-fall {
  0%   { transform: translateY(-70px) rotate(var(--rot)); opacity: 1; }
  75%  { opacity: 1; }
  100% { transform: translateY(var(--travel)) rotate(var(--rot)); opacity: 0; }
}
.mimiki-word {
  position: fixed;
  top: 0;
  left: var(--x);
  font-family: sans-serif;
  font-size: var(--sz);
  font-weight: 900;
  color: var(--clr);
  text-shadow: 0 0 8px var(--clr);
  white-space: nowrap;
  letter-spacing: 2px;
  pointer-events: none;
  will-change: transform, opacity;
  animation: mimiki-fall var(--dur) linear forwards;
}`;
    document.head.appendChild(style);
  }

  const wrap = document.createElement('div');
  wrap.id = 'mimiki-rain-wrap';
  wrap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:99999;overflow:hidden;';
  document.body.appendChild(wrap);

  const W = window.innerWidth || 390;
  const H = window.innerHeight || 844;

  // Жёсткий лимит — не больше 10 элементов на экране одновременно
  const MAX_ALIVE = 10;
  let alive = 0;
  let stopped = false;

  // Автостоп через 7 секунд (пока кейс открывается)
  const autoStop = setTimeout(() => { stopped = true; }, 7000);
  wrap._autoStop = autoStop;

  function spawnOne() {
    if (stopped || !document.getElementById('mimiki-rain-wrap')) return;
    if (alive >= MAX_ALIVE) {
      // Немного подождать и попробовать снова
      setTimeout(spawnOne, 200);
      return;
    }

    alive++;
    const el = document.createElement('div');
    el.className = 'mimiki-word';

    const word  = words[Math.floor(Math.random() * words.length)];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size  = (13 + Math.random() * 22) + 'px';
    const x     = Math.floor(Math.random() * Math.max(W - 100, 10)) + 'px';
    const rot   = (-20 + Math.random() * 40).toFixed(1) + 'deg';
    const dur   = (1.8 + Math.random() * 1.4).toFixed(2) + 's';
    const travel = (H + 80) + 'px';

    el.style.setProperty('--clr', color);
    el.style.setProperty('--sz', size);
    el.style.setProperty('--x', x);
    el.style.setProperty('--rot', rot);
    el.style.setProperty('--dur', dur);
    el.style.setProperty('--travel', travel);
    el.textContent = word;

    wrap.appendChild(el);

    el.addEventListener('animationend', () => {
      el.remove();
      alive--;
    }, { once: true });

    // Следующий — через паузу, чтобы не всё сразу
    if (!stopped) {
      setTimeout(spawnOne, 300 + Math.random() * 350);
    }
  }

  // Стартуем 3 потока с небольшим сдвигом (вместо 5)
  spawnOne();
  setTimeout(spawnOne, 150);
  setTimeout(spawnOne, 310);
}
// ══════════════════════════════════════════
// КОЛЕСО РУЛЕТКИ — Canvas анимация
// ══════════════════════════════════════════

// Цвета для игроков (по индексу)
const PLAYER_COLORS = ['#ff4328','#70e84e','#f0a33a','#25b9c9','#c75ce7','#ff6d9f','#8fcf42','#c36b32'];
const PLAYER_COLORS_LEGACY = ['#e53935','#1e88e5','#43a047','#fb8c00','#8e24aa','#00acc1','#f4511e','#6d4c41'];
const wheelRenderState = new Map();

function drawWheelLegacy(canvasId, players, highlightIdx = -1, rotation = 0) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = cx - 8;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const total = players.reduce((s, p) => s + p.bet, 0);
  if (total === 0) return;

  let angle = rotation;
  players.forEach((p, i) => {
    const slice = (p.bet / total) * Math.PI * 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = PLAYER_COLORS_LEGACY[i % PLAYER_COLORS_LEGACY.length];
    ctx.fill();
    if (highlightIdx === i) {
      ctx.strokeStyle = '#ffd700';
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    // Лейбл % шанса
    const mid = angle + slice / 2;
    const tx = cx + (r * 0.62) * Math.cos(mid);
    const ty = cy + (r * 0.62) * Math.sin(mid);
    const pct = Math.round(p.bet / total * 100);
    if (slice > 0.25) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.font = 'bold 11px Orbitron, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${pct}%`, tx, ty);
    }

    angle += slice;
  });

  // Центральный круг
  ctx.beginPath();
  ctx.arc(cx, cy, 18, 0, Math.PI * 2);
  ctx.fillStyle = '#0e1319';
  ctx.fill();
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Стрелка сверху (указатель)
  ctx.fillStyle = '#ffd700';
  ctx.beginPath();
  ctx.moveTo(cx - 8, 4);
  ctx.lineTo(cx + 8, 4);
  ctx.lineTo(cx, 22);
  ctx.closePath();
  ctx.fill();
}

function drawWheel(canvasId, players, highlightIdx = -1, rotation = 0) {
  wheelRenderState.set(canvasId, { players, highlightIdx, rotation });
  if (uiThemeChoice === 'ultra' && window.BBUltraVisuals) {
    const total = players.reduce((sum, p) => sum + Number(p.bet || 0), 0);
    const parts = total > 0 ? players.map(p => ({weight: p.bet, label: `${Math.round(p.bet / total * 100)}%`}))
      : Array.from({length: canvasId.includes('ffa') ? 8 : 2}, () => ({weight: 1, label: ''}));
    window.BBUltraVisuals.drawDial(canvasId, parts, rotation, highlightIdx, canvasId.includes('ffa') ? 'JACKPOT' : '1 VS 1');
    return;
  }
  if (uiTheme === 'classic') {
    drawWheelLegacy(canvasId, players, highlightIdx, rotation);
    return;
  }
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const r = Math.min(cx, cy) - 8;
  const isFFA = canvasId.includes('ffa');
  const innerR = r * (isFFA ? 0.38 : 0.34);
  const hasBets = players && players.length && players.some(p => Number(p.bet || 0) > 0);
  const wheelPlayers = hasBets ? players : Array.from({ length: isFFA ? 8 : 2 }, () => ({ bet: 1 }));
  const total = wheelPlayers.reduce((s, p) => s + Number(p.bet || 0), 0);

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const plate = ctx.createRadialGradient(cx, cy, innerR * 0.15, cx, cy, r + 8);
  plate.addColorStop(0, '#171a14');
  plate.addColorStop(0.72, '#080a08');
  plate.addColorStop(1, '#3c1b10');
  ctx.beginPath();
  ctx.arc(cx, cy, r + 7, 0, Math.PI * 2);
  ctx.fillStyle = plate;
  ctx.fill();

  let angle = rotation;
  wheelPlayers.forEach((p, i) => {
    const slice = (Number(p.bet || 0) / total) * Math.PI * 2;
    const a0 = angle + 0.012;
    const a1 = angle + slice - 0.012;
    const mid = angle + slice / 2;
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
    const grad = ctx.createLinearGradient(cx, cy, cx + Math.cos(mid) * r, cy + Math.sin(mid) * r);
    grad.addColorStop(0, '#11120f');
    grad.addColorStop(0.32, color);
    grad.addColorStop(1, '#2a130d');

    ctx.beginPath();
    ctx.arc(cx, cy, r - 3, a0, a1);
    ctx.arc(cx, cy, innerR, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,197,92,.34)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.save();
    ctx.clip();
    ctx.globalAlpha = 0.26;
    ctx.strokeStyle = '#0b0907';
    ctx.lineWidth = 2;
    for (let rr = innerR + 8; rr < r; rr += 12) {
      ctx.beginPath();
      ctx.arc(cx, cy, rr, a0, a1);
      ctx.stroke();
    }
    ctx.restore();

    if (highlightIdx === i) {
      ctx.save();
      ctx.shadowColor = '#fff2a8';
      ctx.shadowBlur = 15;
      ctx.strokeStyle = '#fff0a0';
      ctx.lineWidth = 4.5;
      ctx.stroke();
      ctx.restore();
    }

    if (slice > 0.22) {
      const labelR = (innerR + r) * 0.52;
      ctx.save();
      ctx.shadowColor = '#000';
      ctx.shadowBlur = 4;
      ctx.fillStyle = '#fff3ce';
      ctx.font = `900 ${isFFA ? 10 : 13}px "IBM Plex Mono", monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${Math.round(Number(p.bet || 0) / total * 100)}%`, cx + labelR * Math.cos(mid), cy + labelR * Math.sin(mid));
      ctx.restore();
    }
    angle += slice;
  });

  ctx.strokeStyle = '#8a3c20';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#d5853d';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (r + 1), cy + Math.sin(a) * (r + 1), 2.2, 0, Math.PI * 2);
    ctx.fillStyle = i % 4 === 0 ? '#e6ff76' : '#321a10';
    ctx.fill();
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 8);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const x = Math.cos(a) * (innerR - 5);
    const y = Math.sin(a) * (innerR - 5);
    if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const hub = ctx.createRadialGradient(0, -8, 2, 0, 0, innerR);
  hub.addColorStop(0, '#38432c');
  hub.addColorStop(0.55, '#11150f');
  hub.addColorStop(1, '#4a2112');
  ctx.fillStyle = hub;
  ctx.fill();
  ctx.strokeStyle = '#bf7132';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = '#efff74';
  ctx.font = `900 ${isFFA ? 14 : 17}px "Rubik Mono One", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(isFFA ? 'POOL' : 'VS', cx, cy + 1);

  ctx.save();
  ctx.shadowColor = '#ff4d28';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(cx - 13, 2);
  ctx.lineTo(cx + 13, 2);
  ctx.lineTo(cx + 7, 10);
  ctx.lineTo(cx, 27);
  ctx.lineTo(cx - 7, 10);
  ctx.closePath();
  ctx.fillStyle = '#ff4a26';
  ctx.fill();
  ctx.strokeStyle = '#ffd172';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

async function animateWheel(canvasId, players, winnerIdx) {
  const total = players.reduce((s, p) => s + p.bet, 0);
  // Вычисляем угол победителя (середина его сектора)
  let startAngle = -Math.PI / 2; // указатель сверху = -90°
  let acc = 0;
  for (let i = 0; i < winnerIdx; i++) acc += players[i].bet / total;
  const winStart = acc * Math.PI * 2;
  const winSlice = (players[winnerIdx].bet / total) * Math.PI * 2;
  const winMid = winStart + winSlice / 2;

  // Хотим чтобы середина сектора победителя оказалась под указателем (сверху = -π/2)
  const targetAngle = -Math.PI / 2 - winMid;
  // Добавляем несколько полных оборотов для красоты
  const totalRotation = targetAngle - (Math.PI * 2 * 5); // 5 оборотов

  const duration = 4000;
  const start = performance.now();

  return new Promise(resolve => {
    function frame(now) {
      const elapsed = now - start;
      const t = Math.min(elapsed / duration, 1);
      // Easing: cubic out
      const ease = 1 - Math.pow(1 - t, 3);
      const rot = ease * totalRotation;
      drawWheel(canvasId, players, -1, rot);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        // Финальный кадр с подсветкой победителя
        drawWheel(canvasId, players, winnerIdx, totalRotation);
        resolve();
      }
    }
    requestAnimationFrame(frame);
  });
}

// ══════════════════════════════════════════
// РУЛЕТКА 1v1 (С ПОЛЛИНГОМ И ТАЙМЕРОМ)
// ══════════════════════════════════════════

let r1PollInterval = null;   // интервал поллинга статуса

// ── Остановить поллинг ─────────────────────────────────────────────────────
function stopR1Poll() {
  if (r1PollInterval) { clearInterval(r1PollInterval); r1PollInterval = null; }
}

// ── Запустить поллинг статуса комнаты ─────────────────────────────────────
function startR1Poll(roomId, myBet) {
  stopR1Poll();
  r1PollInterval = setInterval(async () => {
    try {
      const res  = await fetch(`${API}/api/roulette1v1/status?room_id=${roomId}&tg_id=${tg_id}`);
      const data = await res.json();

      if (data.error) { stopR1Poll(); return; }

      if (data.status === 'matched') {
        // Показываем обратный отсчёт
        const sec = Math.ceil(data.seconds_until_spin || 0);
        showR1Countdown(roomId, myBet, sec);
      }

      if (data.status === 'finished') {
        stopR1Poll();
        roomState.r1 = { room_id: null, bet: 0, waiting: false };
        if (data.balance !== undefined) loadInit();
        await handleR1Result(data, myBet);
      }
    } catch (e) { console.error('r1 poll error', e); }
  }, 1000);
}

// ── Обратный отсчёт в UI ──────────────────────────────────────────────────
function showR1Countdown(roomId, bet, sec) {
  const box = document.getElementById('r1-result');
  if (!box) return;
  box.style.display = 'block';
  box.className     = 'result-box';
  box.innerHTML = `
    <div class="result-title" style="color:var(--accent)">⚔️ Соперник найден!</div>
    <div class="result-detail">Комната #${roomId} · Ставка: ${bet} 🧠</div>
    <div style="margin-top:14px;">
      <div style="font-family:'Orbitron',sans-serif;font-size:36px;font-weight:900;
                  color:var(--gold);text-shadow:0 0 20px rgba(255,215,0,.5);">${sec}</div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:4px;letter-spacing:.1em;">СЕКУНД ДО БРОСКА</div>
    </div>
  `;
}

// ── СОЗДАТЬ ДУЭЛЬ ─────────────────────────────────────────────────────────
async function playRoulette1v1() {
  if (isPlaying) return;
  const bet = parseInt(document.getElementById('r1-bet').value);
  if (!bet || bet < 1) { showToast('Введи ставку!'); return; }

  // Уже в комнате? — показываем её и не создаём новую
  if (roomState.r1.waiting && roomState.r1.room_id) {
    showToast('У тебя уже есть активная дуэль!');
    showR1WaitingUI(roomState.r1.room_id, roomState.r1.bet);
    return;
  }

  isPlaying = true;
  document.getElementById('r1-result').style.display = 'none';

  try {
    const res  = await fetch(`${API}/api/roulette1v1/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, bet })
    });
    const data = await res.json();

    if (data.error) {
      if (data.error === 'already_in_room') {
        roomState.r1 = { room_id: data.room_id, bet, waiting: true };
        showR1WaitingUI(data.room_id, bet);
        startR1Poll(data.room_id, bet);
      } else {
        showToast(data.error === 'insufficient_balance' ? 'Недостаточно баланса!' : data.message || data.error, 'lose');
      }
      isPlaying = false;
      return;
    }

    // Комната создана
    roomState.r1 = { room_id: data.room_id, bet, waiting: true };
    showR1WaitingUI(data.room_id, bet);
    loadInit();
    startR1Poll(data.room_id, bet);   // ← начинаем поллинг
  } catch (e) {
    console.error(e);
    showToast('Ошибка сервера', 'lose');
  }
  isPlaying = false;
}

// ── ПРИСОЕДИНИТЬСЯ К ДУЭЛИ ────────────────────────────────────────────────
async function joinRoom1v1(roomId) {
  if (isPlaying) return;

  // Нельзя зайти если у самого активная комната
  if (roomState.r1.waiting && roomState.r1.room_id) {
    showToast('Сначала отмени свою дуэль!', 'lose');
    return;
  }

  const rooms = await (await fetch(`${API}/api/roulette/rooms?type=1v1`)).json();
  const room  = rooms.rooms?.find(r => r.id == roomId);
  if (!room) { showToast('Комната не найдена', 'lose'); return; }

  const userBal = getDisplayedBalance();
  if (userBal < room.bet) { showToast('Недостаточно баланса!', 'lose'); return; }

  isPlaying = true;
  try {
    const res  = await fetch(`${API}/api/roulette1v1/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, room_id: roomId })
    });
    const data = await res.json();

    if (data.error) {
      const msgs = {
        already_in_room:  'Сначала отмени свою дуэль!',
        insufficient_balance: 'Недостаточно баланса!',
        room_not_found:   'Комната не найдена',
        cant_join_own:    'Нельзя играть с собой'
      };
      showToast(msgs[data.error] || data.error, 'lose');
      isPlaying = false;
      return;
    }

    // Матч найден — ждём 5 сек через поллинг
    roomState.r1 = { room_id: roomId, bet: room.bet, waiting: true };
    showR1Countdown(roomId, room.bet, 5);
    loadInit();
    startR1Poll(roomId, room.bet);   // ← поллим и мы
  } catch (e) {
    console.error(e);
    showToast('Ошибка сервера', 'lose');
  }
  isPlaying = false;
}

// ── ФИНАЛ И АНИМАЦИЯ 1v1 ──────────────────────────────────────────────────
async function handleR1Result(data, myBet) {
  const players = data.players || [
    { tg_id: data.creator_tg_id, bet: myBet, label: 'Ты' },
    { tg_id: data.joiner_tg_id,  bet: myBet, label: 'Соперник' }
  ];

  // Гарантируем что canvas существует в DOM перед отрисовкой
  const r1box = document.getElementById('r1-result');
  if (r1box && !document.getElementById('r1-canvas')) {
    r1box.style.display = 'block';
    r1box.className = 'result-box';
    r1box.innerHTML = '<canvas id="r1-canvas" width="260" height="260" style="display:block;margin:0 auto;border-radius:50%"></canvas>';
  }

  // Рисуем начальное колесо
  drawWheel('r1-canvas', players, -1, 0);
  await sleep(300);

  // Крутим
  const winnerIdx = data.winner_idx !== undefined ? data.winner_idx
    : (data.winner_tg_id === tg_id ? 0 : 1);
  await animateWheel('r1-canvas', players, winnerIdx);

  await sleep(400);

  const won = data.winner_tg_id === tg_id;
  const payout = data.payout || Math.floor(myBet * 2 * 0.9);
  const winnerPlayer = players.find(player => Number(player.tg_id) === Number(data.winner_tg_id));
  const winnerName = winnerPlayer?.roblox_username || `Игрок #${data.winner_tg_id}`;

  showResult('r1-result', {
    win: won,
    title: won ? '🎉 ПОБЕДА!' : '💀 ПРОИГРЫШ',
    detailHtml: true,
    detail: won
      ? `${playerProfileLink(data.winner_tg_id, winnerName, true)} выиграл дуэль! Пул: ${myBet * 2} 🧠 · Сгорело 10%`
      : `Победил ${playerProfileLink(data.winner_tg_id, winnerName)}. Ставка потеряна.`,
    amount: won ? payout : -myBet
  });
  showToast(won ? `+${payout} 🧠` : `-${myBet} 🧠`, won ? 'win' : 'lose');
  loadInit();
}

// ── UI "ЖДЁМ СОПЕРНИКА" ───────────────────────────────────────────────────
function showR1WaitingUI(roomId, bet) {
  const box = document.getElementById('r1-result');
  if (!box) return;
  box.style.display = 'block';
  box.className     = 'result-box';
  box.innerHTML = `
    <div class="result-title" style="color:var(--accent)">⏳ Комната #${roomId} создана</div>
    <div class="result-detail">Ставка: ${bet} 🧠 · Ждём соперника...</div>
    <div style="margin-top:10px;font-size:12px;color:var(--text-dim)">
      ID комнаты: <b style="color:var(--gold)">#${roomId}</b>
    </div>
    <div style="margin-top:10px">
      <button onclick="cancelR1Wait(${roomId})"
        style="padding:8px 20px;background:var(--surface2);border:1px solid var(--border);
               border-radius:8px;color:var(--text-dim);font-family:'Rajdhani',sans-serif;
               font-size:12px;cursor:pointer">
        Отмена (ставка вернётся)
      </button>
    </div>
  `;
}

// ── ВОССТАНОВЛЕНИЕ СОСТОЯНИЯ ──────────────────────────────────────────────
function restoreR1State() {
  if (roomState.r1.waiting && roomState.r1.room_id) {
    showR1WaitingUI(roomState.r1.room_id, roomState.r1.bet);
    startR1Poll(roomState.r1.room_id, roomState.r1.bet);   // ← возобновляем поллинг
  }
}

// ── ОТМЕНА ────────────────────────────────────────────────────────────────
async function cancelR1Wait(roomId) {
  stopR1Poll();
  try {
    const res  = await fetch(`${API}/api/roulette1v1/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, room_id: roomId })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Дуэль отменена, ставка возвращена', 'win');
      loadInit();
    } else {
      showToast(data.error || 'Нельзя отменить', 'lose');
    }
  } catch (e) {
    showToast('Ошибка', 'lose');
  }
  roomState.r1 = { room_id: null, bet: 0, waiting: false };
  document.getElementById('r1-result').style.display = 'none';
}

// ── СПИСОК КОМНАТ ─────────────────────────────────────────────────────────
async function loadRooms1v1() {
  try {
    const res  = await fetch(`${API}/api/roulette/rooms?type=1v1`);
    const data = await res.json();
    const list = document.getElementById('r1-rooms');
    if (!data.rooms || data.rooms.length === 0) {
      list.innerHTML = '<div class="rooms-empty">Нет открытых дуэлей</div>';
      return;
    }
    const hasMyActive = roomState.r1.waiting && roomState.r1.room_id;

    list.innerHTML = data.rooms.map(r => {
      const isMine    = r.creator_tg_id === tg_id;
      const isMatched = r.status === 'matched';
      const creator = (r.players || []).find(player => Number(player.tg_id) === Number(r.creator_tg_id));
      const creatorName = creator?.roblox_username || `Игрок #${r.creator_tg_id}`;
      return `
      <div class="room-item">
        <div class="room-info">
          <div class="room-id">
            Дуэль #${r.id}
            ${isMine       ? '<b style="color:var(--accent)">(Твоя)</b>' : ''}
            ${isMatched    ? '<b style="color:var(--gold)">⚔️ В игре</b>' : ''}
          </div>
          <div class="room-owner">${playerProfileLink(r.creator_tg_id, creatorName, isMine)}</div>
          <div class="room-bet" style="display:flex;gap:8px;align-items:center;margin-top:4px;">
            <span style="color:var(--red)">🔴 ${r.bet}</span>
            <span style="color:var(--text-dim);font-size:10px">VS</span>
            <span style="color:var(--accent)">🔵 ${r.bet}</span>
          </div>
        </div>
        ${isMine || isMatched
          ? `<button class="room-join" disabled
               style="background:var(--surface2);color:${isMatched ? 'var(--gold)' : 'var(--red)'};
                      border:1px solid ${isMatched ? 'var(--gold)' : 'var(--red)'};cursor:not-allowed">
               ${isMatched ? '⚔️ ИДЁТ...' : '🔴 ЖДЁМ...'}
             </button>`
          : hasMyActive
            ? `<button class="room-join" disabled
                 style="background:var(--surface2);color:var(--text-dim);cursor:not-allowed"
                 title="Сначала отмени свою дуэль">🚫</button>`
            : `<button class="room-join" style="background:var(--accent);color:#000;"
                 onclick="joinRoom1v1(${r.id})">🔵 ПРИНЯТЬ</button>`
        }
      </div>`;
    }).join('');
  } catch (e) { console.error(e); }
}
// ══════════════════════════════════════════
// FFA — единая глобальная очередь с таймером
// ══════════════════════════════════════════

let ffaTimerInterval = null;   // интервал обратного отсчёта
let ffaPollInterval  = null;   // интервал опроса статуса (для других игроков)
// Переменная для хранения таймера
let autoRefreshTimer = null;

// Функция, которая будет тихо обновлять данные в фоне
async function backgroundUpdate() {
  // ВАЖНО: Если прямо сейчас крутится колесо рулетки, мы НЕ обновляем 
  // списки, чтобы не сбить анимацию и не перерисовать интерфейс в самый ответственный момент
  if (isPlaying || document.hidden) return;
  const active = activeGameName();
  if (active !== 'roulette1v1' && active !== 'rouletteFFA') return;

  try {
    if (active === 'roulette1v1') {
      await loadRooms1v1();
    } else {
      const ffaRes = await fetch(`${API}/api/ffa/status`);
      if (ffaRes.ok) {
        const ffaData = await ffaRes.json();
        renderFFAQueue(ffaData);
      }
      
      // Если сервер сказал, что мы победили/проиграли (раунд завершился, пока мы ждали)
      // Можно раскомментировать вызов функции итогов, если она у тебя так называется:
      // if (ffaData.status === 'finished') handleFFAResult(ffaData);
    }
  } catch (e) {
    // Ошибки в фоне просто игнорим, чтобы не спамить в консоль при плохом интернете
  }
}

// Обновляем только открытую рулетку; на остальных экранах функция сразу выходит.
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(backgroundUpdate, 5000);
}
function ffaStopPolling() {
  if (ffaTimerInterval) { clearInterval(ffaTimerInterval); ffaTimerInterval = null; }
  if (ffaPollInterval)  { clearInterval(ffaPollInterval);  ffaPollInterval  = null; }
}

async function loadFFAStatus() {
  try {
    const res = await fetch(`${API}/api/ffa/status`);
    const data = await res.json();
    renderFFAQueue(data);
  } catch (e) { console.error(e); }
}

function renderFFAQueue(data) {
  const list = document.getElementById('ffa-rooms');
  const count   = data.player_count || 0;
  const pool    = data.total_pool   || 0;
  const players = data.players      || [];
  const timerEnd = data.timer_end   || 0;

  if (count === 0) {
    list.innerHTML = '<div class="rooms-empty">Джекпот пуст — делай ставку первым!</div>';
    drawWheel('ffa-canvas', [], -1, 0);
    return;
  }

  const myInQueue = players.some(p => p.tg_id === tg_id);
  if (myInQueue && data.room_id) {
    roomState.ffa.room_id = data.room_id;
    roomState.ffa.waiting = true;
  }

  const timerActive = timerEnd > 0;
  // Остаток считаем от СЕРВЕРНОГО времени: часы телефона часто спешат/отстают,
  // из-за этого таймер показывал 0 и колесо никогда не запускалось
  const serverNow = data.server_now || (Date.now() / 1000);
  const secLeft = timerActive ? Math.max(0, Math.ceil(timerEnd - serverNow)) : null;

  // Отрисовка каждого игрока и его ставки внутри комнаты
  // Стандартные цвета колеса по порядку захода
  const ffaColors = ['var(--red)', 'var(--accent)', 'var(--green)', 'var(--gold)', 'var(--accent2)', '#b100e8'];

  // Отрисовка каждого игрока с его цветом
  const playersListHTML = players.map((p, index) => {
    const pColor = ffaColors[index % ffaColors.length];
    const isMe = p.tg_id === tg_id;
    return `
    <div style="display:flex;justify-content:space-between;width:100%;font-size:13px;padding:6px 0;border-top:1px dashed var(--border)">
      <span style="color:var(--text-dim); display:flex; align-items:center; gap:8px;">
        <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${pColor};box-shadow:0 0 6px ${pColor};"></span>
        ${playerProfileLink(p.tg_id, p.roblox_username || `Игрок #${p.tg_id}`, isMe)}
      </span>
      <span style="color:var(--gold);font-family:'Orbitron',sans-serif">${p.bet} 🧠</span>
    </div>
  `}).join('');

  list.innerHTML = `
    <div class="room-item" style="flex-direction:column;align-items:flex-start;gap:8px">
      <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
        <div class="room-info">
          <div class="room-id">🌀 Общий Джекпот · <b style="color:var(--text)">${count}</b> игр.</div>
          <div class="room-bet">Пул: ${pool} 🧠</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          ${myInQueue ? `<div style="padding:5px 10px;background:rgba(0,230,118,0.15);border:1px solid var(--green);border-radius:8px;color:var(--green);font-size:11px;font-weight:700">✅ В игре</div>` : ''}
          ${timerActive ? (secLeft > 0 ? `<div id="ffa-countdown" style="font-family:'Orbitron',sans-serif;font-size:18px;font-weight:900;color:var(--accent)">${secLeft}с</div>` : '<div style="font-size:12px;color:var(--accent);font-weight:700">🎲 Розыгрыш...</div>') : '<div style="font-size:11px;color:var(--text-dim)">Ждём ставок...</div>'}
        </div>
      </div>
      ${timerActive ? `
      <div style="width:100%;height:5px;background:var(--surface2);border-radius:3px;overflow:hidden">
        <div id="ffa-timer-bar" style="height:100%;width:${Math.round(secLeft / 15 * 100)}%;background:var(--accent);border-radius:3px;transition:width 1s linear"></div>
      </div>` : ''}
      <div style="width:100%;margin-top:4px">
        ${playersListHTML}
      </div>
    </div>
  `;

  if (players.length > 0) drawWheel('ffa-canvas', players, -1, 0);

  if (timerActive && secLeft > 0) {
    // Переводим дедлайн в часы клиента, чтобы отсчёт шёл ровно secLeft секунд
    const clientDeadline = Date.now() / 1000 + secLeft;
    ffaStartCountdown(clientDeadline, data.room_id);
  } else if (timerActive && secLeft <= 0 && data.room_id) {
    // Таймер уже истёк (мы открыли приложение позже или раунд завис) —
    // раньше здесь ничего не происходило, и колесо не крутилось никогда
    ffaHandleExpired(data.room_id);
  }
}

let ffaResolveInFlight = false;
async function ffaHandleExpired(roomId) {
  if (ffaResolveInFlight || ffaPollInterval) return;
  ffaResolveInFlight = true;
  try {
    const isMyRoom = roomState.ffa.waiting && roomState.ffa.room_id === roomId;
    if (isMyRoom) {
      await ffaDoResolve(roomId);
    } else {
      ffaStartPolling(roomId);
    }
  } finally {
    ffaResolveInFlight = false;
  }
}

function ffaStartCountdown(timerEnd, roomId) {
  // 1. Всегда очищаем предыдущий интервал перед созданием нового
  if (ffaTimerInterval) {
    clearInterval(ffaTimerInterval);
    ffaTimerInterval = null;
  }

  // 2. Создаем новый таймер
  ffaTimerInterval = setInterval(async () => {
    const now = Date.now() / 1000;
    const secLeft = Math.ceil(timerEnd - now);
    
    const el = document.getElementById('ffa-countdown');
    const bar = document.getElementById('ffa-timer-bar');
    
    if (el) el.textContent = `${Math.max(0, secLeft)}с`;
    if (bar) bar.style.width = `${Math.max(0, (secLeft / 15) * 100)}%`;

    if (secLeft <= 0) {
      // 3. Останавливаем таймер сразу при достижении нуля
      clearInterval(ffaTimerInterval);
      ffaTimerInterval = null;

      // 4. Логика инициации розыгрыша
      const isMyRoom = roomState.ffa.waiting && roomState.ffa.room_id === roomId;
      if (isMyRoom) {
        await ffaDoResolve(roomId);
      } else {
        ffaStartPolling(roomId);
      }
    }
  }, 1000);
}
async function ffaDoResolve(roomId) {
  try {
    const res = await fetch(`${API}/api/ffa/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId })
    });
    const data = await res.json();

    if (data.error) {
      // Уже разыграно другим — опрашиваем
      ffaStartPolling(roomId);
      return;
    }

    roomState.ffa.waiting = false;
    await handleFFAResult(data);
  } catch (e) {
    console.error(e);
    showToast('Ошибка розыгрыша', 'lose');
  }
}

function ffaStartPolling(roomId) {
  if (ffaPollInterval) return;
  ffaPollInterval = setInterval(async () => {
    try {
      // Смотрим историю — ищем последний finished раунд
      const res = await fetch(`${API}/api/ffa/result?room_id=${roomId}`);
      const data = await res.json();
      if (data.status === 'finished') {
        clearInterval(ffaPollInterval);
        ffaPollInterval = null;
        roomState.ffa.waiting = false;
        await handleFFAResult(data);
      }
    } catch (e) { /* ждём */ }
  }, 2000);
}

async function playRouletteFFA() {
  if (isPlaying) return;

  const betInput = document.getElementById('ffa-bet');
  const bet = parseInt(betInput.value);
  
  if (!bet || bet < 1) { 
    showToast('Введи ставку!'); 
    return; 
  }

  isPlaying = true;
  document.getElementById('ffa-result').style.display = 'none';

  try {
    const res = await fetch(`${API}/api/ffa/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, bet })
    });
    const data = await res.json();

    if (data.error) {
      showToast(data.error === 'insufficient_balance' ? 'Недостаточно баланса!' : data.error, 'lose');
      isPlaying = false;
      return;
    }

    // Успешно вошли в очередь
    roomState.ffa.waiting = true;
    roomState.ffa.room_id = data.room_id;
    
    showToast('Ставка принята!', 'win');
    loadInit();
    loadFFAStatus(); // Обновляем список, чтобы увидеть себя в очереди
  } catch (e) {
    console.error(e);
    showToast('Ошибка сервера', 'lose');
  }

  isPlaying = false;
}

// ══════════════════════════════════════════
// ФИНАЛ FFA
// ══════════════════════════════════════════

async function handleFFAResult(data) {
  ffaStopPolling();
  roomState.ffa.waiting = false;
  roomState.ffa.room_id = null;

  const players = data.players || [];

  // Гарантируем что canvas существует в DOM перед отрисовкой
  const ffabox = document.getElementById('ffa-result');
  if (ffabox && !document.getElementById('ffa-canvas')) {
    ffabox.style.display = 'block';
    ffabox.className = 'result-box';
    ffabox.innerHTML = '<canvas id="ffa-canvas" width="260" height="260" style="display:block;margin:0 auto;border-radius:50%"></canvas>';
  }

  // Рисуем начальное состояние
  drawWheel('ffa-canvas', players, -1, 0);
  await sleep(300);

  // Определяем индекс победителя
  const winnerIdx = data.winner_idx !== undefined ? data.winner_idx
    : players.findIndex(p => p.tg_id === data.winner_tg_id);
  
  // Анимация вращения
  await animateWheel('ffa-canvas', players, Math.max(0, winnerIdx));
  await sleep(400);

  const won = data.winner_tg_id === tg_id;
  const myPlayer = players.find(p => p.tg_id === tg_id);
  const winnerPlayer = players.find(p => p.tg_id === data.winner_tg_id);
  const winnerName = winnerPlayer?.roblox_username || `Игрок #${data.winner_tg_id}`;
  const myBet  = myPlayer?.bet || 0;
  const payout = data.payout   || 0;
  const burned = data.burned   || 0;

  showResult('ffa-result', {
    win: won,
    title: won ? '🏆 ПОБЕДА!' : '💀 ПРОИГРЫШ',
    detailHtml: true,
    detail: won
      ? `Пул: ${data.total_pool} 🧠 · Твой выигрыш: ${payout} 🧠`
      : `Победил ${playerProfileLink(data.winner_tg_id, winnerName)}. Твоя ставка: ${myBet} 🧠 ушла в пул.`
  });

  if (won) {
    showToast(`+${payout} 🧠`, 'win');
  } else {
    showToast(`-${myBet} 🧠`, 'lose');
  }

  loadInit();
}

// Вспомогательная функция задержки
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Онлайн (heartbeat для счётчика в админке) ──────────────
const adminAbuseSeenDrops = new Set();
const adminAbuseClaimingOffers = new Set();
let adminAbuseFreeOffers = [];
let adminAbusePollTimer = null;
let adminAbusePolling = false;
let adminAbuseWatcherStarted = false;
let adminAbusePollingEnabled = false;
const adminAbuseRewardQueue = [];
let adminAbuseRewardShowing = false;
let adminAbuseAnnouncementId = '';
let adminAbuseAnnouncementTimer = null;
const adminAbuseDismissedAnnouncements = new Set();
let adminAbuseLaunchTimer = null;

function ensureAdminAbuseUi() {
  let rain = document.getElementById('admin-abuse-rain');
  if (!rain) {
    rain = document.createElement('div');
    rain.id = 'admin-abuse-rain';
    rain.className = 'abuse-rain-layer';
    rain.setAttribute('aria-live', 'polite');
    document.body.appendChild(rain);
  }
  document.getElementById('admin-abuse-free-shelf')?.remove();
  return { rain };
}

function renderAdminAbuseDepositBonus(bonus, serverTime) {
  let badge = document.getElementById('admin-abuse-deposit-bonus');
  if (!bonus?.percent || Number(bonus.expires_at || 0) <= Number(serverTime || 0)) {
    badge?.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement('aside');
    badge.id = 'admin-abuse-deposit-bonus';
    badge.className = 'abuse-deposit-bonus';
    document.body.appendChild(badge);
  }
  const seconds = Math.max(0, Math.ceil(Number(bonus.expires_at) - Number(serverTime || Date.now() / 1000)));
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  badge.innerHTML = `<b>+${Number(bonus.percent)}%</b><span>к пополнению</span><small>${minutes} мин.</small>`;
}

function formatAdminAbuseCountdown(totalSeconds) {
  const seconds = Math.max(0, Math.ceil(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function renderAdminAbuseLaunch(launch, serverTime) {
  const current = document.getElementById('admin-abuse-launch');
  clearInterval(adminAbuseLaunchTimer);
  adminAbuseLaunchTimer = null;

  if (!launch?.id) {
    current?.remove();
    return;
  }

  const startsAtMs = Number(launch.starts_at || 0) * 1000;
  if (!startsAtMs) {
    current?.remove();
    return;
  }

  if (launch.status !== 'scheduled') {
    current?.remove();
    return;
  }

  const panel = current || document.createElement('aside');
  panel.id = 'admin-abuse-launch';
  panel.className = 'abuse-launch-countdown';
  panel.setAttribute('aria-live', 'off');
  if (!panel.isConnected) document.body.appendChild(panel);

  const serverOffsetMs = Number(serverTime || Date.now() / 1000) * 1000 - Date.now();
  const render = () => {
    const remainingMs = startsAtMs - (Date.now() + serverOffsetMs);
    if (remainingMs <= 0) {
      panel.remove();
      clearInterval(adminAbuseLaunchTimer);
      adminAbuseLaunchTimer = null;
      return;
    }
    panel.textContent = `ADMIN ABUSE · ${formatAdminAbuseCountdown(remainingMs / 1000)}`;
  };

  render();
  adminAbuseLaunchTimer = setInterval(render, 1000);
}

function adminAbuseToast(text) {
  document.querySelector('.abuse-event-toast')?.remove();
  const toast = document.createElement('div');
  toast.className = 'abuse-event-toast';
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 2800);
}

function renderAdminAbuseAnnouncement(announcement, serverTime) {
  const current = document.getElementById('admin-abuse-announcement');
  if (!announcement?.id || !announcement?.text) {
    current?.remove();
    adminAbuseAnnouncementId = '';
    clearTimeout(adminAbuseAnnouncementTimer);
    return;
  }
  if (adminAbuseDismissedAnnouncements.has(String(announcement.id))) {
    current?.remove();
    return;
  }
  if (String(announcement.id) === adminAbuseAnnouncementId && current) return;
  current?.remove();
  clearTimeout(adminAbuseAnnouncementTimer);
  adminAbuseAnnouncementId = String(announcement.id);
  const banner = document.createElement('aside');
  banner.id = 'admin-abuse-announcement';
  banner.className = 'abuse-announcement';
  banner.setAttribute('role', 'status');
  banner.innerHTML = `
    <strong class="abuse-announcement-text">${escHtml(announcement.text)}</strong>
    <button type="button" class="abuse-announcement-close" aria-label="Закрыть">×</button>`;
  banner.querySelector('.abuse-announcement-close')?.addEventListener('click', () => {
    adminAbuseDismissedAnnouncements.add(String(announcement.id));
    banner.remove();
  });
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner.classList.add('visible'));
  const remaining = Math.max(0, (Number(announcement.expires_at || 0) - Number(serverTime || Date.now() / 1000)) * 1000);
  adminAbuseAnnouncementTimer = setTimeout(() => {
    banner.remove();
    adminAbuseAnnouncementId = '';
  }, remaining + 100);
}

function adminAbuseRewardPool(winnerName, winnerValue) {
  const pool = CASES_CLIENT.level_daily.items.map(item => ({
    name: String(item?.name || winnerName),
    value: Math.max(0, Math.floor(Number(item?.value || 0))),
    chance: Math.max(0, Number(item?.chance || 0))
  }));
  if (!pool.some(item => item.name === winnerName)) {
    pool.push({ name: winnerName, value: winnerValue, chance: 0 });
  }
  return pool;
}

function adminAbuseRewardReel(data, winnerName, winnerValue) {
  const pool = adminAbuseRewardPool(winnerName, winnerValue);
  const winnerIndex = 24;
  const slots = Array.from({ length: winnerIndex + 2 }, (_, index) => {
    const item = index === winnerIndex
      ? { name: winnerName, value: winnerValue }
      : weightedRandom(pool);
    return `<div class="abuse-reward-slot${index === winnerIndex ? ' is-winner' : ''}">
      <div class="abuse-reward-slot-image">${caseImgHtml(item.name, 72)}</div>
      <strong>${escHtml(item.name)}</strong>
      <small>${Math.floor(Number(item.value || 0))} \ud83e\udde0</small>
    </div>`;
  }).join('');
  return `<div class="abuse-reward-reel" aria-label="\u041e\u0442\u043a\u0440\u044b\u0442\u0438\u0435 \u0438\u0432\u0435\u043d\u0442\u043e\u0432\u043e\u0433\u043e \u043a\u0435\u0439\u0441\u0430">
    <div class="abuse-reward-pointer" aria-hidden="true"></div>
    <div class="abuse-reward-track">${slots}</div>
  </div>`;
}

function showNextAdminAbuseReward() {
  if (adminAbuseRewardShowing || !adminAbuseRewardQueue.length) return;
  adminAbuseRewardShowing = true;
  const data = adminAbuseRewardQueue.shift();
  const itemName = String(data?.item?.name || 'Награда');
  const itemValue = Math.max(0, Math.floor(Number(data?.payout || data?.item?.value || 0)));

  document.getElementById('admin-abuse-reward')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'admin-abuse-reward';
  overlay.className = 'abuse-reward-overlay';
  overlay.innerHTML = `
    <div class="abuse-reward-dialog" role="dialog" aria-modal="true" aria-label="Награда Admin Abuse">
      <button type="button" class="abuse-reward-close" aria-label="Закрыть">×</button>
      <div class="abuse-reward-kicker">ADMIN ABUSE / ПОЙМАНО</div>
      <div class="abuse-reward-stage">
        <div class="abuse-reward-crate"><i></i><b>BB</b><span>OPEN</span></div>
        ${adminAbuseRewardReel(data, itemName, itemValue)}
        <div class="abuse-reward-burst" aria-hidden="true"></div>
      </div>
      <div class="abuse-reward-copy">
        <small>ТЕБЕ ВЫПАЛО</small>
        <strong>${escHtml(itemName)}</strong>
        <b>${itemValue} 🧠</b>
        <span>Предмет уже в игровом инвентаре</span>
      </div>
      <button type="button" class="abuse-reward-done" disabled>ОТЛИЧНО</button>
    </div>`;

  const close = () => {
    if (!overlay.isConnected) return;
    overlay.classList.add('closing');
    setTimeout(() => {
      overlay.remove();
      adminAbuseRewardShowing = false;
      showNextAdminAbuseReward();
    }, 180);
  };
  overlay.querySelector('.abuse-reward-close')?.addEventListener('click', close);
  overlay.querySelector('.abuse-reward-done')?.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.body.appendChild(overlay);

  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  const unlockDelay = reducedMotion ? 40 : 320;
  const spinDelay = reducedMotion ? 90 : 820;
  let revealed = false;
  const reveal = () => {
    if (revealed || !overlay.isConnected) return;
    revealed = true;
    overlay.classList.add('revealed');
    const done = overlay.querySelector('.abuse-reward-done');
    if (done) done.disabled = false;
    try { SND.play('reveal'); } catch (_) {}
  };
  requestAnimationFrame(() => overlay.classList.add('opening'));
  setTimeout(() => {
    if (!overlay.isConnected) return;
    overlay.classList.add('unlocking');
    try { SND.play('case'); } catch (_) {}
  }, unlockDelay);
  setTimeout(() => {
    if (!overlay.isConnected) return;
    overlay.classList.add('spinning');
    const viewport = overlay.querySelector('.abuse-reward-reel');
    const track = overlay.querySelector('.abuse-reward-track');
    const winner = overlay.querySelector('.abuse-reward-slot.is-winner');
    requestAnimationFrame(() => {
      if (!viewport || !track || !winner) return;
      const offset = viewport.clientWidth / 2 - winner.offsetLeft - winner.offsetWidth / 2;
      track.style.setProperty('--abuse-reel-stop', `${offset}px`);
      track.addEventListener('transitionend', event => {
        if (event.propertyName === 'transform') reveal();
      }, { once: true });
      track.classList.add('rolling');
    });
  }, spinDelay);
  // Fallback for WebViews that fail to dispatch transitionend.
  setTimeout(reveal, reducedMotion ? 220 : spinDelay + 3800);
}

function queueAdminAbuseReward(data) {
  adminAbuseRewardQueue.push(data);
  showNextAdminAbuseReward();
}

function renderAdminAbuseDrop(drop) {
  const id = Number(drop?.id || 0);
  const claimToken = String(drop?.claim_token || '');
  // Do not remember or render a drop until the API signs it for this user.
  if (!id || !claimToken || adminAbuseSeenDrops.has(id)) return;
  adminAbuseSeenDrops.add(id);
  const { rain } = ensureAdminAbuseUi();
  const button = document.createElement('button');
  const seed = (id * 47) % 73;
  button.type = 'button';
  button.className = 'abuse-falling-case';
  button.dataset.dropId = String(id);
  button.dataset.waveId = String(drop.wave_id || '');
  button.dataset.claimToken = claimToken;
  button.style.setProperty('--abuse-x', `${12 + seed}%`);
  button.style.setProperty('--abuse-drift', `${((id * 13) % 35) - 17}px`);
  button.setAttribute('aria-label', 'Поймать кейс Admin Abuse');
  button.innerHTML = '<i class="abuse-case-handle"></i><i class="abuse-case-flare"></i>';
  button.addEventListener('click', () => claimAdminAbuseDrop(button, id));
  button.addEventListener('animationend', () => button.remove(), { once: true });
  rain.appendChild(button);
}

async function claimAdminAbuseDrop(button, dropId) {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add('claiming');
  try {
    const response = await fetch(`${API}/api/admin-abuse/drop/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tg_id, init_data: TG_INIT_DATA || '', drop_id: dropId,
        claim_token: button.dataset.claimToken || ''
      })
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      button.classList.remove('claiming');
      button.classList.add('lost');
      const messages = {
        not_recipient: 'Этот кейс предназначен другому игроку',
        already_claimed: 'Этот кейс уже поймал другой игрок',
        wave_limit: 'Ты уже поймал кейс из этой волны',
        drop_expired: 'Кейс улетел',
        not_active: 'Вернись в приложение и попробуй снова',
        invalid_claim_token: 'Кейс обновился - нажми на следующий'
      };
      adminAbuseToast(messages[data.error] || 'Не удалось поймать кейс');
      return;
    }
    const waveId = button.dataset.waveId;
    document.querySelectorAll('.abuse-falling-case').forEach(node => {
      if (node.dataset.waveId === waveId) node.remove();
    });
    queueAdminAbuseReward(data);
    loadInit();
  } catch (_) {
    button.disabled = false;
    button.classList.remove('claiming');
    adminAbuseToast('Связь оборвалась, попробуй нажать ещё раз');
  }
}

function renderAdminAbuseOffers(offers) {
  adminAbuseFreeOffers = Array.isArray(offers)
    ? offers.filter(offer => Number(offer?.id) > 0 && Number(offer?.remaining_stock) > 0)
    : [];
  if (upgData) upgRenderShop();
}

async function claimAdminAbuseFreeOffer(button, offerId) {
  if (!offerId || button.disabled || adminAbuseClaimingOffers.has(offerId)) return;
  const offer = adminAbuseFreeOffers.find(row => Number(row?.id) === Number(offerId));
  const claimToken = String(offer?.claim_token || '');
  adminAbuseClaimingOffers.add(offerId);
  button.disabled = true;
  button.textContent = '...';
  try {
    const response = await fetch(`${API}/api/admin-abuse/free/claim`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tg_id, init_data: TG_INIT_DATA || '', offer_id: offerId,
        claim_token: claimToken
      })
    });
    const data = await response.json();
    if (!response.ok || data.error) {
      adminAbuseToast(data.error === 'offer_unavailable' ? 'Товар уже закончился' : 'Ты уже забрал эту награду');
    } else {
      adminAbuseToast(`${data.item_name} добавлен в игровой инвентарь`);
      adminAbuseFreeOffers = adminAbuseFreeOffers.filter(offer => Number(offer.id) !== offerId);
      if (upgData) upgRenderShop();
      upgLoad();
      loadInit();
    }
    pollAdminAbuseState();
  } catch (_) {
    button.disabled = false;
    button.textContent = 'ЗАБРАТЬ';
    adminAbuseToast('Нет связи с сервером');
  } finally {
    adminAbuseClaimingOffers.delete(offerId);
  }
}

function isAdminAbuseRunning(state) {
  if (!state) return false;
  const serverTime = Number(state.server_time || Date.now() / 1000);
  if (state.launch?.id) return true;
  if (Array.isArray(state.drops) && state.drops.length) return true;
  if (Array.isArray(state.offers) && state.offers.length) return true;
  if (state.announcement?.id && Number(state.announcement.expires_at || 0) > serverTime) return true;
  return Boolean(state.deposit_bonus?.percent && Number(state.deposit_bonus.expires_at || 0) > serverTime);
}

function adminAbusePollDelay(state) {
  if (Array.isArray(state?.drops) && state.drops.length) return 1000;
  if (state?.launch?.status === 'scheduled') return 10_000;
  return 2000;
}

function syncAdminAbuseState(state, fromPoll = false) {
  if (!state || document.hidden) return;
  (state.drops || []).forEach(renderAdminAbuseDrop);
  renderAdminAbuseOffers(state.offers || []);
  renderAdminAbuseLaunch(state.launch, state.server_time);
  renderAdminAbuseAnnouncement(state.announcement, state.server_time);
  renderAdminAbuseDepositBonus(state.deposit_bonus, state.server_time);

  adminAbusePollingEnabled = isAdminAbuseRunning(state);
  if (!adminAbusePollingEnabled) {
    clearTimeout(adminAbusePollTimer);
    adminAbusePollTimer = null;
    return;
  }
  if (!fromPoll && adminAbuseWatcherStarted && !adminAbusePolling) {
    scheduleAdminAbusePoll(adminAbusePollDelay(state));
  }
}

async function pollAdminAbuseState() {
  if (!tg_id || document.hidden || adminAbusePolling || !adminAbusePollingEnabled) return;
  adminAbusePolling = true;
  let nextDelay = 2000;
  try {
    const query = new URLSearchParams({ tg_id: String(tg_id), init_data: TG_INIT_DATA || '' });
    const response = await fetch(`${API}/api/admin-abuse/state?${query}`, { cache: 'no-store' });
    if (response.ok) {
      const state = await response.json();
      syncAdminAbuseState(state, true);
      nextDelay = adminAbusePollDelay(state);
    }
  } catch (_) {
    nextDelay = 5000;
  } finally {
    adminAbusePolling = false;
    if (adminAbusePollingEnabled) scheduleAdminAbusePoll(nextDelay);
  }
}

function scheduleAdminAbusePoll(delay) {
  clearTimeout(adminAbusePollTimer);
  adminAbusePollTimer = null;
  if (!adminAbuseWatcherStarted || document.hidden || !adminAbusePollingEnabled) return;
  adminAbusePollTimer = setTimeout(() => {
    adminAbusePollTimer = null;
    pollAdminAbuseState();
  }, delay);
}

function startAdminAbuseWatcher() {
  ensureAdminAbuseUi();
  if (adminAbuseWatcherStarted) return;
  adminAbuseWatcherStarted = true;
  if (adminAbusePollingEnabled) scheduleAdminAbusePoll(0);
}

document.addEventListener('visibilitychange', () => {
  if (!adminAbuseWatcherStarted || document.hidden || !adminAbusePollingEnabled) return;
  scheduleAdminAbusePoll(0);
});

async function sendHeartbeat() {
  if (!tg_id || !termsAccepted || document.hidden) return;
  try {
    const response = await fetch(`${API}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, init_data: TG_INIT_DATA || '' })
    });
    if (response.ok) syncAdminAbuseState((await response.json()).admin_abuse);
  } catch (e) { /* тихо игнорируем — не критично */ }
}

let achievementWatcherTimer = null;
let achievementCelebrationQueue = [];
let achievementCelebrationOpen = false;

function achievementSeenKey() {
  return `brainbet_seen_achievements_${Number(tg_id || 0)}`;
}

function syncAchievementCelebrations(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const completed = items.filter(item => item.completed);
  if (!completed.length) return;
  const key = achievementSeenKey();
  let stored = null;
  try { stored = localStorage.getItem(key); } catch (_) {}
  if (stored === null) {
    try { localStorage.setItem(key, JSON.stringify(completed.map(item => item.id))); } catch (_) {}
    return;
  }
  let seen = [];
  try { seen = JSON.parse(stored) || []; } catch (_) {}
  const seenSet = new Set(Array.isArray(seen) ? seen : []);
  const fresh = completed.filter(item => !seenSet.has(item.id));
  if (!fresh.length) return;
  fresh.forEach(item => seenSet.add(item.id));
  try { localStorage.setItem(key, JSON.stringify([...seenSet])); } catch (_) {}
  achievementCelebrationQueue.push(...fresh);
  showNextAchievementCelebration();
}

function showNextAchievementCelebration() {
  if (achievementCelebrationOpen || !achievementCelebrationQueue.length) return;
  achievementCelebrationOpen = true;
  const item = achievementCelebrationQueue.shift();
  const confetti = Array.from({length: 28}, (_, index) => `<i style="--i:${index};--x:${((index * 37) % 100)}%;--d:${(index % 7) * .08}s"></i>`).join('');
  const overlay = document.createElement('div');
  overlay.className = 'achievement-celebration';
  overlay.innerHTML = `<div class="achievement-confetti" aria-hidden="true">${confetti}</div><article role="dialog" aria-modal="true" aria-labelledby="achievement-celebration-title"><small>ДОСТИЖЕНИЕ ВЫПОЛНЕНО</small><div class="achievement-celebration-icon">${escHtml(item.icon || 'AP')}</div><h2 id="achievement-celebration-title">${escHtml(item.title || 'Новое достижение')}</h2><p>${escHtml(item.description || '')}</p><strong>+${Number(item.points || 0)} AP</strong><button type="button">ПРОДОЛЖИТЬ</button></article>`;
  const close = () => {
    overlay.classList.add('is-closing');
    setTimeout(() => {
      overlay.remove();
      achievementCelebrationOpen = false;
      showNextAchievementCelebration();
    }, 220);
  };
  overlay.querySelector('button')?.addEventListener('click', close);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('is-visible'));
  try { SND.play('craftResult'); } catch (_) {}
}

async function pollAchievementCompletions() {
  if (!tg_id || !termsAccepted || document.hidden) return;
  try {
    const response = await fetch(`${API}/api/profile/achievements`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || ''})
    });
    if (!response.ok) return;
    syncAchievementCelebrations(await response.json());
  } catch (_) {}
}

function startAchievementWatcher() {
  if (achievementWatcherTimer) return;
  setTimeout(pollAchievementCompletions, 1800);
  achievementWatcherTimer = setInterval(pollAchievementCompletions, 30000);
}

sendHeartbeat();
setInterval(sendHeartbeat, 20000); // раз в 20 секунд, пока мини-апп открыт

// Запуск фонового обновления при старте
startAdminAbuseWatcher();
startAutoRefresh();
startBrainBetAfterConsent().then(initialized => {
  if (!initialized && document.documentElement.classList.contains('bb-booting')) {
    failBrainBetBoot('Не удалось подтвердить запуск. Обнови страницу и попробуй ещё раз.');
  }
});
startAchievementWatcher();
// Лента живых выигрышей
setTimeout(lwInit, 0);

function syncAppVisibility() {
  document.documentElement.classList.toggle('bb-app-hidden', document.hidden);
  if (document.hidden) {
    if (typeof mrPause === 'function') mrPause();
    return;
  }

  sendHeartbeat();
  lwPoll();
  const active = activeGameName();
  if (active === 'coin') coinLoad();
  if (active === 'mr' && !mrSpinning) mrInit();
  if (active === 'roulette1v1' || active === 'rouletteFFA') backgroundUpdate();
}

document.addEventListener('visibilitychange', syncAppVisibility);
setTimeout(syncAppVisibility, 0);

// ══════════════════════════════════════════
// ВНУТРЕННИЙ ДОЖДЬ МИМИК В КАРТОЧКЕ
// ══════════════════════════════════════════
function mimikiCardRainInit() {
  const container = document.getElementById('mimiki-card-rain');
  if (!container || container.childElementCount) return;

  const words  = ['mimiki','🎭','мими','mimik','✦','🌸','MIMI'];
  const colors = ['#ff64c8','#c864ff','#ff8ae2','#e040fb','#ff4dd8','#ffaaee'];

  // Получаем размеры карточки
  const card = container.parentElement;
  const cardW = card ? card.offsetWidth  || 120 : 120;
  const cardH = card ? card.offsetHeight || 140 : 140;
  const travel = (cardH + 30) + 'px';

  // Количество постоянных частиц — немного, чтоб не перегружать
  const COUNT = 7;

  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('span');
    el.className = 'mc-particle';

    const word  = words[Math.floor(Math.random() * words.length)];
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size  = (7 + Math.random() * 8).toFixed(1) + 'px';
    const x     = (Math.random() * 85).toFixed(1) + '%';
    const rot   = (-25 + Math.random() * 50).toFixed(1) + 'deg';
    const dur   = (2.2 + Math.random() * 2.0).toFixed(2) + 's';
    const delay = (Math.random() * 3.5).toFixed(2) + 's';
    const opacity = (0.35 + Math.random() * 0.45).toFixed(2);

    el.style.setProperty('--cx',      x);
    el.style.setProperty('--cclr',    color);
    el.style.setProperty('--csz',     size);
    el.style.setProperty('--crot',    rot);
    el.style.setProperty('--cdur',    dur);
    el.style.setProperty('--cdelay',  delay);
    el.style.setProperty('--ctravel', travel);
    el.style.setProperty('--cop',     opacity);
    el.textContent = word;

    container.appendChild(el);
  }
}

// ══════════════════════════════════════════
// МАГАЗИН
// ══════════════════════════════════════════

async function loadShop() {
  const grid = document.getElementById('shop-grid');
  grid.innerHTML = '<div class="shop-loading">Загрузка...</div>';
  try {
    const res = await fetch(`${API}/api/shop/items`);
    const data = await res.json();
    if (!data.items || data.items.length === 0) {
      grid.innerHTML = '<div class="shop-loading">Магазин пуст</div>';
      return;
    }
    grid.innerHTML = data.items.map(item => `
      <div class="shop-card ${item.rarity}" onclick="buyItem('${item.item_name.replace(/'/g,"\\'")}', ${item.price_brains})">
        <div class="shop-emoji">${caseImgHtml(item.item_name, 72)}</div>
        <div class="shop-name">${item.item_name}</div>
        <div class="shop-price">${item.price_brains} 🧠</div>
        <div class="shop-rarity ${item.rarity}">${item.rarity.toUpperCase()}</div>
      </div>
    `).join('');
  } catch (e) {
    grid.innerHTML = '<div class="shop-loading">Ошибка загрузки</div>';
  }
}

async function buyItem(itemName, price) {
  // Вызываем наше красивое окно вместо браузерного
  const confirmed = await showConfirm('🛒 Покупка', `Купить «${itemName}» за ${price} 🧠?`);
  if (!confirmed) return;

  try {
    const res = await fetch(`${API}/api/shop/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, item_name: itemName })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error === 'insufficient_balance' ? 'Недостаточно 🧠!' : data.error, 'lose');
      return;
    }
    showToast(`✅ Куплено: ${itemName}`, 'win');
    loadInit();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}

// ══════════════════════════════════════════
// ИНВЕНТАРЬ
// ══════════════════════════════════════════

let withdrawSelectedIds = new Set();
const WITHDRAW_MAX_ITEMS = 10; // лимит предметов в одном выводе
let extraWithdrawInfo = null;  // {enabled, cost, min_sum} — с сервера

async function loadInventory() {
  withdrawSelectedIds.clear();
  document.getElementById('inv-withdraw-panel').style.display = 'none';
  document.getElementById('inv-normal-mode').style.display = 'block';

  // Показываем / скрываем wager-бар
  updateWagerUI();

  // Блокируем кнопку "Вывести" если не отыгран
  const withdrawBtn = document.getElementById('inv-withdraw-btn');
  if (withdrawBtn) {
    if (wagerState.required && !wagerState.unlocked) {
      withdrawBtn.disabled = true;
      withdrawBtn.title = `Сначала отыграй депозит`;
      withdrawBtn.style.opacity = '0.4';
    } else {
      withdrawBtn.disabled = false;
      withdrawBtn.style.opacity = '';
    }
  }

  const grid = document.getElementById('inv-grid');
  const actions = document.getElementById('inv-actions');
  grid.innerHTML = '';

  try {
    const res = await fetch(`${API}/api/inventory?tg_id=${tg_id}`);
    const data = await res.json();
    const items = data.items || [];

    if (items.length === 0) {
      grid.innerHTML = '<div class="inv-empty">Инвентарь пуст — купи что-нибудь в магазине!</div>';
      actions.style.display = 'none';
      return;
    }

    actions.style.display = 'block';
    grid.innerHTML = items.map(item => `
      <div class="inv-item ${item.frozen ? 'frozen' : ''}" id="invitem-${item.id}">
        <div class="inv-emoji">${item.emoji || '🧠'}</div>
        <div class="inv-name">${item.item_name}</div>
        <div class="inv-source">${srcLabel(item.source)}</div>
        ${item.frozen
          ? `<div class="frozen-badge">⏳ На выводе</div>${item.slot_date ? `<div style="font-size:9px;color:var(--gold);margin-top:2px;text-align:center">${item.slot_start === '--:--' ? '🔥 ЭКСТРА ВЫВОД' : `📅 ${item.slot_date} ${item.slot_start ? item.slot_start + ' МСК' : ''}`}</div>` : ''}`
          : `<div class="inv-item-btns">
               <button class="inv-btn sell" onclick="sellInvItem(${item.id}, '${item.item_name.replace(/'/g,"\\'")}')">💰 Продать</button>
             </div>`
        }
      </div>
    `).join('');

    document.getElementById('inv-result').style.display = 'none';
  } catch (e) {
    grid.innerHTML = '<div class="inv-empty">Ошибка загрузки</div>';
  }
}

function srcLabel(src) {
  return { shop: '🛒 Куплено', case: '📦 Из кейса', trade: '🔄 Трейд' }[src] || src;
}

async function sellInvItem(itemId, itemName) {
  // Меняем текст на 100% и используем красивое окно
  const confirmed = await showConfirm('💰 Продажа', `Продать «${itemName}»?\nВернём 100% стоимости.`);
  if (!confirmed) return;

  try {
    const res = await fetch(`${API}/api/inventory/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, item_id: itemId })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'lose'); return; }
    showToast(`+${data.sell_price} 🧠 за ${data.item_name}`, 'win');
    loadInit();
    loadInventory();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}
// ── Режим выбора предметов для вывода ──────

async function startWithdrawMode() {
  withdrawSelectedIds.clear();
  document.getElementById('inv-normal-mode').style.display = 'none';
  document.getElementById('inv-withdraw-panel').style.display = 'block';
  document.getElementById('inv-actions').style.display = 'none';   // ← добавить
  document.getElementById('inv-result').style.display = 'none';

  const grid = document.getElementById('inv-select-grid');
  try {
    const res = await fetch(`${API}/api/inventory?tg_id=${tg_id}`);
    const data = await res.json();
    const items = (data.items || []).filter(i => !i.frozen);

    // 🔥 Экстра вывод: показываем кнопку и подсказку если включён
    extraWithdrawInfo = data.extra_withdraw || null;
    const extraBtn  = document.getElementById('extra-withdraw-btn');
    const extraHint = document.getElementById('extra-withdraw-hint');
    const extraOn = !!(extraWithdrawInfo && extraWithdrawInfo.enabled);
    const extraFeePercent = Number(extraWithdrawInfo?.fee_percent);
    const percentFeeEnabled = Number.isFinite(extraFeePercent) && extraFeePercent > 0;
    if (extraBtn) {
      extraBtn.style.display = extraOn ? '' : 'none';
      if (extraOn) extraBtn.textContent = percentFeeEnabled
        ? `🔥 ЭКСТРА ВЫВОД (${extraFeePercent}%)`
        : `🔥 ЭКСТРА ВЫВОД (${extraWithdrawInfo.cost} 🧠)`;
    }
    if (extraHint) {
      extraHint.style.display = extraOn ? '' : 'none';
      if (extraOn) extraHint.innerHTML = percentFeeEnabled
        ? `🔥 <b>Экстра вывод</b> — без очереди, трейд через 10 минут после подтверждения.<br>Комиссия: <b>${extraFeePercent}% от суммы вывода</b>, минимальная сумма — <b>${extraWithdrawInfo.min_sum} 🧠</b>.`
        : `🔥 <b>Экстра вывод</b> — без очереди, трейд через 10 минут после подтверждения.<br>Стоимость: <b>${extraWithdrawInfo.cost} 🧠</b>, предметы на сумму от <b>${extraWithdrawInfo.min_sum} 🧠</b>.`;
    }

    if (items.length === 0) {
      grid.innerHTML = '<div class="inv-empty">Нет доступных предметов для вывода</div>';
      return;
    }

    grid.innerHTML = items.map(item => `
      <div class="inv-item withdraw-select-item" id="sel-${item.id}"
           data-withdraw-item-id="${item.id}" role="checkbox" aria-checked="false" tabindex="0"
           onclick="toggleWithdrawItem(${item.id})"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();toggleWithdrawItem(${item.id})}">
        <span class="inv-select-state" aria-hidden="true">
          <span class="inv-select-check">✓</span>
          <span class="inv-select-copy">ВЫБРАНО</span>
          <span class="inv-select-order"></span>
        </span>
        <div class="inv-emoji">${item.emoji || '🧠'}</div>
        <div class="inv-name">${item.item_name}</div>
        <div class="inv-source">${srcLabel(item.source)}</div>
      </div>
    `).join('');

    // Показываем/сбрасываем счётчик
    const counter = document.getElementById('withdraw-counter');
    if (counter) {
      counter.textContent = `Выбрано: 0 / ${WITHDRAW_MAX_ITEMS}`;
      counter.style.color = 'var(--text-dim)';
      counter.setAttribute('aria-live', 'polite');
    }
    syncWithdrawSelectionUi();
  } catch (e) {
    grid.innerHTML = '<div class="inv-empty">Ошибка загрузки</div>';
  }
}

function toggleWithdrawItem(itemId) {
  if (withdrawSelectedIds.has(itemId)) {
    withdrawSelectedIds.delete(itemId);
  } else {
    if (withdrawSelectedIds.size >= WITHDRAW_MAX_ITEMS) {
      showToast(`Максимум ${WITHDRAW_MAX_ITEMS} предметов за один вывод!`, 'lose');
      return;
    }
    withdrawSelectedIds.add(itemId);
  }
  syncWithdrawSelectionUi();
}

function syncWithdrawSelectionUi() {
  const selectedOrder = [...withdrawSelectedIds];
  document.querySelectorAll('#inv-select-grid .withdraw-select-item').forEach(card => {
    const itemId = Number(card.dataset.withdrawItemId);
    const order = selectedOrder.indexOf(itemId);
    const selected = order !== -1;
    card.classList.toggle('selected', selected);
    card.setAttribute('aria-checked', selected ? 'true' : 'false');
    const orderNode = card.querySelector('.inv-select-order');
    if (orderNode) orderNode.textContent = selected ? String(order + 1) : '';
  });

  // Обновляем счётчик
  const counter = document.getElementById('withdraw-counter');
  if (counter) {
    counter.textContent = `Выбрано: ${withdrawSelectedIds.size} / ${WITHDRAW_MAX_ITEMS}`;
    counter.style.color = withdrawSelectedIds.size >= WITHDRAW_MAX_ITEMS ? 'var(--gold)' : 'var(--text-dim)';
    counter.classList.toggle('has-selection', withdrawSelectedIds.size > 0);
    counter.classList.toggle('is-full', withdrawSelectedIds.size >= WITHDRAW_MAX_ITEMS);
  }
}

function cancelWithdraw() {
  withdrawSelectedIds.clear();
  document.getElementById('inv-withdraw-panel').style.display = 'none';
  document.getElementById('inv-normal-mode').style.display = 'block';
  document.getElementById('inv-actions').style.display = 'block';  // ← добавить
}

async function confirmWithdraw() {
  if (withdrawSelectedIds.size === 0) {
    showToast('Выбери хотя бы один предмет!');
    return;
  }
  const username = document.getElementById('withdraw-username').value.trim();
  if (!username || username.length < 3 || username.includes(' ')) {
    showToast('Введи корректный ник Roblox!', 'lose');
    return;
  }

  try {
    const res = await fetch(`${API}/api/withdraw/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, roblox_username: username, item_ids: [...withdrawSelectedIds] })
    });
    const data = await res.json();

    if (data.error) { showToast(data.error, 'lose'); return; }

    // Успех — показываем результат
    cancelWithdraw();
    const box = document.getElementById('inv-result');
    box.style.display = 'block';
    box.className = 'result-box result-win';
    const merged = !!data.merged;
    box.innerHTML = `
      <div class="result-title">${merged ? '📦 Добавлено к твоему выводу!' : '📤 Вывод запланирован!'}</div>
      <div class="result-detail">
        ${merged ? '♻️ У тебя уже был активный вывод — новые предметы добавлены в него, всё придёт одним трейдом.<br><br>' : ''}
        🏆 <b>${data.item_names}</b><br>
        🎮 Ник: <b>${username}</b><br><br>
        📅 <b>${data.date_label}</b> с <b>${data.slot_start}</b> до <b>${data.slot_end}</b> по МСК<br><br>
        ⚠️ Важно: будь в игре и прими трейд!<br>
        Предметы заморожены до выполнения вывода.
      </div>
    `;
    showToast(merged ? '✅ Добавлено к существующему выводу!' : '✅ Вывод запланирован!', 'win');
    loadInit();
    loadInventory();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}

// 🔥 Экстра вывод — без слота, платно, подтверждается админом
async function confirmExtraWithdraw() {
  if (withdrawSelectedIds.size === 0) {
    showToast('Выбери хотя бы один предмет!');
    return;
  }
  const username = document.getElementById('withdraw-username').value.trim();
  if (!username || username.length < 3 || username.includes(' ')) {
    showToast('Введи корректный ник Roblox!', 'lose');
    return;
  }

  try {
    const res = await fetch(`${API}/api/withdraw/extra`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, roblox_username: username, item_ids: [...withdrawSelectedIds] })
    });
    const data = await res.json();

    if (data.error) { showToast(data.error, 'lose'); return; }

    cancelWithdraw();
    const box = document.getElementById('inv-result');
    box.style.display = 'block';
    box.className = 'result-box result-win';
    box.innerHTML = `
      <div class="result-title">🔥 Заявка на экстра вывод отправлена!</div>
      <div class="result-detail">
        🏆 <b>${data.item_names}</b><br>
        🎮 Ник: <b>${username}</b><br>
        💰 Комиссия 10%: <b>${data.cost} 🧠</b><br><br>
        ⏳ Жди подтверждения — уведомление придёт в Telegram.<br>
        После подтверждения трейд будет <b>через 10 минут</b> — будь в игре!<br><br>
        Если заявку отклонят или не обработают за 10 минут — ${data.cost} 🧠 вернутся на баланс, а предметы разморозятся.
      </div>
    `;
    showToast('🔥 Заявка на экстра вывод отправлена!', 'win');
    loadInit();
    loadInventory();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}
// ════════════════════════════════════════════════════════════════════
// DICEE — три режима: ОБЫЧНЫЙ / НЕО / ЭПИК
// ════════════════════════════════════════════════════════════════════

const DICE_COLORS_DATA = [
  { name: 'red',    color: '#ff4444', glow: '#ff666688' },
  { name: 'orange', color: '#ff8c00', glow: '#ffaa2288' },
  { name: 'yellow', color: '#ffd700', glow: '#ffdd4488' },
  { name: 'green',  color: '#00cc66', glow: '#00ee7788' },
  { name: 'blue',   color: '#4488ff', glow: '#5599ff88' },
  { name: 'purple', color: '#9944ff', glow: '#aa55ff88' },
];

function diceOrbMarkup(name, compact = false) {
  const marks = { red:'X', orange:'=', yellow:'◆', green:'+', blue:'••', purple:'▲' };
  return `<span class="dice-orb dice-orb--${name}${compact ? ' dice-orb--compact' : ''}"><i></i><b>${marks[name] || '?'}</b></span>`;
}

const ALL_COLORS = ['red','orange','yellow','green','blue','purple'];

let slotsChosenColor = null;
let slotsSpinning    = false;
let diceMode         = 'normal'; // 'normal' | 'neo' | 'epic'

const DICE_CELL_H = 52; // ячейка + gap для барабанов

// ─── Переключатель режима ─────────────────────────────────────────────────
function diceSetMode(mode) {
  diceMode = mode;
  document.querySelectorAll('.dice-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  diceBuildReels();
}

// ─── Строим барабаны под текущий режим ───────────────────────────────────
function diceBuildReels() {
  const container = document.getElementById('dice-reels-container');
  if (!container) return;

  if (diceMode === 'normal') {
    container.innerHTML = `
      <div class="slots-reels">
        ${['red','orange','green','blue'].map((name, i) => `<div class="slots-reel idle" id="sr-${i}">${diceOrbMarkup(name)}</div>`).join('')}
      </div>`;
  } else if (diceMode === 'epic') {
    container.innerHTML = `
      <div class="epic-reels-wrap" id="epic-reels-wrap">
        <div class="fs-reels-wrap" id="dice-fs-wrap">
          <div class="fs-reels" id="dice-fs-reels">
            ${[0,1,2,3].map(i => `
              <div class="fs-reel" id="dice-fsr${i}">
                <div class="fs-reel-inner" id="dice-fsri${i}"></div>
              </div>`).join('')}
          </div>
          <div class="fs-line"></div>
        </div>
      </div>`;
    epicFillAllReels();
  }
}

// ─── Нео: заполнить статичные ленты ──────────────────────────────────────
function neoFillAllReels() {
  for (let i = 0; i < 4; i++) {
    const inner = document.getElementById(`neo-ri${i}`);
    if (!inner) continue;
    inner.innerHTML = '';
    for (let j = 0; j < 20; j++) {
      const c = DICE_COLORS_DATA[Math.floor(Math.random() * 6)];
      const el = document.createElement('div');
      el.className = 'neo-cell';
      el.innerHTML = diceOrbMarkup(c.name, true);
      el.style.setProperty('--c', c.color);
      inner.appendChild(el);
    }
  }
}

// ─── Эпик: заполнить статичные ленты ─────────────────────────────────────
function epicFillAllReels() {
  for (let i = 0; i < 4; i++) {
    const inner = document.getElementById(`dice-fsri${i}`);
    if (!inner) continue;
    inner.innerHTML = '';
    for (let j = 0; j < 20; j++) {
      const c = DICE_COLORS_DATA[Math.floor(Math.random() * 6)];
      const el = document.createElement('div');
      el.className = 'fs-cell';
      el.innerHTML = diceOrbMarkup(c.name, true);
      el.style.background = c.color + '22';
      inner.appendChild(el);
    }
  }
}

// ─── Выбор цвета ──────────────────────────────────────────────────────────────
function slotsPickColor(color) {
  slotsChosenColor = color;
  document.querySelectorAll('.slots-color-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.color === color);
  });
  const res = document.getElementById('slots-result');
  if (res) res.style.display = 'none';
}

// ─── ОБЫЧНЫЙ режим: анимация ──────────────────────────────────────────────
async function animateReelsNormal(finalValues, chosen) {
  const STEPS = 20;
  for (let step = 0; step < STEPS; step++) {
    SND.play('diceBlip', step);
    for (let i = 0; i < 4; i++) {
      const el = document.getElementById('sr-' + i);
      if (!el) continue;
      if (step < STEPS - 1) {
        const rnd = ALL_COLORS[Math.floor(Math.random() * ALL_COLORS.length)];
        el.innerHTML = diceOrbMarkup(rnd);
        el.className   = 'slots-reel spinning';
      } else {
        const val     = finalValues[i];
        const isMatch = val === chosen;
        el.innerHTML = diceOrbMarkup(val);
        el.className   = 'slots-reel ' + (isMatch ? 'match' : 'no-match');
        el.dataset.color = val;
      }
    }
    await sleep(40 + step * 10);
  }
}

// ─── НЕО режим: барабан с матричным стилем ───────────────────────────────
const NEO_CELL_H = 48;

async function neoSpinReel(idx, finalColor, delayMs) {
  await sleep(delayMs);
  const inner = document.getElementById(`neo-ri${idx}`);
  const reel  = document.getElementById(`neo-r${idx}`);
  if (!inner || !reel) return;

  const STRIP = 50;
  const MID   = Math.floor(STRIP / 2);

  inner.innerHTML = '';
  inner.style.transition = 'none';
  inner.style.transform  = 'translateY(0)';

  for (let j = 0; j < STRIP; j++) {
    const c  = (j === MID) ? finalColor : DICE_COLORS_DATA[Math.floor(Math.random() * 6)];
    const el = document.createElement('div');
    el.className = 'neo-cell';
    el.innerHTML = diceOrbMarkup(c.name, true);
    el.style.setProperty('--c', c.color);
    inner.appendChild(el);
  }

  const targetY = -(MID * NEO_CELL_H - 72 + NEO_CELL_H / 2);
  const startY  = 300 + Math.random() * 100;
  inner.style.transform = `translateY(${startY}px)`;
  await sleep(16);

  reel.classList.add('neo-spinning');

  // Быстрый разгон
  const t1 = 600 + idx * 180;
  inner.style.transition = `transform ${t1}ms cubic-bezier(0.2, 0, 0.8, 0.2)`;
  inner.style.transform  = `translateY(${targetY - 180}px)`;
  await sleep(t1);

  // Замедление с перелётом
  const t2 = 400 + idx * 100;
  inner.style.transition = `transform ${t2}ms cubic-bezier(0.05, 0.7, 0.1, 1)`;
  inner.style.transform  = `translateY(${targetY + 16}px)`;
  await sleep(t2);

  // Пружина
  inner.style.transition = 'transform 140ms cubic-bezier(0.34, 1.6, 0.64, 1)';
  inner.style.transform  = `translateY(${targetY}px)`;
  await sleep(160);

  reel.classList.remove('neo-spinning');
  reel.classList.add('neo-landed');

  // Подсветка финальной ячейки
  const cells = inner.querySelectorAll('.neo-cell');
  if (cells[MID]) {
    cells[MID].classList.add('neo-cell-landed');
    cells[MID].style.setProperty('--c', finalColor.color);
  }

  // Тряска экрана в нео-режиме тоже (небольшая)
  neoShakeScreen(0.4);

  await sleep(150);
}

function neoShakeScreen(intensity = 1) {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.remove('screen-shake');
  void app.offsetWidth;
  app.style.setProperty('--shake-intensity', intensity);
  app.classList.add('screen-shake');
  setTimeout(() => app.classList.remove('screen-shake'), 350);
}

// ─── ЭПИК режим: барабан с кристаллами + тряска экрана ───────────────────
async function epicSpinReel(idx, finalColor) {
  const inner = document.getElementById(`dice-fsri${idx}`);
  const reel  = document.getElementById(`dice-fsr${idx}`);
  if (!inner || !reel) return;

  const LEAD  = 50;
  const TOTAL = LEAD + 1;

  inner.innerHTML = '';
  inner.style.transition = 'none';
  inner.style.transform  = 'translateY(0)';

  reel.classList.add('epic-idle');

  for (let j = 0; j < TOTAL; j++) {
    const c  = (j === LEAD) ? finalColor : DICE_COLORS_DATA[Math.floor(Math.random() * 6)];
    const el = document.createElement('div');
    el.className = 'fs-cell';
    el.innerHTML = diceOrbMarkup(c.name, true);
    el.style.background = c.color + '22';
    inner.appendChild(el);
  }

  const targetY = -(LEAD * DICE_CELL_H - 90 + DICE_CELL_H / 2);

  inner.style.transform = `translateY(320px)`;
  await sleep(16);

  // Все вместе стартуют — это для одного барабана, вызывается последовательно
  inner.style.transition = `transform 1800ms cubic-bezier(0.2, 0, 0.6, 1)`;
  inner.style.transform  = `translateY(${targetY - 500}px)`;
  await sleep(1800);

  // Читаем текущую позицию
  const ct = window.getComputedStyle(inner).transform;
  let curY = 0;
  if (ct && ct !== 'none') {
    const m = ct.match(/matrix.*\((.+)\)/);
    if (m) curY = parseFloat(m[1].split(', ')[5]);
  }

  inner.style.transition = 'none';
  inner.style.transform  = `translateY(${curY}px)`;
  await sleep(16);

  // Удар — резкое торможение
  const overshoot = targetY + 28;
  const brakeDist = Math.abs(curY - overshoot);
  const brakeMs   = Math.min(Math.max(brakeDist * 0.5, 250), 520);

  inner.style.transition = `transform ${brakeMs}ms cubic-bezier(0.05, 0.7, 0.1, 1)`;
  inner.style.transform  = `translateY(${overshoot}px)`;
  await sleep(brakeMs);

  // Пружина назад
  inner.style.transition = 'transform 160ms cubic-bezier(0.34, 2.2, 0.64, 1)';
  inner.style.transform  = `translateY(${targetY - 8}px)`;
  await sleep(160);

  // Финальная посадка
  inner.style.transition = 'transform 120ms ease-out';
  inner.style.transform  = `translateY(${targetY}px)`;
  await sleep(130);

  // Эффекты
  reel.classList.remove('epic-idle');
  reel.classList.add('epic-reveal');

  const cells   = inner.querySelectorAll('.fs-cell');
  const midCell = cells[LEAD];
  if (midCell) {
    midCell.classList.add('landed');
    midCell.style.background  = finalColor.color + '44';
    midCell.style.boxShadow   = `0 0 32px ${finalColor.color}99, 0 0 12px ${finalColor.color}66`;
  }

  // Частицы
  diceSpawnParticles(reel, finalColor.color, 14, 'burst');
  setTimeout(() => diceSpawnRing(reel, finalColor.color), 80);
  setTimeout(() => diceSpawnParticles(reel, finalColor.color, 6, 'down'), 160);

  // Мини-вспышка на барабане
  const miniFlash = document.createElement('div');
  miniFlash.className = 'fs-epic-flash';
  miniFlash.style.cssText = 'opacity:0.6;animation-duration:0.3s;';
  reel.style.position = 'relative';
  reel.appendChild(miniFlash);
  setTimeout(() => miniFlash.remove(), 400);

  // ── ТРЯСКА ЭКРАНА при каждом появлении ────────────────────────────────
  epicShakeScreen();

  // Пульс линии
  const line = document.querySelector('#dice-fs-wrap .fs-line');
  if (line) {
    line.style.transition = 'box-shadow .1s, border-color .1s';
    line.style.borderColor = finalColor.color;
    line.style.boxShadow   = `0 0 28px ${finalColor.color}aa`;
    setTimeout(() => { line.style.borderColor = ''; line.style.boxShadow = ''; }, 500);
  }
}

function epicShakeScreen() {
  const app = document.querySelector('.app');
  if (!app) return;
  app.classList.remove('epic-screen-shake');
  void app.offsetWidth; // force reflow
  app.classList.add('epic-screen-shake');
  setTimeout(() => app.classList.remove('epic-screen-shake'), 450);
}

// ─── Частицы для эпик-режима (dice) ───────────────────────────────────────
function diceSpawnParticles(anchor, color, count = 8, mode = 'burst') {
  const rect = anchor.getBoundingClientRect();
  const cx   = rect.left + rect.width  / 2;
  const cy   = rect.top  + rect.height / 2;

  for (let i = 0; i < count; i++) {
    const p    = document.createElement('div');
    const big  = Math.random() > 0.6;
    const size = big ? (8 + Math.random() * 8) : (4 + Math.random() * 5);
    let angle;
    if (mode === 'all')  angle = Math.random() * 360;
    else if (mode === 'down') angle = 60 + Math.random() * 60;
    else angle = Math.random() > 0.5 ? -80 + Math.random() * 160 : (Math.random() > 0.5 ? 100 + Math.random() * 60 : -160 - Math.random() * 60);

    const rad  = angle * Math.PI / 180;
    const dist = 60 + Math.random() * 130;
    const dx   = Math.cos(rad) * dist;
    const dy   = Math.sin(rad) * dist;
    const dur  = 700 + Math.random() * 400;

    p.className = 'fs-particle';
    p.style.cssText = `left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;background:${color};box-shadow:0 0 ${size*1.5}px ${color},0 0 ${size*.5}px #fff8;--dx:${dx}px;--dy:${dy}px;--rot:${Math.random()*720}deg;animation-duration:${dur}ms;animation-delay:${Math.random()*80}ms;`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), dur + 150);
  }

  // Шары вниз
  for (let i = 0; i < Math.ceil(count * 0.35); i++) {
    const p  = document.createElement('div');
    const sz = 5 + Math.random() * 7;
    const dx = (Math.random() - 0.5) * 60;
    const dy = 80 + Math.random() * 120;
    const dur = 600 + Math.random() * 350;
    p.className = 'fs-particle fs-particle-down';
    p.style.cssText = `left:${cx}px;top:${cy}px;width:${sz}px;height:${sz}px;background:${color};box-shadow:0 0 ${sz}px ${color};--dx:${dx}px;--dy:${dy}px;--rot:${Math.random()*360}deg;animation-duration:${dur}ms;`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), dur + 100);
  }
}

function diceSpawnRing(anchor, color) {
  const rect = anchor.getBoundingClientRect();
  const cx   = rect.left + rect.width  / 2;
  const cy   = rect.top  + rect.height / 2;
  const N    = 12;
  for (let i = 0; i < N; i++) {
    const angle = (360 / N) * i;
    const rad   = angle * Math.PI / 180;
    const dist  = 50 + Math.random() * 35;
    const p     = document.createElement('div');
    p.className = 'fs-particle';
    p.style.cssText = `left:${cx}px;top:${cy}px;width:4px;height:4px;border-radius:50%;background:#fff;box-shadow:0 0 6px ${color},0 0 12px ${color};--dx:${Math.cos(rad)*dist}px;--dy:${Math.sin(rad)*dist}px;--rot:0deg;animation-duration:500ms;animation-timing-function:ease-out;`;
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 560);
  }
}

// ─── Финальная вспышка после всех 4 барабанов (эпик) ────────────────────────
function diceEpicFinalBlast(finals) {
  const wrap = document.getElementById('dice-fs-wrap');
  if (!wrap) return;

  const flash = document.createElement('div');
  flash.className = 'fs-epic-flash';
  wrap.appendChild(flash);
  setTimeout(() => flash.remove(), 700);

  setTimeout(() => {
    const flash2 = document.createElement('div');
    flash2.className = 'fs-epic-flash';
    flash2.style.animationDuration = '0.4s';
    flash2.style.opacity = '0.4';
    wrap.appendChild(flash2);
    setTimeout(() => flash2.remove(), 450);
  }, 200);

  for (let i = 0; i < 4; i++) {
    const reel = document.getElementById(`dice-fsr${i}`);
    if (reel) {
      diceSpawnParticles(reel, finals[i].color, 16, 'all');
      setTimeout(() => diceSpawnRing(reel, finals[i].color), 120);
    }
  }

  // Финальная большая тряска
  epicShakeScreen();
  setTimeout(() => epicShakeScreen(), 220);
}

// ─── Основная функция ─────────────────────────────────────────────────────
async function playSlotsGame() {
  if (slotsSpinning) return;

  if (!slotsChosenColor) {
    showToast('Сначала выбери цвет!');
    return;
  }

  const bet = parseInt(document.getElementById('slots-bet')?.value);
  if (!bet || bet <= 0) {
    showToast('Введи ставку!');
    return;
  }

  slotsSpinning = true;
  const btn = document.getElementById('slots-btn');
  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'КРУТИМ...'; }

  const resBox = document.getElementById('slots-result');
  if (resBox) resBox.style.display = 'none';

  try {
    const resp = await fetch(`${API}/api/slots/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, bet, chosen: slotsChosenColor })
    });

    const data = await resp.json();

    if (data.error) {
      const msgs = {
        insufficient_balance: 'Недостаточно баланса!',
        invalid_bet:          'Некорректная ставка',
        invalid_color:        'Неверный цвет',
        missing_params:       'Ошибка запроса'
      };
      showToast(msgs[data.error] || data.error, 'lose');
      slotsSpinning = false;
      if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'КРУТИТЬ'; }
      return;
    }

    // Конвертируем имена цветов в объекты для эпик/нео режимов
    const finalColors = data.reels.map(name => DICE_COLORS_DATA.find(c => c.name === name));

    // ──── Анимация по режиму ─────────────────────────────────────────────
    if (diceMode === 'normal') {
      await animateReelsNormal(data.reels, slotsChosenColor);

    } else if (diceMode === 'epic') {
      // Все сразу разгоняются, потом тормозят по очереди
      const innerEls = finalColors.map((_, i) => document.getElementById(`dice-fsri${i}`));
      const reelEls  = finalColors.map((_, i) => document.getElementById(`dice-fsr${i}`));

      // Фаза 1: все барабаны разгоняются вместе
      for (let i = 0; i < 4; i++) {
        const inner = innerEls[i];
        const reel  = reelEls[i];
        if (!inner || !reel) continue;

        const LEAD  = 50;
        const TOTAL = LEAD + 1;
        inner.innerHTML = '';
        inner.style.transition = 'none';
        inner.style.transform  = 'translateY(0)';
        reel.classList.remove('epic-idle','epic-reveal');
        reel.classList.add('epic-idle');

        for (let j = 0; j < TOTAL; j++) {
          const c  = (j === LEAD) ? finalColors[i] : DICE_COLORS_DATA[Math.floor(Math.random() * 6)];
          const el = document.createElement('div');
          el.className   = 'fs-cell';
          el.innerHTML = diceOrbMarkup(c.name, true);
          el.style.background = c.color + '22';
          inner.appendChild(el);
        }

        const targetY = -(LEAD * DICE_CELL_H - 90 + DICE_CELL_H / 2);
        inner._targetY = targetY;
        inner.style.transform = `translateY(320px)`;
      }

      await sleep(16);

      SND.play('whoosh');
      SND.spinTicks(6300, 34);
      for (let i = 0; i < 4; i++) {
        const inner = innerEls[i];
        if (!inner) continue;
        inner.style.transition = `transform 1800ms cubic-bezier(0.2, 0, 0.6, 1)`;
        inner.style.transform  = `translateY(${inner._targetY - 500}px)`;
      }
      await sleep(1800);

      // Фаза 2: тормозим по очереди
      for (let i = 0; i < 4; i++) {
        const inner = innerEls[i];
        const reel  = reelEls[i];
        if (!inner || !reel) continue;

        const targetY = inner._targetY;
        const ct = window.getComputedStyle(inner).transform;
        let curY = 0;
        if (ct && ct !== 'none') {
          const m = ct.match(/matrix.*\((.+)\)/);
          if (m) curY = parseFloat(m[1].split(', ')[5]);
        }

        inner.style.transition = 'none';
        inner.style.transform  = `translateY(${curY}px)`;
        await sleep(16);

        const overshoot = targetY + 28;
        const brakeDist = Math.abs(curY - overshoot);
        const brakeMs   = Math.min(Math.max(brakeDist * 0.5, 250), 520);

        inner.style.transition = `transform ${brakeMs}ms cubic-bezier(0.05, 0.7, 0.1, 1)`;
        inner.style.transform  = `translateY(${overshoot}px)`;
        await sleep(brakeMs);

        inner.style.transition = 'transform 160ms cubic-bezier(0.34, 2.2, 0.64, 1)';
        inner.style.transform  = `translateY(${targetY - 8}px)`;
        await sleep(160);

        inner.style.transition = 'transform 120ms ease-out';
        inner.style.transform  = `translateY(${targetY}px)`;
        await sleep(130);

        // Эффекты посадки
        reel.classList.remove('epic-idle');
        reel.classList.add('epic-reveal');

        const cells   = inner.querySelectorAll('.fs-cell');
        const LEAD    = 50;
        const midCell = cells[LEAD];
        if (midCell) {
          midCell.classList.add('landed');
          midCell.style.background = finalColors[i].color + '44';
          midCell.style.boxShadow  = `0 0 32px ${finalColors[i].color}99, 0 0 12px ${finalColors[i].color}66`;
        }

        diceSpawnParticles(reel, finalColors[i].color, 14, 'burst');
        setTimeout(() => diceSpawnRing(reel, finalColors[i].color), 80);
        setTimeout(() => diceSpawnParticles(reel, finalColors[i].color, 6, 'down'), 160);

        const miniFlash = document.createElement('div');
        miniFlash.className = 'fs-epic-flash';
        miniFlash.style.cssText = 'opacity:0.6;animation-duration:0.3s;';
        reel.style.position = 'relative';
        reel.appendChild(miniFlash);
        setTimeout(() => miniFlash.remove(), 400);

        // Тряска экрана при КАЖДОМ барабане
        epicShakeScreen();
        SND.play('tick');
        SND.play('dicePip', i);

        const line = document.querySelector('#dice-fs-wrap .fs-line');
        if (line) {
          line.style.transition = 'box-shadow .1s, border-color .1s';
          line.style.borderColor = finalColors[i].color;
          line.style.boxShadow   = `0 0 28px ${finalColors[i].color}aa`;
          setTimeout(() => { line.style.borderColor = ''; line.style.boxShadow = ''; }, 500);
        }

        if (i < 3) await sleep(350 + i * 120);
      }

      // Финальный взрыв
      await sleep(180);
      diceEpicFinalBlast(finalColors);
    }

    // Обновляем баланс
    loadInit();

    // Результат
    if (data.result === 'jackpot') {
      showResult('slots-result', { win: true, title: '🔥 JACKPOT!', detail: `4 совпадения · ×10`, amount: data.profit });
      showToast(`+${data.profit} 🧠 JACKPOT!`, 'win');
    } else if (data.result === 'win') {
      showResult('slots-result', { win: true, title: '🎉 WIN!', detail: `${data.matches} совп. · ×${data.multiplier}`, amount: data.profit });
      showToast(`+${data.profit} 🧠`, 'win');
    } else {
      showResult('slots-result', { win: false, title: '💀 ПРОИГРЫШ', detail: `${data.matches} совп. — не попал`, amount: -bet });
      showToast(`-${bet} 🧠`, 'lose');
    }

  } catch (e) {
    console.error('Slots error:', e);
    showToast('Ошибка сервера', 'lose');
  }

  slotsSpinning = false;
  if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'КРУТИТЬ'; }
}

    
function analyticsMetric(distribution, key) {
  return distribution && distribution[String(key)] || { count: 0, pct: 0 };
}

function analyticsBar(label, metric, color = 'var(--green)') {
  const pct = Math.max(0, Math.min(100, Number(metric.pct || 0)));
  return `
    <div class="analytics-row">
      <div class="analytics-row-head"><span>${escHtml(label)}</span><b>${pct.toFixed(1)}%</b><small>${Number(metric.count || 0).toLocaleString('ru-RU')}</small></div>
      <div class="analytics-track"><i style="width:${pct}%;background:${color}"></i></div>
    </div>`;
}

function analyticsToggle(label, distribution, color = 'var(--green)') {
  const on = analyticsMetric(distribution, 1);
  const off = analyticsMetric(distribution, 0);
  return `
    <div class="analytics-toggle-row">
      <div><b>${escHtml(label)}</b><small>выключено ${Number(off.pct || 0).toFixed(1)}%</small></div>
      <div class="analytics-toggle-value"><strong>${Number(on.pct || 0).toFixed(1)}%</strong><span>${Number(on.count || 0).toLocaleString('ru-RU')} вкл.</span></div>
      <div class="analytics-track"><i style="width:${Math.max(0, Math.min(100, Number(on.pct || 0)))}%;background:${color}"></i></div>
    </div>`;
}

function analyticsVolume(label, value, color) {
  const pct = Math.max(0, Math.min(100, Number(value || 0)));
  return `
    <div class="analytics-row">
      <div class="analytics-row-head"><span>${escHtml(label)}</span><b>${pct.toFixed(1)}%</b><small>среднее</small></div>
      <div class="analytics-track"><i style="width:${pct}%;background:${color}"></i></div>
    </div>`;
}

function analyticsKpi(label, value, note = '') {
  return `<div class="analytics-kpi"><span>${escHtml(label)}</span><b>${escHtml(value)}</b><small>${escHtml(note)}</small></div>`;
}

function renderClientAnalytics(data) {
  const content = document.getElementById('analytics-content');
  if (!content) return;
  const totals = data.totals || {};
  const financial = data.financial || {};
  const finance24h = financial.day_24h || {};
  const financeWeek = financial.week || {};
  const financeAll = financial.all || {};
  const fmt = value => Number(value || 0).toLocaleString('ru-RU');
  const platforms = Object.entries(data.platform || {}).sort((a, b) => Number(b[1].count || 0) - Number(a[1].count || 0));
  const platformNames = {
    ios: 'iOS', android: 'Android', android_x: 'Android X',
    tdesktop: 'Telegram Desktop', macos: 'macOS', web: 'Web',
    weba: 'Telegram Web A', webk: 'Telegram Web K', unigram: 'Unigram', unknown: 'Неизвестно',
  };
  const accessAudit = Array.isArray(data.access_audit) ? data.access_audit : [];
  const accessAllowed = accessAudit.filter(row => Number(row.allowed) === 1).length;
  const accessDenied = accessAudit.length - accessAllowed;
  const accessReasonNames = {
    authorized: 'Доступ администратора',
    invalid_or_missing_init_data: 'Нет подписи Telegram',
    not_admin: 'Чужой Telegram-аккаунт',
    missing_admin_token: 'Нет второго токена',
    invalid_admin_token: 'Неверный второй токен',
  };
  const accessRows = accessAudit.slice(0, 12).map(row => {
    const allowed = Number(row.allowed) === 1;
    const when = row.created_at
      ? new Date(Number(row.created_at) * 1000).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
      : '—';
    const actor = row.tg_id ? `#${Number(row.tg_id)}` : 'не определён';
    return `<div class="analytics-reaction-row">
      <span>${allowed ? 'РАЗРЕШЕНО' : 'ЗАБЛОКИРОВАНО'} · ${escHtml(actor)}</span>
      <b>${escHtml(accessReasonNames[row.reason] || row.reason || 'Неизвестно')}</b>
      <small>${escHtml(when)}</small>
    </div>`;
  }).join('') || '<div class="analytics-empty">Попыток после установки журнала пока нет</div>';
  const recent = (data.recent || []).map(row => {
    const name = row.roblox_username || `#${row.tg_id}`;
    const updated = row.updated_at ? new Date(Number(row.updated_at) * 1000).toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
    const audio = row.game_sound || row.ui_sound || row.music_sound;
    return `
      <div class="analytics-recent-row">
        <div><b>${escHtml(name)}</b><small>#${Number(row.tg_id)} · ${escHtml(updated)}</small></div>
        <div class="analytics-recent-tags">
          <span>${row.ui_theme === 'classic' ? 'СТАРЫЙ 2.0' : 'НОВЫЙ'}</span>
          <span>${escHtml(platformNames[row.platform] || row.platform || 'Неизвестно')}</span>
          <span class="${audio ? 'on' : 'off'}">${audio ? 'ЗВУК' : 'ТИШИНА'}</span>
        </div>
      </div>`;
  }).join('') || '<div class="analytics-empty">Пока нет собранных данных</div>';
  const gameNames = {
    dice: 'Dice', coin: 'Монетка', resonance: 'РотДек', mines: 'Мины', rocket: 'Ракетка',
    case: 'Кейсы', cases: 'Кейсы', upgrader: 'Апгрейд', upgrade: 'Апгрейд',
    craft: 'Крафт', roulette_1v1: '1v1', duel: '1v1', jackpot: 'Jackpot',
    roulette: 'Мульти-рулетка', multi_roulette: 'Мульти-рулетка',
    ffa: 'FFA', slots: 'Dice', brain_slots: 'Слоты', freeslots: 'Призма', unknown: 'Неизвестно',
  };
  const gameUsage = Array.isArray(data.game_usage) ? data.game_usage : [];
  const maxGameUsage = Math.max(1, ...gameUsage.map(row => Number(row.participations || 0)));
  const gameUsageRows = gameUsage.map((row, index) => {
    const count = Number(row.participations || 0);
    const pct = count * 100 / maxGameUsage;
    const color = ['#65d43d','#f5c542','#50c8b4','#ff805f','#c355bb','#68a5ff'][index % 6];
    return `
      <div class="analytics-row">
        <div class="analytics-row-head"><span>${escHtml(gameNames[row.game_type] || row.game_type)}</span><b>${fmt(count)}</b><small>${fmt(row.players)} игроков</small></div>
        <div class="analytics-track"><i style="width:${pct}%;background:${color}"></i></div>
      </div>`;
  }).join('') || '<div class="analytics-empty">Завершённых игр пока нет</div>';
  const reactions = data.reactions || {};
  const reactionBreakdown = Object.entries(reactions.breakdown || {}).map(([key, value]) =>
    `${key === 'heart' ? '♥' : key.replace(/^emoji:/, '')}: ${fmt(value)}`
  ).join(' · ') || 'нет данных';
  const reactionTop = (reactions.top_today || []).map(row => `
    <div class="analytics-reaction-row">
      <span>${escHtml(row.roblox_username || `#${row.tg_id}`)}</span>
      <b>${Number(row.hearts || 0)} / ${Number(reactions.required || 5)}</b>
      <small>${row.claimed ? 'кейс забран' : 'в процессе'}</small>
    </div>`).join('') || '<div class="analytics-empty">Сегодня реакций пока нет</div>';

  content.innerHTML = `
    <div class="analytics-kpis">
      ${analyticsKpi('ОТСЛЕЖЕНО', fmt(totals.tracked), `из ${fmt(totals.registered)}`)}
      ${analyticsKpi('ОХВАТ', `${Number(totals.coverage_pct || 0).toFixed(1)}%`, 'от всей базы')}
      ${analyticsKpi('ЗА 24 ЧАСА', fmt(totals.active_24h), 'активных')}
      ${analyticsKpi('ЗА 7 ДНЕЙ', fmt(totals.active_7d), 'активных')}
      ${analyticsKpi('ЗАПУСКИ', fmt(totals.sessions), 'всего')}
      ${analyticsKpi('ИГРОКИ', fmt(totals.registered), 'в базе')}
    </div>
    <div class="analytics-grid">
      <section class="analytics-panel analytics-panel-wide">
        <h3>ПОПОЛНЕНИЯ И УСПЕШНЫЕ ВЫВОДЫ</h3>
        <div class="analytics-kpis analytics-kpis-compact">
          ${analyticsKpi('ПОПОЛНЕНИЯ · 24 Ч', `${fmt(finance24h.deposits)} 🧠`, 'последние 24 часа')}
          ${analyticsKpi('ВЫВОДЫ · 24 Ч', `${fmt(finance24h.withdrawals)} 🧠`, 'только успешные')}
          ${analyticsKpi('ПОПОЛНЕНИЯ · НЕДЕЛЯ', `${fmt(financeWeek.deposits)} 🧠`, 'с понедельника по МСК')}
          ${analyticsKpi('ВЫВОДЫ · НЕДЕЛЯ', `${fmt(financeWeek.withdrawals)} 🧠`, 'только успешные')}
          ${analyticsKpi('ПОПОЛНЕНИЯ · ВСЁ ВРЕМЯ', `${fmt(financeAll.deposits)} 🧠`, 'завершённые пополнения')}
          ${analyticsKpi('ВЫВОДЫ · ВСЁ ВРЕМЯ', `${fmt(financeAll.withdrawals)} 🧠`, 'только успешные')}
        </div>
      </section>
      <section class="analytics-panel">
        <h3>ДИЗАЙН</h3>
        ${analyticsBar('Новый', analyticsMetric(data.theme, 'modern'), '#61d641')}
        ${analyticsBar('Старый 2.0', analyticsMetric(data.theme, 'classic'), '#f5c542')}
      </section>
      <section class="analytics-panel">
        <h3>ОКНО TELEGRAM</h3>
        ${analyticsBar('Полный экран', analyticsMetric(data.display_mode, 'fullscreen'), '#50c8b4')}
        ${analyticsBar('Обычное', analyticsMetric(data.display_mode, 'normal'), '#f5a642')}
      </section>
      <section class="analytics-panel analytics-panel-wide">
        <h3>ЗВУК И ОТКЛИК</h3>
        ${analyticsToggle('Любой звук', data.audio_any, '#65d43d')}
        ${analyticsToggle('Игровые эффекты', data.game_sound, '#ffb552')}
        ${analyticsToggle('Интерфейс', data.ui_sound, '#50c8b4')}
        ${analyticsToggle('Музыка', data.music_sound, '#c355bb')}
        ${analyticsToggle('Вибрация', data.haptic, '#e7ff78')}
      </section>
      <section class="analytics-panel analytics-panel-wide">
        <h3>РЕАКЦИИ НА ПОСТЫ</h3>
        <div class="analytics-kpis analytics-kpis-compact">
          ${analyticsKpi('ПОСТЫ СЕГОДНЯ', fmt(reactions.posts_today), 'по МСК')}
          ${analyticsKpi('СЕРДЕЧКИ', fmt(reactions.hearts_today), 'активных сейчас')}
          ${analyticsKpi('УЧАСТНИКИ', fmt(reactions.reactors_today), 'поставили ♥')}
          ${analyticsKpi('АКТИВНЫЕ 5+', fmt(reactions.eligible_today), `по ${reactions.required || 5} реакций`)}
        </div>
        <div class="analytics-reaction-events">За 24 часа: +${fmt(reactions.events_24h && reactions.events_24h.added)} добавлений · −${fmt(reactions.events_24h && reactions.events_24h.removed)} снятий<br>Типы сегодня: ${escHtml(reactionBreakdown)}</div>
        <div class="analytics-reaction-top">${reactionTop}</div>
        <div id="analytics-reaction-posts" class="analytics-reaction-posts"><div class="analytics-empty">Загрузка постов...</div></div>
      </section>
      <section class="analytics-panel">
        <h3>СРЕДНЯЯ ГРОМКОСТЬ</h3>
        ${analyticsVolume('Игра', data.average_volume && data.average_volume.game, '#ffb552')}
        ${analyticsVolume('Интерфейс', data.average_volume && data.average_volume.ui, '#50c8b4')}
        ${analyticsVolume('Музыка', data.average_volume && data.average_volume.music, '#c355bb')}
      </section>
      <section class="analytics-panel">
        <h3>ПЛАТФОРМЫ</h3>
        ${platforms.slice(0, 7).map(([key, metric], index) => analyticsBar(platformNames[key] || key, metric, ['#65d43d','#50c8b4','#ffb552','#c355bb','#e7ff78'][index % 5])).join('') || '<div class="analytics-empty">Нет данных</div>'}
      </section>
      <section class="analytics-panel analytics-panel-wide">
        <h3>УЧАСТИЯ В РЕЖИМАХ</h3>
        <div class="analytics-reaction-events">Один раунд на 5 игроков считается как 5 участий.</div>
        ${gameUsageRows}
      </section>
      <section class="analytics-panel analytics-panel-wide">
        <h3>БЕЗОПАСНОСТЬ МЕТРИК</h3>
        <div class="analytics-kpis analytics-kpis-compact">
          ${analyticsKpi('РАЗРЕШЕНО', fmt(accessAllowed), 'только твой подписанный аккаунт')}
          ${analyticsKpi('ЗАБЛОКИРОВАНО', fmt(accessDenied), 'из последних 100 решений')}
        </div>
        <div class="analytics-reaction-events">Журнал ведётся с момента этого обновления. IP, Telegram initData и необработанные токены браузерного входа в нём не сохраняются.</div>
        <div class="analytics-reaction-top">${accessRows}</div>
      </section>
      <section class="analytics-panel analytics-panel-wide">
        <h3>ПОСЛЕДНИЕ АКТИВНЫЕ</h3>
        <div class="analytics-recent">${recent}</div>
      </section>
    </div>`;
}

async function loadReactionAdminPosts() {
  if (!_adminToken) return;
  const target = document.getElementById('analytics-reaction-posts');
  if (!target) return;
  try {
    const res = await fetch(`${API}/api/admin/reactions`, {
      headers: { 'X-Admin-Token': _adminToken }, cache: 'no-store'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const posts = data.posts || [];
    target.innerHTML = posts.length ? posts.map(post => {
      const when = new Date(Number(post.posted_at || 0) * 1000).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' });
      const reactions = (post.reactions || []).map(item =>
        `<span>${escHtml(item.reaction === 'heart' ? '♥' : String(item.reaction || '').replace(/^emoji:/, ''))} ${escHtml(item.roblox_username || `#${item.tg_id}`)}</span>`
      ).join('') || '<small>реакций пока нет</small>';
      return `<div class="analytics-post-row"><div class="analytics-post-head"><b>${when} · #${post.message_id}</b><span>${escHtml(post.post_type || '')}</span></div><div class="analytics-post-text">${escHtml(post.post_text || 'Без текста')}</div><div class="analytics-post-reactions">${reactions}</div></div>`;
    }).join('') : '<div class="analytics-empty">Сегодня отслеживаемых постов пока нет</div>';
  } catch (e) {
    target.innerHTML = '<div class="analytics-empty error">Не удалось загрузить посты</div>';
  }
}

async function loadClientAnalytics() {
  if (!_adminToken) return;
  const content = document.getElementById('analytics-content');
  const refresh = document.getElementById('analytics-refresh');
  if (refresh) refresh.disabled = true;
  if (content && !content.querySelector('.analytics-kpis')) content.innerHTML = '<div class="analytics-empty">Загрузка...</div>';
  try {
    const res = await fetch(`${API}/api/admin/client-metrics`, {
      headers: { 'X-Admin-Token': _adminToken },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderClientAnalytics(data);
    loadReactionAdminPosts();
    const updated = document.getElementById('analytics-updated');
    if (updated) updated.textContent = `ОБНОВЛЕНО ${new Date(Number(data.generated_at || 0) * 1000).toLocaleString('ru-RU')}`;
  } catch (e) {
    if (content) content.innerHTML = '<div class="analytics-empty error">Не удалось загрузить аналитику</div>';
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

async function loadAdminPanel() {
  if (!_adminToken) return;
 
  ensureOnlineWidget();

  // Сбрасываем UI
  document.getElementById('admin-players-list').innerHTML =
    '<div style="color:var(--text-dim);font-size:13px">Загрузка...</div>';
  document.getElementById('adm-core-charge').textContent  = '...';
 
  try {
    const res  = await fetch(`${API}/api/admin/overview`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Admin-Token': _adminToken         // ← шифр
      },
      body: JSON.stringify({ tg_id })
    });
 
    if (!res.ok) { showToast('Нет доступа', 'lose'); return; }
    const data = await res.json();
 
    // ── Онлайн в мини-аппе ──────────────────────────────────────────────
    const onlineEl = document.getElementById('adm-online-count');
    if (onlineEl) onlineEl.textContent = `${data.online_count ?? 0}`;

    // ── Ядро ─────────────────────────────────────────────────────────────
    const b = data.core || {};
    document.getElementById('adm-core-charge').textContent  = `${Math.floor(b.balance  || 0)} 🧠`;
    document.getElementById('adm-core-plus').textContent   = `${Math.floor(b.total_in  || 0)} 🧠`;
    document.getElementById('adm-core-minus').textContent  = `${Math.floor(b.total_out || 0)} 🧠`;
 // ── Мозги в системе (admin-brains-box) ──────────────────────────────
try {
  const r2   = await fetch(`${API}/api/stats/totals`, {
    headers: { 'X-Admin-Token': _adminToken }
  });
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  const d2   = await r2.json();
  const fmt  = n => Number(n || 0).toLocaleString('ru-RU');
  const set  = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  set('adm-pb-grand-total',   `${fmt(d2.grand_total)} 🧠`);
  set('adm-pb-balances',      `${fmt(d2.total_balances)} 🧠`);
  set('adm-pb-users',         `${fmt(d2.total_users)} игроков`);
  set('adm-pb-items',         `${fmt(d2.total_items)} 🧠`);
  set('adm-pb-items-count',   `${fmt(d2.total_items_count)} предметов`);
  set('adm-pb-withdraw',      `${fmt(d2.total_withdraw)} 🧠`);
} catch (e) { console.error('Brains stats error', e); }
    // ── Список игроков ────────────────────────────────────────────────────
    window._adminPlayersList = data.players || [];
    const list    = document.getElementById('admin-players-list');
    const players = window._adminPlayersList;
 
    if (players.length === 0) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Нет игроков</div>';
      return;
    }
 
    list.innerHTML = players.map(p => {
      const net   = (p.total_won - p.total_lost).toFixed(0);
      const netColor = net >= 0 ? 'var(--green)' : 'var(--red)';
      return `
        <div onclick="openPlayerModal(${p.tg_id})" style="
          background:var(--surface);border:1px solid var(--border);
          border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;
          transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'"
          onmouseout="this.style.borderColor='var(--border)'">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <div style="font-family:'Orbitron',sans-serif;font-size:12px;color:var(--text)">
                #${p.tg_id}
              </div>
              <div style="font-size:11px;color:var(--text-dim);margin-top:2px">
                ${escHtml(p.roblox_username || '—')} · ${p.total_games || 0} игр
              </div>
            </div>
            <div style="text-align:right">
              <div style="font-family:'Orbitron',sans-serif;font-size:14px;color:var(--gold)">
                ${Math.floor(p.balance)} 🧠
              </div>
              <div style="font-size:11px;color:${netColor};margin-top:2px">
                нетто: ${net >= 0 ? '+' : ''}${net}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
 
  } catch (e) {
    console.error('Admin panel error', e);
    showToast('Ошибка загрузки', 'lose');
  }
}

function formatAdminIpTime(value) {
  const timestamp = Number(value || 0);
  if (!timestamp) return '—';
  return new Date(timestamp * 1000).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function encodeAdminCopyValue(value) {
  try {
    return encodeURIComponent(String(value ?? ''));
  } catch (error) {
    return encodeURIComponent(String(value ?? '').replace(/[\uD800-\uDFFF]/g, ' '));
  }
}

function adminCopyButton(value, label = 'КОПИРОВАТЬ') {
  return `<button type="button" class="admin-copy-btn" data-copy="${escHtml(encodeAdminCopyValue(value))}" onclick="copyAdminDataset(this)">${escHtml(label)}</button>`;
}

async function copyAdminDataset(button) {
  let value = '';
  try { value = decodeURIComponent(String(button?.dataset?.copy || '')); } catch (error) {}
  if (!value) return;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      copied = true;
    }
  } catch (error) {}

  if (!copied) {
    const field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', '');
    field.setAttribute('aria-hidden', 'true');
    field.style.cssText = 'position:fixed;left:8px;bottom:8px;width:2px;height:2px;opacity:.01;font-size:16px;z-index:99999';
    document.body.appendChild(field);
    field.focus({ preventScroll: true });
    field.select();
    field.setSelectionRange(0, field.value.length);
    try { copied = document.execCommand('copy'); } catch (error) {}
    field.remove();
  }

  if (copied) {
    const oldLabel = button.textContent;
    button.textContent = 'СКОПИРОВАНО';
    button.classList.add('copied');
    setTimeout(() => {
      if (!button?.isConnected) return;
      button.textContent = oldLabel;
      button.classList.remove('copied');
    }, 1200);
    if (typeof haptic === 'function') haptic('light');
  } else {
    showToast('Зажми текст и выбери «Скопировать»', 'error');
  }
}

function renderAdminIpRows(rows, relation = false) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return '<div class="admin-ip-empty">IP за период не найден.</div>';
  return list.map(ip => {
    const matchedPeriod = relation && ip.matched_last_seen
      ? `<time>у найденного аккаунта: ${formatAdminIpTime(ip.matched_first_seen)} → ${formatAdminIpTime(ip.matched_last_seen)}<br>у возможного твинка: ${formatAdminIpTime(ip.first_seen)} → ${formatAdminIpTime(ip.last_seen)}</time>`
      : `<time>первый: ${formatAdminIpTime(ip.first_seen)} · последний: ${formatAdminIpTime(ip.last_seen)}</time>`;
    return `<div class="admin-ip-row">
      <code class="admin-ip-address">${escHtml(ip.ip_address || '')}</code>
      <span class="admin-ip-count">${Number(ip.seen_count || 0)} запросов</span>
      ${matchedPeriod}
      ${adminCopyButton(ip.ip_address || '', 'IP')}
    </div>`;
  }).join('');
}

function renderAdminIpHead(account, twin = false) {
  const targetId = Number(account?.tg_id || 0);
  const name = account?.roblox_username || 'Без Roblox-ника';
  const confidence = String(account?.confidence || 'possible');
  const overlap = Number(account?.overlap_count || account?.shared_ips?.length || 0);
  const labels = { possible: 'возможная связь', medium: 'заметная связь', high: 'сильная связь' };
  return `<div class="${twin ? 'admin-ip-twin-head' : 'admin-ip-account-head'}">
    <div>
      <b>${escHtml(name)}</b>
      <small>TG ID: ${targetId}</small>
      ${twin ? `<span class="admin-ip-confidence ${escHtml(confidence)}">${escHtml(labels[confidence] || labels.possible)} · общих IP: ${overlap}</span>` : ''}
    </div>
    <div class="admin-ip-head-actions">
      ${adminCopyButton(targetId, 'TG ID')}
      ${name !== 'Без Roblox-ника' ? adminCopyButton(name, 'НИК') : ''}
      <button type="button" class="admin-ip-profile-btn" onclick="openPlayerModal(${targetId})">ПРОФИЛЬ</button>
    </div>
  </div>`;
}

async function adminIpLookup() {
  if (!_adminToken) return;

  const input = document.getElementById('admin-ip-search');
  const results = document.getElementById('admin-ip-results');
  const button = input?.closest('.admin-ip-search-row')?.querySelector('button');
  const query = String(input?.value || '').trim();
  if (!results || !query) {
    if (results) results.innerHTML = '<div class="admin-ip-empty error">Введи IP, tg_id или Roblox-ник.</div>';
    return;
  }

  if (button) button.disabled = true;
  results.innerHTML = '<div class="admin-ip-empty">Ищу связи...</div>';

  try {
    const response = await fetch(`${API}/api/admin/ip-lookup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': _adminToken,
      },
      body: JSON.stringify({ query }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`);

    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (!accounts.length) {
      results.innerHTML = '<div class="admin-ip-empty">За последние 30 дней совпадений нет.</div>';
      return;
    }

    const totals = data.totals || {};
    const summary = `<div class="admin-ip-summary">
      <div><small>НАЙДЕНО</small><b>${Number(totals.matched ?? accounts.length)}</b></div>
      <div><small>ВОЗМОЖНЫЕ ТВИНКИ</small><b>${Number(totals.related ?? 0)}</b></div>
      <div><small>IP В ЦЕПОЧКЕ</small><b>${Number(totals.shared_ips || 0)}</b></div>
    </div><div class="admin-ip-warning">Совпавший IP — важный сигнал для проверки, но не окончательное доказательство: адрес может быть общим у семьи, мобильной сети или VPN.</div>`;

    if (data.mode === 'ip') {
      results.innerHTML = summary + accounts.map(account => `<article class="admin-ip-account">
        ${renderAdminIpHead(account)}
        <div class="admin-ip-list">${renderAdminIpRows(account.ips)}</div>
      </article>`).join('');
      return;
    }

    const groups = Array.isArray(data.groups) && data.groups.length
      ? data.groups
      : accounts.map(account => ({ matched_account: account, twins: [] }));
    results.innerHTML = summary + groups.map(group => {
      const account = group.matched_account || {};
      const twins = Array.isArray(group.twins) ? group.twins : [];
      return `<article class="admin-ip-account">
        ${renderAdminIpHead(account)}
        <div class="admin-ip-list">${renderAdminIpRows(account.ips)}</div>
        <div class="admin-ip-twins">
          <div class="admin-ip-twins-title">ВОЗМОЖНЫЕ ТВИНКИ (${twins.length})</div>
          ${twins.length ? twins.map(twin => `<div class="admin-ip-twin">
            ${renderAdminIpHead(twin, true)}
            <div class="admin-ip-list">${renderAdminIpRows(twin.shared_ips, true)}</div>
          </div>`).join('') : '<div class="admin-ip-no-twins">Других аккаунтов на этих IP за 30 дней не найдено.</div>'}
        </div>
      </article>`;
    }).join('');
  } catch (error) {
    results.innerHTML = `<div class="admin-ip-empty error">Не удалось выполнить поиск: ${escHtml(error.message || 'ошибка')}</div>`;
  } finally {
    if (button) button.disabled = false;
  }
}

function formatReferralDateTime(value) {
  if (!value) return '—';
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${String(value).replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }) + ' МСК';
}

async function openPlayerModalLegacy(targetId) {
  if (!_adminToken) return;

  const modal   = document.getElementById('admin-player-modal');
  const content = document.getElementById('apm-content');
  const title   = document.getElementById('apm-title');
  
  modal.style.display = 'block';
  content.innerHTML   = '<div style="color:var(--text-dim);font-size:13px;padding:20px 0">Загрузка...</div>';
  title.textContent   = `Игрок #${targetId}`;

  try {
    const res  = await fetch(`${API}/api/admin/player`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: targetId })
    });
    
    const d = await res.json();
    if (d.error) { 
      content.innerHTML = `<div style="color:var(--red);padding:20px 0">Ошибка: ${escHtml(d.error)}</div>`; 
      return; 
    }

    const s    = d.stats        || {};
    const u    = d.user         || {};
    const hist = d.history      || [];
    const inv  = d.inventory    || [];
    const deps = d.deposits     || [];
    const wds  = d.withdrawals || [];
    const refs        = d.referral_count      ?? 0;
    const refsList    = d.referrals_list     || [];
    const refsIncome  = d.total_referral_income ?? 0;
    const referrer    = d.referrer_info      || null;

    const srcLabel = s => ({'shop':'🛒 Магазин','case':'📦 Кейс','trade':'🔄 Трейд'}[s] || s);

    content.innerHTML = ` 
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:10px">
        <div style="font-family:'Orbitron',sans-serif;font-size:15px;color:var(--accent);margin-bottom:6px">
          ${escHtml(u.roblox_username || '—')}
        </div>
        <div style="font-size:11px;color:var(--text-dim);line-height:1.8">
          tg_id: <b style="color:var(--text)">${u.tg_id || targetId}</b><br>
          Рефкод: <b style="color:var(--text)">${escHtml(u.referral_code || '—')}</b> · 
          Рефералов: <b style="color:var(--text)">${refs}</b><br>
          Регистрация: <b style="color:var(--text)">${escHtml(u.created_at || '—')}</b>
        </div>

        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:10px;color:var(--text-dim);letter-spacing:.08em;margin-bottom:6px">НИК ROBLOX</div>
          <div style="display:flex;gap:8px">
            <input id="apm-new-nick" type="text" value="${escHtml(u.roblox_username || '')}"
              style="flex:1;background:var(--surface2);border:1px solid var(--border);
                     border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px">
            <button onclick="apmSaveNick(${u.tg_id || targetId})"
              style="background:var(--accent);border:none;border-radius:8px;
                     padding:7px 14px;color:#000;font-family:'Orbitron',sans-serif;
                     font-size:11px;font-weight:900;cursor:pointer">СОХРАНИТЬ</button>
          </div>
        </div>

        <div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border)">
          <div style="font-size:10px;color:var(--text-dim);letter-spacing:.08em;margin-bottom:6px">БАЛАНС</div>
          <div style="font-family:'Orbitron',sans-serif;font-size:20px;color:var(--gold);margin-bottom:8px"
               id="apm-bal-display">${u.balance ?? 0} 🧠</div>
          <div style="display:flex;gap:8px">
            <input id="apm-new-bal" type="number" value="${u.balance ?? 0}"
              style="flex:1;background:var(--surface2);border:1px solid var(--border);
                     border-radius:8px;padding:7px 10px;color:var(--text);font-size:13px">
            <button onclick="apmSaveBalance(${u.tg_id || targetId})"
              style="background:var(--accent);border:none;border-radius:8px;
                     padding:7px 14px;color:#000;font-family:'Orbitron',sans-serif;
                     font-size:11px;font-weight:900;cursor:pointer">СОХРАНИТЬ</button>
          </div>
        </div>
      </div>

      ${playerBankControl(u.tg_id || targetId, u.special_mode, u.bank_exempt)}
      ${playerChatLaunch(u.tg_id || targetId)}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
        ${statBox('🎮 Игр',        s.total_games || 0,          'var(--text)')}
        ${statBox('🎯 Win rate',  `${s.win_rate || 0}%`,       'var(--accent)')}
        ${statBox('🏆 Выиграно',  `+${Math.floor(s.total_won  || 0)} 🧠`, 'var(--green)')}
        ${statBox('💀 Проиграно', `-${Math.floor(s.total_lost || 0)} 🧠`, 'var(--red)')}
        ${statBox('📈 Нетто',
          `${(s.net_profit||0)>=0?'+':''}${Math.floor(s.net_profit||0)} 🧠`,
          (s.net_profit||0)>=0?'var(--green)':'var(--red)')}
        ${statBox('💰 Баланс',    `${Math.floor(u.balance||0)} 🧠`, 'var(--gold)')}
      </div>

      ${section('🎒 ИНВЕНТАРЬ', inv.length,
        inv.length
          ? inv.map(i => `
            <div style="display:flex;justify-content:space-between;align-items:center;
                        padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
              <span>${escHtml(i.emoji||'🧠')} ${escHtml(i.item_name || 'Предмет')}
                <span style="color:var(--text-dim);font-size:10px;margin-left:6px">${escHtml(srcLabel(i.source))}</span>
                ${i.frozen?'<span style="color:var(--accent);font-size:10px;margin-left:4px">🔒</span>':''}
              </span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:var(--text-dim);font-size:10px">${escHtml(i.rarity||'')}</span>
                ${!i.frozen ? `<button onclick="apmDeleteItem(${i.id}, ${u.tg_id || targetId})"
                  style="background:rgba(255,50,50,.15);border:1px solid var(--red);border-radius:6px;
                         padding:2px 8px;color:var(--red);font-size:10px;cursor:pointer">✕</button>` : ''}
              </div>
            </div>`).join('')
          : '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Пусто</div>'
      )}

      ${section('💳 ПОПОЛНЕНИЯ', deps.length,
        deps.length
          ? deps.map(dep => `
            <div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
              <div style="display:flex;justify-content:space-between">
                <span style="color:var(--text)">${escHtml(dep.items_text||'—')}</span>
                <span style="color:var(--green)">+${dep.total_cost || 0} 🧠</span>
              </div>
              <div style="color:var(--text-dim);font-size:10px;margin-top:2px">${escHtml(dep.created_at||'—')}</div>
            </div>`).join('')
          : '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет пополнений</div>'
      )}

      ${section('📤 ВЫВОДЫ', wds.length,
        wds.length
          ? wds.map(w => `
            <div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="color:var(--text)">${escHtml(w.item_names||'—')}</span>
                <div style="display:flex;align-items:center;gap:8px">
                  <span style="font-size:10px;padding:2px 6px;border-radius:4px;
                    background:${w.status==='done'?'rgba(0,200,100,.2)':w.status==='pending'?'rgba(255,200,0,.2)':'var(--surface2)'};
                    color:${w.status==='done'?'var(--green)':w.status==='pending'?'var(--gold)':'var(--text-dim)'}">
                    ${escHtml(w.status || 'unknown')}</span>
                  ${(w.status==='pending'||w.status==='notified') ? `<button onclick="apmCancelWithdraw(${w.id}, ${u.tg_id || targetId})"
                    style="background:rgba(255,50,50,.15);border:1px solid var(--red);border-radius:6px;
                           padding:2px 8px;color:var(--red);font-size:10px;cursor:pointer">✕ отмена</button>` : ''}
                </div>
              </div>
              <div style="color:var(--text-dim);font-size:10px;margin-top:2px">
                ${escHtml(w.slot_date||'')} ${escHtml(w.slot_start||'')}–${escHtml(w.slot_end||'')} МСК
              </div>
            </div>`).join('')
          : '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет выводов</div>'
      )}

      ${(function(){
        let html = '';
        // Реферер
        if (referrer) {
          html += '<div style="font-size:12px;color:var(--text-dim);line-height:1.7;margin-bottom:8px">Чей реферал: <b style=\"color:var(--text)\">tg: ' + escHtml(referrer.tg_id) + '</b>' + (referrer.roblox_username ? ' · ' + escHtml(referrer.roblox_username) : '') + '<br>Дата привязки: <b style=\"color:var(--accent)\">' + escHtml(formatReferralDateTime(referrer.joined_at)) + '</b></div>';
        } else {
          html += '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Без реферера</div>';
        }
        // Сводка
        html += '<div style="display:flex;justify-content:space-between;padding:8px;background:var(--surface2);border-radius:8px;margin-bottom:8px">';
        html += '<span style="font-size:12px;color:var(--text-dim)">Рефералов: <b style=\"color:var(--text)\">' + refs + '</b></span>';
        html += '<span style="font-size:12px;color:var(--green);font-family:\'Orbitron\',sans-serif">Доход: +' + refsIncome + ' 🧠</span>';
        html += '</div>';
        // Список
        if (refsList.length) {
          refsList.forEach(function(r) {
            html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">';
            html += '<div><span style="color:var(--text);font-size:12px">tg: ' + escHtml(r.tg_id) + '</span><span style="color:var(--text-dim);font-size:10px;margin-left:6px">' + escHtml(formatReferralDateTime(r.joined_at)) + '</span></div>';
            html += '<div style="text-align:right"><div style="font-size:11px;color:var(--text-dim)">пополнено: ' + r.total_deposited + ' 🧠</div><div style="font-size:12px;color:var(--green)">+' + r.referral_income + ' 🧠</div></div>';
            html += '</div>';
          });
        } else {
          html += '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет рефералов</div>';
        }
        return section('👥 РЕФЕРАЛЫ', refs, html);
      })()}

      ${section('📊 ИСТОРИЯ ИГР', hist.length,
        hist.length
          ? hist.map(g => {
              const isWin = (g.profit || 0) > 0;
              
              // БЕЗОПАСНЫЙ ПАРСИНГ ДАТЫ (работает и со строкой, и с timestamp)
              let dt;
              if (g.created_at && !isNaN(g.created_at)) {
                dt = new Date(g.created_at * 1000);
              } else if (typeof g.created_at === 'string') {
                dt = new Date(g.created_at.replace(' ', 'T')); // Замена для совместимости с Safari
              } else {
                dt = new Date();
              }

              // Защита от Invalid Date перед вызовом методов локали
              const time = !isNaN(dt.getTime()) ? dt.toLocaleTimeString('ru',{hour:'2-digit',minute:'2-digit'}) : '—';
              const date = !isNaN(dt.getTime()) ? dt.toLocaleDateString('ru',{day:'2-digit',month:'2-digit'}) : '—';

              return `
                <div style="display:flex;justify-content:space-between;align-items:center;
                            padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">
                  <div>
                    <span style="color:var(--text)">${escHtml(g.game_type || 'Игра')}</span>
                    <span style="color:var(--text-dim);font-size:10px;margin-left:6px">${date} ${time}</span>
                    <span style="color:var(--text-dim);font-size:10px;margin-left:6px">ставка ${Math.floor(g.bet || 0)}</span>
                  </div>
                  <span style="color:${isWin?'var(--green)':'var(--red)'};font-family:'Orbitron',sans-serif;font-size:11px">
                    ${isWin?'+':''}${Math.floor(g.profit || 0)} 🧠
                  </span>
                </div>`;
            }).join('')
          : '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет игр</div>'
      )}

      <div style="height:24px"></div>
    `;
  } catch (e) {
    console.error("Критическая ошибка отрисовки модалки:", e);
    content.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px 0">Ошибка отрисовки шаблона. Проверь консоль браузера (F12)!</div>`;
  }
}

// ─── Хелпер: Секция с заголовком и счётчиком ────────────────────────────
function section(title, count, innerHtml) {
  return `
    <div style="background:var(--surface);border:1px solid var(--border);
                border-radius:14px;padding:12px 14px;margin-bottom:10px">
      <div style="font-family:'Orbitron',sans-serif;font-size:10px;color:var(--text-dim);
                  margin-bottom:8px;letter-spacing:.08em">
        ${title} <span style="color:var(--text-dim);font-weight:400">(${count})</span>
      </div>
      ${innerHtml}
    </div>`;
}

function enhanceProfileLayout(root) {
  if (!root) return;

  const makeCollapsible = (container, handle, extraClass = '') => {
    if (!container || !handle) return;
    container.classList.add('profile-collapsible', 'is-collapsed');
    if (extraClass) container.classList.add(extraClass);
    handle.classList.add('profile-collapsible-handle');
    handle.setAttribute('role', 'button');
    handle.setAttribute('tabindex', '0');
    handle.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const collapsed = container.classList.toggle('is-collapsed');
      handle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    handle.addEventListener('click', toggle);
    handle.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggle();
    });
  };

  const levelPanel = root.querySelector('.profile-level-panel');
  const hero = root.querySelector('.self-profile-hero');
  if (levelPanel && hero) levelPanel.before(hero);

  const achievements = root.querySelector('.profile-achievements');
  if (achievements) {
    achievements.classList.remove('profile-collapsible', 'is-collapsed');
    achievements.querySelector(':scope > header')?.setAttribute('aria-expanded', 'true');
  }

  const editor = root.querySelector('.profile-editor');
  if (editor) {
    editor.addEventListener('input', updateProfilePreview);
    editor.addEventListener('change', updateProfilePreview);
    updateProfilePreview();
  }

  let activityAssigned = false;
  root.querySelectorAll(':scope > div').forEach(card => {
    if (card.classList.contains('profile-collapsible')) return;
    const heading = card.firstElementChild;
    if (!heading || !heading.querySelector('span') || !String(card.getAttribute('style') || '').includes('border-radius:14px')) return;
    makeCollapsible(card, heading, 'profile-data-card');
    if (!activityAssigned) {
      card.id = 'profile-activity';
      activityAssigned = true;
    }
  });
}

// ─── Хелпер: Маленькая карточка статистики ───────────────────────────
function statBox(title, value, color) {
  return `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px 10px">
      <div style="font-size:10px;color:var(--text-dim);margin-bottom:3px;letter-spacing:.05em">${title}</div>
      <div style="font-family:'Orbitron',sans-serif;font-size:13px;font-weight:700;color:${color}">${value}</div>
    </div>`;
}

// ════════════════════════════════════════════════════════════════
// ЦЕНТР УПРАВЛЕНИЯ ИГРОКОМ
// ════════════════════════════════════════════════════════════════
let _adminPlayerTargetId = null;

function apmNum(value) {
  return Math.floor(Number(value || 0)).toLocaleString('ru-RU');
}

function apmDate(value, withTime = true) {
  if (!value) return '—';
  let date;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value);
    date = new Date(number > 1e12 ? number : number * 1000);
  } else {
    const text = String(value);
    date = new Date(/Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  });
}

function apmGameName(value) {
  const key = String(value || '').toLowerCase();
  return ({
    coin: 'Монетка', slots: 'DICE', brain_slots: 'Слоты', dice: 'DICE', resonance: 'РотДек', mines: 'Мины', case: 'Кейсы',
    cases: 'Кейсы', upgrader: 'Апгрейдер', upgrade: 'Апгрейдер', craft: 'Крафты',
    rocket: 'Ракетка', wheel: 'Колесо', roulette: 'Колесо', duel_1v1: 'Дуэли',
    ffa_queue: 'FFA', multi_roulette: 'Мульти-рулетка', freeslots: 'Призма',
  })[key] || value || 'Игра';
}

function apmKpi(label, value, tone = '', note = '') {
  return `<article class="apm-kpi ${tone}"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</article>`;
}

function apmEmpty(text) {
  return `<div class="apm-empty">${escHtml(text)}</div>`;
}

function apmSetTab(tab, trigger = null) {
  const root = document.getElementById('apm-content');
  if (!root) return;
  const safeTab = root.querySelector(`[data-apm-panel="${tab}"]`) ? tab : 'overview';
  root.dataset.activeTab = safeTab;
  root.querySelectorAll('[data-apm-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.apmTab === safeTab);
  });
  root.querySelectorAll('[data-apm-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.apmPanel === safeTab);
  });
  if (trigger) trigger.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  document.querySelector('.admin-player-dialog')?.scrollTo({ top: 0, behavior: 'smooth' });
}

function apmCopyValue(value, label = 'Значение') {
  const text = String(value ?? '');
  const done = () => showToast(`${label} скопировано`, 'win');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => apmCopyFallback(text, done));
  } else {
    apmCopyFallback(text, done);
  }
}

function apmCopyFallback(text, done) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;left:8px;bottom:8px;width:2px;height:2px;opacity:.01;font-size:16px;z-index:99999';
  document.body.appendChild(area);
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, area.value.length);
  try {
    if (document.execCommand('copy')) done();
    else showToast('Зажми текст и выбери «Скопировать»', 'lose');
  } catch (_) { showToast('Зажми текст и выбери «Скопировать»', 'lose'); }
  area.remove();
}

function apmBalanceStep(delta) {
  const input = document.getElementById('apm-new-bal');
  if (!input) return;
  input.value = String(Math.max(0, Math.floor(Number(input.value || 0) + Number(delta || 0))));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function apmFilterGames(value) {
  const filter = String(value || 'all');
  document.querySelectorAll('#apm-games-history [data-game]').forEach(row => {
    row.hidden = filter !== 'all' && row.dataset.game !== filter;
  });
}

function apmFilterInventory(value) {
  const query = String(value || '').trim().toLowerCase();
  document.querySelectorAll('#apm-inventory-list [data-item-name]').forEach(row => {
    row.hidden = query && !row.dataset.itemName.includes(query);
  });
}

function apmFilterUpgraderInventory(value) {
  const query = String(value || '').trim().toLowerCase();
  document.querySelectorAll('#apm-upgrader-inventory-list [data-item-name]').forEach(row => {
    row.hidden = query && !row.dataset.itemName.includes(query);
  });
}

async function apmRefresh() {
  if (!_adminPlayerTargetId) return;
  const activeTab = document.getElementById('apm-content')?.dataset?.activeTab || 'overview';
  await openPlayerModal(_adminPlayerTargetId, activeTab);
}

async function openPlayerModal(targetId, preferredTab = 'overview') {
  if (!_adminToken) return;
  targetId = Number(targetId);
  if (!Number.isFinite(targetId) || targetId <= 0) return;
  _adminPlayerTargetId = targetId;

  const modal = document.getElementById('admin-player-modal');
  const content = document.getElementById('apm-content');
  const title = document.getElementById('apm-title');
  if (!modal || !content || !title) return;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('admin-player-modal-open');
  title.textContent = `Игрок #${targetId}`;
  content.innerHTML = '<div class="apm-loading"><i></i><span>Собираем данные игрока</span></div>';

  try {
    const res = await fetch(`${API}/api/admin/player`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: targetId })
    });
    const d = await res.json();
    if (!res.ok || d.error) throw new Error(d.error || `HTTP ${res.status}`);

    const u = d.user || {};
    const s = d.stats || {};
    const ban = d.ban || {};
    const activity = d.activity || {};
    const wager = d.wager || {};
    const progress = d.progression || {};
    const depSummary = d.deposit_summary || {};
    const wdSummary = d.withdrawal_summary || {};
    const invSummary = d.inventory_summary || {};
    const upgraderInvSummary = d.upgrader_inventory_summary || {};
    const deposits = d.deposits || [];
    const withdrawals = d.withdrawals || [];
    const inventory = d.inventory || [];
    const upgraderInventory = d.upgrader_inventory || [];
    const upgraderTransactions = d.upgrader_transactions || [];
    const upgraderCatalog = d.upgrader_catalog || [];
    const history = d.history || [];
    const gameBreakdown = d.game_breakdown || [];
    const transactions = d.transactions || [];
    const refsList = d.referrals_list || [];
    const refs = Number(d.referral_count || 0);
    const refsIncome = Number(d.total_referral_income || 0);
    const referrer = d.referrer_info || null;
    const banHistory = d.ban_history || [];
    const adminActions = d.admin_actions || [];
    const usernameHistory = d.username_history || [];
    const telegramIdentity = d.telegram_identity || {};
    const telegramUsernameHistory = d.telegram_username_history || [];
    const playerId = Number(u.tg_id || targetId);
    const playerName = String(u.roblox_username || `user${playerId}`);
    const online = Boolean(activity.online);
    const net = Number(s.net_profit || 0);
    const wagerRequired = Number(wager.required || 0);
    const wagerDone = Number(wager.done || 0);
    const wagerPercent = wagerRequired ? Math.min(100, wagerDone / wagerRequired * 100) : 100;
    const specialMode = Number(u.special_mode ?? (u.bank_exempt ? 1 : 0));
    const gameTypes = [...new Set(history.map(item => String(item.game_type || 'unknown')))];
    const sourceLabels = { shop: 'Магазин', case: 'Кейс', trade: 'Трейд', admin_abuse: 'Admin Abuse' };

    title.textContent = playerName;

    const depositRows = deposits.length ? deposits.map(item => `
      <article class="apm-list-row">
        <div><strong>${escHtml(item.items_text || `Пополнение #${item.id}`)}</strong><small>${apmDate(item.created_at)}</small></div>
        <div class="apm-row-value positive">+${apmNum(item.credited_total ?? item.total_cost)} 🧠${Number(item.deposit_bonus || 0) ? `<small>бонус +${apmNum(item.deposit_bonus)}</small>` : ''}</div>
      </article>`).join('') : apmEmpty('Пополнений пока нет');

    const withdrawalRows = withdrawals.length ? withdrawals.map(item => {
      const active = ['pending', 'notified'].includes(item.status);
      return `<article class="apm-list-row">
        <div><strong>${escHtml(item.item_names || `Вывод #${item.id}`)}</strong><small>${escHtml(`${item.slot_date || ''} ${item.slot_start || ''}–${item.slot_end || ''}`.trim())} МСК</small></div>
        <div class="apm-row-actions"><span class="apm-state state-${escHtml(item.status || 'unknown')}">${escHtml(item.status || 'unknown')}</span>${active ? `<button class="danger ghost" onclick="apmCancelWithdraw(${Number(item.id)}, ${playerId})">ОТМЕНИТЬ</button>` : ''}</div>
      </article>`;
    }).join('') : apmEmpty('Заявок на вывод нет');

    const transactionRows = transactions.length ? transactions.map(item => {
      const amount = Number(item.amount || 0);
      return `<article class="apm-list-row compact">
        <div><strong>${escHtml(item.item_name || item.action || 'Операция')}</strong><small>${escHtml(item.action || '—')} · ${apmDate(item.created_at)}</small></div>
        <div class="apm-row-value ${amount >= 0 ? 'positive' : 'negative'}">${amount > 0 ? '+' : ''}${apmNum(amount)} 🧠</div>
      </article>`;
    }).join('') : apmEmpty('Операций магазина нет');

    const gameSummaryRows = gameBreakdown.length ? gameBreakdown.map(item => {
      const games = Number(item.games || 0);
      const wins = Number(item.wins || 0);
      const profit = Number(item.net_profit || 0);
      return `<article class="apm-game-summary">
        <div><strong>${escHtml(apmGameName(item.game_type))}</strong><small>${games} игр · ${games ? (wins / games * 100).toFixed(1) : 0}% побед</small></div>
        <div><span>${apmNum(item.total_bet)} 🧠 оборот</span><b class="${profit >= 0 ? 'positive' : 'negative'}">${profit > 0 ? '+' : ''}${apmNum(profit)} 🧠</b></div>
      </article>`;
    }).join('') : apmEmpty('Нет данных по играм');

    const historyRows = history.length ? history.map(item => {
      const profit = Number(item.profit || 0);
      const gameKey = String(item.game_type || 'unknown');
      const chance = item.chance == null ? null : Number(item.chance);
      const effectiveChance = item.effective_chance == null ? null : Number(item.effective_chance);
      const multiplier = item.multiplier == null ? null : Number(item.multiplier);
      const meta = item.meta && typeof item.meta === 'object' ? item.meta : {};
      const chanceText = Number.isFinite(chance) ? `${chance.toFixed(chance < 1 ? 3 : 2).replace(/\.?0+$/, '')}%` : null;
      const effectiveText = Number.isFinite(effectiveChance) ? `${effectiveChance.toFixed(effectiveChance < 1 ? 3 : 2).replace(/\.?0+$/, '')}%` : null;
      const detailTags = [];
      if (chanceText) detailTags.push(`шанс ${chanceText}`);
      if (effectiveText && (!Number.isFinite(chance) || Math.abs(effectiveChance - chance) > 0.0001)) detailTags.push(`факт ${effectiveText}`);
      if (Number.isFinite(multiplier) && multiplier > 0) detailTags.push(`x${multiplier.toFixed(multiplier < 10 ? 2 : 1).replace(/\.?0+$/, '')}`);
      if (meta.target_name || meta.item_name) detailTags.push(String(meta.target_name || meta.item_name));
      if (meta.chosen) detailTags.push(`выбор ${String(meta.chosen)}`);
      if (meta.mine_count != null) detailTags.push(`мин ${Number(meta.mine_count)}`);
      if (meta.bank_guarded) detailTags.push('ограничено банком');
      return `<article class="apm-list-row compact" data-game="${escHtml(gameKey)}">
        <div><strong>${escHtml(apmGameName(gameKey))}</strong><small>${apmDate(item.created_at)} · ставка ${apmNum(item.bet)} 🧠</small>${detailTags.length ? `<div class="apm-history-tags">${detailTags.map(tag => `<span>${escHtml(tag)}</span>`).join('')}</div>` : '<div class="apm-history-tags legacy"><span>шанс —</span></div>'}</div>
        <div class="apm-row-value ${profit > 0 ? 'positive' : profit < 0 ? 'negative' : ''}">${profit > 0 ? '+' : ''}${apmNum(profit)} 🧠</div>
      </article>`;
    }).join('') : apmEmpty('История игр пуста');

    const inventoryRows = inventory.length ? inventory.map(item => `
      <article class="apm-list-row" data-item-name="${escHtml(String(item.item_name || '').toLowerCase())}">
        <div class="apm-item-name"><i>${escHtml(item.emoji || '🧠')}</i><span><strong>${escHtml(item.item_name || 'Предмет')}</strong><small>${escHtml(sourceLabels[item.source] || item.source || '—')} · ${escHtml(item.rarity || '—')}${item.frozen ? ' · заморожен' : ''}</small></span></div>
        <div class="apm-row-actions"><b>${apmNum(item.value)} 🧠</b>${!item.frozen ? `<button class="danger icon" onclick="apmDeleteItem(${Number(item.id)}, ${playerId})" aria-label="Удалить предмет">✕</button>` : '<span class="apm-lock">LOCK</span>'}</div>
      </article>`).join('') : apmEmpty('Инвентарь пуст');

    const upgraderInventoryRows = upgraderInventory.length ? upgraderInventory.map(item => `
      <article class="apm-list-row" data-item-name="${escHtml(String(item.item_name || '').toLowerCase())}">
        <div class="apm-item-name"><i>🎮</i><span><strong>${escHtml(item.item_name || 'Предмет')}</strong><small>${escHtml(item.rarity || 'common')} · ID ${Number(item.id)} · получен ${apmDate(item.created_at)}</small></span></div>
        <div class="apm-row-actions"><b>${apmNum(item.value)} 🧠</b><button class="credit" onclick="apmManageUpgraderItem(${Number(item.id)}, ${playerId}, 'sell', '${escHtml(String(item.item_name || '').replace(/'/g, "\\'"))}', ${Number(item.value || 0)})">ПРОДАТЬ</button><button class="danger icon" onclick="apmManageUpgraderItem(${Number(item.id)}, ${playerId}, 'delete', '${escHtml(String(item.item_name || '').replace(/'/g, "\\'"))}', ${Number(item.value || 0)})" aria-label="Удалить игровой предмет без компенсации">✕</button></div>
      </article>`).join('') : apmEmpty('Игровой инвентарь пуст');

    const upgraderActionLabels = {
      buy: 'ПОКУПКА', sell: 'ПРОДАЖА', upgrade_win: 'АПГРЕЙД', upgrade_loss: 'СГОРЕЛО',
      craft_win: 'КРАФТ', craft_loss: 'КРАФТ НЕ УДАЛСЯ', admin_grant: 'ВЫДАНО АДМИНОМ',
      admin_sell: 'ПРОДАНО АДМИНОМ', admin_delete: 'УДАЛЕНО АДМИНОМ'
    };
    const upgraderTransactionRows = upgraderTransactions.length ? upgraderTransactions.map(item => {
      const amount = Number(item.amount || 0);
      return `<article class="apm-list-row compact"><div><strong>${escHtml(upgraderActionLabels[item.action] || String(item.action || 'ОПЕРАЦИЯ').toUpperCase())}</strong><small>${escHtml(item.item_name || '—')} · ${apmDate(item.created_at)}</small></div><div class="apm-row-value ${amount > 0 ? 'positive' : amount < 0 ? 'negative' : ''}">${amount > 0 ? '+' : ''}${apmNum(amount)} 🧠</div></article>`;
    }).join('') : apmEmpty('Операций с игровыми предметами пока нет');

    const upgraderCatalogOptions = upgraderCatalog.map(item =>
      `<option value="${escHtml(item.item_name || '')}">${apmNum(item.value)} 🧠 · ${escHtml(item.rarity || 'common')}</option>`
    ).join('');
    const totalInventoryCount = Number(invSummary.count || 0) + Number(upgraderInvSummary.count || 0);
    const totalInventoryValue = Number(invSummary.value || 0) + Number(upgraderInvSummary.value || 0);

    const referralRows = refsList.length ? refsList.map(item => `
      <article class="apm-list-row">
        <div><strong>tg: ${escHtml(item.tg_id)}</strong><small>${apmDate(item.joined_at)}</small></div>
        <div class="apm-row-value positive">+${apmNum(item.referral_income)} 🧠<small>пополнил ${apmNum(item.total_deposited)}</small></div>
      </article>`).join('') : apmEmpty('Рефералов пока нет');

    const banRows = banHistory.length ? banHistory.map(item => `
      <article class="apm-list-row compact">
        <div><strong>${escHtml(String(item.action || '').toUpperCase())}</strong><small>${escHtml(item.reason || 'Без причины')} · админ ${escHtml(item.admin_tg_id || 'system')}</small></div>
        <div class="apm-row-value"><small>${apmDate(item.created_at)}</small>${Number(item.ban_until || 0) ? `<small>до ${apmDate(item.ban_until)}</small>` : ''}</div>
      </article>`).join('') : apmEmpty('Истории блокировок нет');

    const adminActionRows = adminActions.length ? adminActions.map(item => {
      const details = item.details && typeof item.details === 'object' ? item.details : {};
      const detailText = Object.entries(details).slice(0, 4).map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
      return `<article class="apm-list-row compact">
        <div><strong>${escHtml(String(item.action || 'action').toUpperCase())} <span class="apm-audit-seal ${item.verified ? 'valid' : 'invalid'}">${item.verified ? 'ПОДПИСЬ OK' : 'НЕ ПРОВЕРЕНО'}</span></strong><small>админ ${escHtml(item.admin_tg_id || 'system')}${detailText ? ` · ${escHtml(detailText)}` : ''}</small></div>
        <div class="apm-row-value"><small>${apmDate(item.created_at)}</small></div>
      </article>`;
    }).join('') : apmEmpty('Административных изменений пока нет');

    const usernameSourceLabels = {
      account_created: 'создание аккаунта', player_change: 'смена игроком',
      admin_change: 'смена администратором', mixed_script_reset: 'автоматический сброс',
      database_sync: 'синхронизация базы', legacy_import: 'импорт старого имени',
      bot_message: 'сообщение боту', bot_callback: 'кнопка бота', mini_app_init: 'вход в Mini App',
    };
    const usernameHistoryRows = usernameHistory.length ? usernameHistory.map(item => `
      <article class="apm-list-row compact">
        <div><strong>${escHtml(item.username || '—')}${item.is_current ? ' <span class="apm-badge online">ТЕКУЩИЙ</span>' : ''}</strong><small>${escHtml(usernameSourceLabels[item.change_source] || item.change_source || 'система')}</small></div>
        <div class="apm-row-value"><small>${apmDate(item.valid_from)}${item.valid_to ? ` — ${apmDate(item.valid_to)}` : ' — сейчас'}</small><button onclick="apmCopyValue('${escHtml(String(item.username || '').replace(/'/g, "\\'"))}', 'username')">КОПИРОВАТЬ</button></div>
      </article>`).join('') : apmEmpty('История имён пока пуста');
    const telegramHistoryRows = telegramUsernameHistory.length ? telegramUsernameHistory.map(item => `
      <article class="apm-list-row compact">
        <div><strong>@${escHtml(item.username || '—')}${item.is_current ? ' <span class="apm-badge online">ТЕКУЩИЙ</span>' : ''}</strong><small>${escHtml(usernameSourceLabels[item.change_source] || item.change_source || 'Telegram')}</small></div>
        <div class="apm-row-value"><small>${apmDate(item.valid_from)}${item.valid_to ? ` — ${apmDate(item.valid_to)}` : ' — сейчас'}</small><button onclick="apmCopyValue('@${escHtml(item.username || '')}', 'Telegram username')">КОПИРОВАТЬ</button></div>
      </article>`).join('') : apmEmpty('Telegram @username ещё не зафиксирован');

    content.innerHTML = `
      <section class="apm-hero ${ban.banned ? 'is-banned' : ''}">
        <div class="apm-avatar">${escHtml(playerName.slice(0, 1).toUpperCase())}<i class="${online ? 'online' : ''}"></i></div>
        <div class="apm-identity">
          <div class="apm-name-line"><h2 id="apm-player-name">${escHtml(playerName)}</h2>${ban.banned ? '<span class="apm-badge danger">ЗАБЛОКИРОВАН</span>' : `<span class="apm-badge ${online ? 'online' : ''}">${online ? 'В СЕТИ' : 'ОФЛАЙН'}</span>`}</div>
          <button class="apm-copy-id" onclick="apmCopyValue('${playerId}', 'tg_id')">tg_id: ${playerId} <span>КОПИРОВАТЬ</span></button>
          <small>Регистрация ${apmDate(u.created_at)} · режим ${specialModeLabel(specialMode)}</small>
        </div>
        <div class="apm-hero-actions">
          <button onclick="openPlayerChat(${playerId})">ЧАТ</button>
          <button onclick="apmSetTab('security')">КОНТРОЛЬ</button>
        </div>
      </section>

      <section class="apm-kpi-grid">
        ${apmKpi('БАЛАНС', `<span id="apm-kpi-balance">${apmNum(u.balance)}</span> 🧠`, 'gold')}
        ${apmKpi('ПОПОЛНЕНО', `${apmNum(depSummary.total)} 🧠`, 'green', `${depSummary.count || 0} операций`)}
        ${apmKpi('ОБОРОТ', `${apmNum(s.total_bet)} 🧠`, '', `${s.total_games || 0} игр`)}
        ${apmKpi('НЕТТО ИГРОКА', `${net > 0 ? '+' : ''}${apmNum(net)} 🧠`, net >= 0 ? 'green' : 'red', `${s.win_rate || 0}% побед`)}
        ${apmKpi('ИНВЕНТАРЬ', `${apmNum(totalInventoryValue)} 🧠`, '', `${totalInventoryCount} предметов в двух разделах`)}
        ${apmKpi('УРОВЕНЬ', `${progress.level || 1} · ${escHtml(progress.level_title || 'Новичок')}`, 'accent', `${apmNum(progress.to_next_level)} до следующего`)}
      </section>

      <nav class="apm-tabs" aria-label="Разделы карточки">
        <button data-apm-tab="overview" onclick="apmSetTab('overview',this)">ОБЗОР</button>
        <button data-apm-tab="finance" onclick="apmSetTab('finance',this)">ФИНАНСЫ <i>${depSummary.count || 0}</i></button>
        <button data-apm-tab="games" onclick="apmSetTab('games',this)">ИГРЫ <i>${s.total_games || 0}</i></button>
        <button data-apm-tab="assets" onclick="apmSetTab('assets',this)">ПРЕДМЕТЫ <i>${totalInventoryCount}</i></button>
        <button data-apm-tab="referrals" onclick="apmSetTab('referrals',this)">РЕФЕРАЛЫ <i>${refs}</i></button>
        <button data-apm-tab="security" onclick="apmSetTab('security',this)">КОНТРОЛЬ</button>
      </nav>

      <div class="apm-panels">
        <section class="apm-panel" data-apm-panel="overview">
          <div class="apm-two-columns">
            <article class="apm-card">
              <header><div><small>БЫСТРАЯ ОПЕРАЦИЯ</small><h3>Баланс</h3></div><strong id="apm-bal-display">${apmNum(u.balance)} 🧠</strong></header>
              <div class="apm-balance-steps"><button onclick="apmBalanceStep(-1000)">−1 000</button><button onclick="apmBalanceStep(-100)">−100</button><button onclick="apmBalanceStep(100)">+100</button><button onclick="apmBalanceStep(1000)">+1 000</button></div>
              <div class="apm-form-row"><input id="apm-new-bal" type="number" min="0" value="${Math.floor(Number(u.balance || 0))}"><button class="primary" onclick="apmSaveBalance(${playerId})">СОХРАНИТЬ</button></div>
            </article>
            <article class="apm-card">
              <header><div><small>ДАННЫЕ АККАУНТА</small><h3>Roblox-ник</h3></div></header>
              <div class="apm-form-row"><input id="apm-new-nick" maxlength="20" value="${escHtml(playerName)}"><button class="primary" onclick="apmSaveNick(${playerId})">СОХРАНИТЬ</button></div>
              <div class="apm-detail-grid"><span><small>РЕФКОД</small><button onclick="apmCopyValue('${escHtml(u.referral_code || '')}', 'Рефкод')">${escHtml(u.referral_code || '—')}</button></span><span><small>ПОСЛЕДНЯЯ АКТИВНОСТЬ</small><b>${online ? 'Сейчас в сети' : apmDate(activity.last_seen)}</b></span></div>
            </article>
          </div>
          <article class="apm-card apm-feed"><header><div><small>ТЕКУЩЕЕ И ПРОШЛЫЕ</small><h3>История username</h3></div><b>${usernameHistory.length}</b></header>${usernameHistoryRows}</article>
          <article class="apm-card apm-feed"><header><div><small>ДАННЫЕ ИЗ TELEGRAM</small><h3>История @username</h3></div><b>${telegramIdentity.current_username ? `@${escHtml(telegramIdentity.current_username)}` : 'НЕТ ТЕКУЩЕГО'}</b></header>${telegramHistoryRows}</article>
          <div class="apm-two-columns">
            <article class="apm-card apm-wager-card">
              <header><div><small>ОГРАНИЧЕНИЕ ВЫВОДА</small><h3>Отыгрыш</h3></div><strong>${wager.unlocked ? 'ВЫПОЛНЕН' : `${apmNum(wager.remaining)} 🧠`}</strong></header>
              <div class="apm-progress"><i style="width:${wagerPercent.toFixed(1)}%"></i></div>
              <div class="apm-progress-meta"><span>${apmNum(wagerDone)} / ${apmNum(wagerRequired)} 🧠</span><b>${wagerPercent.toFixed(0)}%</b></div>
            </article>
            <div class="apm-control-stack">${playerBankControl(playerId, specialMode, u.bank_exempt)}${playerChatLaunch(playerId)}</div>
          </div>
        </section>

        <section class="apm-panel" data-apm-panel="finance">
          <div class="apm-summary-strip">
            ${apmKpi('ЗАЧИСЛЕНО', `${apmNum(depSummary.credited_total)} 🧠`, 'green')}
            ${apmKpi('БОНУСАМИ', `${apmNum(depSummary.bonus_total)} 🧠`, 'accent')}
            ${apmKpi('ВЫВОДОВ', `${wdSummary.completed || 0} / ${wdSummary.count || 0}`, '', `${wdSummary.active || 0} активных`)}
            ${apmKpi('ЗАМОРОЖЕНО', `${apmNum(invSummary.frozen_value)} 🧠`, 'red', `${invSummary.frozen_count || 0} предметов`)}
          </div>
          <article class="apm-card apm-feed"><header><div><small>ПОСЛЕДНИЕ 20</small><h3>Пополнения</h3></div><b>${apmNum(depSummary.total)} 🧠 всего</b></header>${depositRows}</article>
          <article class="apm-card apm-feed"><header><div><small>ОЧЕРЕДЬ И ИСТОРИЯ</small><h3>Выводы</h3></div><b>${wdSummary.active || 0} активных</b></header>${withdrawalRows}</article>
          <article class="apm-card apm-feed"><header><div><small>МАГАЗИН И ПРЕДМЕТЫ</small><h3>Операции</h3></div></header>${transactionRows}</article>
        </section>

        <section class="apm-panel" data-apm-panel="games">
          <div class="apm-summary-strip">
            ${apmKpi('ИГР', apmNum(s.total_games))}${apmKpi('ПОБЕД', apmNum(s.wins), 'green')}${apmKpi('ПРОИГРЫШЕЙ', apmNum(s.losses), 'red')}${apmKpi('WIN RATE', `${s.win_rate || 0}%`, 'accent')}
          </div>
          <article class="apm-card"><header><div><small>ЗА ВСЁ ВРЕМЯ</small><h3>По режимам</h3></div></header><div class="apm-game-breakdown">${gameSummaryRows}</div></article>
          <article class="apm-card apm-feed"><header><div><small>ПОСЛЕДНИЕ ${history.length}</small><h3>История игр</h3></div><select onchange="apmFilterGames(this.value)"><option value="all">Все режимы</option>${gameTypes.map(type => `<option value="${escHtml(type)}">${escHtml(apmGameName(type))}</option>`).join('')}</select></header><div id="apm-games-history">${historyRows}</div></article>
        </section>

        <section class="apm-panel" data-apm-panel="assets">
          <div class="apm-summary-strip">${apmKpi('ВЫВОДИМЫХ', apmNum(invSummary.count))}${apmKpi('ИХ СТОИМОСТЬ', `${apmNum(invSummary.value)} 🧠`, 'gold')}${apmKpi('ИГРОВЫХ', apmNum(upgraderInvSummary.count), 'accent')}${apmKpi('ИГРОВАЯ СУММА', `${apmNum(upgraderInvSummary.value)} 🧠`, 'green')}</div>
          <article class="apm-card apm-feed"><header><div><small>МАГАЗИН И ВЫВОД</small><h3>Обычный инвентарь</h3></div><input class="apm-search" placeholder="Найти предмет" oninput="apmFilterInventory(this.value)"></header><div id="apm-inventory-list">${inventoryRows}</div></article>
          <article class="apm-card apm-upgrader-admin">
            <header><div><small>АПГРЕЙДЕР · КЕЙСЫ · КРАФТ</small><h3>Выдать игровой предмет</h3></div><b>только серверный каталог</b></header>
            <div class="apm-form-row apm-upgrader-grant"><input id="apm-upgrader-item-name" list="apm-upgrader-catalog" maxlength="120" placeholder="Начни вводить название"><datalist id="apm-upgrader-catalog">${upgraderCatalogOptions}</datalist><input id="apm-upgrader-item-qty" class="apm-qty-input" type="number" min="1" max="25" value="1"><button class="primary" onclick="apmGrantUpgraderItem(${playerId})">ВЫДАТЬ</button></div>
            <p class="apm-grant-help">Предмет появится только в игровом инвентаре. Мозги у игрока не списываются.</p>
          </article>
          <article class="apm-card apm-feed"><header><div><small>НЕ ВЫВОДИТСЯ · МОЖНО ИСПОЛЬЗОВАТЬ В ИГРЕ</small><h3>Игровой инвентарь</h3></div><input class="apm-search" placeholder="Найти игровой" oninput="apmFilterUpgraderInventory(this.value)"></header><div id="apm-upgrader-inventory-list">${upgraderInventoryRows}</div></article>
          <article class="apm-card apm-feed"><header><div><small>ПОСЛЕДНИЕ ${upgraderTransactions.length}</small><h3>История игрового инвентаря</h3></div></header>${upgraderTransactionRows}</article>
        </section>

        <section class="apm-panel" data-apm-panel="referrals">
          <div class="apm-summary-strip">${apmKpi('РЕФЕРАЛОВ', apmNum(refs))}${apmKpi('ДОХОД', `+${apmNum(refsIncome)} 🧠`, 'green')}${apmKpi('РЕФКОД', escHtml(u.referral_code || '—'), 'accent')}${apmKpi('ПРИГЛАСИЛ', referrer ? `#${escHtml(referrer.tg_id)}` : 'Никто')}</div>
          ${referrer ? `<article class="apm-card apm-referrer"><header><div><small>ИГРОКА ПРИГЛАСИЛ</small><h3>${escHtml(referrer.roblox_username || `#${referrer.tg_id}`)}</h3></div><button onclick="openPlayerModal(${Number(referrer.tg_id)})">ОТКРЫТЬ #${Number(referrer.tg_id)}</button></header><p>Привязка: ${apmDate(referrer.joined_at)}</p></article>` : ''}
          <article class="apm-card apm-feed"><header><div><small>КОМАНДА ИГРОКА</small><h3>Рефералы</h3></div><b>+${apmNum(refsIncome)} 🧠</b></header>${referralRows}</article>
        </section>

        <section class="apm-panel" data-apm-panel="security">
          ${ban.banned ? `<article class="apm-ban-card active"><div><small>АККАУНТ ЗАБЛОКИРОВАН</small><h3>${escHtml(ban.reason || 'Причина не указана')}</h3><p>${ban.permanent ? 'Навсегда' : `До ${apmDate(ban.banned_until)}`} · админ ${escHtml(ban.banned_by || '—')}</p></div><button onclick="apmSetBan(${playerId},'unban')">РАЗБЛОКИРОВАТЬ</button></article>` : `<article class="apm-ban-card"><div><small>ДОСТУП К АККАУНТУ</small><h3>Заблокировать игрока</h3><p>Блокировка применяется сервером ко всем игровым запросам.</p></div><div class="apm-ban-form"><input id="apm-ban-reason" maxlength="300" placeholder="Причина блокировки"><select id="apm-ban-duration"><option value="60">1 час</option><option value="360">6 часов</option><option value="1440">1 день</option><option value="10080">7 дней</option><option value="43200">30 дней</option><option value="0">Навсегда</option></select><button onclick="apmSetBan(${playerId},'ban')">ЗАБЛОКИРОВАТЬ</button></div></article>`}
          <article class="apm-card"><header><div><small>СОСТОЯНИЕ</small><h3>Аккаунт и доступ</h3></div></header><div class="apm-detail-grid wide"><span><small>tg_id</small><button onclick="apmCopyValue('${playerId}', 'tg_id')">${playerId}</button></span><span><small>TELEGRAM</small><b>${telegramIdentity.current_username ? `@${escHtml(telegramIdentity.current_username)}` : 'нет @username'}</b></span><span><small>РЕГИСТРАЦИЯ</small><b>${apmDate(u.created_at)}</b></span><span><small>ПОСЛЕДНИЙ ONLINE</small><b>${online ? 'Сейчас' : apmDate(activity.last_seen)}</b></span><span><small>ОСОБЫЙ РЕЖИМ</small><b>${specialModeLabel(specialMode)}</b></span></div></article>
          <article class="apm-card apm-feed"><header><div><small>ЖУРНАЛ ДЕЙСТВИЙ</small><h3>Блокировки</h3></div></header>${banRows}</article>
          <article class="apm-card apm-feed"><header><div><small>ЗАЩИЩЁННЫЙ АУДИТ</small><h3>Действия администраторов</h3></div></header>${adminActionRows}</article>
        </section>
      </div>`;

    apmSetTab(preferredTab);
  } catch (error) {
    console.error('Не удалось открыть карточку игрока:', error);
    content.innerHTML = `<div class="apm-error"><strong>Не удалось загрузить игрока</strong><span>${escHtml(error.message || 'Ошибка сервера')}</span><button onclick="apmRefresh()">ПОВТОРИТЬ</button></div>`;
  }
}

async function apmSetBan(targetId, action) {
  if (!_adminToken) return;
  const isBan = action === 'ban';
  const reason = isBan ? (document.getElementById('apm-ban-reason')?.value || '').trim() : '';
  const duration = isBan ? Number(document.getElementById('apm-ban-duration')?.value || 0) : 0;
  if (isBan && !reason) { showToast('Укажи причину блокировки', 'lose'); return; }
  if (!confirm(isBan ? 'Заблокировать этого игрока?' : 'Разблокировать этого игрока?')) return;
  try {
    const res = await fetch(`${API}/api/admin/player-ban`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ target_id: Number(targetId), action, reason, duration_minutes: duration })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(isBan ? 'Игрок заблокирован' : 'Игрок разблокирован', 'win');
    await openPlayerModal(targetId, 'security');
    loadAdminPanel();
  } catch (error) {
    showToast(`Не удалось изменить доступ: ${error.message}`, 'lose');
  }
}
// ─── Сохранение баланса прямо из модалки ────────────────────────────────
async function apmSaveBalance(targetId) {
  const newBal = parseInt(document.getElementById('apm-new-bal').value);
  if (isNaN(newBal) || newBal < 0) { showToast('Некорректный баланс', 'lose'); return; }
  try {
    const res  = await fetch(`${API}/api/admin/balance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: targetId, new_balance: newBal })
    });
    const data = await res.json();
    if (data.error) { showToast(`Ошибка: ${data.error}`, 'lose'); return; }
    const formattedBalance = apmNum(data.balance);
    const balanceDisplay = document.getElementById('apm-bal-display');
    const balanceKpi = document.getElementById('apm-kpi-balance');
    if (balanceDisplay) balanceDisplay.textContent = `${formattedBalance} 🧠`;
    if (balanceKpi) balanceKpi.textContent = formattedBalance;
    const balanceInput = document.getElementById('apm-new-bal');
    if (balanceInput) balanceInput.value = String(data.balance);
    showToast(`✅ Баланс: ${data.balance} 🧠`, 'win');
    loadInit();
    loadAdminPanel();
  } catch (e) { showToast('Ошибка сервера', 'lose'); }
}
// ─── Сохранение ника из модалки ─────────────────────────────────────────
async function apmSaveNick(targetId) {
  const newNick = (document.getElementById('apm-new-nick').value || '').trim();
  if (!newNick || newNick.length < 3) { showToast('Ник слишком короткий', 'lose'); return; }
  if (newNick.includes(' '))          { showToast('Ник не должен содержать пробелы', 'lose'); return; }
  try {
    const res  = await fetch(`${API}/api/admin/nick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: targetId, nick: newNick })
    });
    const data = await res.json();
    if (data.error) { showToast(`Ошибка: ${data.error}`, 'lose'); return; }
    const playerName = document.getElementById('apm-player-name');
    if (playerName) playerName.textContent = data.nick;
    document.getElementById('apm-title').textContent = data.nick;
    showToast(`✅ Ник изменён: ${data.nick}`, 'win');
    await openPlayerModal(targetId, 'overview');
  } catch (e) { showToast('Ошибка сервера', 'lose'); }
}

// ─── Удаление предмета из инвентаря ─────────────────────────────────────
async function apmDeleteItem(itemId, targetId) {
  if (!confirm('Удалить предмет?')) return;
  try {
    const res  = await fetch(`${API}/api/admin/delete_item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, item_id: itemId })
    });
    const data = await res.json();
    if (data.error) { showToast(`Ошибка: ${data.error}`, 'lose'); return; }
    showToast('✅ Предмет удалён', 'win');
    openPlayerModal(targetId, 'assets');
  } catch (e) { showToast('Ошибка сервера', 'lose'); }
}

async function apmGrantUpgraderItem(targetId) {
  const itemName = (document.getElementById('apm-upgrader-item-name')?.value || '').trim();
  const quantity = Number(document.getElementById('apm-upgrader-item-qty')?.value || 1);
  if (!itemName) { showToast('Выбери игровой предмет из каталога', 'lose'); return; }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) { showToast('Можно выдать от 1 до 25 предметов', 'lose'); return; }
  if (!confirm(`Выдать игроку ${quantity} × ${itemName}? Мозги не спишутся.`)) return;
  try {
    const res = await fetch(`${API}/api/admin/upgrader-inventory/grant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: Number(targetId), item_name: itemName, quantity })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(`✅ Выдано: ${data.quantity} × ${data.item_name}`, 'win');
    await openPlayerModal(targetId, 'assets');
  } catch (error) {
    const labels = { invalid_item: 'Такого предмета нет в серверном каталоге', invalid_quantity: 'Количество должно быть от 1 до 25', audit_unavailable: 'Защищённый аудит недоступен — действие отменено' };
    showToast(labels[error.message] || `Не удалось выдать предмет: ${error.message}`, 'lose');
  }
}

async function apmManageUpgraderItem(itemId, targetId, action, itemName, itemValue) {
  const isSell = action === 'sell';
  const question = isSell
    ? `Продать «${itemName}» и зачислить игроку ${apmNum(itemValue)} 🧠?`
    : `Удалить «${itemName}» БЕЗ компенсации? Это действие нельзя отменить.`;
  if (!confirm(question)) return;
  try {
    const res = await fetch(`${API}/api/admin/upgrader-inventory/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, target_id: Number(targetId), item_id: Number(itemId), action })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    showToast(isSell ? `✅ Продано: +${apmNum(data.credited)} 🧠 игроку` : '✅ Игровой предмет удалён без компенсации', 'win');
    await openPlayerModal(targetId, 'assets');
    if (isSell) loadAdminPanel();
  } catch (error) {
    const labels = { not_found: 'Предмет уже отсутствует', audit_unavailable: 'Защищённый аудит недоступен — действие отменено' };
    showToast(labels[error.message] || `Не удалось изменить предмет: ${error.message}`, 'lose');
  }
}

// ─── Отмена вывода из модалки ────────────────────────────────────────────
async function apmCancelWithdraw(withdrawId, targetId) {
  if (!confirm('Отменить вывод?')) return;
  try {
    const res  = await fetch(`${API}/api/admin/cancel_withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ tg_id, withdraw_id: withdrawId })
    });
    const data = await res.json();
    if (data.error) { showToast(`Ошибка: ${data.error}`, 'lose'); return; }
    showToast('✅ Вывод отменён, предметы разморожены', 'win');
    openPlayerModal(targetId);
  } catch (e) { showToast('Ошибка сервера', 'lose'); }
}

// ─── Закрытие модалки игрока ──────────────────────────────────────────
function closePlayerModal() {
  const modal = document.getElementById('admin-player-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
  }
  document.body.classList.remove('admin-player-modal-open');
  _adminPlayerTargetId = null;
}

function openTicketPlayerProfile(targetId) {
  if (!_adminToken) {
    showToast('Профиль игрока доступен только администратору', 'error');
    return;
  }
  openPlayerModal(targetId);
}

// ══════════════════════════════════════════
// ПРОФИЛЬ ПОЛЬЗОВАТЕЛЯ
// ══════════════════════════════════════════
const PROFILE_AVATARS = {
  initial: '',
  brain: '&#129504;',
  rocket: '&#128640;',
  dice: '&#127922;',
  crown: '&#128081;',
  shield: '&#128737;',
  star: '&#9733;',
  target: '&#9678;',
  gem: '&#128142;',
  flame: '&#128293;',
  bolt: '&#9889;',
  orbit: '&#8857;',
  ghost: '&#128123;',
  skull: '&#9760;',
  diamond: '&#9670;',
  infinity: '&#8734;',
  trophy: '&#127942;',
  dragon: '&#128009;',
  pickaxe: '&#9935;',
  anvil: '&#9874;',
  case: '&#128230;',
  handshake: '&#129309;'
};

function profileAvatarMarkup(key, initial) {
  return PROFILE_AVATARS[key] || escHtml(String(initial || 'И').slice(0, 1).toUpperCase());
}

function profileChecked(value) {
  return Number(value) === 1 || value === true ? ' checked' : '';
}

function profileFormatBrains(value) {
  return Math.floor(Number(value || 0)).toLocaleString('ru-RU');
}

function renderProfileSectionLauncher(progression) {
  const p = progression || {};
  const achievements = p.achievements || {};
  const level = Number(p.level || 1);
  const maxLevel = Number(p.max_level || 50);
  const completed = Number(achievements.completed || 0);
  const total = Number(achievements.total || achievements.items?.length || 0);
  return `<nav class="profile-section-launcher" aria-label="Разделы профиля">
    <button type="button" onclick="openProfileSection('levels')"><i>01</i><span><b>УРОВНИ И НАГРАДЫ</b><small>Все ${maxLevel} уровней, бонусы и открытия</small></span><strong>LVL ${level} · ОТКРЫТЬ <em>→</em></strong></button>
    <button type="button" onclick="openProfileSection('achievements')"><i>02</i><span><b>ДОСТИЖЕНИЯ</b><small>Условия, AP и награды за выполнение</small></span><strong>${completed}/${total} · ОТКРЫТЬ <em>→</em></strong></button>
    <button type="button" onclick="openProfileSection('workshop')"><i>03</i><span><b>МАСТЕРСКАЯ</b><small>Имя, оформление и публичность профиля</small></span><strong>НАСТРОИТЬ <em>→</em></strong></button>
    <button type="button" onclick="openProfileSection('activity')"><i>04</i><span><b>ИСТОРИЯ И ДАННЫЕ</b><small>Инвентарь, операции и игровые записи</small></span><strong>ПОКАЗАТЬ <em>→</em></strong></button>
  </nav>`;
}

function openProfileSection(sectionKey) {
  const root = document.getElementById('profile-content');
  if (!root) return;
  const targets = {
    levels: root.querySelector('#profile-levels'),
    achievements: root.querySelector('#profile-achievements'),
    workshop: root.querySelector('#profile-workshop'),
    activity: root.querySelector('#profile-activity') || root.querySelector('.profile-data-card'),
  };
  const target = targets[sectionKey];
  if (!target) return;
  if (sectionKey === 'levels') {
    const roadmap = target.querySelector('.profile-level-roadmap');
    if (roadmap) roadmap.open = true;
  }
  if (target.classList.contains('profile-collapsible')) {
    target.classList.remove('is-collapsed');
    target.querySelector(':scope > .profile-collapsible-handle')?.setAttribute('aria-expanded', 'true');
  }
  target.classList.remove('profile-section-pulse');
  requestAnimationFrame(() => {
    target.classList.add('profile-section-pulse');
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  window.setTimeout(() => target.classList.remove('profile-section-pulse'), 1100);
}

function renderProfileProgression(progression) {
  const p = progression || {};
  const level = Number(p.level || 1);
  const maxLevel = Number(p.max_level || 50);
  const progress = Math.max(0, Math.min(100, Number(p.progress || 0) * 100));
  const nextText = p.next_threshold == null
    ? 'МАКСИМАЛЬНЫЙ УРОВЕНЬ'
    : `До уровня ${level + 1} осталось ${profileFormatBrains(p.to_next_level)} 🧠`;
  const levels = Array.isArray(p.levels) ? p.levels : [];
  return `<section class="profile-level-panel" id="profile-levels">
    <header class="profile-level-emblem">
      <div class="profile-level-number"><small>LVL</small><strong>${level}</strong></div>
      <div class="profile-level-copy"><small>ПУТЬ ИГРОКА</small><span>${escHtml(p.level_title || 'Новичок')}</span><b>${level} ИЗ ${maxLevel} УРОВНЕЙ</b></div>
    </header>
    <div class="profile-level-progress">
      <div class="profile-level-heading"><b>ОБОРОТ В ИГРАХ</b><strong>${profileFormatBrains(p.total_bet)} 🧠</strong></div>
      <div class="profile-level-track"><i style="width:${progress.toFixed(2)}%"></i></div>
      <div class="profile-level-next"><span>${nextText}</span><b>${progress.toFixed(0)}%</b></div>
    </div>
    <div class="profile-active-bonuses">
      <span><small>БОНУС К ПОПОЛНЕНИЯМ</small><b>+${Number(p.deposit_bonus_percent || 0)}%</b></span>
      <span><small>ДОХОД С РЕФЕРАЛОВ</small><b>${Number(p.referral_percent || 5)}%</b></span>
    </div>
    <details class="profile-level-roadmap"><summary><span class="profile-roadmap-label"><i>${maxLevel}</i><span><b>ВСЕ УРОВНИ И НАГРАДЫ</b><small>Нажми, чтобы открыть полный путь и награду каждого уровня</small></span></span><strong><span>ПОКАЗАТЬ</span><i>⌄</i></strong></summary><div>${levels.map(item => `<article class="${item.unlocked ? 'unlocked' : 'locked'}"><strong>${item.level}</strong><span><b>${escHtml(item.title)}</b><small>${escHtml(item.perk)}</small></span><i>${item.unlocked ? 'ОТКРЫТО' : `${profileFormatBrains(item.threshold)} ставок`}</i></article>`).join('')}</div></details>
  </section>`;
}

function renderProfileAchievements(progression, settings) {
  const data = progression?.achievements || {};
  const items = Array.isArray(data.items) ? data.items : [];
  const featuredLimit = Math.max(3, Number(progression?.featured_achievement_limit || 3));
  const selected = new Set(Array.isArray(settings?.featured_achievements) ? settings.featured_achievements : []);
  const groups = [...new Set(items.map(item => item.group))];
  const cards = groups.map((group, groupIndex) => {
    const groupItems = items.filter(item => item.group === group);
    const finished = groupItems.filter(item => item.completed).length;
    return `<details class="profile-achievement-group"${groupIndex === 0 ? ' open' : ''}>
      <summary><span>${escHtml(group)}</span><b>${finished}/${groupItems.length}</b></summary>
      <div>${groupItems.map(item => {
        const progress = Math.max(0, Math.min(100, Number(item.progress || 0) * 100));
        const rewards = Array.isArray(item.rewards) && item.rewards.length
          ? `<small class="achievement-reward">ОТКРЫВАЕТ: ${item.rewards.map(reward => escHtml(reward.label)).join(', ')}</small>` : '';
        const favorite = item.completed
          ? `<label class="achievement-feature"><input class="profile-featured-achievement" type="checkbox" value="${escHtml(item.id)}" data-title="${escHtml(item.title)}" data-icon="${escHtml(item.icon)}" data-points="${Number(item.points || 0)}"${selected.has(item.id) ? ' checked' : ''} onchange="limitFeaturedAchievements(this)"><i></i><span>НА ВИТРИНУ</span></label>` : '';
        const verification = item.verification?.type === 'telegram_membership' ? item.verification : null;
        const verificationAction = verification && !item.completed
          ? `<div class="achievement-membership-action"><a href="${escHtml(verification.url || 'https://t.me/BBrainsbet')}" target="_blank" rel="noopener">ПОДПИСАТЬСЯ</a><button type="button" onclick="verifyCommunityMembership(this)">ПРОВЕРИТЬ</button></div>`
          : '';
        return `<article class="profile-achievement ${item.completed ? 'completed' : ''}">
          <div class="achievement-icon">${escHtml(item.icon)}</div>
          <div class="achievement-copy"><b>${escHtml(item.title)}</b><p>${escHtml(item.description)}</p>${rewards}<div class="achievement-progress"><i style="width:${progress.toFixed(2)}%"></i></div><small>${profileFormatBrains(item.value)} / ${profileFormatBrains(item.target)}</small></div>
          <strong class="achievement-points">+${Number(item.points || 0)} AP</strong>${favorite}${verificationAction}
        </article>`;
      }).join('')}</div>
    </details>`;
  }).join('');
  const featuredItems = items.filter(item => item.completed && selected.has(item.id));
  return `<section class="profile-achievements" id="profile-achievements" data-featured-limit="${featuredLimit}">
    <header><div><small>ACHIEVEMENT ARCHIVE</small><b>Достижения</b></div><span><strong>${Number(data.completed || 0)}</strong> / ${Number(data.total || items.length)}<small>${Number(data.points || 0)} AP</small></span></header>
    <p class="profile-achievement-help">Выполняй условия, открывай редкое оформление и выбери до ${featuredLimit} достижений для публичной витрины.</p>
    <section class="profile-featured-board">
      <div><small>ПУБЛИЧНАЯ ВИТРИНА</small><b>Выбранные достижения</b><span>${featuredItems.length}/${featuredLimit}</span></div>
      <section class="profile-featured-board-items">${renderProfileAchievementBadges(featuredItems, true)}</section>
    </section>
    ${renderAchievementShop(progression?.achievement_shop)}
    <div class="profile-achievement-groups">${cards}</div>
  </section>`;
}

function limitFeaturedAchievements(changed) {
  const selected = [...document.querySelectorAll('.profile-featured-achievement:checked')];
  const limit = Math.max(3, Number(document.querySelector('.profile-achievements')?.dataset.featuredLimit || 3));
  if (selected.length > limit) {
    changed.checked = false;
    showToast(`На твоём уровне доступно ${limit} мест на витрине`, 'lose');
  }
  updateProfileAchievementShowcase();
}

async function verifyCommunityMembership(button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    const response = await fetch(`${API}/api/profile/achievements/verify-community`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, init_data: TG_INIT_DATA || '' })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || 'community_check_failed');
    showToast(data.awarded ? '+400 AP за подписку на @BBrainsbet' : 'Подписка уже подтверждена', 'win');
    await loadProfile();
  } catch (error) {
    if (button) button.disabled = false;
    const messages = {
      community_membership_required: 'Сначала подпишись на @BBrainsbet, затем нажми «Проверить»',
      community_verification_unavailable: 'Не удалось проверить подписку. Попробуй немного позже.',
      unauthorized: 'Открой Mini App из Telegram и попробуй ещё раз.'
    };
    showToast(messages[error.message] || 'Не удалось проверить подписку', 'lose');
  }
}

function renderProfileAchievementBadges(items, showEmpty = false) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return showEmpty
    ? '<div class="profile-featured-empty"><b>Витрина пока пустая</b><span>Отметь выполненное достижение ниже</span></div>'
    : '';
  return list.map(item => `<article class="profile-featured-badge"><strong>${escHtml(item.icon || 'AP')}</strong><span><b>${escHtml(item.title || 'Достижение')}</b><small>${Number(item.points || 0)} AP</small></span></article>`).join('');
}

function selectedProfileAchievementsFromProgression(progression, settings) {
  const selected = new Set(Array.isArray(settings?.featured_achievements) ? settings.featured_achievements : []);
  const items = Array.isArray(progression?.achievements?.items) ? progression.achievements.items : [];
  return items.filter(item => item.completed && selected.has(item.id));
}

function renderProfileHeroCard(options = {}) {
  const settings = options.settings || {};
  const name = options.name || options.username || 'Игрок';
  const preview = Boolean(options.preview);
  const achievements = Array.isArray(options.achievements) ? options.achievements : [];
  const badge = settings.badge && settings.badge !== 'none' ? ` · ${String(settings.badge).toUpperCase()}` : '';
  const ids = preview ? {
    avatar: ' id="profile-preview-avatar"', level: ' id="profile-preview-level"',
    name: ' id="profile-preview-name"', title: ' id="profile-preview-title"',
    bio: ' id="profile-preview-bio"'
  } : {avatar:'', level:'', name:'', title:'', bio:''};
  const games = options.showGames === false ? '' : `<div class="public-profile-games"><small>ИГР ВСЕГО</small><strong>${profileFormatBrains(options.totalGames || 0)}</strong></div>`;
  const showcase = `<div class="profile-card-achievements"${preview ? ' id="profile-preview-achievements"' : ''}${achievements.length ? '' : ' hidden'}>${renderProfileAchievementBadges(achievements)}</div>`;
  const idAttribute = options.id ? ` id="${escHtml(options.id)}"` : '';
  return `<section${idAttribute} class="public-profile-hero ${escHtml(options.className || '')}" data-profile-accent="${escHtml(settings.accent || 'gold')}" data-profile-frame="${escHtml(settings.frame || 'basic')}" data-profile-pattern="${escHtml(settings.pattern || 'none')}" data-profile-badge="${escHtml(settings.badge || 'none')}" data-profile-nameplate="${escHtml(settings.nameplate || 'none')}" data-profile-effect="${escHtml(settings.effect || 'none')}">
    <div class="public-profile-avatar"${ids.avatar}>${profileAvatarMarkup(settings.avatar, name)}</div>
    <div class="public-profile-identity"><small${ids.level}>LVL ${Number(options.level || 1)} · ${escHtml(options.levelTitle || 'НОВИЧОК')}${escHtml(badge)}</small><h2${ids.name}>${escHtml(name)}</h2><em${ids.title}${settings.profile_title ? '' : ' hidden'}>${escHtml(settings.profile_title || '')}</em><span${options.meta ? '' : ' hidden'}>${escHtml(options.meta || '')}</span><p${ids.bio}${settings.bio ? '' : ' hidden'}>${escHtml(settings.bio || '')}</p></div>
    ${games}${showcase}
  </section>`;
}

function renderAchievementShop(shop) {
  const state = shop || {};
  const items = Array.isArray(state.items) ? state.items : [];
  return `<section class="achievement-shop" id="achievement-shop">
    <header><div><small>AP REWARD VAULT</small><b>Магазин достижений</b></div><strong><span id="achievement-shop-available">${profileFormatBrains(state.available)}</span> AP</strong></header>
    <div class="achievement-shop-ledger"><span>ЗАРАБОТАНО <b>${profileFormatBrains(state.earned)}</b></span><span>ПОТРАЧЕНО <b>${profileFormatBrains(state.spent)}</b></span><span>ДОСТУПНО <b>${profileFormatBrains(state.available)}</b></span></div>
    <p>Очки достижений не покупаются за баланс. Награда сразу попадает в игровой инвентарь.</p>
    <div class="achievement-shop-grid">${items.map(item => `<article class="achievement-shop-item ${item.affordable ? 'affordable' : ''}">
      <div>${caseImgHtml(item.name, 78)}</div><span><b>${escHtml(item.name)}</b><small>${Math.floor(Number(item.value || 0))} 🧠 · ${escHtml(item.rarity || '')}</small></span>
      <button type="button" data-achievement-shop-key="${escHtml(item.key)}" onclick="buyAchievementReward('${escHtml(item.key)}',this)"${item.affordable ? '' : ' disabled'}><b>${profileFormatBrains(item.cost)} AP</b><span>${item.affordable ? 'ПОЛУЧИТЬ' : 'НЕ ХВАТАЕТ'}</span></button>
    </article>`).join('')}</div>
  </section>`;
}

async function buyAchievementReward(itemKey, button) {
  if (!itemKey || button?.disabled) return;
  if (button) button.disabled = true;
  const requestId = (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    const response = await fetch(`${API}/api/profile/achievement-shop/buy`, {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || '', item_key: itemKey, request_id: requestId})
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'purchase_failed');
    showToast(`${data.purchase?.item_name || 'Награда'} добавлен в игровой инвентарь`, 'win');
    await loadProfile();
  } catch (error) {
    if (button) button.disabled = false;
    showToast(error.message === 'insufficient_achievement_points' ? 'Недостаточно AP' : 'Не удалось получить награду', 'lose');
  }
}

function updateProfileAchievementShowcase() {
  const inputs = [...document.querySelectorAll('.profile-featured-achievement:checked')];
  const items = inputs.map(input => ({title: input.dataset.title, icon: input.dataset.icon, points: Number(input.dataset.points || 0)}));
  const board = document.querySelector('.profile-featured-board-items');
  if (board) board.innerHTML = renderProfileAchievementBadges(items, true);
  const card = document.getElementById('profile-preview-achievements');
  if (card) {
    card.innerHTML = renderProfileAchievementBadges(items);
    card.hidden = !items.length;
  }
}

let dailyLevelCaseState = null;

function renderDailyLevelCase(dailyState) {
  const daily = dailyState || {};
  const localPool = Array.isArray(CASES_CLIENT?.level_daily?.items)
    ? CASES_CLIENT.level_daily.items
    : [];
  const pool = Array.isArray(daily.pool) && daily.pool.length
    ? daily.pool
    : localPool;
  const dragon = pool.find(item => item.name === 'Dragon Cannelloni');
  const currentLevel = Math.max(1, Number(daily.current_level || 1));
  const requiredLevel = Math.max(10, Number(daily.required_level || 10));
  const levelProgress = Math.min(100, (currentLevel / requiredLevel) * 100);
  const previewPool = pool.filter(item => item.name !== 'Dragon Cannelloni').slice(0, 2);
  if (dragon) previewPool.push(dragon);
  const rewardPreview = previewPool.map((item, index) => `
    <span class="${index === previewPool.length - 1 && dragon ? 'daily-case-dragon' : ''}">
      ${caseImgHtml(item.name, 68)}
      ${item.name === 'Dragon Cannelloni' ? '<i>1%</i>' : ''}
    </span>`).join('');

  let action = `<button class="daily-case-action" type="button" disabled>ДОСТУПЕН С 10 УРОВНЯ</button>`;
  let status = `<div class="daily-case-level"><span>ТВОЙ УРОВЕНЬ ${currentLevel} / ${requiredLevel}</span><i><b style="width:${levelProgress.toFixed(2)}%"></b></i></div>`;
  if (daily.load_error) {
    action = '<button class="daily-case-action" type="button" onclick="loadDailyLevelCase()">ОБНОВИТЬ СТАТУС</button>';
  }
  if (daily.unlocked && daily.available) {
    action = '<button class="daily-case-action" type="button" onclick="claimDailyLevelCase(this)">ОТКРЫТЬ БЕСПЛАТНО</button>';
    status = '<div class="daily-case-status available"><span>ДОСТУПЕН СЕГОДНЯ</span><b>1 БЕСПЛАТНОЕ ОТКРЫТИЕ</b></div>';
  }
  if (daily.claimed_today) {
    const rewardName = daily.last_reward?.item_name || 'награда';
    action = '<button class="daily-case-action" type="button" disabled>ВОЗВРАЩАЙСЯ ЗАВТРА</button>';
    status = `<div class="daily-case-status claimed"><span>СЕГОДНЯ УЖЕ ПОЛУЧЕН</span><b>${escHtml(rewardName)}</b></div>`;
  }

  return `<section class="daily-level-case ${daily.unlocked ? 'is-unlocked' : 'is-locked'}" id="daily-level-case">
    <div class="daily-case-kicker"><span>БЕСПЛАТНЫЙ КЕЙС</span><b>НАГРАДА 10 УРОВНЯ</b></div>
    <div class="daily-case-main">
      <div class="daily-case-copy"><small>КАЖДЫЙ ДЕНЬ</small><h3>КЕЙС УРОВНЯ</h3><p>10 дешёвых брейнротов и ${dragon ? escHtml(dragon.name) : 'Dragon Cannelloni'} с шансом 1%. После прокрутки выбери: продать предмет или оставить в игровом инвентаре.</p></div>
      <div class="daily-case-preview" aria-hidden="true">${rewardPreview || '<strong>10</strong>'}</div>
    </div>
    ${status}
    ${action}
  </section>`;
}

async function loadDailyLevelCase() {
  const panel = document.getElementById('daily-level-case');
  if (!panel) return;
  panel.className = 'daily-level-case is-loading';
  panel.innerHTML = '<div class="daily-case-loading"><b>БЕСПЛАТНЫЙ КЕЙС</b><span>Проверяем награду...</span></div>';
  try {
    const response = await fetch(`${API}/api/profile/daily-case/status`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || ''})
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'status_failed');
    dailyLevelCaseState = data;
    panel.outerHTML = renderDailyLevelCase(data);
  } catch (error) {
    dailyLevelCaseState = null;
    panel.outerHTML = renderDailyLevelCase({
      current_level: 1,
      required_level: 10,
      unlocked: false,
      available: false,
      load_error: true,
      pool: []
    });
  }
}

async function claimDailyLevelCase(button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch(`${API}/api/profile/daily-case/claim`, {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || ''})
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'claim_failed');
    const item = data.item || {};
    await runCaseAnimation(
      'level_daily',
      item.name || 'Награда',
      Number(item.value || 0),
      data.image_url,
      data.drop_id
    );
    SND.play('craftResult');
    showToast('Выбери: продать предмет или оставить в инвентаре', 'win');
    await loadDailyLevelCase();
  } catch (error) {
    if (button) button.disabled = false;
    showToast(error.message === 'already_claimed' ? 'Сегодня кейс уже получен' : 'Не удалось открыть ежедневный кейс', 'lose');
  }
}

let depositRewardCaseState = null;

function depositRewardNumber(value) {
  return Math.max(0, Math.floor(Number(value || 0))).toLocaleString('ru-RU');
}

function depositRewardPreview(pool) {
  const items = Array.isArray(pool) ? [...pool] : [];
  const selected = items.sort((a, b) => Number(b.value || 0) - Number(a.value || 0)).slice(0, 3);
  return selected.map((item, index) => `
    <span class="deposit-reward-preview-item" style="--preview-order:${index}" title="${escHtml(item.name)} — ${depositRewardNumber(item.value)} мозгов">
      ${caseImgHtml(item.name, 74)}
      <i>${depositRewardNumber(item.value)}</i>
    </span>`).join('');
}

function renderDepositRewardCard(reward) {
  const key = String(reward.key || 'reward');
  const progress = Math.max(0, Math.min(100, Number(reward.progress || 0)));
  const deposited = depositRewardNumber(reward.deposited);
  const threshold = depositRewardNumber(reward.threshold);
  const remaining = depositRewardNumber(reward.remaining);
  const periodCopy = reward.period === 'day' ? 'ПОПОЛНЕНО СЕГОДНЯ' : 'ПОПОЛНЕНО ЗА НЕДЕЛЮ';
  const variant = key === 'daily_200' ? 'daily' : (key === 'weekly_9000' ? 'dragon' : 'weekly');
  const artClass = variant === 'daily'
    ? 'case-art-themed--daily'
    : (variant === 'dragon' ? 'case-art-themed--reserve' : 'case-art-themed--weekly');
  const tierClass = variant === 'daily' ? 'tier-cosmic' : (variant === 'dragon' ? 'tier-forge' : 'tier-vault');
  const badge = variant === 'daily' ? 'СУТОЧНЫЙ' : (variant === 'dragon' ? 'ОСОБЫЙ' : 'НЕДЕЛЬНЫЙ');
  let stateCopy = `<span>ЕЩЁ ${remaining} 🧠</span><b>${progress.toFixed(0)}%</b>`;
  let action = `<button type="button" class="deposit-reward-action" disabled>НЕДОСТУПЕН</button>`;
  if (reward.available) {
    stateCopy = '<span>ПОРОГ ВЫПОЛНЕН</span><b>ГОТОВ</b>';
    action = `<button type="button" class="deposit-reward-action is-ready" onclick="claimDepositRewardCase('${key}',this)">ОТКРЫТЬ</button>`;
  } else if (reward.claimed) {
    const itemName = reward.last_reward?.item_name || 'Награда получена';
    stateCopy = `<span>ПОЛУЧЕНО</span><b>${escHtml(itemName)}</b>`;
    action = '<button type="button" class="deposit-reward-action is-claimed" disabled>УЖЕ ОТКРЫТ</button>';
  }
  return `
    <article class="case-card deposit-reward-card is-${variant}">
      <div class="case-tier-line ${tierClass}"></div>
      <div class="deposit-reward-tag">${escHtml(reward.eyebrow || badge)}</div>
      <div class="case-icon-wrap deposit-reward-art">
        <span class="case-art case-art-themed ${artClass}" aria-hidden="true"></span>
        <span class="case-icon-glow"></span>
      </div>
      <div class="case-name">${escHtml(reward.name || 'Кейс')}</div>
      <div class="case-price">${threshold} 🧠</div>
      <div class="case-badge deposit-reward-badge">${badge}</div>
      <div class="deposit-reward-progress-copy"><span>${periodCopy}</span><b>${deposited} / ${threshold}</b></div>
      <div class="deposit-reward-progress" aria-label="Прогресс ${progress.toFixed(0)} процентов"><i style="width:${progress}%"></i></div>
      <div class="deposit-reward-state ${reward.available ? 'is-ready' : ''} ${reward.claimed ? 'is-claimed' : ''}">${stateCopy}</div>
      ${action}
      <div class="deposit-reward-period">${escHtml(reward.period_label || '')}</div>
    </article>`;
}

function renderDepositRewardCases(data = {}) {
  const rewards = Array.isArray(data.rewards) ? data.rewards : [];
  return `<section class="deposit-reward-hub ${data.load_error ? 'has-error' : ''}" id="deposit-reward-cases" aria-live="polite">
    <div class="deposit-reward-heading">
      <div><small>НАГРАДЫ ЗА ПОПОЛНЕНИЯ</small><h2>ОСОБЫЕ КЕЙСЫ</h2></div>
      <p>Прогресс считается без бонусов и обновляется по Москве.</p>
    </div>
    ${data.load_error
      ? '<button class="deposit-reward-retry" type="button" onclick="loadDepositRewardCases()">ОБНОВИТЬ СТАТУС</button>'
      : `<div class="deposit-reward-grid">${rewards.map(renderDepositRewardCard).join('')}</div>`}
  </section>`;
}

async function loadDepositRewardCases() {
  const panel = document.getElementById('deposit-reward-cases');
  if (!panel) return;
  panel.className = 'deposit-reward-hub is-loading';
  panel.innerHTML = '<div class="deposit-reward-loading"><b>КЕЙСЫ ЗА ПОПОЛНЕНИЯ</b><span>Считаем прогресс за день и неделю...</span></div>';
  try {
    const response = await fetch(`${API}/api/cases/deposit-rewards/status`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || ''})
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'status_failed');
    depositRewardCaseState = data;
    panel.outerHTML = renderDepositRewardCases(data);
  } catch (error) {
    depositRewardCaseState = null;
    panel.outerHTML = renderDepositRewardCases({load_error: true, rewards: []});
  }
}

async function claimDepositRewardCase(rewardKey, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch(`${API}/api/cases/deposit-rewards/claim`, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({tg_id, init_data: TG_INIT_DATA || '', reward_key: rewardKey})
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'claim_failed');
    const item = data.item || {};
    const caseType = data.case_type || `deposit_${rewardKey}`;
    await runCaseAnimation(
      caseType,
      item.name || 'Награда',
      Number(item.value || 0),
      data.image_url,
      data.drop_id
    );
    SND.play('craftResult');
    showToast('Кейс открыт. Продай предмет или оставь в игровом инвентаре', 'win');
    await loadDepositRewardCases();
  } catch (error) {
    if (button) button.disabled = false;
    const message = error.message === 'already_claimed'
      ? 'Этот кейс уже получен'
      : error.message === 'threshold_not_met'
        ? 'Нужная сумма пополнений ещё не набрана'
        : 'Не удалось открыть кейс за пополнение';
    showToast(message, 'lose');
    await loadDepositRewardCases();
  }
}

let eventRelicCaseState = null;

function renderEventRelicCase(eventCase) {
  const panel = document.getElementById('event-case-hub');
  if (!panel) return;
  if (!eventCase) {
    panel.hidden = true;
    panel.innerHTML = '';
    return;
  }
  const key = String(eventCase?.key || 'event_relic');
  const caseData = CASES_CLIENT[key] || CASES_CLIENT.event_relic;
  const items = caseData.items;
  const names = items.slice(0, 5).map(item => caseImgHtml(item.name, 38)).join('');
  panel.hidden = false;
  panel.innerHTML = `
    <article class="event-relic-case-card">
      <div class="event-relic-case-art" aria-hidden="true">
        <img src="${IMG_BASE}event-relic-case.svg" alt="">
      </div>
      <div class="event-relic-case-copy">
        <small>ИВЕНТ В ЭФИРЕ · ОГРАНИЧЕННЫЙ ДОСТУП</small>
        <h2>${escHtml(caseData.label)}</h2>
        <p>Пять снятых предметов. Их нельзя купить, выбить или скрафтить обычным путём. Витрину открывает и закрывает администратор независимо от схем.</p>
        <div class="event-relic-case-preview" title="Часть возможных наград">${names}</div>
      </div>
      <div class="event-relic-case-action">
        <b>${Math.floor(caseData.price).toLocaleString('ru-RU')} 🧠</b>
        <button type="button" onclick="showCaseModal('${key}')">ОТКРЫТЬ</button>
      </div>
    </article>`;
}

async function loadEventRelicCase() {
  const panel = document.getElementById('event-case-hub');
  if (!panel) return;
  try {
    await ensureTelegramAuth();
    const response = await fetch(`${API}/api/craft/data?tg_id=${tg_id}&_=${Date.now()}-event-case`, {
      cache: 'no-store'
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'event_case_load_failed');
    eventRelicCaseState = data?.event_craft?.event_case || null;
    renderEventRelicCase(eventRelicCaseState);
  } catch (error) {
    eventRelicCaseState = null;
    renderEventRelicCase(null);
  }
}

function renderUsernameManager(user = {}) {
  const username = String(user.roblox_username || 'Игрок');
  const changedAt = Number(user.username_changed_at || 0);
  const availableAt = changedAt ? changedAt + (7 * 86400) : 0;
  const remaining = Math.max(0, availableAt - Math.floor(Date.now() / 1000));
  const days = Math.floor(remaining / 86400);
  const hours = Math.ceil((remaining % 86400) / 3600);
  const status = remaining
    ? `Смена будет доступна через ${days ? `${days} д. ` : ''}${hours} ч.`
    : 'Смена доступна сейчас';
  return `<details class="profile-username-manager">
    <summary>
      <span class="profile-username-icon">Aa</span>
      <span><small>СМЕНА НИКА</small><b>Управление игровым именем</b><i>${status}</i></span>
      <strong>ИЗМЕНИТЬ</strong>
    </summary>
    <div class="profile-username-body">
      <p>Сейчас: <b>@${escHtml(username)}</b>. Это единое имя видно в профиле, топе, LIVE и других публичных разделах. После изменения действует пауза 7 дней.</p>
      <div class="profile-username-form">
        <label><span>НОВЫЙ НИК</span><input id="new-username-input" type="text" maxlength="20" autocomplete="off" placeholder="Русский или английский алфавит"${remaining ? ' disabled' : ''}></label>
        <button type="button" onclick="submitUsernameChange()"${remaining ? ' disabled' : ''}>СОХРАНИТЬ НИК</button>
      </div>
      <div id="username-change-msg" class="profile-username-message"></div>
    </div>
  </details>`;
}

function renderProfileSettings(settings, fallbackName, progression, profileMeta = '', user = {}) {
  const ps = settings || {};
  const p = progression || {};
  const unlocks = p.customization || {};
  const catalog = p.customization_catalog || {};
  const level = Number(p.level || 1);
  const titleLimit = Number(p.profile_title_limit || 22);
  const bioLimit = Number(p.bio_limit || 160);
  const privacy = [
    ['show_game_history', 'История игр', 'Последние матчи, ставки и результат'],
    ['show_balance', 'Баланс', 'Текущий баланс мозга'],
    ['show_total_games', 'Количество игр', 'Общее число сыгранных матчей'],
    ['show_inventory', 'Игровой инвентарь', 'До 30 последних предметов'],
    ['show_join_date', 'Дата регистрации', 'Когда профиль появился в BrainBet'],
    ['show_achievements', 'Достижения', 'Очки и выбранная витрина достижений']
  ];
  const isAvailable = (category, key) => (unlocks[category] || []).includes(key) || ps[category] === key;
  const lockText = item => item.achievement_title ? `АЧИВКА: ${item.achievement_title}` : `LVL ${Number(item.level || 1)}`;
  const categoryMeta = {
    frame: ['КОНТУР', 'Форма и свечение границ карточки'],
    pattern: ['ФОН', 'Рисунок внутри карточки'],
    badge: ['ЗНАК УРОВНЯ', 'Короткая отметка рядом с уровнем'],
    nameplate: ['ИМЯ', 'Как будет оформлено отображаемое имя'],
    effect: ['АНИМАЦИЯ', 'Движущийся эффект поверх карточки']
  };
  const glyphs = {frame: '[]', pattern: '##', badge: 'LV', nameplate: 'Aa', effect: '++'};
  const styleOptions = (category, selected) => (catalog[category] || []).map(item => {
    const available = isAvailable(category, item.key);
    return `<label class="profile-style-option ${available ? '' : 'locked'}" data-profile-kind="${escHtml(category)}" data-profile-value="${escHtml(item.key)}"><input type="radio" name="profile-${category}" value="${escHtml(item.key)}"${selected === item.key ? ' checked' : ''}${available ? '' : ' disabled'}><span><i>${glyphs[category] || '◇'}</i><b>${escHtml(item.label)}</b><small>${available ? 'ОТКРЫТО' : escHtml(lockText(item))}</small></span></label>`;
  }).join('');
  const upcoming = Object.entries(catalog).flatMap(([category, items]) =>
    (items || []).filter(item => Number(item.level || 0) > level).map(item => ({
      ...item,
      category,
      categoryLabel: categoryMeta[category]?.[0] || category
    }))
  ).sort((a, b) => Number(a.level) - Number(b.level));
  const nextUnlockLevel = upcoming.length ? Number(upcoming[0].level) : null;
  const nextUnlocks = upcoming.filter(item => Number(item.level) === nextUnlockLevel).slice(0, 4);
  const unlockedCount = Object.values(unlocks).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const catalogCount = Object.values(catalog).reduce((sum, items) => sum + (Array.isArray(items) ? items.length : 0), 0);
  const currentName = fallbackName || 'Игрок';
  const previewAchievements = selectedProfileAchievementsFromProgression(p, ps);
  const nextUnlockMarkup = nextUnlocks.length
    ? `<div class="profile-next-unlocks"><span>СЛЕДУЮЩЕЕ ОТКРЫТИЕ · LVL ${nextUnlockLevel}</span><div>${nextUnlocks.map(item => `<b>${escHtml(item.categoryLabel)}: ${escHtml(item.label)}</b>`).join('')}</div></div>`
    : '<div class="profile-next-unlocks is-complete"><span>КОЛЛЕКЦИЯ УРОВНЕЙ ЗАВЕРШЕНА</span><b>Открывай редкие стили достижениями</b></div>';

  return `<section class="profile-editor" id="profile-workshop" data-profile-accent="${escHtml(ps.accent || 'gold')}" data-fallback-name="${escHtml(fallbackName || 'Игрок')}" data-profile-level="${level}" data-level-title="${escHtml(p.level_title || 'Новичок')}">
    <div class="profile-editor-heading"><div><small>PROFILE WORKSHOP</small><b>Мастерская профиля</b><p>Выбирай оформление и сразу смотри результат.</p></div><div class="profile-editor-status"><span>${unlockedCount}/${catalogCount} ОТКРЫТО</span><button type="button" onclick="focusProfilePreview(this)">К КАРТОЧКЕ</button></div></div>
    <div class="profile-preview-dock">
      <div class="profile-preview-label"><span>ЖИВОЙ ПРЕДПРОСМОТР</span><b>ИЗМЕНЕНИЯ ВИДНЫ СРАЗУ</b></div>
      ${renderProfileHeroCard({
        settings: ps,
        name: currentName,
        username: fallbackName || 'игрок',
        level,
        levelTitle: p.level_title || 'НОВИЧОК',
        totalGames: p.achievements?.metrics?.total_games || 0,
        achievements: previewAchievements,
        preview: true,
        id: 'profile-live-preview-card',
        meta: profileMeta,
        className: 'profile-live-preview-card',
      })}
    </div>
    ${nextUnlockMarkup}
    <nav class="profile-workshop-tabs" aria-label="Разделы настройки профиля">
      <button type="button" class="active" data-workshop-tab="identity" onclick="switchProfileWorkshopTab(this, 'identity')"><i>01</i><span>ЛИЧНОСТЬ</span></button>
      <button type="button" data-workshop-tab="style" onclick="switchProfileWorkshopTab(this, 'style')"><i>02</i><span>ОФОРМЛЕНИЕ</span></button>
      <button type="button" data-workshop-tab="privacy" onclick="switchProfileWorkshopTab(this, 'privacy')"><i>03</i><span>ПУБЛИЧНОСТЬ</span></button>
    </nav>
    <div class="profile-workshop-pane active" data-workshop-pane="identity">
      <div class="profile-pane-intro"><b>ЛИЧНОСТЬ</b><span>Имя, описание, основной цвет и знак аватара.</span></div>
      ${renderUsernameManager(user)}
      <div class="profile-editor-fields">
        <label class="${p.can_use_title ? '' : 'profile-field-locked'}"><span>ТИТУЛ · ${p.can_use_title ? `ДО ${titleLimit}` : 'ОТКРОЕТСЯ НА LVL 6'}</span><input id="profile-title" maxlength="${titleLimit}" value="${escHtml(ps.profile_title || '')}" placeholder="Например: Охотник за джекпотом"${p.can_use_title ? '' : ' disabled'}></label>
        <label class="profile-bio-field ${p.can_use_bio ? '' : 'profile-field-locked'}"><span>О СЕБЕ · ${p.can_use_bio ? `ДО ${bioLimit}` : 'ОТКРОЕТСЯ НА LVL 2'}</span><textarea id="profile-bio" maxlength="${bioLimit}" placeholder="Коротко о себе..."${p.can_use_bio ? '' : ' disabled'}>${escHtml(ps.bio || '')}</textarea><small><i id="profile-bio-count">${String(ps.bio || '').length}</i>/${bioLimit}</small></label>
      </div>
      <div class="profile-choice-title"><b>ЦВЕТ ПРОФИЛЯ</b><span>Меняет акцент всей карточки</span></div>
      <div class="profile-accent-options">${(catalog.accent || []).map(item => { const available = isAvailable('accent', item.key); return `<label class="profile-accent-option accent-${escHtml(item.key)} ${available ? '' : 'locked'}" title="${escHtml(item.label)}${available ? '' : ` · ${escHtml(lockText(item))}`}"><input type="radio" name="profile-accent" value="${escHtml(item.key)}"${(ps.accent || 'gold') === item.key ? ' checked' : ''}${available ? '' : ' disabled'}><i></i><span>${available ? escHtml(item.label) : escHtml(lockText(item))}</span></label>`; }).join('')}</div>
      <div class="profile-choice-title"><b>ЗНАК АВАТАРА</b><span>Символ слева от имени</span></div>
      <div class="profile-avatar-options">${(catalog.avatar || []).map(item => { const available = isAvailable('avatar', item.key); const symbol = item.key === 'initial' ? escHtml(String(fallbackName || 'И')[0].toUpperCase()) : (PROFILE_AVATARS[item.key] || '&#9670;'); return `<label class="${available ? '' : 'locked'}" title="${escHtml(item.label)}${available ? '' : ` · ${escHtml(lockText(item))}`}"><input type="radio" name="profile-avatar" value="${escHtml(item.key)}"${(ps.avatar || 'initial') === item.key ? ' checked' : ''}${available ? '' : ' disabled'}><span>${symbol}<small>${available ? escHtml(item.label) : '&#128274;'}</small></span></label>`; }).join('')}</div>
    </div>
    <div class="profile-workshop-pane" data-workshop-pane="style" hidden>
      <div class="profile-pane-intro"><b>ОФОРМЛЕНИЕ</b><span>Каждый пункт отвечает за отдельный слой карточки. Нажми вариант и проверь его сверху.</span></div>
      ${Object.entries(categoryMeta).map(([category, meta], index) => `<details class="profile-style-group"${index === 0 ? ' open' : ''}><summary><span><b>${meta[0]}</b><small>${meta[1]}</small></span><i aria-hidden="true"></i></summary><div class="profile-style-options">${styleOptions(category, ps[category] || (category === 'frame' ? 'basic' : 'none'))}</div></details>`).join('')}
    </div>
    <div class="profile-workshop-pane" data-workshop-pane="privacy" hidden>
      <div class="profile-pane-intro"><b>ПУБЛИЧНОСТЬ</b><span>Зелёный переключатель означает, что раздел увидят другие игроки. История игр включена по умолчанию.</span></div>
      <div class="profile-privacy-grid">${privacy.map(([key, title, note]) => `<label><input id="profile-${key}" type="checkbox"${profileChecked(ps[key])}><span><b>${title}</b><small>${note}</small></span><i aria-hidden="true"></i></label>`).join('')}</div>
    </div>
    <div class="profile-workshop-actions"><button class="profile-reset-btn" type="button" onclick="loadProfile()">ОТМЕНИТЬ ИЗМЕНЕНИЯ</button><button class="profile-save-btn" type="button" onclick="saveProfileSettings()">СОХРАНИТЬ ПРОФИЛЬ</button></div>
    <div class="profile-save-status" id="profile-save-status"></div>
  </section>`;
}

function switchProfileWorkshopTab(button, tab) {
  const editor = button?.closest('.profile-editor');
  if (!editor) return;
  editor.querySelectorAll('[data-workshop-tab]').forEach(item => item.classList.toggle('active', item.dataset.workshopTab === tab));
  editor.querySelectorAll('[data-workshop-pane]').forEach(item => {
    const active = item.dataset.workshopPane === tab;
    item.classList.toggle('active', active);
    item.hidden = !active;
  });
}

function focusProfilePreview(button) {
  const editor = button?.closest('.profile-editor') || document.querySelector('.profile-editor');
  const preview = editor?.querySelector('.profile-preview-dock');
  if (!preview) return;
  preview.scrollIntoView({behavior: 'smooth', block: 'center'});
  preview.classList.remove('is-highlighted');
  requestAnimationFrame(() => preview.classList.add('is-highlighted'));
  setTimeout(() => preview.classList.remove('is-highlighted'), 900);
}

function updateProfilePreview() {
  const editor = document.querySelector('.profile-editor');
  const card = editor?.querySelector('#profile-live-preview-card');
  if (!editor || !card) return;
  const checkedValue = name => editor.querySelector(`input[name="${name}"]:checked`)?.value;
  const accent = checkedValue('profile-accent') || 'gold';
  const frame = checkedValue('profile-frame') || 'basic';
  const pattern = checkedValue('profile-pattern') || 'none';
  const badge = checkedValue('profile-badge') || 'none';
  const nameplate = checkedValue('profile-nameplate') || 'none';
  const effect = checkedValue('profile-effect') || 'none';
  const fallbackName = editor.dataset.fallbackName || 'Игрок';
  const displayName = fallbackName;
  const title = editor.querySelector('#profile-title')?.value.trim() || '';
  const bio = editor.querySelector('#profile-bio')?.value.trim() || '';
  const avatar = checkedValue('profile-avatar') || 'initial';
  const level = Number(editor.dataset.profileLevel || 1);
  const levelTitle = editor.dataset.levelTitle || 'Новичок';

  editor.dataset.profileAccent = accent;
  card.dataset.profileAccent = accent;
  card.dataset.profileFrame = frame;
  card.dataset.profilePattern = pattern;
  card.dataset.profileBadge = badge;
  card.dataset.profileNameplate = nameplate;
  card.dataset.profileEffect = effect;
  const avatarNode = editor.querySelector('#profile-preview-avatar');
  if (avatarNode) avatarNode.innerHTML = profileAvatarMarkup(avatar, displayName);
  const nameNode = editor.querySelector('#profile-preview-name');
  if (nameNode) nameNode.textContent = displayName;
  const levelNode = editor.querySelector('#profile-preview-level');
  if (levelNode) levelNode.textContent = `LVL ${level} · ${levelTitle}${badge !== 'none' ? ` · ${badge.toUpperCase()}` : ''}`;
  const titleNode = editor.querySelector('#profile-preview-title');
  if (titleNode) {
    titleNode.textContent = title;
    titleNode.hidden = !title;
  }
  const bioNode = editor.querySelector('#profile-preview-bio');
  if (bioNode) {
    bioNode.textContent = bio;
    bioNode.hidden = !bio;
  }
  const bioCount = editor.querySelector('#profile-bio-count');
  const bioInput = editor.querySelector('#profile-bio');
  if (bioCount && bioInput) bioCount.textContent = bioInput.value.length;
  updateProfileAchievementShowcase();
}

async function saveProfileSettings() {
  const status = document.getElementById('profile-save-status');
  const button = document.querySelector('.profile-save-btn');
  const checkedValue = name => document.querySelector(`input[name="${name}"]:checked`)?.value;
  const payload = {
    tg_id,
    init_data: TG_INIT_DATA || '',
    display_name: '',
    bio: document.getElementById('profile-bio')?.value.trim() || '',
    accent: checkedValue('profile-accent') || 'gold',
    avatar: checkedValue('profile-avatar') || 'initial',
    profile_title: document.getElementById('profile-title')?.value.trim() || '',
    frame: checkedValue('profile-frame') || 'basic',
    pattern: checkedValue('profile-pattern') || 'none',
    badge: checkedValue('profile-badge') || 'none',
    nameplate: checkedValue('profile-nameplate') || 'none',
    effect: checkedValue('profile-effect') || 'none',
    featured_achievements: [...document.querySelectorAll('.profile-featured-achievement:checked')].map(input => input.value),
    show_game_history: Boolean(document.getElementById('profile-show_game_history')?.checked),
    show_balance: Boolean(document.getElementById('profile-show_balance')?.checked),
    show_total_games: Boolean(document.getElementById('profile-show_total_games')?.checked),
    show_inventory: Boolean(document.getElementById('profile-show_inventory')?.checked),
    show_join_date: Boolean(document.getElementById('profile-show_join_date')?.checked),
    show_achievements: Boolean(document.getElementById('profile-show_achievements')?.checked)
  };
  if (button) button.disabled = true;
  if (status) status.textContent = 'Сохраняем...';
  try {
    const response = await fetch(`${API}/api/profile/settings`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const responseText = await response.text();
    let data = {};
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (_) {
      const contentType = response.headers.get('content-type') || '';
      const isHtml = contentType.includes('text/html') || responseText.trimStart().startsWith('<');
      throw new Error(isHtml
        ? `Сервер запущен со старым кодом (HTTP ${response.status}). Перезапусти mini_app.py`
        : `Сервер вернул некорректный ответ (HTTP ${response.status})`);
    }
    if (!response.ok || data.error) throw new Error(data.error || 'save_failed');
    if (status) status.textContent = 'Профиль сохранён';
    showToast('Настройки профиля сохранены', 'win');
    setTimeout(loadProfile, 350);
  } catch (error) {
    console.error('[PROFILE] save failed', error);
    if (status) status.textContent = `Не удалось сохранить: ${error.message || 'ошибка сервера'}`;
    showToast('Не удалось сохранить профиль', 'lose');
  } finally {
    if (button) button.disabled = false;
  }
}

async function loadProfile() {
  const el = document.getElementById('profile-content');
  el.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:30px;font-family:\'Space Mono\',monospace;font-size:12px">Загрузка...</div>';

  try {
    const res = await fetch(`${API}/api/profile`, {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tg_id })
});
    const d = await res.json();

    if (d.error) {
      el.innerHTML = '<div style="color:var(--red);font-size:13px;padding:20px">Ошибка: ' + escHtml(d.error) + '</div>';
      return;
    }

    const s    = d.stats       || {};
    const u    = d.user        || {};
    const hist = d.history     || [];
    const inv  = d.inventory   || [];
    const deps = d.deposits    || [];
    const wds  = d.withdrawals || [];
    const refs       = d.referral_count        || 0;
    const refsList   = d.referrals_list        || [];
    const refsIncome = d.total_referral_income || 0;
    const ps = d.profile_settings || {};
    const progressionData = d.progression || {};
    syncAchievementCelebrations(progressionData.achievements || {});

    const srcLabel = function(s) {
      return ({shop:'🛒 Магазин', case:'📦 Кейс', trade:'🔄 Трейд'})[s] || s;
    };

    // ── Публичная шапка профиля ──────────────────
    let html = '';
    const rawProfileName = u.roblox_username || 'ИГРОК';
    const selfFeaturedAchievements = selectedProfileAchievementsFromProgression(progressionData, ps);
    html += `${renderProfileHeroCard({settings: ps, name: rawProfileName, username: u.roblox_username || 'игрок', level: progressionData.level, levelTitle: progressionData.level_title, totalGames: s.total_games, achievements: selfFeaturedAchievements, meta: `в BrainBet с ${u.created_at || '—'}`, className: 'self-profile-hero'})}
    <section class="profile-private-meta"><span>ID <b>${u.tg_id || tg_id}</b></span><span>РЕФКОД <b>${escHtml(u.referral_code || '—')}</b></span><span>РЕФЕРАЛОВ <b>${refs}</b></span></section>
    ${renderProfileSectionLauncher(progressionData)}
    ${renderProfileProgression(progressionData)}
    ${renderProfileAchievements(progressionData, ps)}
    ${renderProfileSettings(ps, u.roblox_username || 'Игрок', progressionData, `в BrainBet с ${u.created_at || '—'}`, u)}`;
    // ── Инвентарь ─────────────────────────────────
    var invRows = '';
    if (inv.length) {
      inv.forEach(function(i) {
        invRows += '<div style="display:flex;justify-content:space-between;align-items:center;' +
                   'padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">';
        invRows += '<span>' + escHtml(i.emoji||'🧠') + ' <span style="color:var(--text)">' + escHtml(i.item_name||'Предмет') + '</span>' +
                   '<span style="color:var(--text-dim);font-size:10px;margin-left:6px">' + escHtml(srcLabel(i.source)) + '</span>' +
                   (i.frozen ? '<span style="color:var(--accent);font-size:10px;margin-left:4px">🔒</span>' : '') + '</span>';
        invRows += '<span style="color:var(--text-dim);font-size:10px">' + escHtml(i.rarity||'') + '</span>';
        invRows += '</div>';
      });
    } else {
      invRows = '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Инвентарь пуст</div>';
    }
    html += section('🎒 ИНВЕНТАРЬ', inv.length, invRows);

    // ── Пополнения ────────────────────────────────
    var depRows = '';
    if (deps.length) {
      deps.forEach(function(dep) {
        depRows += '<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">';
        depRows += '<div style="display:flex;justify-content:space-between">';
        depRows += '<span style="color:var(--text)">' + escHtml(dep.items_text||'—') + '</span>';
        depRows += '<span style="color:var(--green);font-family:\'Space Mono\',monospace">+' + (dep.total_cost||0) + ' 🧠</span>';
        depRows += '</div>';
        depRows += '<div style="color:var(--text-dim);font-size:10px;margin-top:2px;font-family:\'Space Mono\',monospace">' + escHtml(dep.created_at||'—') + '</div>';
        depRows += '</div>';
      });
    } else {
      depRows = '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет пополнений</div>';
    }
    html += section('💳 ПОПОЛНЕНИЯ', deps.length, depRows);

    // ── Выводы ────────────────────────────────────
    var wdRows = '';
    if (wds.length) {
      wds.forEach(function(w) {
        var statusBg    = w.status === 'done' ? 'rgba(0,255,136,.15)' : w.status === 'pending' ? 'rgba(245,197,66,.15)' : 'var(--surface2)';
        var statusColor = w.status === 'done' ? 'var(--green)'        : w.status === 'pending' ? 'var(--gold)'          : 'var(--text-dim)';
        wdRows += '<div style="padding:5px 0;border-bottom:1px solid var(--border);font-size:12px">';
        wdRows += '<div style="display:flex;justify-content:space-between;align-items:center">';
        wdRows += '<span style="color:var(--text)">' + escHtml(w.item_names||'—') + '</span>';
        wdRows += '<span style="font-family:\'Space Mono\',monospace;font-size:10px;padding:2px 8px;' +
                  'clip-path:polygon(3px 0, 100% 0, calc(100% - 3px) 100%, 0 100%);' +
                  'background:' + statusBg + ';color:' + statusColor + '">' + escHtml(w.status||'—') + '</span>';
        wdRows += '</div>';
        wdRows += '<div style="color:var(--text-dim);font-size:10px;margin-top:2px;font-family:\'Space Mono\',monospace">' +
                  escHtml(w.slot_date||'') + ' ' + escHtml(w.slot_start||'') + (w.slot_end ? '–' + escHtml(w.slot_end) : '') + ' МСК</div>';
        wdRows += '</div>';
      });
    } else {
      wdRows = '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет выводов</div>';
    }
    html += section('📤 ВЫВОДЫ', wds.length, wdRows);

    // ── Рефералы ──────────────────────────────────
    var refRows = '';
    refRows += '<div style="display:flex;justify-content:space-between;padding:8px 10px;' +
               'background:rgba(0,255,136,.04);border:1px solid rgba(0,255,136,.15);' +
               'clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%);margin-bottom:8px">';
    refRows += '<span style="font-size:12px;color:var(--text-dim)">Рефералов: <b style="color:var(--text)">' + refs + '</b></span>';
    refRows += '<span style="font-size:12px;color:var(--green);font-family:\'Space Mono\',monospace">+' + refsIncome + ' 🧠</span>';
    refRows += '</div>';
    if (refsList.length) {
      refsList.forEach(function(r) {
        refRows += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border)">';
        refRows += '<div><span style="color:var(--text);font-size:12px">tg: ' + r.tg_id + '</span>' +
                   '<span style="color:var(--text-dim);font-size:10px;margin-left:8px;font-family:\'Space Mono\',monospace">' + formatReferralDateTime(r.joined_at) + '</span></div>';
        refRows += '<div style="text-align:right">' +
                   '<div style="font-size:10px;color:var(--text-dim)">пополнено: ' + r.total_deposited + ' 🧠</div>' +
                   '<div style="font-size:12px;color:var(--green);font-family:\'Space Mono\',monospace">+' + r.referral_income + ' 🧠</div>' +
                   '</div>';
        refRows += '</div>';
      });
    } else {
      refRows += '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет рефералов</div>';
    }
    html += section('👥 РЕФЕРАЛЫ', refs, refRows);

    // ── История игр ───────────────────────────────
    var histRows = '';
    if (hist.length) {
      hist.forEach(function(g) {
        var isWin = (g.profit || 0) > 0;
        var dt;
        if (g.created_at && !isNaN(g.created_at)) {
          dt = new Date(g.created_at * 1000);
        } else if (typeof g.created_at === 'string') {
          dt = new Date(g.created_at.replace(' ', 'T'));
        } else {
          dt = new Date();
        }
        var timeStr = !isNaN(dt.getTime()) ? dt.toLocaleTimeString('ru', {hour:'2-digit', minute:'2-digit'}) : '—';
        var dateStr = !isNaN(dt.getTime()) ? dt.toLocaleDateString('ru', {day:'2-digit', month:'2-digit'}) : '—';
        var profitColor = isWin ? 'var(--green)' : 'var(--red)';
        var profitStr   = (isWin ? '+' : '') + Math.floor(g.profit || 0) + ' 🧠';

        histRows += '<div style="display:flex;justify-content:space-between;align-items:center;' +
                    'padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">';
        histRows += '<div>';
        histRows += '<span style="color:var(--text)">' + escHtml(g.game_type||'Игра') + '</span>';
        histRows += '<span style="color:var(--text-dim);font-size:10px;margin-left:6px;font-family:\'Space Mono\',monospace">' + dateStr + ' ' + timeStr + '</span>';
        histRows += '<span style="color:var(--text-dim);font-size:10px;margin-left:6px">ставка ' + Math.floor(g.bet||0) + '</span>';
        histRows += '</div>';
        histRows += '<span style="color:' + profitColor + ';font-family:\'Space Mono\',monospace;font-size:12px;font-weight:700">' + profitStr + '</span>';
        histRows += '</div>';
      });
    } else {
      histRows = '<div style="color:var(--text-dim);font-size:12px;padding:6px 0">Нет игр</div>';
    }
    html += section('📊 ИСТОРИЯ ИГР', hist.length, histRows);

    html += '<div style="height:24px"></div>';
    el.innerHTML = html;
    enhanceProfileLayout(el);

  } catch(e) {
    console.error('Profile error:', e);
    document.getElementById('profile-content').innerHTML =
      '<div style="color:var(--red);font-size:13px;padding:20px;font-family:\'Space Mono\',monospace">Ошибка загрузки профиля</div>';
  }
}

let publicProfileRequestVersion = 0;
let publicProfileLastFocus = null;

function preparePublicProfileOverlay() {
  const overlay = document.getElementById('public-profile-overlay');
  if (!overlay) return null;

  // A transformed game screen creates a new containing block on mobile.
  // Keeping the dialog at body level makes it a true viewport modal.
  if (overlay.parentElement !== document.body) document.body.appendChild(overlay);
  if (!overlay.dataset.publicProfileBound) {
    overlay.dataset.publicProfileBound = '1';
    overlay.addEventListener('pointerdown', event => {
      if (event.target === overlay) closePublicProfile();
    });
  }
  return overlay;
}

preparePublicProfileOverlay();

async function openPublicProfile(targetId) {
  const numericTarget = Number(targetId);
  if (!Number.isSafeInteger(numericTarget) || numericTarget <= 0) return;
  if (numericTarget === Number(tg_id)) {
    closePublicProfile();
    showGame('profile');
    return;
  }

  const overlay = preparePublicProfileOverlay();
  const content = document.getElementById('public-profile-content');
  if (!overlay || !content) return;
  const modal = overlay.querySelector('.public-profile-modal');
  const requestVersion = ++publicProfileRequestVersion;
  publicProfileLastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('public-profile-open');
  document.body.classList.add('public-profile-open');
  overlay.scrollTop = 0;
  if (modal) {
    modal.scrollTop = 0;
    modal.focus({ preventScroll: true });
  }
  content.innerHTML = '<div class="public-profile-loading">Загрузка профиля...</div>';

  try {
    const response = await fetch(`${API}/api/profile/public`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, target_id: numericTarget, init_data: TG_INIT_DATA || '' })
    });
    const data = await response.json();
    if (requestVersion !== publicProfileRequestVersion || !overlay.classList.contains('open')) return;
    if (!response.ok || data.error) throw new Error(data.error || 'profile_load_failed');
    const user = data.user || {};
    const stats = data.stats || {};
    const visibility = data.visibility || {};
    const history = Array.isArray(data.history) ? data.history : [];
    const inventory = Array.isArray(data.inventory) ? data.inventory : [];
    const achievements = data.achievements || {};
    const username = user.roblox_username || 'Игрок';
    const name = username;
    const featuredAchievements = visibility.achievements && Array.isArray(achievements.featured) ? achievements.featured : [];
    const joinMeta = visibility.join_date && user.created_at ? `с ${user.created_at}` : '';

    let openBlocks = '';
    if (visibility.balance) {
      openBlocks += `<section class="public-profile-balance"><small>ПУБЛИЧНЫЙ БАЛАНС</small><strong>${Math.floor(data.balance || 0).toLocaleString('ru-RU')} 🧠</strong></section>`;
    }
    if (visibility.game_history) {
      const rows = history.length ? history.map(game => {
        const rawDate = game.created_at;
        const date = rawDate == null
          ? null
          : (typeof rawDate === 'number' || /^\d+(?:\.\d+)?$/.test(String(rawDate)))
            ? new Date(Number(rawDate) * 1000)
            : new Date(String(rawDate).replace(' ', 'T'));
        const stamp = date && !isNaN(date.getTime()) ? date.toLocaleString('ru', {day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}) : '—';
        const profit = Math.floor(Number(game.profit || 0));
        return `<div><span><b>${escHtml(apmGameName(game.game_type))}</b><small>${stamp} · ставка ${Math.floor(Number(game.bet || 0))}</small></span><strong class="${profit >= 0 ? 'positive' : 'negative'}">${profit >= 0 ? '+' : ''}${profit} 🧠</strong></div>`;
      }).join('') : '<p>История пока пуста</p>';
      openBlocks += `<section class="public-profile-section"><header><b>ПОСЛЕДНИЕ МАТЧИ</b><span>${history.length}</span></header><div class="public-profile-list">${rows}</div></section>`;
    }
    if (visibility.inventory) {
      const items = inventory.length ? inventory.map(item => `<div><span><b>${escHtml(item.emoji || '🧠')} ${escHtml(item.item_name || 'Предмет')}</b><small>${escHtml(item.rarity || '')} ${escHtml(item.source || '')}</small></span></div>`).join('') : '<p>Инвентарь пуст</p>';
      openBlocks += `<section class="public-profile-section"><header><b>ИГРОВОЙ ИНВЕНТАРЬ</b><span>${inventory.length}</span></header><div class="public-profile-list">${items}</div></section>`;
    }
    if (visibility.achievements) {
      const featured = Array.isArray(achievements.featured) ? achievements.featured : [];
      const cards = featured.length ? featured.map(item => `<article><strong>${escHtml(item.icon)}</strong><span><b>${escHtml(item.title)}</b><small>${escHtml(item.description)}</small></span><i>+${Number(item.points || 0)} AP</i></article>`).join('') : '<p>Игрок пока не выбрал достижения для витрины</p>';
      openBlocks += `<section class="public-profile-section public-achievement-showcase"><header><b>ВИТРИНА ДОСТИЖЕНИЙ</b><span>${Number(achievements.completed || 0)}/${Number(achievements.total || 0)} · ${Number(achievements.points || 0)} AP</span></header><div>${cards}</div></section>`;
    }
    if (!openBlocks) {
      openBlocks = '<div class="public-profile-privacy"><b>ПРОФИЛЬ ЗАКРЫТ</b><span>Игрок пока не открыл дополнительные данные.</span></div>';
    }

    content.innerHTML = `${renderProfileHeroCard({settings: user, name, username, level: user.level, levelTitle: user.level_title, totalGames: stats.total_games, showGames: visibility.total_games, achievements: featuredAchievements, meta: joinMeta, className: 'public-profile-remote'})}${openBlocks}`;
  } catch (error) {
    if (requestVersion !== publicProfileRequestVersion || !overlay.classList.contains('open')) return;
    content.innerHTML = '<div class="public-profile-loading error">Не удалось открыть профиль</div>';
  }
}

function openPublicProfileFromKey(event, targetId) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openPublicProfile(targetId);
}

function playerProfileLink(targetId, name, isSelf = false) {
  const numericTarget = Number(targetId);
  const label = String(name || (numericTarget > 0 ? `Игрок #${numericTarget}` : 'Игрок'));
  if (!Number.isSafeInteger(numericTarget) || numericTarget <= 0) {
    return `<span class="player-profile-link is-disabled">${escHtml(label)}</span>`;
  }
  return `<button type="button" class="player-profile-link" onclick="openPublicProfile(${numericTarget})" aria-label="Open profile: ${escHtml(label)}"><span>${escHtml(label)}</span>${isSelf ? '<b>(Ты)</b>' : ''}</button>`;
}

function closePublicProfile() {
  const overlay = document.getElementById('public-profile-overlay');
  if (!overlay) return;
  publicProfileRequestVersion += 1;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  document.documentElement.classList.remove('public-profile-open');
  document.body.classList.remove('public-profile-open');
  const lastFocus = publicProfileLastFocus;
  publicProfileLastFocus = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  const overlay = document.getElementById('public-profile-overlay');
  if (event.key === 'Escape' && overlay?.classList.contains('open')) {
    event.preventDefault();
    closePublicProfile();
  }
});
// ══════════════════════════════════════════
// ФРИСПИН СЛОТЫ (whitelist, без ставок)
// ══════════════════════════════════════════

// ── Whitelist tg_id у кого есть доступ ─────
const FS_WHITELIST = [
  5644967254,
  1717934434,    // новый айди
];
// ═══════════════════════════════════════════════════════════════════════════
// ПРИЗМА — система фриспинов (whitelist only)
// Механика: кристаллы заряжаются энергией → внутри крутится цветовой вихрь
//            → кристалл "кристаллизуется" → финальный цвет проявляется
// НЕ казино: нет барабанов, нет одноруких бандитов — магический ритуал
// ═══════════════════════════════════════════════════════════════════════════

const FS_COLORS = [
  { emoji: '🔴', color: '#ff4444', name: 'red',    glow: 'rgba(255,68,68,0.6)'    },
  { emoji: '🟠', color: '#ff8c00', name: 'orange', glow: 'rgba(255,140,0,0.6)'    },
  { emoji: '🟡', color: '#ffd700', name: 'yellow', glow: 'rgba(255,215,0,0.6)'    },
  { emoji: '🟢', color: '#00cc66', name: 'green',  glow: 'rgba(0,204,102,0.6)'    },
  { emoji: '🔵', color: '#4488ff', name: 'blue',   glow: 'rgba(68,136,255,0.6)'   },
  { emoji: '🟣', color: '#9944ff', name: 'purple', glow: 'rgba(153,68,255,0.6)'   },
];

const FS_CELL_H = 52;
let fsCount    = 1;
let fsSpinning = false;
let fsEpicMode = false;
let fsMode     = 'ritual'; // 'ritual' | 'chaos'

// ── Переключение режима Призмы ───────────────────────────────────────────────
function fsSetMode(mode) {
  if (fsSpinning) return;   // ← блокируем переключение во время анимации
  fsMode = mode;
  document.querySelectorAll('.prism-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  const btn = document.getElementById('fs-btn');
  if (btn) {
    btn.querySelector('span').textContent = mode === 'chaos' ? '☠ РАЗРУШИТЬ' : '✦ ЗАРЯДИТЬ';
    btn.className = mode === 'chaos'
      ? 'play-btn prism-spin-btn prism-chaos-btn'
      : 'play-btn prism-spin-btn';
  }
  prismBuildArena(fsCount);
}

// ── Инициализация tab в nav ──────────────────────────────────────────────────
function fsInit() {
  if (!FS_WHITELIST.includes(tg_id)) return;
  if (document.getElementById('tab-freeslots')) return;

  const btn = document.createElement('button');
  btn.className = 'nav-btn';
  btn.id        = 'tab-freeslots';
  btn.innerHTML = navIconMarkup('prism') + '<span>Призма</span>';
  btn.onclick   = () => showGame('freeslots');
  document.querySelector('.nav').appendChild(btn);

  prismBuildArena(1);
}

// ── Выбор кол-ва кристаллов ──────────────────────────────────────────────────
function fsPick(n) {
  if (fsSpinning) return;   // ← блокируем во время анимации
  fsCount = n;
  document.querySelectorAll('.prism-count-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.n) === n);
  });
  prismBuildArena(n);
}

// ═══════════════════════════════════════════════════════════════════════════
// DOM — строим арену с кристаллами
// ═══════════════════════════════════════════════════════════════════════════
function prismBuildArena(n) {
  const arena = document.getElementById('prism-arena');
  if (!arena) return;
  arena.innerHTML = '';

  for (let i = 0; i < n; i++) {
    const crystal = document.createElement('div');
    crystal.className = 'prism-crystal';
    crystal.id = `prism-c${i}`;

    // SVG кристалл (шестигранник)
    crystal.innerHTML = `
      <div class="prism-crystal-wrap">
        <svg class="prism-svg" viewBox="0 0 80 92" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="pcg${i}" cx="50%" cy="40%" r="60%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/>
              <stop offset="60%" stop-color="#8888ff" stop-opacity="0.6"/>
              <stop offset="100%" stop-color="#220044" stop-opacity="0.9"/>
            </radialGradient>
            <filter id="pcf${i}">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur"/>
              <feColorMatrix in="blur" type="saturate" values="3"/>
            </filter>
          </defs>
          <!-- Тело кристалла -->
          <polygon class="prism-body" id="prism-body-${i}"
            points="40,4 76,24 76,68 40,88 4,68 4,24"
            fill="url(#pcg${i})" stroke="rgba(180,120,255,0.5)" stroke-width="1.5"/>
          <!-- Внутренние грани (блики) -->
          <polygon points="40,4 76,24 40,46" fill="rgba(255,255,255,0.08)" stroke="none"/>
          <polygon points="4,24 40,4 40,46" fill="rgba(255,255,255,0.04)" stroke="none"/>
          <polygon points="4,68 40,88 40,46" fill="rgba(0,0,0,0.15)" stroke="none"/>
          <!-- Центральный блик -->
          <ellipse cx="35" cy="30" rx="10" ry="7" fill="rgba(255,255,255,0.18)" transform="rotate(-15,35,30)"/>
          <!-- Ореол цвета (скрыт до раскрытия) -->
          <polygon class="prism-color-fill" id="prism-fill-${i}"
            points="40,4 76,24 76,68 40,88 4,68 4,24"
            fill="transparent" stroke="none" opacity="0"/>
        </svg>
        <!-- Частицы внутри кристалла -->
        <canvas class="prism-canvas" id="prism-cv${i}" width="80" height="92"></canvas>
        <!-- Символ цвета (проявляется в конце) -->
        <div class="prism-emoji" id="prism-emoji-${i}">?</div>
      </div>
      <div class="prism-label" id="prism-label-${i}">— — —</div>
    `;
    arena.appendChild(crystal);
  }

  // Сброс результата
  const rr = document.getElementById('prism-result-row');
  if (rr) rr.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════════════════════
// ГЛАВНАЯ ФУНКЦИЯ СПИНА
// ═══════════════════════════════════════════════════════════════════════════
async function fsSpin() {
  if (fsSpinning) return;
  fsSpinning = true;

  const btn = document.getElementById('fs-btn');
  btn.disabled = true;

  // Визуально блокируем переключатели режима и кол-ва кристаллов
  document.querySelectorAll('.prism-mode-btn, .prism-count-btn').forEach(b => {
    b.style.opacity = '0.35';
    b.style.pointerEvents = 'none';
  });

  if (fsMode === 'chaos') {
    btn.querySelector('span').textContent = '☠ ХАОС...';
    prismBuildArena(fsCount);
    // Пульс сразу при нажатии
    document.body.classList.add('chaos-pulse');
    await sleep(600);
    document.body.classList.remove('chaos-pulse');
    await sleep(60);
    const finals = Array.from({ length: fsCount }, () =>
      FS_COLORS[Math.floor(Math.random() * FS_COLORS.length)]
    );
    await prismSpinChaos(finals);
    prismShowResult(finals);
    btn.disabled = false;
    btn.querySelector('span').textContent = '☠ РАЗРУШИТЬ';
    document.querySelectorAll('.prism-mode-btn, .prism-count-btn').forEach(b => {
      b.style.opacity = '';
      b.style.pointerEvents = '';
    });
  } else {
    btn.querySelector('span').textContent = '✦ РИТУАЛ...';
    prismBuildArena(fsCount);
    await sleep(80);
    const finals = Array.from({ length: fsCount }, () =>
      FS_COLORS[Math.floor(Math.random() * FS_COLORS.length)]
    );
    // Храним функции остановки переливания для каждого кристалла
const shimmerStops = [];

for (let i = 0; i < fsCount; i++) {
  await prismChargeOne(i, finals[i]);
  // Если ещё есть кристаллы после — запускаем переливание на только что заряженном
  if (i < fsCount - 1) {
    shimmerStops.push(prismStartShimmer(i, finals[i]));
    await sleep(250);
  }
}

// Останавливаем все переливания перед финальной гармонией
shimmerStops.forEach(stop => stop());
    if (fsCount > 1) {
      await sleep(200);
      await prismFinalHarmony(finals);
    }
    prismShowResult(finals);
    btn.disabled = false;
    btn.querySelector('span').textContent = '✦ ЗАРЯДИТЬ';
    document.querySelectorAll('.prism-mode-btn, .prism-count-btn').forEach(b => {
      b.style.opacity = '';
      b.style.pointerEvents = '';
    });
  }

  fsSpinning = false;
}

// ═══════════════════════════════════════════════════════════════════════════
// ХАОС-РЕЖИМ — психоделический взрыв
// Кристаллы бешено мигают всеми цветами одновременно,
// экран трясётся волнами, в конце — резкое замирание на финале
// ═══════════════════════════════════════════════════════════════════════════
async function prismSpinChaos(finals) {
  const arena = document.getElementById('prism-arena');
  const app   = document.body;
  const TOTAL_MS = 2800; // общее время хаоса

  // ── Фаза 1: все кристаллы бешено мигают (~2.2с) ──────────────────────────
  const flashStart = Date.now();
  const FLASH_MS   = 2200;

  // Интервал: каждые ~50ms меняем цвета всем кристаллам случайно
  // + периодически трясём экран
  let shakeCount = 0;
  const shakeAt = [300, 650, 1000, 1400, 1750, 2050]; // ms когда трясём

  await new Promise(resolve => {
    let lastShake = 0;

    function tick() {
      const elapsed = Date.now() - flashStart;
      if (elapsed >= FLASH_MS) { resolve(); return; }

      const progress = elapsed / FLASH_MS; // 0→1

      // Скорость мигания нарастает: от 80ms до 20ms интервала
      const flickerMs = 80 - progress * 60;

      // Красим все кристаллы в случайные цвета
      for (let i = 0; i < finals.length; i++) {
        const crystalEl = document.getElementById(`prism-c${i}`);
        const fill      = document.getElementById(`prism-fill-${i}`);
        const label     = document.getElementById(`prism-label-${i}`);
        const emojiEl   = document.getElementById(`prism-emoji-${i}`);
        if (!crystalEl) continue;

        const rndColor = FS_COLORS[Math.floor(Math.random() * FS_COLORS.length)];

        // Заливка кристалла случайным цветом
        if (fill) {
          fill.setAttribute('fill', rndColor.color);
          fill.setAttribute('opacity', String(0.3 + Math.random() * 0.6));
        }

        // Свечение
        const glowSize = 6 + Math.random() * 22;
        crystalEl.style.filter = `drop-shadow(0 0 ${glowSize}px ${rndColor.color}) brightness(${0.9 + Math.random() * 0.8})`;

        // Эмодзи мигает случайными
        if (emojiEl) {
          emojiEl.textContent = Math.random() > 0.4 ? rndColor.emoji : '?';
          emojiEl.style.opacity = String(Math.random() > 0.3 ? 1 : 0);
          emojiEl.style.textShadow = `0 0 16px ${rndColor.color}`;
        }

        // Лейбл мелькает
        if (label) {
          label.textContent = Math.random() > 0.5 ? rndColor.name.toUpperCase() : '???';
          label.style.color = rndColor.color;
        }

        // Случайные частицы наружу (редко)
        if (Math.random() > 0.85) {
          diceSpawnParticles(crystalEl, rndColor.color, 4, 'all');
        }
      }

      // Тряска экрана в заданные моменты
      shakeAt.forEach(t => {
        if (elapsed >= t && elapsed < t + flickerMs + 10 && app) {
          app.classList.remove('chaos-screen-shake');
          void app.offsetWidth;
          // Чередуем силу тряски: нарастает к середине, потом убывает
          const intensity = Math.sin(progress * Math.PI);
          app.style.setProperty('--chaos-shake', String(intensity));
          app.classList.add('chaos-screen-shake');
          setTimeout(() => app.classList.remove('chaos-screen-shake'), 280);
        }
      });

      // Мигание фона арены
      if (arena) {
        const bg = FS_COLORS[Math.floor(Math.random() * FS_COLORS.length)];
        arena.style.background = `radial-gradient(ellipse at center, ${bg.color}18 0%, transparent 70%)`;
      }

      setTimeout(tick, flickerMs);
    }

    setTimeout(tick, 0);
  });

  // ── Финальная тряска-взрыв ────────────────────────────────────────────────
  if (app) {
    app.classList.remove('chaos-screen-shake');
    void app.offsetWidth;
    app.style.setProperty('--chaos-shake', '1');
    app.classList.add('chaos-screen-shake');
    setTimeout(() => app.classList.remove('chaos-screen-shake'), 400);
  }

  // Большой взрыв частиц со всех кристаллов
  for (let i = 0; i < finals.length; i++) {
    const crystalEl = document.getElementById(`prism-c${i}`);
    if (crystalEl) {
      diceSpawnParticles(crystalEl, finals[i].color, 18, 'all');
      diceSpawnRing(crystalEl, finals[i].color);
    }
  }

  await sleep(120);

  // ── Фаза 2: резкое замирание — каждый кристалл вспыхивает финальным цветом
  for (let i = 0; i < finals.length; i++) {
    const crystalEl = document.getElementById(`prism-c${i}`);
    const fill      = document.getElementById(`prism-fill-${i}`);
    const emojiEl   = document.getElementById(`prism-emoji-${i}`);
    const label     = document.getElementById(`prism-label-${i}`);
    if (!crystalEl) continue;

    const fc = finals[i];

    // Резко ставим финальный цвет
    if (fill) {
      fill.setAttribute('fill', fc.color);
      fill.setAttribute('opacity', '0.75');
    }

    crystalEl.style.filter = `drop-shadow(0 0 28px ${fc.color}) brightness(1.4)`;
    crystalEl.classList.add('chaos-crystal-lock');

    if (emojiEl) {
      emojiEl.textContent   = fc.emoji;
      emojiEl.style.opacity = '1';
      emojiEl.style.textShadow = `0 0 24px ${fc.color}, 0 0 8px #fff`;
    }
    if (label) {
      label.textContent = fc.name.toUpperCase();
      label.style.color = fc.color;
      label.style.textShadow = `0 0 10px ${fc.glow}`;
    }

    // Ещё один взрыв при финальном проявлении
    diceSpawnParticles(crystalEl, fc.color, 10, 'burst');
    setTimeout(() => diceSpawnRing(crystalEl, fc.color), 60);

    // Небольшое смещение между кристаллами для драматизма
    await sleep(80 + i * 60);
    crystalEl.style.filter = `drop-shadow(0 0 18px ${fc.color})`;
  }

  // Сбрасываем фон арены
  if (arena) arena.style.background = '';

  await sleep(200);
}

// ═══════════════════════════════════════════════════════════════════════════
// ЗАРЯДКА ОДНОГО КРИСТАЛЛА
// Фаза 1: частицы хаотично летают внутри (1.5с)
// Фаза 2: частицы закручиваются (0.8с)
// Фаза 3: вспышка → кристалл окрашивается (0.6с)
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// ПЕРЕЛИВАНИЕ — уже заряженный кристалл пульсирует пока другие заряжаются
// ═══════════════════════════════════════════════════════════════════════════
function prismStartShimmer(idx, finalColor) {
  const crystalEl = document.getElementById(`prism-c${idx}`);
  const fill = document.getElementById(`prism-fill-${idx}`);
  const cv = document.getElementById(`prism-cv${idx}`);
  if (!crystalEl || !fill || !cv) return () => {};

  const ctx = cv.getContext('2d');
  const W = 80, H = 92, CX = 40, CY = 46;
  let running = true;
  const startTime = Date.now();

  // Маленькие светящиеся частицы внутри заряженного кристалла
  const glowParticles = Array.from({ length: 12 }, () => ({
    x: 15 + Math.random() * 50,
    y: 10 + Math.random() * 72,
    vx: (Math.random() - 0.5) * 0.8,
    vy: (Math.random() - 0.5) * 0.8,
    r: 0.8 + Math.random() * 1.5,
    phase: Math.random() * Math.PI * 2,  // случайная фаза для мерцания
  }));

  function loop() {
    if (!running) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    const t = (Date.now() - startTime) / 1000; // секунды

    // Пульсация свечения кристалла (медленная, 2с цикл)
    const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI); // 0..1
    const glowSize = 10 + pulse * 16;
    const brightness = 1.0 + pulse * 0.35;
    crystalEl.style.filter = `drop-shadow(0 0 ${glowSize}px ${finalColor.color}) brightness(${brightness})`;

    // Пульсация прозрачности заливки (переливание)
    const fillOpacity = 0.55 + pulse * 0.25;
    fill.setAttribute('opacity', String(fillOpacity));

    // Рисуем частицы внутри
    ctx.clearRect(0, 0, W, H);
    glowParticles.forEach(p => {
      // Движение
      p.x += p.vx;
      p.y += p.vy;
      p.phase += 0.06;

      // Отражение от границ
      if (p.x < 10 || p.x > 70) p.vx *= -1;
      if (p.y < 10 || p.y > 82) p.vy *= -1;

      // Мерцание прозрачности у каждой частицы
      const alpha = 0.3 + 0.7 * Math.abs(Math.sin(p.phase));

      ctx.save();
      ctx.shadowColor = finalColor.color;
      ctx.shadowBlur = p.r * 4;
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = finalColor.color;
      ctx.fill();
      ctx.restore();
    });

    // Редкие вспышки — случайная искра раз в ~1.5с
    if (Math.random() < 0.008) {
      const sx = 15 + Math.random() * 50;
      const sy = 10 + Math.random() * 72;
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, 8 + Math.random() * 8);
      grd.addColorStop(0, finalColor.color + 'cc');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.globalAlpha = 0.6 + Math.random() * 0.4;
      ctx.fillStyle = grd;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);

  // Возвращаем функцию остановки
  return () => { running = false; };
}
async function prismChargeOne(idx, finalColor) {
  const cv = document.getElementById(`prism-cv${idx}`);
  const fill = document.getElementById(`prism-fill-${idx}`);
  const emojiEl = document.getElementById(`prism-emoji-${idx}`);
  const labelEl = document.getElementById(`prism-label-${idx}`);
  const crystalWrap = document.querySelector(`#prism-c${idx} .prism-crystal-wrap`);

  if (!cv) return;
  const ctx = cv.getContext('2d');
  const W = 80, H = 92;

  // Частицы внутри кристалла
  const hexPoints = [{x:40,y:4},{x:76,y:24},{x:76,y:68},{x:40,y:88},{x:4,y:68},{x:4,y:24}];

  class InnerParticle {
    constructor() { this.reset(true); }
    reset(init = false) {
      // Стартуем из центра или random внутри
      this.x = 30 + Math.random() * 20;
      this.y = 30 + Math.random() * 32;
      this.vx = (Math.random() - 0.5) * 2.5;
      this.vy = (Math.random() - 0.5) * 2.5;
      // Случайный цвет из всех
      const c = FS_COLORS[Math.floor(Math.random() * FS_COLORS.length)];
      this.color = c.color;
      this.r = 1.2 + Math.random() * 2.2;
      this.alpha = 0.5 + Math.random() * 0.5;
      this.life = 0;
      this.maxLife = 60 + Math.random() * 80;
    }
    update(phase, t, cx, cy) {
      this.life++;
      if (phase === 'attract') {
        // Вихрь к центру
        const dx = cx - this.x, dy = cy - this.y;
        const dist = Math.sqrt(dx*dx+dy*dy)||1;
        const force = 0.12 + t * 0.5;
        this.vx += dx/dist * force - dy/dist * force * 0.6;
        this.vy += dy/dist * force + dx/dist * force * 0.6;
        const spd = Math.sqrt(this.vx*this.vx+this.vy*this.vy);
        if (spd > 5) { this.vx=this.vx/spd*5; this.vy=this.vy/spd*5; }
        // Перекрашиваем в финальный цвет постепенно
        this.color = finalColor.color;
      } else {
        // Хаотичное движение
        this.vx += (Math.random()-0.5)*0.3;
        this.vy += (Math.random()-0.5)*0.3;
        const spd = Math.sqrt(this.vx*this.vx+this.vy*this.vy);
        if (spd > 2.5) { this.vx=this.vx/spd*2.5; this.vy=this.vy/spd*2.5; }
      }
      this.x += this.vx; this.y += this.vy;
      // Отражение от граней (упрощённо — bbox шестигранника)
      if (this.x < 8)  { this.x = 8;  this.vx = Math.abs(this.vx); }
      if (this.x > 72) { this.x = 72; this.vx = -Math.abs(this.vx); }
      if (this.y < 8)  { this.y = 8;  this.vy = Math.abs(this.vy); }
      if (this.y > 84) { this.y = 84; this.vy = -Math.abs(this.vy); }
      if (this.life > this.maxLife) this.reset();
    }
    draw(ctx) {
      ctx.save();
      ctx.shadowColor = this.color;
      ctx.shadowBlur = this.r * 3;
      ctx.globalAlpha = this.alpha;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r, 0, Math.PI*2);
      ctx.fillStyle = this.color;
      ctx.fill();
      ctx.restore();
    }
  }

  const particles = Array.from({length: 28}, () => new InnerParticle());
  const CX = 40, CY = 46;

  // ── Фаза 1: хаотичный полёт (1.5с) ─────────────────────────────────────
  // Подсветка кристалла — он "пробуждается"
  crystalWrap?.classList.add('prism-charging');

  const phase1Ms = 1500;
  const p1Start = Date.now();
  await new Promise(resolve => {
    function loop() {
      const t = Math.min((Date.now() - p1Start) / phase1Ms, 1);
      ctx.clearRect(0, 0, W, H);
      // Внутреннее свечение нарастает
      const grd = ctx.createRadialGradient(CX, CY, 0, CX, CY, 35);
      grd.addColorStop(0, `rgba(140,80,255,${0.04 + t * 0.08})`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

      particles.forEach(p => { p.update('idle', t, CX, CY); p.draw(ctx); });
      if (t < 1) requestAnimationFrame(loop); else resolve();
    }
    requestAnimationFrame(loop);
  });

  // ── Фаза 2: вихрь (0.8с) ────────────────────────────────────────────────
  labelEl.textContent = '⟳ РЕЗОНАНС...';
  labelEl.style.color = finalColor.color;

  const phase2Ms = 800;
  const p2Start = Date.now();
  await new Promise(resolve => {
    function loop() {
      const t = Math.min((Date.now() - p2Start) / phase2Ms, 1);
      ctx.clearRect(0, 0, W, H);

      // Нарастающий вихрь
      const grd = ctx.createRadialGradient(CX, CY, 0, CX, CY, 30 + (1-t)*15);
      grd.addColorStop(0, finalColor.color + Math.floor(t * 120).toString(16).padStart(2,'0'));
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);

      particles.forEach(p => { p.update('attract', t, CX, CY); p.draw(ctx); });
      if (t < 1) requestAnimationFrame(loop); else resolve();
    }
    requestAnimationFrame(loop);
  });

  // ── Фаза 3: кристаллизация (0.6с) ────────────────────────────────────────
  ctx.clearRect(0, 0, W, H);
  crystalWrap?.classList.remove('prism-charging');
  crystalWrap?.classList.add('prism-crystallized');

  // Анимируем заливку кристалла нужным цветом
  const phase3Ms = 600;
  const p3Start = Date.now();
  await new Promise(resolve => {
    function loop() {
      const t = Math.min((Date.now() - p3Start) / phase3Ms, 1);
      const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic

      // Заполняем polygon цветом
      if (fill) {
        fill.setAttribute('fill', finalColor.color);
        fill.setAttribute('opacity', String(ease * 0.72));
      }

      // Свечение кристалла через CSS
      const crystalEl = document.getElementById(`prism-c${idx}`);
      if (crystalEl) {
        crystalEl.style.filter = `drop-shadow(0 0 ${8 + ease * 18}px ${finalColor.color})`;
      }

      // Вспышка частиц наружу
      if (t > 0.3 && t < 0.7) {
        const flashT = (t - 0.3) / 0.4;
        ctx.clearRect(0, 0, W, H);
        const grd = ctx.createRadialGradient(CX, CY, 0, CX, CY, flashT * 50);
        grd.addColorStop(0, `rgba(255,255,255,${(1-flashT)*0.8})`);
        grd.addColorStop(0.4, finalColor.color + Math.floor((1-flashT)*160).toString(16).padStart(2,'0'));
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
      } else if (t >= 0.7) {
        ctx.clearRect(0, 0, W, H);
      }

      if (t < 1) requestAnimationFrame(loop); else resolve();
    }
    requestAnimationFrame(loop);
  });

  // Финал — показываем emoji и подпись
  emojiEl.textContent = finalColor.emoji;
  emojiEl.style.opacity = '1';
  emojiEl.style.textShadow = `0 0 20px ${finalColor.color}`;

  labelEl.textContent = finalColor.name.toUpperCase();
  labelEl.style.color = finalColor.color;
  labelEl.style.textShadow = `0 0 12px ${finalColor.glow}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ФИНАЛЬНАЯ ГАРМОНИЯ — все кристаллы пульсируют вместе
// ═══════════════════════════════════════════════════════════════════════════
async function prismFinalHarmony(finals) {
  const crystals = finals.map((_, i) => document.getElementById(`prism-c${i}`));

  // Синхронный пульс 3 раза
  for (let pulse = 0; pulse < 3; pulse++) {
    const pMs = 350, pStart = Date.now();
    await new Promise(resolve => {
      function loop() {
        const t = Math.min((Date.now() - pStart) / pMs, 1);
        const scale = 1 + Math.sin(t * Math.PI) * 0.08;
        crystals.forEach((c, i) => {
          if (c) c.style.transform = `scale(${scale})`;
        });
        if (t < 1) requestAnimationFrame(loop);
        else {
          crystals.forEach(c => { if (c) c.style.transform = ''; });
          resolve();
        }
      }
      requestAnimationFrame(loop);
    });
    await sleep(80);
  }

  // Вспышка-связь между кристаллами (линии на canvas поверх арены)
  const arena = document.getElementById('prism-arena');
  if (!arena || finals.length < 2) return;

  const lineCv = document.createElement('canvas');
  lineCv.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:10;width:100%;height:100%';
  lineCv.width = arena.offsetWidth || 300;
  lineCv.height = arena.offsetHeight || 120;
  arena.style.position = 'relative';
  arena.appendChild(lineCv);

  const lctx = lineCv.getContext('2d');

  // Позиции центров кристаллов
  const arenaRect = arena.getBoundingClientRect();
  const centers = finals.map((_, i) => {
    const c = document.getElementById(`prism-c${i}`);
    if (!c) return {x:0,y:0};
    const r = c.getBoundingClientRect();
    return {
      x: r.left - arenaRect.left + r.width/2,
      y: r.top  - arenaRect.top  + r.height/2
    };
  });

  const lineMs = 800, lineStart = Date.now();
  await new Promise(resolve => {
    function loop() {
      const t = Math.min((Date.now() - lineStart) / lineMs, 1);
      const alpha = t < 0.5 ? t/0.5 : 1 - (t-0.5)/0.5;
      lctx.clearRect(0, 0, lineCv.width, lineCv.height);

      for (let a = 0; a < centers.length; a++) {
        for (let b = a+1; b < centers.length; b++) {
          const grad = lctx.createLinearGradient(
            centers[a].x, centers[a].y,
            centers[b].x, centers[b].y
          );
          grad.addColorStop(0, finals[a].color + Math.floor(alpha*200).toString(16).padStart(2,'0'));
          grad.addColorStop(1, finals[b].color + Math.floor(alpha*200).toString(16).padStart(2,'0'));
          lctx.save();
          lctx.strokeStyle = grad;
          lctx.lineWidth = 1.5;
          lctx.shadowColor = finals[a].color;
          lctx.shadowBlur = 6;
          lctx.globalAlpha = alpha * 0.8;
          lctx.setLineDash([4,6]);
          lctx.lineDashOffset = -(t * 20);
          lctx.beginPath();
          lctx.moveTo(centers[a].x, centers[a].y);
          lctx.lineTo(centers[b].x, centers[b].y);
          lctx.stroke();
          lctx.restore();
        }
      }
      if (t < 1) requestAnimationFrame(loop);
      else { lineCv.remove(); resolve(); }
    }
    requestAnimationFrame(loop);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// РЕЗУЛЬТАТ
// ═══════════════════════════════════════════════════════════════════════════
function prismShowResult(finals) {
  const rr = document.getElementById('prism-result-row');
  if (!rr) return;

  const counts = {};
  finals.forEach(f => { counts[f.name] = (counts[f.name]||0)+1; });
  const dominant = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  const domColor = FS_COLORS.find(c=>c.name===dominant[0]);

  rr.innerHTML = finals.map(f =>
    `<span class="prism-res-dot" style="background:${f.color};box-shadow:0 0 8px ${f.color}"></span>`
  ).join('');

  rr.style.display = 'flex';
  rr.style.justifyContent = 'center';
  rr.style.gap = '8px';
  rr.style.marginTop = '12px';
  rr.style.padding = '10px';
  rr.style.borderRadius = '12px';
  rr.style.background = `linear-gradient(135deg, ${domColor?.color || '#444'}22, transparent)`;
  rr.style.border = `1px solid ${domColor?.color || '#444'}44`;
}

// Заглушки для совместимости
function fsToggleEpic() {}
function fsBuildReels() {}

// freeslots инициализация встроена в оригинальный showGame выше
async function submitUsernameChange() {
  const input = document.getElementById('new-username-input');
  const msg   = document.getElementById('username-change-msg');
  const val   = (input?.value || '').trim();

  if (!val) { msg.style.color = 'var(--red)'; msg.textContent = 'Введи ник!'; return; }
  if (val.length < 3 || val.length > 20 || val.includes(' ')) {
    msg.style.color = 'var(--red)';
    msg.textContent = '3–20 символов, без пробелов';
    return;
  }
  const latinUsername = /^[A-Za-z0-9_]+$/;
  const cyrillicUsername = /^[А-Яа-яЁё0-9_]+$/;
  if (!latinUsername.test(val) && !cyrillicUsername.test(val)) {
    msg.style.color = 'var(--red)';
    msg.textContent = '❌ Используй только один алфавит: русский или английский';
    return;
  }
  if (val.toLowerCase().startsWith('user')) {
    msg.style.color = 'var(--red)';
    msg.textContent = '❌ Ник не может начинаться с "user"';
    return;
  }

  msg.style.color = 'var(--text-dim)';
  msg.textContent = 'Сохраняем...';

  try {
    const res  = await fetch(`${API}/api/profile/change_username`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tg_id, username: val })
    });
    const data = await res.json();

    if (data.success) {
      msg.style.color = 'var(--green)';
      msg.textContent = `Ник изменён на ${data.username}`;
      input.value = '';
      await loadInit();
      await pollAchievementCompletions();
      await loadProfile();
    } else if (data.error === 'cooldown') {
      msg.style.color = 'var(--red)';
      msg.textContent = `⏳ Подожди ещё ${data.days_left}д ${data.hours_left}ч`;
    } else if (data.error === 'username_taken') {
      msg.style.color = 'var(--red)';
      msg.textContent = '❌ Этот ник уже занят';
    } else if (data.error === 'username_reserved') {
      msg.style.color = 'var(--red)';
      msg.textContent = '❌ Ник не может начинаться с "user"';
    } else if (data.error === 'invalid_username') {
      msg.style.color = 'var(--red)';
      msg.textContent = '❌ 3–20 символов и только один алфавит';
    } else {
      msg.style.color = 'var(--red)';
      msg.textContent = 'Ошибка: ' + (data.error || 'неизвестно');
    }
  } catch (e) {
    msg.style.color = 'var(--red)';
    msg.textContent = 'Ошибка соединения';
  }
}
// ══════════════════════════════════════════
// ЛИДЕРБОРД
// ══════════════════════════════════════════

let _lbPeriod = 'week';
let _lbLoading = false;
let _lbReloadPending = false;
let _lbProcessedImage = null;
let _lbImageEditor = {
  file: null,
  url: null,
  image: null,
  scale: 1,
  minScale: 1,
  maxScale: 8,
  stretchX: 1,
  stretchY: 1,
  offsetX: 0,
  offsetY: 0,
  pointers: new Map(),
  gesture: null,
};

// ══════════════════════════════════════════
// РОЗЫГРЫШ (только для админа)
// ══════════════════════════════════════════

let _ldRunning = false;
let _ldPool = [];
let _ldPreviousBodyOverflow = '';
const LD_SPIN_DURATION = 25000;

function closeLuckyDraw() {
  const overlay = document.getElementById('lucky-draw-overlay');
  if (!overlay || overlay.style.display === 'none') return;
  overlay.style.display = 'none';
  document.body.style.overflow = _ldPreviousBodyOverflow;
  _ldRunning = false;
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeLuckyDraw();
});

const LD_COLORS = [
  '#f2bd35', '#ef6b3b', '#5ac878', '#4e8fe8', '#ae66d5',
  '#e65379', '#54c7c1', '#d3974d', '#7886df', '#a6c84d',
];

function ldDrawWheel(pool) {
  const canvas = document.getElementById('ld-wheel');
  if (!canvas) return [];
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const radius = center - 18;
  const total = pool.reduce((sum, entry) => sum + Number(entry.total_deposited || 0), 0);
  const separatorWidth = pool.length > 250 ? 0 : pool.length > 100 ? .65 : pool.length > 40 ? 1.2 : 3;
  context.clearRect(0, 0, size, size);
  context.save();
  context.translate(center, center);
  let angle = -Math.PI / 2;
  const slices = [];
  pool.forEach((entry, index) => {
    const weight = Number(entry.total_deposited || 0);
    const span = total ? Math.PI * 2 * weight / total : 0;
    const end = angle + span;
    const color = LD_COLORS[index % LD_COLORS.length];
    context.beginPath();
    context.moveTo(0, 0);
    context.arc(0, 0, radius, angle, end);
    context.closePath();
    context.fillStyle = color;
    context.fill();
    if (separatorWidth > 0) {
      context.strokeStyle = '#09090e';
      context.lineWidth = separatorWidth;
      context.stroke();
    }

    if (span > 0.12) {
      context.save();
      const labelAngle = angle + span / 2;
      context.rotate(labelAngle);
      context.translate(radius * .64, 0);
      if (Math.cos(labelAngle) < 0) context.rotate(Math.PI);
      const maxLength = span < .28 ? 5 : span < .5 ? 9 : 15;
      const label = String(entry.roblox_username || `user${entry.tg_id}`).slice(0, maxLength);
      context.fillStyle = '#09090e';
      context.font = `700 ${span < .23 ? 16 : 21}px Space Mono, monospace`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(label, 0, 0, radius * .46);
      context.restore();
    }
    slices.push({ entry, start: angle, end, center: angle + span / 2, color });
    angle = end;
  });
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.strokeStyle = '#f2bd35';
  context.lineWidth = 12;
  context.stroke();
  context.beginPath();
  context.arc(0, 0, radius - 16, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(9,9,14,.8)';
  context.lineWidth = 4;
  context.stroke();
  context.restore();
  return slices;
}

function ldRenderLegend(pool) {
  const legend = document.getElementById('ld-legend');
  if (!legend) return;
  const visibleLimit = pool.length > 24 ? 16 : pool.length;
  const visiblePool = pool.slice(0, visibleLimit);
  legend.innerHTML = visiblePool.map((entry, index) => `
    <div class="ld-legend-row">
      <i style="background:${LD_COLORS[index % LD_COLORS.length]}"></i>
      ${playerProfileLink(entry.tg_id, entry.roblox_username || `user${entry.tg_id}`)}
      <span>${Number(entry.chance_percent || 0).toLocaleString('ru-RU', {maximumFractionDigits:2})}%</span>
    </div>
  `).join('') + (pool.length > visibleLimit
    ? `<div class="ld-legend-more">И ЕЩЁ ${pool.length - visibleLimit} УЧАСТНИКОВ НА КОЛЕСЕ</div>`
    : '');
}

function ldRandomLandingAngle(slice) {
  const span = Math.max(0, slice.end - slice.start);
  if (!span) return slice.center;
  // Keep the pointer away from a separator so the visual result is unambiguous.
  const edgePadding = Math.min(span * .18, Math.PI / 90);
  const usableSpan = Math.max(0, span - edgePadding * 2);
  let randomUnit = Math.random();
  if (window.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    randomUnit = value[0] / 0x100000000;
  }
  return slice.start + edgePadding + usableSpan * randomUnit;
}

function ldAnimateWheel(canvas, targetDegrees, duration) {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const actualDuration = reduceMotion ? 500 : duration;
  return new Promise(resolve => {
    const started = performance.now();
    const ease = t => 1 - Math.pow(1 - t, 5);
    function frame(now) {
      const progress = Math.min(1, (now - started) / actualDuration);
      canvas.style.transform = `rotate(${targetDegrees * ease(progress)}deg)`;
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });
}

function ldRenderResult(data) {
  const resultEl = document.getElementById('ld-result');
  const winner = data?.winner;
  if (!resultEl || !winner) return;
  resultEl.innerHTML = `
    <div class="ld-result-label">РЕЗУЛЬТАТ ЗАФИКСИРОВАН</div>
    <div class="ld-result-name">${playerProfileLink(winner.tg_id, winner.roblox_username)}</div>
    <div class="ld-result-meta">
      <b>ПОПОЛНИЛ: ${Number(winner.total_deposited).toLocaleString('ru-RU')} 🧠</b>
      <span>${Number(winner.total_deposited).toLocaleString('ru-RU')} билетов · шанс ${Number(winner.chance_percent).toLocaleString('ru-RU', {maximumFractionDigits:2})}%</span>
    </div>`;
  resultEl.style.display = 'block';
}

async function openLuckyDraw() {
  if (_ldRunning) return;
  if (_lbPeriod === 'all') {
    showToast('Для раздела «Всё время» розыгрыша нет', 'lose');
    return;
  }
  const overlay = document.getElementById('lucky-draw-overlay');
  const canvas = document.getElementById('ld-wheel');
  const subtitle = document.getElementById('ld-subtitle');
  const resultEl = document.getElementById('ld-result');
  const legend = document.getElementById('ld-legend');
  const empty = document.getElementById('ld-empty');
  const runBtn = document.getElementById('ld-run-btn');
  const rerollBtn = document.getElementById('ld-reroll-btn');
  const viewerNote = document.getElementById('ld-viewer-note');
  const periodLabels = { day: 'СЕГОДНЯ', yesterday: 'ВЧЕРА', week: 'ЭТА НЕДЕЛЯ', last_week: 'ПРОШЛАЯ НЕДЕЛЯ' };
  _ldPreviousBodyOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  overlay.style.display = 'flex';
  overlay.scrollTop = 0;
  requestAnimationFrame(() => { overlay.scrollTop = 0; });
  canvas.style.transform = 'rotate(0deg)';
  if (legend) legend.innerHTML = '';
  resultEl.style.display = 'none';
  resultEl.innerHTML = '';
  if (empty) empty.style.display = 'none';
  if (runBtn) runBtn.style.display = 'none';
  if (rerollBtn) rerollBtn.style.display = 'none';
  if (viewerNote) viewerNote.style.display = '';
  subtitle.textContent = 'Собираю тех, кто пополнил баланс и отправил сообщение...';

  try {
    const response = await fetch(`${API}/api/leaderboard/lucky_draw?period=${encodeURIComponent(_lbPeriod)}`);
    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'preview_failed');
    }

    _ldPool = data.pool || [];
    ldDrawWheel(_ldPool);
    ldRenderLegend(_ldPool);
    subtitle.textContent = `${_ldPool.length} участников · ${Number(data.total_weight || 0).toLocaleString('ru-RU')} билетов · ${periodLabels[_lbPeriod]}`;
    if (!_ldPool.length && empty) empty.style.display = 'block';
    if (data.drawn) {
      ldRenderResult(data);
      if ((_adminToken || _canRaffle) && rerollBtn) rerollBtn.style.display = 'block';
      if (viewerNote) viewerNote.textContent = (_adminToken || _canRaffle)
        ? 'Результат зафиксирован. Перерозыгрыш сохранит прошлый результат в истории.'
        : 'Розыгрыш этого периода уже завершён.';
    } else if ((_adminToken || _canRaffle) && _ldPool.length) {
      runBtn.style.display = 'block';
      if (viewerNote) viewerNote.textContent = 'Участники видят это же колесо. Результат фиксируется один раз.';
    }
  } catch (error) {
    console.error('[LEADERBOARD DRAW PREVIEW]', error);
    showToast('Не удалось загрузить колесо', 'lose');
    if (subtitle) subtitle.textContent = 'Колесо не загрузилось. Повтори позже.';
    if (empty) {
      empty.textContent = 'Не удалось получить участников розыгрыша.';
      empty.style.display = 'block';
    }
  }
}

async function rerunLuckyDraw() {
  if (_ldRunning || (!_adminToken && !_canRaffle)) return;
  const confirmed = await showConfirm(
    'Перерозыгрыш',
    'Провести новый розыгрыш? Текущий победитель останется в истории, но публичным станет новый результат.'
  );
  if (confirmed) await runLuckyDraw(true);
}

async function runLuckyDraw(reroll = false) {
  if (_ldRunning || (!_adminToken && !_canRaffle)) return;
  const canvas = document.getElementById('ld-wheel');
  const runBtn = document.getElementById('ld-run-btn');
  const rerollBtn = document.getElementById('ld-reroll-btn');
  const subtitle = document.getElementById('ld-subtitle');
  const resultEl = document.getElementById('ld-result');
  _ldRunning = true;
  if (runBtn) runBtn.disabled = true;
  if (rerollBtn) rerollBtn.disabled = true;
  try {
    const response = await fetch(`${API}/api/admin/lucky_draw`, {
      method: 'POST',
      headers: _adminToken
        ? { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken }
        : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, period: _lbPeriod, reroll: Boolean(reroll) }),
    });
    const data = await response.json();
    if (!response.ok || data.error) throw new Error(data.error || 'draw_failed');
    _ldPool = data.pool || _ldPool;
    const slices = ldDrawWheel(_ldPool);
    ldRenderLegend(_ldPool);
    const winnerSlice = slices.find(slice => String(slice.entry.tg_id) === String(data.winner?.tg_id));
    if (!winnerSlice) throw new Error('winner_not_in_pool');
    const winnerLandingDegrees = ldRandomLandingAngle(winnerSlice) * 180 / Math.PI;
    const landing = ((-90 - winnerLandingDegrees) % 360 + 360) % 360;
    if (subtitle) subtitle.textContent = 'Колесо запущено. Результат уже защищён сервером.';
    if (resultEl) {
      resultEl.style.display = 'none';
      resultEl.innerHTML = '';
    }
    await ldAnimateWheel(canvas, 360 * 10 + landing, LD_SPIN_DURATION);
    ldRenderResult(data);
    if (runBtn) runBtn.style.display = 'none';
    if (rerollBtn) rerollBtn.style.display = 'block';
  } catch (error) {
    console.error('[LEADERBOARD DRAW]', error);
    showToast(error.message === 'empty_pool' ? 'Нет участников' : 'Не удалось провести розыгрыш', 'lose');
  } finally {
    _ldRunning = false;
    if (runBtn) runBtn.disabled = false;
    if (rerollBtn) rerollBtn.disabled = false;
  }
}

let _lbShareStatus = null;
let _lbShareBusy = false;

function renderLeaderboardShareStatus(status) {
  _lbShareStatus = status;
  const card = document.getElementById('lb-entry-card');
  if (!card) return;
  const hidden = !['day', 'week'].includes(_lbPeriod);
  card.style.display = hidden ? 'none' : '';
  if (hidden || !status) return;
  const deposit = document.getElementById('lb-entry-deposit');
  const share = document.getElementById('lb-entry-share');
  const state = document.getElementById('lb-entry-state');
  const button = document.getElementById('lb-share-button');
  const depositCopy = document.getElementById('lb-entry-deposit-copy');
  const shareCopy = document.getElementById('lb-entry-share-copy');
  const foot = document.getElementById('lb-entry-foot');
  deposit?.classList.toggle('done', Boolean(status.has_deposit));
  share?.classList.toggle('done', Boolean(status.message_shared));
  card.classList.toggle('is-eligible', Boolean(status.eligible));
  if (depositCopy) depositCopy.textContent = status.has_deposit
    ? `${Number(status.total_deposited).toLocaleString('ru-RU')} билетов на колесе`
    : 'Нужно хотя бы одно пополнение в этом периоде';
  if (shareCopy) shareCopy.textContent = status.message_shared
    ? `Засчитано${status.share_code ? ` · ${status.share_code}` : ''}`
    : 'Отправь сообщение со своей реферальной ссылкой';
  if (state) state.textContent = status.eligible ? 'ДОПУЩЕН' : '0 / 2';
  if (state && !status.eligible) state.textContent = `${Number(Boolean(status.has_deposit)) + Number(Boolean(status.message_shared))} / 2`;
  if (button) {
    button.style.display = status.message_shared ? 'none' : '';
    button.disabled = _lbShareBusy || !status.can_share_now || !status.message_configured;
    button.textContent = _lbShareBusy ? 'ОТКРЫВАЮ TELEGRAM...'
      : !status.can_share_now ? 'ПЕРИОД ЗАКРЫТ'
      : !status.message_configured ? 'СООБЩЕНИЕ ЕЩЁ НЕ НАСТРОЕНО'
      : 'ПОДЕЛИТЬСЯ В TELEGRAM';
  }
  if (foot) foot.textContent = status.eligible
    ? 'Ты участвуешь. Размер сектора зависит от твоих пополнений за выбранный период.'
    : 'Нужны обе галочки. Одна отправка засчитывается на текущий день и неделю.';
}

async function loadLeaderboardShareStatus(period = _lbPeriod) {
  if (!['day', 'week'].includes(period)) {
    renderLeaderboardShareStatus(null);
    const card = document.getElementById('lb-entry-card');
    if (card) card.style.display = 'none';
    return;
  }
  try {
    const response = await fetch(`${API}/api/leaderboard/share-status?period=${encodeURIComponent(period)}`);
    const data = await response.json();
    if (response.ok && period === _lbPeriod) renderLeaderboardShareStatus(data);
  } catch (error) {
    console.error('[LEADERBOARD SHARE STATUS]', error);
  }
}

async function shareLeaderboardMessage() {
  if (_lbShareBusy) return;
  const tg = window.Telegram && window.Telegram.WebApp;
  if (!tg || typeof tg.shareMessage !== 'function' || !telegramSupports('8.0')) {
    showToast('Обнови Telegram: отправка доступна в новых версиях', 'lose');
    return;
  }
  _lbShareBusy = true;
  renderLeaderboardShareStatus(_lbShareStatus || {});
  try {
    const preparedResponse = await fetch(`${API}/api/leaderboard/share/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: _lbPeriod }),
    });
    const prepared = await preparedResponse.json();
    if (prepared.already_shared) {
      await loadLeaderboardShareStatus();
      return;
    }
    if (!preparedResponse.ok || !prepared.prepared_message_id) {
      const messages = {
        share_message_not_configured: 'Администратор ещё не добавил сообщение',
        period_closed: 'Этот период уже закрыт',
        referral_code_unavailable: 'Не удалось создать реферальную ссылку',
        telegram_prepare_failed: 'Telegram не смог подготовить сообщение',
      };
      showToast(messages[prepared.error] || 'Не удалось подготовить сообщение', 'lose');
      return;
    }
    const sent = await new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        resolve(Boolean(value));
      };
      try {
        tg.shareMessage(prepared.prepared_message_id, finish);
      } catch (error) {
        finish(false);
      }
      setTimeout(() => finish(false), 120000);
    });
    if (!sent) {
      showToast('Сообщение не отправлено', 'lose');
      return;
    }
    const confirmResponse = await fetch(`${API}/api/leaderboard/share/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ period: _lbPeriod, confirm_token: prepared.confirm_token }),
    });
    const confirmed = await confirmResponse.json();
    if (!confirmResponse.ok || !confirmed.ok) {
      showToast('Отправка прошла, но допуск не сохранился. Повтори ещё раз.', 'lose');
      return;
    }
    renderLeaderboardShareStatus(confirmed.participation);
    showToast(confirmed.participation?.eligible
      ? 'Оба условия выполнены: ты на колесе'
      : 'Сообщение засчитано на день и неделю. Осталось пополнить баланс', 'win');
  } catch (error) {
    console.error('[LEADERBOARD SHARE]', error);
    showToast('Ошибка соединения', 'lose');
  } finally {
    _lbShareBusy = false;
    if (_lbShareStatus) renderLeaderboardShareStatus(_lbShareStatus);
  }
}

function lbSetPeriod(period) {
  _lbPeriod = period;
  document.querySelectorAll('.lb-period-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period);
  });
  // Колесо доступно для просмотра всем, кроме бессрочного рейтинга.
  const raffleBtn = document.getElementById('lb-raffle-btn');
  if (raffleBtn) raffleBtn.style.display = period !== 'all' ? 'block' : 'none';
  const rewardSection = document.getElementById('lb-weekly-reward');
  if (rewardSection) rewardSection.style.display = period === 'all' ? 'none' : '';
  lbLoad();
}

async function lbLoad() {
  if (_lbLoading) {
    _lbReloadPending = true;
    return;
  }
  _lbLoading = true;
  _lbReloadPending = false;
  const requestedPeriod = _lbPeriod;

  // The leaderboard opens on the weekly period by default. Keep controls in
  // sync here as well as in lbSetPeriod(), otherwise the wheel button remains
  // hidden until the user switches periods manually.
  const raffleBtn = document.getElementById('lb-raffle-btn');
  if (raffleBtn) raffleBtn.style.display = requestedPeriod !== 'all' ? 'block' : 'none';
  const rewardSection = document.getElementById('lb-weekly-reward');
  if (rewardSection) rewardSection.style.display = requestedPeriod === 'all' ? 'none' : '';

  const podium   = document.getElementById('lb-podium');
  const restList = document.getElementById('lb-rest-list');
  const emptyEl  = document.getElementById('lb-empty');
  const rangeEl  = document.getElementById('lb-week-range');

  // Скелетон
  podium.innerHTML   = '';
  emptyEl.style.display = 'none';
  restList.innerHTML = [1,2,3].map(() =>
    `<div class="lb-skeleton"></div>`
  ).join('');

  try {
    const res  = await fetch(`${API}/api/leaderboard?period=${requestedPeriod}`);
    const data = await res.json();
    if (requestedPeriod !== _lbPeriod) {
      _lbLoading = false;
      _lbReloadPending = false;
      lbLoad();
      return;
    }
    const list = data.leaderboard || [];
    renderLeaderboardReward(data.weekly_reward);
    loadLeaderboardShareStatus(requestedPeriod);

    // Заголовок с датами
    if (_lbPeriod === 'day') {
      rangeEl.textContent = `${data.day} · по МСК`;
    } else if (_lbPeriod === 'yesterday') {
      rangeEl.textContent = `${data.day} · прошлый день по МСК`;
    } else if (_lbPeriod === 'week') {
      rangeEl.textContent = `${data.week_start} — ${data.week_end} · сбрасывается в понедельник`;
    } else if (_lbPeriod === 'last_week') {
      rangeEl.textContent = 'прошлая неделя';
    } else {
      rangeEl.textContent = 'все депозиты за всё время';
    }

    if (!list.length) {
      podium.innerHTML   = '';
      restList.innerHTML = '';
      emptyEl.style.display = 'block';
      _lbLoading = false;
      if (_lbReloadPending) {
        _lbReloadPending = false;
        lbLoad();
      }
      return;
    }

    // ── Подиум (места 1-3) ──────────────────────────────────────
    const top3  = [list[1], list[0], list[2]]; // порядок: 2-й, 1-й, 3-й (визуальная пирамида)
    const ranks = [2, 1, 3];

    podium.innerHTML = top3.map((entry, i) => {
      const rank   = ranks[i];
      const letter = entry ? entry.roblox_username.charAt(0).toUpperCase() : '?';
      const name   = entry ? entry.roblox_username : '—';
      const amount = entry ? entry.total_deposited : 0;
      const isMe   = entry && String(entry.tg_id) === String(tg_id);

      const crownHtml = (rank === 1)
        ? `<div class="lb-crown">👑</div>`
        : '';

      const medalHtml = entry
        ? `<div class="lb-medal rank-${rank}">${rank}</div>`
        : '';

      const avatarClass = entry ? `rank-${rank}` : 'empty';
      const colClass    = entry ? `rank-${rank}` : `rank-${rank}`;
      const nameSuffix  = isMe ? ' 👈' : '';

      const profileAttrs = entry
        ? `role="button" tabindex="0" aria-label="Открыть профиль ${lbEscape(name)}" onclick="openPublicProfile(${Number(entry.tg_id)})" onkeydown="openPublicProfileFromKey(event, ${Number(entry.tg_id)})"`
        : '';

      return `
        <div class="lb-podium-slot ${entry ? 'profile-link' : ''}" ${profileAttrs}>
          <div class="lb-avatar-wrap">
            ${crownHtml}
            <div class="lb-avatar ${avatarClass}">${entry ? letter : '—'}</div>
            ${medalHtml}
          </div>
          <div class="lb-name">${lbEscape(name)}${nameSuffix}</div>
          <div class="lb-deposit">${entry ? amount + ' 🧠' : ''}</div>
          <div class="lb-column ${colClass}"></div>
        </div>
      `;
    }).join('');

    // ── Список 4-10 ─────────────────────────────────────────────
    const rest = list.slice(3);
    if (!rest.length) {
      restList.innerHTML = '';
    } else {
      restList.innerHTML = rest.map(entry => {
        const letter = entry.roblox_username.charAt(0).toUpperCase();
        const isMe   = String(entry.tg_id) === String(tg_id);
        return `
          <div class="lb-row profile-link ${isMe ? 'lb-row-me' : ''}" role="button" tabindex="0" aria-label="Открыть профиль ${lbEscape(entry.roblox_username)}" onclick="openPublicProfile(${Number(entry.tg_id)})" onkeydown="openPublicProfileFromKey(event, ${Number(entry.tg_id)})">
            <div class="lb-row-rank">${entry.rank}</div>
            <div class="lb-row-avatar">${letter}</div>
            <div class="lb-row-name">${lbEscape(entry.roblox_username)}${isMe ? ' 👈' : ''}</div>
            <div class="lb-row-amount">${entry.total_deposited} 🧠</div>
          </div>
        `;
      }).join('');
    }

  } catch(e) {
    podium.innerHTML   = '';
    restList.innerHTML = `<div style="color:var(--text-dim);text-align:center;font-size:12px;padding:20px">Ошибка загрузки</div>`;
  }

  _lbLoading = false;
  if (_lbReloadPending) {
    _lbReloadPending = false;
    lbLoad();
  }
}

function lbEscape(str) {
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function renderLeaderboardReward(reward) {
  const section = document.getElementById('lb-weekly-reward');
  const content = document.getElementById('lb-reward-content');
  const adminBox = document.getElementById('lb-reward-admin');
  const kicker = document.getElementById('lb-reward-kicker');
  if (!content) return;

  if (section) section.style.display = _lbPeriod === 'all' ? 'none' : '';
  if (_lbPeriod === 'all') return;

  const periodNames = {
    day: 'НАГРАДА ЗА ПОБЕДУ В КОЛЕСЕ · СЕГОДНЯ',
    yesterday: 'НАГРАДА ЗА ПОБЕДУ В КОЛЕСЕ · ВЧЕРА',
    week: 'НАГРАДА ЗА 1 МЕСТО · ЭТА НЕДЕЛЯ',
    last_week: 'НАГРАДА ЗА 1 МЕСТО · ПРОШЛАЯ НЕДЕЛЯ',
  };
  const emptyNames = {
    day: 'Награда за победу в сегодняшнем колесе ещё не объявлена',
    yesterday: 'Награда за победу во вчерашнем колесе не была объявлена',
    week: 'Награда недели ещё не объявлена',
    last_week: 'Награда прошлой недели не была объявлена',
  };
  if (kicker) kicker.textContent = periodNames[_lbPeriod] || periodNames.week;
  if (adminBox) adminBox.style.display = _adminToken ? 'block' : 'none';
  const textInput = document.getElementById('lb-reward-text');
  if (textInput && document.activeElement !== textInput) {
    textInput.value = reward?.text || '';
  }
  const shareTextInput = document.getElementById('lb-reward-share-text');
  if (shareTextInput && document.activeElement !== shareTextInput) {
    shareTextInput.value = reward?.share_text || reward?.text || '';
  }

  if (!reward || !reward.text) {
    content.innerHTML = `<div class="lb-reward-empty">${emptyNames[_lbPeriod] || emptyNames.week}</div>`;
    return;
  }

  const isWheelReward = _lbPeriod === 'day' || _lbPeriod === 'yesterday';
  const rewardLabel = isWheelReward ? 'ЗА ПОБЕДУ В КОЛЕСЕ' : 'ЗА 1 МЕСТО ПО ПОПОЛНЕНИЯМ';
  const image = reward.image_url
    ? `<img class="lb-reward-image" src="${lbEscape(reward.image_url)}" alt="${rewardLabel}">`
    : '';
  content.innerHTML = `
    ${image}
    <div class="lb-reward-copy">
      <div class="lb-reward-label">${rewardLabel}</div>
      <div class="lb-reward-text">${lbEscape(reward.text)}</div>
    </div>`;
}

function lbOpenImageEditor(input) {
  const file = input?.files?.[0];
  if (!file) return;
  _lbProcessedImage = null;
  const selected = document.getElementById('lb-reward-selected');
  if (selected) selected.textContent = '';
  if (!file.type.startsWith('image/')) {
    showToast('Выбери файл изображения', 'lose');
    input.value = '';
    return;
  }

  if (_lbImageEditor.url) URL.revokeObjectURL(_lbImageEditor.url);
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.onload = () => {
    _lbImageEditor = {
      ..._lbImageEditor,
      file,
      url,
      image,
      pointers: new Map(),
      gesture: null,
    };
    const editor = document.getElementById('lb-image-editor');
    if (editor) editor.style.display = 'flex';
    requestAnimationFrame(lbResetImage);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    input.value = '';
    showToast('Не удалось открыть картинку', 'lose');
  };
  image.src = url;
}

function lbImageGeometry() {
  const frame = document.getElementById('lb-image-editor-frame');
  const image = _lbImageEditor.image;
  if (!frame || !image) return null;
  const frameWidth = frame.clientWidth;
  const frameHeight = frame.clientHeight;
  if (!frameWidth || !frameHeight) return null;
  return {
    frameWidth,
    frameHeight,
    left: _lbImageEditor.offsetX,
    top: _lbImageEditor.offsetY,
    width: image.naturalWidth * _lbImageEditor.scale * _lbImageEditor.stretchX,
    height: image.naturalHeight * _lbImageEditor.scale * _lbImageEditor.stretchY,
  };
}

function lbClampImagePosition() {
  const geometry = lbImageGeometry();
  if (!geometry) return;
  const minX = geometry.width < geometry.frameWidth ? 0 : geometry.frameWidth - geometry.width;
  const maxX = geometry.width < geometry.frameWidth ? geometry.frameWidth - geometry.width : 0;
  const minY = geometry.height < geometry.frameHeight ? 0 : geometry.frameHeight - geometry.height;
  const maxY = geometry.height < geometry.frameHeight ? geometry.frameHeight - geometry.height : 0;
  _lbImageEditor.offsetX = Math.max(minX, Math.min(maxX, _lbImageEditor.offsetX));
  _lbImageEditor.offsetY = Math.max(minY, Math.min(maxY, _lbImageEditor.offsetY));
}

function lbRenderImageEditor() {
  const preview = document.getElementById('lb-image-editor-preview');
  const geometry = lbImageGeometry();
  if (!preview || !geometry) return;
  preview.src = _lbImageEditor.url || '';
  preview.style.left = `${geometry.left}px`;
  preview.style.top = `${geometry.top}px`;
  preview.style.transform = 'none';
  preview.style.width = `${geometry.width}px`;
  preview.style.height = `${geometry.height}px`;
  const zoomValue = document.getElementById('lb-image-editor-zoom');
  if (zoomValue) {
    zoomValue.textContent = `${Math.round((_lbImageEditor.scale / _lbImageEditor.minScale) * 100)}%`;
  }
  const stretchX = document.getElementById('lb-image-editor-stretch-x');
  const stretchY = document.getElementById('lb-image-editor-stretch-y');
  if (stretchX) stretchX.textContent = `${Math.round(_lbImageEditor.stretchX * 100)}%`;
  if (stretchY) stretchY.textContent = `${Math.round(_lbImageEditor.stretchY * 100)}%`;
}

function lbResetImage() {
  const frame = document.getElementById('lb-image-editor-frame');
  const image = _lbImageEditor.image;
  if (!frame || !image) return;
  const frameWidth = frame.clientWidth;
  const frameHeight = frame.clientHeight;
  // Показываем исходное фото целиком. Приближение пользователь выбирает сам.
  const fitScale = Math.min(frameWidth / image.naturalWidth, frameHeight / image.naturalHeight);
  _lbImageEditor.minScale = fitScale;
  _lbImageEditor.maxScale = fitScale * 8;
  _lbImageEditor.scale = fitScale;
  _lbImageEditor.stretchX = 1;
  _lbImageEditor.stretchY = 1;
  _lbImageEditor.offsetX = (frameWidth - image.naturalWidth * fitScale) / 2;
  _lbImageEditor.offsetY = (frameHeight - image.naturalHeight * fitScale) / 2;
  lbRenderImageEditor();
}

function lbCenterImage() {
  const frame = document.getElementById('lb-image-editor-frame');
  const image = _lbImageEditor.image;
  if (!frame || !image) return;
  const geometry = lbImageGeometry();
  _lbImageEditor.offsetX = (frame.clientWidth - geometry.width) / 2;
  _lbImageEditor.offsetY = (frame.clientHeight - geometry.height) / 2;
  lbClampImagePosition();
  lbRenderImageEditor();
}

function lbFramePoint(event) {
  const frame = document.getElementById('lb-image-editor-frame');
  if (!frame) return { x: 0, y: 0 };
  const rect = frame.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function lbSetZoom(nextScale, anchorX, anchorY) {
  const image = _lbImageEditor.image;
  const frame = document.getElementById('lb-image-editor-frame');
  if (!image || !frame) return;
  const oldScale = _lbImageEditor.scale;
  const scale = Math.max(_lbImageEditor.minScale, Math.min(_lbImageEditor.maxScale, nextScale));
  const x = Number.isFinite(anchorX) ? anchorX : frame.clientWidth / 2;
  const y = Number.isFinite(anchorY) ? anchorY : frame.clientHeight / 2;
  const imageX = (x - _lbImageEditor.offsetX) /
    (oldScale * _lbImageEditor.stretchX);
  const imageY = (y - _lbImageEditor.offsetY) /
    (oldScale * _lbImageEditor.stretchY);
  _lbImageEditor.scale = scale;
  _lbImageEditor.offsetX = x - imageX * scale * _lbImageEditor.stretchX;
  _lbImageEditor.offsetY = y - imageY * scale * _lbImageEditor.stretchY;
  lbClampImagePosition();
  lbRenderImageEditor();
}

function lbZoomImage(factor) {
  lbSetZoom(_lbImageEditor.scale * factor);
}

function lbSetStretch(axis, factor) {
  const frame = document.getElementById('lb-image-editor-frame');
  const image = _lbImageEditor.image;
  if (!frame || !image) return;
  const centerX = frame.clientWidth / 2;
  const centerY = frame.clientHeight / 2;
  const geometry = lbImageGeometry();
  const oldWidth = geometry.width;
  const oldHeight = geometry.height;
  const imageX = (centerX - _lbImageEditor.offsetX) / oldWidth;
  const imageY = (centerY - _lbImageEditor.offsetY) / oldHeight;
  if (axis === 'x') {
    _lbImageEditor.stretchX = Math.max(.2, Math.min(5, _lbImageEditor.stretchX * factor));
  } else {
    _lbImageEditor.stretchY = Math.max(.2, Math.min(5, _lbImageEditor.stretchY * factor));
  }
  const next = lbImageGeometry();
  _lbImageEditor.offsetX = centerX - imageX * next.width;
  _lbImageEditor.offsetY = centerY - imageY * next.height;
  lbClampImagePosition();
  lbRenderImageEditor();
}

function lbNudgeImage(dx, dy) {
  if (!_lbImageEditor.image) return;
  _lbImageEditor.offsetX += dx;
  _lbImageEditor.offsetY += dy;
  lbClampImagePosition();
  lbRenderImageEditor();
}

function lbImageWheel(event) {
  if (!_lbImageEditor.image) return;
  event.preventDefault();
  const point = lbFramePoint(event);
  lbSetZoom(_lbImageEditor.scale * (event.deltaY < 0 ? 1.12 : 0.89), point.x, point.y);
}

function lbStartPointerGesture() {
  const points = Array.from(_lbImageEditor.pointers.values());
  if (points.length >= 2) {
    const [a, b] = points;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    _lbImageEditor.gesture = {
      type: 'pinch',
      distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      scale: _lbImageEditor.scale,
      imageX: (midX - _lbImageEditor.offsetX) /
        (_lbImageEditor.scale * _lbImageEditor.stretchX),
      imageY: (midY - _lbImageEditor.offsetY) /
        (_lbImageEditor.scale * _lbImageEditor.stretchY),
    };
  } else if (points.length === 1) {
    _lbImageEditor.gesture = {
      type: 'drag',
      x: points[0].x,
      y: points[0].y,
      offsetX: _lbImageEditor.offsetX,
      offsetY: _lbImageEditor.offsetY,
    };
  } else {
    _lbImageEditor.gesture = null;
  }
}

function lbImagePointerDown(event) {
  if (!_lbImageEditor.image) return;
  _lbImageEditor.pointers.set(event.pointerId, lbFramePoint(event));
  lbStartPointerGesture();
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch (error) {}
  event.preventDefault();
}

function lbImagePointerMove(event) {
  if (!_lbImageEditor.pointers.has(event.pointerId)) return;
  _lbImageEditor.pointers.set(event.pointerId, lbFramePoint(event));
  const points = Array.from(_lbImageEditor.pointers.values());
  const gesture = _lbImageEditor.gesture;
  if (points.length >= 2 && gesture?.type === 'pinch') {
    const [a, b] = points;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const scale = Math.max(
      _lbImageEditor.minScale,
      Math.min(_lbImageEditor.maxScale, gesture.scale * distance / gesture.distance),
    );
    _lbImageEditor.scale = scale;
    _lbImageEditor.offsetX = midX - gesture.imageX * scale * _lbImageEditor.stretchX;
    _lbImageEditor.offsetY = midY - gesture.imageY * scale * _lbImageEditor.stretchY;
  } else if (points.length === 1 && gesture?.type === 'drag') {
    _lbImageEditor.offsetX = gesture.offsetX + points[0].x - gesture.x;
    _lbImageEditor.offsetY = gesture.offsetY + points[0].y - gesture.y;
  }
  lbClampImagePosition();
  lbRenderImageEditor();
  event.preventDefault();
}

function lbImagePointerUp(event) {
  _lbImageEditor.pointers.delete(event.pointerId);
  lbStartPointerGesture();
}

function lbCancelImageEditor() {
  const editor = document.getElementById('lb-image-editor');
  const input = document.getElementById('lb-reward-image');
  if (editor) editor.style.display = 'none';
  if (input) input.value = '';
  _lbProcessedImage = null;
  if (_lbImageEditor.url) URL.revokeObjectURL(_lbImageEditor.url);
  _lbImageEditor.url = null;
  const selected = document.getElementById('lb-reward-selected');
  if (selected) selected.textContent = '';
}

function lbApplyImageEditor() {
  const image = _lbImageEditor.image;
  const geometry = lbImageGeometry();
  if (!image || !geometry) return;
  const canvas = document.createElement('canvas');
  const outputWidth = 1200;
  const outputHeight = 750;
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const context = canvas.getContext('2d');
  context.fillStyle = '#120b08';
  context.fillRect(0, 0, outputWidth, outputHeight);
  const ratioX = outputWidth / geometry.frameWidth;
  const ratioY = outputHeight / geometry.frameHeight;
  context.drawImage(
    image,
    geometry.left * ratioX,
    geometry.top * ratioY,
    geometry.width * ratioX,
    geometry.height * ratioY,
  );
  canvas.toBlob(blob => {
    if (!blob) {
      showToast('Не удалось подготовить картинку', 'lose');
      return;
    }
    _lbProcessedImage = new File([blob], 'leaderboard-reward.jpg', { type: 'image/jpeg' });
    const editor = document.getElementById('lb-image-editor');
    if (editor) editor.style.display = 'none';
    const selected = document.getElementById('lb-reward-selected');
    if (selected) selected.textContent = 'Картинка подготовлена под формат блока';
    showToast('Обрезка сохранена', 'win');
  }, 'image/jpeg', 0.92);
}

async function saveLeaderboardReward() {
  if (!_adminToken) return;
  if (_lbPeriod === 'all') return;
  const text = (document.getElementById('lb-reward-text')?.value || '').trim();
  const shareText = (document.getElementById('lb-reward-share-text')?.value || '').trim();
  const imageInput = document.getElementById('lb-reward-image');
  const image = _lbProcessedImage || imageInput?.files?.[0];
  if (imageInput?.files?.length && !_lbProcessedImage) {
    showToast('Сначала нажми «ПРИМЕНИТЬ» в редакторе картинки', 'lose');
    return;
  }
  if (!text) {
    showToast('Напиши, что разыгрывается', 'lose');
    return;
  }
  const form = new FormData();
  form.append('text', text);
  form.append('share_text', shareText || text);
  form.append('period', _lbPeriod);
  if (image) form.append('image', image, image.name || 'leaderboard-reward.jpg');
  try {
    const res = await fetch(`${API}/api/admin/leaderboard/reward`, {
      method: 'POST',
      headers: { 'X-Admin-Token': _adminToken },
      body: form,
    });
    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch (e) {}
    if (!res.ok || data.error) {
      const message = res.status === 405
        ? 'Сервер ещё не перезапущен после обновления'
        : data.error === 'image_too_large'
          ? 'Картинка больше 6 МБ'
          : `Не удалось сохранить награду (${res.status || 'ошибка'})`;
      showToast(message, 'lose');
      return;
    }
    renderLeaderboardReward(data.weekly_reward);
    if (imageInput) imageInput.value = '';
    _lbProcessedImage = null;
    const selected = document.getElementById('lb-reward-selected');
    if (selected) selected.textContent = '';
    showToast('Награда этого раздела обновлена', 'win');
  } catch (e) {
    showToast('Ошибка соединения', 'lose');
  }
}
// ══════════════════════════════════════════════
// ТИКЕТЫ — клиентская логика
// ══════════════════════════════════════════════

const TICKET_CATEGORY_LABELS = {
  general: 'ОБЩИЙ', deposit: 'ПОПОЛНЕНИЕ', withdraw: 'ВЫВОД',
  exchange: 'БИРЖА', game: 'ИГРЫ', account: 'АККАУНТ'
};
const TICKET_PRIORITY_LABELS = { normal: 'ОБЫЧНЫЙ', high: 'ВЫСОКИЙ', urgent: 'СРОЧНЫЙ' };
let _currentTicketId = null;
let _currentTicketData = null;
let _ticketsFilter = 'open';
let _ticketsNeedsOnly = false;
let _ticketSearchTimer = null;

function showTicketCreate() {
  document.getElementById('ticket-create-modal').style.display = 'block';
  document.getElementById('ticket-new-subject').value = '';
  document.getElementById('ticket-new-text').value = '';
  const category = document.getElementById('ticket-new-category');
  if (category) category.value = 'general';
  loadMyTickets();
}

function closeTicketCreate() {
  document.getElementById('ticket-create-modal').style.display = 'none';
}

async function submitTicketCreate() {
  const subject = document.getElementById('ticket-new-subject').value.trim();
  const text    = document.getElementById('ticket-new-text').value.trim();
  const category = document.getElementById('ticket-new-category')?.value || 'general';
  if (!subject) { showToast('Введи тему тикета', 'error'); return; }
  if (!text)    { showToast('Введи текст обращения', 'error'); return; }

  try {
    const res  = await fetch(`${API}/api/tickets/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, subject, text, category })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ Тикет создан!', 'win');
      closeTicketCreate();
      loadMyTickets();
    } else {
      const message = data.message || (data.error === 'active_ticket_exists'
        ? 'У тебя уже есть активный тикет. Продолжи диалог в нём.'
        : 'Ошибка: ' + (data.error || 'неизвестно'));
      showToast(message, 'error');
      if (data.error === 'active_ticket_exists' && data.ticket_id) {
        closeTicketCreate();
        openTicketModal(data.ticket_id);
      }
    }
  } catch (e) {
    showToast('Ошибка соединения', 'error');
  }
}

async function loadMyTickets() {
  const container = document.getElementById('my-tickets-list');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">Загрузка...</div>';
  try {
    const res  = await fetch(`${API}/api/tickets/my?tg_id=${tg_id}`);
    const data = await res.json();
    const list = data.tickets || [];
    if (!list.length) {
      container.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:8px 0">У тебя пока нет тикетов.</div>';
      return;
    }
    container.innerHTML = list.map(t => {
      const statusLabel = t.status === 'open' ? 'ОТКРЫТ' : 'ЗАКРЫТ';
      const unread = Number(t.unread_count || 0);
      return `<article class="my-ticket-card" onclick="openTicketModal(${Number(t.id)})">
        <div class="my-ticket-card-head"><b>${escHtml(t.subject)}</b><span>${statusLabel}${unread ? ` · ${unread} новых` : ''}</span></div>
        <p>${escHtml(t.last_message || TICKET_CATEGORY_LABELS[t.category] || '')}</p>
      </article>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px 0">Ошибка загрузки</div>';
  }
}

async function openTicketModal(ticketId) {
  _currentTicketId = Number(ticketId);
  const modal = document.getElementById('ticket-modal');
  modal.style.display = 'block';
  document.getElementById('ticket-modal-subject').textContent = '';
  document.getElementById('ticket-modal-messages').innerHTML = '<div class="ticket-loading">Загрузка...</div>';
  document.getElementById('ticket-close-confirm').style.display = 'none';

  try {
    const headers = _modToken ? { 'X-Mod-Token': _modToken } : {};
    const res  = await fetch(
      `${API}/api/tickets/messages?ticket_id=${ticketId}&tg_id=${tg_id}`,
      { headers }
    );
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Ошибка', 'error'); return; }

    const ticket = data.ticket || {};
    _currentTicketData = ticket;
    document.getElementById('ticket-modal-subject').textContent = ticket.subject;
    document.getElementById('ticket-modal-number').textContent = `ОБРАЩЕНИЕ #${Number(ticket.id || ticketId)}`;

    const statusEl = document.getElementById('ticket-modal-status');
    statusEl.classList.toggle('closed', ticket.status !== 'open');
    if (ticket.status === 'open') {
      statusEl.textContent = ticket.last_actor_role === 'user' ? '● НУЖЕН ОТВЕТ' : '● ЖДЁМ ИГРОКА';
    } else {
      statusEl.textContent = '● ЗАКРЫТ';
    }

    const meta = document.getElementById('ticket-modal-meta');
    meta.innerHTML = `
      <span class="ticket-meta-chip">${escHtml(TICKET_CATEGORY_LABELS[ticket.category] || 'ОБЩИЙ')}</span>
      <span class="ticket-meta-chip">${escHtml(TICKET_PRIORITY_LABELS[ticket.priority] || 'ОБЫЧНЫЙ')}</span>
      <span class="ticket-meta-chip">TG ID ${Number(ticket.tg_id || 0)}</span>
      <span class="ticket-meta-chip">${Number(ticket.message_count || data.messages?.length || 0)} сообщений</span>
      ${adminCopyButton(ticket.subject || '', 'КОПИРОВАТЬ ТЕМУ')}`;

    const closeBtn = document.getElementById('ticket-close-btn');
    if (closeBtn) closeBtn.style.display = (_modToken && ticket.status === 'open') ? '' : 'none';

    const replyArea = document.getElementById('ticket-reply-area');
    if (replyArea) replyArea.style.display = ticket.status === 'open' ? '' : 'none';
    const quickReplies = document.getElementById('ticket-quick-replies');
    if (quickReplies) quickReplies.style.display = _modToken && ticket.status === 'open' ? '' : 'none';

    const tools = document.getElementById('ticket-admin-tools');
    if (tools) tools.style.display = _modToken ? '' : 'none';
    if (_modToken) {
      const ownerName = ticket.roblox_username || 'Без Roblox-ника';
      document.getElementById('ticket-owner-card').innerHTML = `
        <b>${escHtml(ownerName)}</b><small>TG ID: ${Number(ticket.tg_id || 0)}</small>
        <div class="ticket-owner-actions">${adminCopyButton(ticket.tg_id || '', 'TG ID')}${adminCopyButton(ownerName, 'НИК')}${_adminToken ? `<button type="button" class="admin-copy-btn" onclick="openTicketPlayerProfile(${Number(ticket.tg_id || 0)})">ПРОФИЛЬ</button>` : ''}</div>`;
      document.getElementById('ticket-manage-priority').value = ticket.priority || 'normal';
      document.getElementById('ticket-manage-category').value = ticket.category || 'general';
      document.getElementById('ticket-admin-note').value = ticket.admin_note || '';
      const assignBtn = document.getElementById('ticket-assign-btn');
      const assignedTo = Number(ticket.assigned_to || 0);
      assignBtn.dataset.assigned = assignedTo ? '1' : '0';
      assignBtn.textContent = assignedTo ? (assignedTo === Number(tg_id) ? 'СНЯТЬ С СЕБЯ' : `НАЗНАЧЕН: ${assignedTo}`) : 'ВЗЯТЬ В РАБОТУ';
      assignBtn.disabled = Boolean(assignedTo && assignedTo !== Number(tg_id));
      document.getElementById('ticket-reopen-btn').style.display = ticket.status === 'closed' ? '' : 'none';
    }

    const msgs = data.messages || [];
    const box  = document.getElementById('ticket-modal-messages');
    if (!msgs.length) {
      box.innerHTML = '<div style="color:var(--text-dim);font-size:12px">Сообщений пока нет.</div>';
      return;
    }
    box.innerHTML = msgs.map(m => {
      const isMod = m.role === 'mod';
      const label = isMod ? 'МОДЕРАТОР' : (_modToken ? (ticket.roblox_username || `ИГРОК ${ticket.tg_id}`) : 'ТЫ');
      return `<div class="ticket-message ${isMod ? 'mod' : 'user'}">
        ${!isMod ? adminCopyButton(m.text || '', 'COPY') : ''}
        <div class="ticket-message-bubble">
          <div class="ticket-message-meta"><b>${escHtml(label)}</b><time>${escHtml(m.created_at || '')}</time></div>
          <div class="ticket-message-text">${escHtml(m.text)}</div>
        </div>
        ${isMod ? adminCopyButton(m.text || '', 'COPY') : ''}
      </div>`;
    }).join('');
    box.scrollTop = box.scrollHeight;
    if (!_modToken) loadMyTickets();
  } catch (e) {
    showToast('Ошибка загрузки тикета', 'error');
  }
}

function closeTicketModal() {
  document.getElementById('ticket-modal').style.display = 'none';
  _currentTicketId = null;
  _currentTicketData = null;
}

function ticketUseQuickReply(text) {
  const field = document.getElementById('ticket-reply-text');
  if (!field) return;
  field.value = field.value.trim() ? `${field.value.trim()}\n${text}` : text;
  field.focus();
}

async function ticketSendReply() {
  if (!_currentTicketId) return;
  const textEl = document.getElementById('ticket-reply-text');
  const text   = textEl.value.trim();
  if (!text) { showToast('Введи текст ответа', 'error'); return; }

  const headers = { 'Content-Type': 'application/json' };
  if (_modToken) headers['X-Mod-Token'] = _modToken;

  try {
    const res  = await fetch(`${API}/api/tickets/reply`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tg_id, ticket_id: _currentTicketId, text })
    });
    const data = await res.json();
    if (data.ok) {
      textEl.value = '';
      await openTicketModal(_currentTicketId);
      if (_modToken) loadAllTickets();
    } else {
      showToast(data.error || 'Ошибка отправки', 'error');
    }
  } catch (e) {
    showToast('Ошибка соединения', 'error');
  }
}

function ticketCloseConfirm() {
  document.getElementById('ticket-close-confirm').style.display = '';
  document.getElementById('ticket-close-btn').style.display = 'none';
}
function ticketCloseCancel() {
  document.getElementById('ticket-close-confirm').style.display = 'none';
  document.getElementById('ticket-close-btn').style.display = '';
}

async function ticketClose() {
  const closeBtn = document.getElementById('ticket-close-btn');
  const ticketId = _currentTicketId || (closeBtn && closeBtn.dataset.ticketId);
  if (!ticketId || !_modToken) return;
  try {
    const res  = await fetch(`${API}/api/tickets/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mod-Token': _modToken },
      body: JSON.stringify({ tg_id, ticket_id: ticketId })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Тикет закрыт', 'win');
      document.getElementById('ticket-close-confirm').style.display = 'none';
      await openTicketModal(ticketId);
      loadAllTickets();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка соединения', 'error');
  }
}

async function ticketManage(action, value = null) {
  if (!_currentTicketId || !_modToken) return;
  try {
    const response = await fetch(`${API}/api/tickets/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mod-Token': _modToken },
      body: JSON.stringify({ tg_id, ticket_id: _currentTicketId, action, value })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
    showToast(action === 'set_note' ? 'Заметка сохранена' : 'Тикет обновлён', 'win');
    await openTicketModal(_currentTicketId);
    loadAllTickets();
  } catch (error) {
    showToast(error.message || 'Не удалось обновить тикет', 'error');
    if (_currentTicketId) openTicketModal(_currentTicketId);
  }
}

function ticketToggleAssign() {
  const assigned = document.getElementById('ticket-assign-btn')?.dataset?.assigned === '1';
  ticketManage(assigned ? 'unassign' : 'assign_self');
}

function ticketsSetFilter(f, mode = '') {
  _ticketsFilter = f;
  _ticketsNeedsOnly = mode === 'needs';
  ['open', 'closed', 'all'].forEach(name => {
    document.getElementById(`tickets-filter-${name}`)?.classList.toggle('active', name === f);
  });
  loadAllTickets();
}

function ticketsSetPriority(priority) {
  const select = document.getElementById('tickets-priority');
  if (select) select.value = priority;
  _ticketsFilter = 'open';
  _ticketsNeedsOnly = false;
  ticketsSetFilter('open');
}

function scheduleTicketSearch() {
  clearTimeout(_ticketSearchTimer);
  _ticketSearchTimer = setTimeout(loadAllTickets, 260);
}

function formatTicketDate(value) {
  if (!value) return '—';
  const parsed = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : String(value).replace(' ', 'T') + 'Z');
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function loadAllTickets() {
  if (!_modToken) return;
  const list = document.getElementById('tickets-list');
  if (!list) return;
  list.innerHTML = '<div class="inv-empty">Загрузка...</div>';
  try {
    const params = new URLSearchParams({
      tg_id: String(tg_id),
      status: _ticketsFilter,
      priority: document.getElementById('tickets-priority')?.value || 'all',
      category: document.getElementById('tickets-category')?.value || 'all',
      sort: document.getElementById('tickets-sort')?.value || 'recent',
      q: document.getElementById('tickets-search')?.value?.trim() || ''
    });
    const res = await fetch(`${API}/api/tickets/all?${params}`, { headers: { 'X-Mod-Token': _modToken } });
    const data = await res.json();
    if (!res.ok) { list.innerHTML = `<div class="inv-empty">Ошибка: ${escHtml(data.error || '?')}</div>`; return; }
    const summary = data.summary || {};
    const setCount = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = Number(value || 0); };
    setCount('ticket-count-needs', summary.needs_reply);
    setCount('ticket-count-urgent', summary.urgent);
    setCount('ticket-count-open', summary.open);
    setCount('ticket-count-closed', summary.closed);
    ['open', 'closed', 'all'].forEach(name => document.getElementById(`tickets-filter-${name}`)?.classList.toggle('active', name === _ticketsFilter));
    let tickets = Array.isArray(data.tickets) ? data.tickets : [];
    if (_ticketsNeedsOnly) tickets = tickets.filter(t => t.status === 'open' && t.last_actor_role === 'user');
    if (!tickets.length) {
      list.innerHTML = '<div class="inv-empty">Нет тикетов</div>';
      return;
    }
    list.innerHTML = tickets.map(t => {
      const needsReply = t.status === 'open' && t.last_actor_role === 'user';
      const unread = Number(t.unread_count || 0);
      const assigned = Number(t.assigned_to || 0);
      return `<article class="ticket-card priority-${escHtml(t.priority || 'normal')} ${needsReply ? 'needs-reply' : ''}" onclick="openTicketModal(${Number(t.id)})">
        <div class="ticket-card-main">
          <div class="ticket-card-kicker"><span>#${Number(t.id)}</span><span>${escHtml(TICKET_CATEGORY_LABELS[t.category] || 'ОБЩИЙ')}</span><span>${escHtml(TICKET_PRIORITY_LABELS[t.priority] || 'ОБЫЧНЫЙ')}</span>${needsReply ? '<span class="needs">НУЖЕН ОТВЕТ</span>' : ''}</div>
          <div class="ticket-card-title">${escHtml(t.subject)}</div>
          <div class="ticket-card-preview">${escHtml(t.last_message || 'Нет сообщений')}</div>
        </div>
        <div class="ticket-card-user"><b>${escHtml(t.roblox_username || 'Без ника')}</b><small>TG ${Number(t.tg_id || 0)}</small></div>
        <div class="ticket-card-foot"><span>${Number(t.message_count || 0)} сообщений · ${formatTicketDate(t.last_message_at || t.updated_at)}</span><span class="${unread ? 'unread' : ''}">${unread ? `${unread} непрочитанных` : assigned ? `в работе у ${assigned}` : 'не назначен'}</span></div>
      </article>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="inv-empty">Ошибка загрузки</div>';
  }
}

// ── Утилита: экранирование HTML ────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
// ── Навигация: стрелки + скролл колёсиком ──────────
(function() {
  const nav     = document.getElementById('main-nav');
  const btnLeft = document.getElementById('nav-arrow-left');
  const btnRight= document.getElementById('nav-arrow-right');
  if (!nav || !btnLeft || !btnRight) return;

  const STEP = 120; // px за один клик

  function updateArrows() {
    const maxScroll = nav.scrollWidth - nav.clientWidth;
    btnLeft.classList.toggle('hidden', nav.scrollLeft <= 2);
    btnRight.classList.toggle('hidden', nav.scrollLeft >= maxScroll - 2);
  }

  // Скролл по клику на стрелку
  window.navScroll = function(dir) {
    nav.scrollBy({ left: dir * STEP, behavior: 'smooth' });
  };

  // Обновление стрелок при скролле
  nav.addEventListener('scroll', updateArrows, { passive: true });

  // Скролл колёсиком мыши
  nav.addEventListener('wheel', function(e) {
    if (e.deltaY === 0) return;
    e.preventDefault();
    nav.scrollBy({ left: e.deltaY * 1.5, behavior: 'smooth' });
  }, { passive: false });

  // Первичная инициализация после загрузки
  function init() { updateArrows(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Небольшая задержка чтобы дать браузеру отрендерить nav
    setTimeout(init, 100);
  }

  // Также обновляем при ресайзе окна
  window.addEventListener('resize', updateArrows);
})();

// ── Постоянный чат админа с игроком через Telegram-бота ──
let _playerChatTargetId = null;
let _playerChatPollTimer = null;
let _playerChatLoading = false;

function playerChatLaunch(targetId) {
  return `
    <button class="player-chat-launch" onclick="openPlayerChat(${Number(targetId)})">
      <span class="player-chat-launch-light"></span>
      <span class="player-chat-launch-copy">
        <b>ЧАТ С ИГРОКОМ</b>
        <small>Сообщения боту и действия с кнопками</small>
      </span>
      <i aria-hidden="true">&#8250;</i>
    </button>`;
}

function playerBankControl(targetId, specialMode, legacyBankExempt = 0) {
  let mode = Number(specialMode);
  if (![0, 1, 2, 3].includes(mode)) mode = Boolean(Number(legacyBankExempt)) ? 1 : 0;
  const label = specialModeLabel(mode);
  return `
    <div class="player-bank-control mode-${mode}" data-bank-target="${Number(targetId)}" data-special-mode="${mode}">
      <span class="player-bank-switch" role="group" aria-label="Особый режим">
        <button type="button" aria-label="Режим I" onclick="setPlayerSpecialMode(${Number(targetId)}, 0, this.closest('.player-bank-control'))"></button>
        <button type="button" aria-label="Режим II" onclick="togglePlayerSpecialModeFlag(${Number(targetId)}, 1, this.closest('.player-bank-control'))"></button>
        <button type="button" aria-label="Режим III" onclick="togglePlayerSpecialModeFlag(${Number(targetId)}, 2, this.closest('.player-bank-control'))"></button>
      </span>
      <span class="player-bank-copy">
        <b>ОСОБЫЙ РЕЖИМ</b>
        <small>Режим ${label}</small>
      </span>
      <strong>${label}</strong>
    </div>`;
}

function specialModeLabel(mode) {
  return ['I', 'II', 'III', 'II+III'][Number(mode)] || 'I';
}

function togglePlayerSpecialModeFlag(targetId, flag, control) {
  const current = Number(control?.dataset?.specialMode || 0);
  const next = current & flag ? current & ~flag : current | flag;
  return setPlayerSpecialMode(targetId, next, control);
}

async function setPlayerSpecialMode(targetId, mode, control) {
  if (!control || !_adminToken) return;
  control.classList.add('saving');
  control.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const res = await fetch(`${API}/api/admin/player-bank-exempt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ target_id: Number(targetId), mode: Number(mode) })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    const savedMode = Number(data.special_mode);
    const label = specialModeLabel(savedMode);
    control.dataset.specialMode = String(savedMode);
    control.classList.remove('mode-0', 'mode-1', 'mode-2', 'mode-3');
    control.classList.add(`mode-${savedMode}`);
    control.querySelector('strong').textContent = label;
    control.querySelector('small').textContent = `Режим ${label}`;
    showToast(`Выбран режим ${label}`, 'win');
  } catch (error) {
    showToast(`Не удалось изменить режим: ${error.message}`, 'error');
  } finally {
    control.querySelectorAll('button').forEach(button => { button.disabled = false; });
    control.classList.remove('saving');
  }
}

async function openPlayerChat(targetId) {
  if (!_adminToken) return;
  const overlay = document.getElementById('player-chat-overlay');
  if (!overlay) return;

  // The app shell gives every direct child its own low stacking layer. Moving
  // the chat to body keeps it above the still-open player profile modal.
  if (overlay.parentElement !== document.body) document.body.appendChild(overlay);

  _playerChatTargetId = Number(targetId);
  document.getElementById('player-chat-name').textContent = 'ИГРОК';
  document.getElementById('player-chat-id').textContent = `tg_id: ${_playerChatTargetId}`;
  document.getElementById('player-chat-messages').innerHTML = '<div class="player-chat-empty">ПОДКЛЮЧЕНИЕ...</div>';
  overlay.style.display = 'flex';
  document.body.classList.add('player-chat-open');
  await loadPlayerChat();

  clearInterval(_playerChatPollTimer);
  _playerChatPollTimer = setInterval(() => loadPlayerChat(true), 2000);
  setTimeout(() => document.getElementById('player-chat-text')?.focus(), 80);
}

function closePlayerChat() {
  clearInterval(_playerChatPollTimer);
  _playerChatPollTimer = null;
  _playerChatTargetId = null;
  _playerChatLoading = false;
  document.body.classList.remove('player-chat-open');
  const overlay = document.getElementById('player-chat-overlay');
  if (overlay) overlay.style.display = 'none';
}

function playerChatTime(value) {
  if (!value) return '';
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
  });
}

function renderPlayerChatMessages(messages, keepPosition = false) {
  const box = document.getElementById('player-chat-messages');
  if (!box) return;

  const distanceFromBottom = box.scrollHeight - box.scrollTop - box.clientHeight;
  const shouldStick = !keepPosition || distanceFromBottom < 90;
  if (!messages.length) {
    box.innerHTML = `
      <div class="player-chat-empty">
        <b>КАНАЛ ПУСТ</b>
        <span>Здесь появятся сообщения игрока боту и его нажатия.</span>
      </div>`;
    return;
  }

  box.innerHTML = messages.map(message => {
    const text = escHtml(message.text || '').replace(/\n/g, '<br>');
    const time = playerChatTime(message.created_at);
    if (message.direction === 'event') {
      return `<div class="player-chat-event"><span></span><b>${text}</b><time>${time}</time></div>`;
    }

    const admin = message.direction === 'admin';
    const status = message.status || 'sent';
    const statusText = status === 'failed' ? 'НЕ ДОСТАВЛЕНО'
      : status === 'sent' ? 'ДОСТАВЛЕНО' : 'ОТПРАВКА...';
    return `
      <div class="player-chat-row ${admin ? 'admin' : 'user'}">
        <div class="player-chat-bubble">
          <div class="player-chat-meta"><b>${admin ? 'ВЫ · BOT' : 'ИГРОК'}</b><time>${time}</time></div>
          <div class="player-chat-body">${text}</div>
          ${admin ? `<div class="player-chat-status ${status}">${statusText}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  if (shouldStick) box.scrollTop = box.scrollHeight;
}

async function loadPlayerChat(silent = false) {
  if (!_playerChatTargetId || !_adminToken || _playerChatLoading) return;
  _playerChatLoading = true;
  try {
    const res = await fetch(`${API}/api/admin/player-chat?target_id=${_playerChatTargetId}`, {
      headers: { 'X-Admin-Token': _adminToken }
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (_playerChatTargetId !== Number(data.user?.tg_id || _playerChatTargetId)) return;

    const name = data.user?.roblox_username || data.user?.first_name || 'ИГРОК';
    document.getElementById('player-chat-name').textContent = String(name).toUpperCase();
    document.getElementById('player-chat-id').textContent = `tg_id: ${_playerChatTargetId}`;
    renderPlayerChatMessages(data.messages || [], silent);
  } catch (error) {
    if (!silent) {
      document.getElementById('player-chat-messages').innerHTML =
        `<div class="player-chat-empty error">КАНАЛ НЕДОСТУПЕН<small>${escHtml(error.message)}</small></div>`;
    }
  } finally {
    _playerChatLoading = false;
  }
}

async function sendPlayerChatMessage() {
  if (!_playerChatTargetId || !_adminToken) return;
  const input = document.getElementById('player-chat-text');
  const button = document.getElementById('player-chat-send');
  const text = input?.value.trim();
  if (!text) return;

  button.disabled = true;
  try {
    const res = await fetch(`${API}/api/admin/player-chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body: JSON.stringify({ target_id: _playerChatTargetId, text })
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.message || data.error || `HTTP ${res.status}`);
    input.value = '';
    await loadPlayerChat();
    input.focus();
  } catch (error) {
    showToast(`Не удалось отправить: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

// ── Экран ИГРОКИ: сводная карточка + поиск ──────────
async function loadPlayersScreen() {
  // Сбрасываем карточку
  ['pb-grand-total','pb-balances','pb-items','pb-withdraw','pb-users','pb-items-count']
    .forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '...'; });

  try {
    const res  = await fetch(`${API}/api/stats/totals`, {
      headers: { 'X-Admin-Token': _adminToken }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const fmt = n => Number(n || 0).toLocaleString('ru-RU');

    const gt = document.getElementById('pb-grand-total');
    if (gt) gt.textContent = `${fmt(data.grand_total)} 🧠`;

    const bal = document.getElementById('pb-balances');
    if (bal) bal.textContent = `${fmt(data.total_balances)} 🧠`;

    const usr = document.getElementById('pb-users');
    if (usr) usr.textContent = `${fmt(data.total_users)} игроков`;

    const itm = document.getElementById('pb-items');
    if (itm) itm.textContent = `${fmt(data.total_items)} 🧠`;

    const cnt = document.getElementById('pb-items-count');
    if (cnt) cnt.textContent = `${fmt(data.total_items_count)} предметов`;

    const wd = document.getElementById('pb-withdraw');
    if (wd) wd.textContent = `${fmt(data.total_withdraw)} 🧠`;

  } catch (e) {
    const gt = document.getElementById('pb-grand-total');
    if (gt) gt.textContent = 'Ошибка';
    console.error('Players data load error', e);
  }
}

async function adminPanelSearch() {
  const q    = (document.getElementById('admin-players-search')?.value || '').trim().toLowerCase();
  const all  = window._adminPlayersList || [];
  const list = document.getElementById('admin-players-list');
  if (!list) return;

  let filtered = all;
  if (q) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Поиск...</div>';
    try {
      const response = await fetch(`${API}/api/admin/players?q=${encodeURIComponent(q.slice(0, 64))}`, {
        headers: { 'X-Admin-Token': _adminToken }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      filtered = (await response.json()).players || [];
    } catch (error) {
      console.error('Admin player search error', error);
      list.innerHTML = '<div style="color:var(--red);font-size:13px">Поиск временно недоступен</div>';
      return;
    }
  }

  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:13px">Никого не найдено</div>';
    return;
  }

  list.innerHTML = filtered.map(p => {
    const net      = (p.total_won - p.total_lost).toFixed(0);
    const netColor = net >= 0 ? 'var(--green)' : 'var(--red)';
    return `
      <div onclick="openPlayerModal(${p.tg_id})" style="
        background:var(--surface);border:1px solid var(--border);
        border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;
        transition:border-color .15s" onmouseover="this.style.borderColor='var(--accent)'"
        onmouseout="this.style.borderColor='var(--border)'">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div style="font-family:'Orbitron',sans-serif;font-size:12px;color:var(--text)">#${p.tg_id}</div>
            <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${escHtml(p.roblox_username || '—')} · ${p.total_games || 0} игр</div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Orbitron',sans-serif;font-size:14px;color:var(--gold)">${Math.floor(p.balance)} 🧠</div>
            <div style="font-size:10px;color:${netColor};margin-top:2px">нетто: ${net >= 0 ? '+' : ''}${net}</div>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function adminSearchPlayers() {
  const q   = (document.getElementById('players-search')?.value || '').trim();
  const list = document.getElementById('players-list');
  if (!list) return;

  if (!q) {
    list.innerHTML = '<div class="inv-empty">Введи tg_id или ник</div>';
    return;
  }
  if (!_adminToken) {
    list.innerHTML = '<div class="inv-empty">Нет доступа (нужен admin)</div>';
    return;
  }

  list.innerHTML = '<div class="inv-empty">Поиск...</div>';

  try {
    const res  = await fetch(`${API}/api/admin/players?tg_id=${tg_id}&q=${encodeURIComponent(q)}`, {
      headers: { 'X-Admin-Token': _adminToken }
    });
    const data = await res.json();
    const players = data.players || [];

    if (!players.length) {
      list.innerHTML = '<div class="inv-empty">Никого не найдено</div>';
      return;
    }

    list.innerHTML = players.map(p => `
      <div onclick="openPlayerProfile(${p.tg_id})" style="
        background:var(--surface2);border:1px solid var(--border);
        border-radius:12px;padding:12px 14px;cursor:pointer;
        display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-family:'Orbitron',sans-serif;font-size:12px;color:var(--text)">#${p.tg_id}</div>
          <div style="font-size:11px;color:var(--text-dim);margin-top:2px">${escHtml(p.roblox_username || '—')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-family:'Orbitron',sans-serif;font-size:14px;color:var(--gold)">${Math.floor(p.balance)} 🧠</div>
        </div>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = '<div class="inv-empty">Ошибка сервера</div>';
  }
}

async function openPlayerProfile(targetId) {
  if (!_adminToken) return;
  const overlay  = document.getElementById('player-profile-overlay');
  const content  = document.getElementById('player-profile-content');
  if (!overlay || !content) return;

  content.innerHTML = '<div class="inv-empty">Загрузка...</div>';
  overlay.style.display = 'block';

  try {
    const res  = await fetch(`${API}/api/admin/player`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': _adminToken },
      body:    JSON.stringify({ tg_id, target_id: targetId })
    });
    const data = await res.json();
    if (data.error) { content.innerHTML = `<div class="inv-empty">${escHtml(data.error)}</div>`; return; }

    const u = data.user || {};
    const items = (data.items || []).map(i =>
      `<div style="display:flex;align-items:center;gap:8px;background:var(--surface2);border-radius:8px;padding:8px 10px;margin-bottom:6px">
        <span style="font-size:18px">${escHtml(i.emoji || '🧠')}</span>
        <div>
          <div style="font-size:12px;color:var(--text)">${escHtml(i.item_name)}</div>
          <div style="font-size:10px;color:var(--text-dim)">${i.frozen ? '⏳ На выводе' : i.rarity}</div>
        </div>
      </div>`
    ).join('') || '<div class="inv-empty">Инвентарь пуст</div>';

    content.innerHTML = `
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:14px;padding:16px;margin-bottom:12px">
        <div style="font-family:'Orbitron',sans-serif;font-size:14px;color:var(--gold);margin-bottom:8px">#${u.tg_id}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Ник: <span style="color:var(--text)">${escHtml(u.roblox_username||'—')}</span></div>
        <div style="font-family:'Orbitron',sans-serif;font-size:20px;color:var(--gold);margin-top:8px">${Math.floor(u.balance||0)} 🧠</div>
        <div style="font-size:10px;color:var(--text-dim);margin-top:2px">${u.total_games||0} игр · нетто: ${((u.total_won||0)-(u.total_lost||0)).toFixed(0)} 🧠</div>
      </div>
      ${playerBankControl(u.tg_id || targetId, u.special_mode, u.bank_exempt)}
      <div style="font-size:10px;color:var(--text-dim);letter-spacing:.1em;margin-bottom:8px">🎒 ИНВЕНТАРЬ</div>
      ${playerChatLaunch(u.tg_id || targetId)}
      ${items}`;
  } catch (e) {
    content.innerHTML = '<div class="inv-empty">Ошибка загрузки</div>';
  }
}

function closePlayerProfile() {
  const overlay = document.getElementById('player-profile-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ════════════════════════════════════════════════════════════════
// МУЛЬТИ-РУЛЕТКА
// ════════════════════════════════════════════════════════════════

const MR_MULTS  = [2, 3, 10, 15, 20, 40];
const MR_COLORS = {
  2:  '#319e9a',
  3:  '#74d342',
  10: '#e5a02f',
  15: '#d95a30',
  20: '#c355bb',
  40: '#ff3825',
};
const MR_COLORS_LEGACY = {
  2:  '#4f8ef7',
  3:  '#43c96e',
  10: '#f5a623',
  15: '#b566f5',
  20: '#9b59b6',
  40: '#f05454',
};

function mrColor(mult) {
  if (uiThemeChoice === 'ultra' && window.BBUltraVisuals) return window.BBUltraVisuals.multipliers[mult];
  return (uiTheme === 'classic' ? MR_COLORS_LEGACY : MR_COLORS)[mult];
}

// Раскладка ячеек по кругу: 20 равных ячеек, количество ячеек на множитель
// пропорционально весу (48/31/9/6/4/2 → 9/6/2/1/1/1). Редкие сектора
// (40, 20, 15, 10, 10) расставлены равномерно через каждые 4 позиции для
// симметричного вида, промежутки заполнены чередованием x2/x3 без
// повторов подряд (в т.ч. на стыке круга).
const MR_CELLS = [40,2,3,2,20,2,3,2,15,2,3,2,10,2,3,2,10,3,2,3];

let mrState            = null;
let mrRoundId          = null;
let mrSpinAt           = null;
let mrTimerHandle      = null;
let mrPolling          = null;
let mrSpinning         = false;
let mrSelectedMult     = null;
let mrCurrentAngle     = 0;
let mrWinningIdx       = null;
let mrLastSpunRoundId  = null; // round_id раунда, анимацию которого уже запустили
let mrWaitingForResult = false; // ждём результат после 400 от /api/mr/spin

function mrInit() {
  mrPause();
  mrBuildSectors();
  mrBuildMultBtns();
  mrDrawWheel();
  mrPoll();
}

function mrPause() {
  if (mrPolling) {
    clearTimeout(mrPolling);
    mrPolling = null;
  }
  if (mrTimerHandle) {
    clearInterval(mrTimerHandle);
    mrTimerHandle = null;
  }
}

// ── Колесо ──
// ── Колесо (ячейки) ──
function mrDrawWheelLegacy(spinAngle = null, winningIdx) {
  const canvas = document.getElementById('mr-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 10;

  // Если угол не передан явно — рисуем колесо там, где оно сейчас "стоит"
  // (не сбрасываем в начальное положение между раундами).
  if (spinAngle === null) spinAngle = mrCurrentAngle;
  // undefined = аргумент вообще не передали → берём текущую глобальную обводку.
  // Явный null (как во время кручения) — это осознанное "обводки нет", не подменяем его.
  if (winningIdx === undefined) winningIdx = mrWinningIdx;

  ctx.clearRect(0, 0, W, H);

  const n     = MR_CELLS.length;
  const slice = (2 * Math.PI) / n;
  const gap   = 0.018; // небольшой зазор между ячейками для симметричного вида

  let angle = spinAngle - Math.PI / 2 - slice / 2;
  MR_CELLS.forEach((mult, idx) => {
    const isWinner  = idx === winningIdx;
    const a0 = angle + gap / 2;
    const a1 = angle + slice - gap / 2;

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = MR_COLORS_LEGACY[mult];
    ctx.fill();
    ctx.strokeStyle = '#0d0d1a';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle + slice / 2);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${mult >= 15 ? 12 : 11}px Orbitron, sans-serif`;
    ctx.fillText(`x${mult}`, R - 10, 4);
    ctx.restore();

    angle += slice;
  });

  // Обводка выигравшей ячейки — рисуем поверх всех секторов
  if (winningIdx !== null) {
    let wAngle = spinAngle - Math.PI / 2 - slice / 2 + winningIdx * slice;
    const wa0 = wAngle + gap / 2;
    const wa1 = wAngle + slice - gap / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, wa0, wa1);
    ctx.closePath();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 10;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // Центр
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, 2 * Math.PI);
  ctx.fillStyle = '#0d0d1a';
  ctx.fill();

  // Стрелка сверху — остриё смотрит вниз, на колесо
  ctx.beginPath();
  ctx.moveTo(cx, 22);
  ctx.lineTo(cx - 10, 4);
  ctx.lineTo(cx + 10, 4);
  ctx.closePath();
  ctx.fillStyle = '#f5c542';
  ctx.fill();
}

// ── Секции ──
function mrDrawWheel(spinAngle = null, winningIdx) {
  if (uiThemeChoice === 'ultra' && window.BBUltraVisuals) {
    const winner = winningIdx === undefined ? mrWinningIdx : winningIdx;
    const angle = (spinAngle === null ? mrCurrentAngle : spinAngle) - Math.PI / 2 - Math.PI / MR_CELLS.length;
    window.BBUltraVisuals.drawDial('mr-canvas', MR_CELLS.map(mult => ({weight: 1, label: `×${mult}`, color: mrColor(mult)})),
      angle, winner, Number.isInteger(winner) && winner >= 0 ? `×${MR_CELLS[winner]}` : 'ULTRA');
    return;
  }
  if (uiTheme === 'classic') {
    mrDrawWheelLegacy(spinAngle, winningIdx);
    return;
  }
  const canvas = document.getElementById('mr-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const cx = W / 2;
  const cy = H / 2;
  const outerR = Math.min(cx, cy) - 10;
  const trackInner = outerR * 0.54;
  const hubR = trackInner - 8;
  if (spinAngle === null) spinAngle = mrCurrentAngle;
  if (winningIdx === undefined) winningIdx = mrWinningIdx;

  ctx.clearRect(0, 0, W, H);
  const plate = ctx.createRadialGradient(cx, cy, 8, cx, cy, outerR + 9);
  plate.addColorStop(0, '#253022');
  plate.addColorStop(0.5, '#0b0d09');
  plate.addColorStop(0.78, '#25140d');
  plate.addColorStop(1, '#6c2d19');
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 8, 0, Math.PI * 2);
  ctx.fillStyle = plate;
  ctx.fill();

  const n = MR_CELLS.length;
  const slice = Math.PI * 2 / n;
  const gap = 0.014;
  let angle = spinAngle - Math.PI / 2 - slice / 2;
  MR_CELLS.forEach((mult, idx) => {
    const a0 = angle + gap;
    const a1 = angle + slice - gap;
    const mid = angle + slice / 2;
    const color = mrColor(mult);
    const grad = ctx.createLinearGradient(
      cx + Math.cos(mid) * trackInner,
      cy + Math.sin(mid) * trackInner,
      cx + Math.cos(mid) * outerR,
      cy + Math.sin(mid) * outerR
    );
    grad.addColorStop(0, '#11130f');
    grad.addColorStop(0.28, color);
    grad.addColorStop(0.72, color);
    grad.addColorStop(1, '#35170f');

    ctx.beginPath();
    ctx.arc(cx, cy, outerR - 4, a0, a1);
    ctx.arc(cx, cy, trackInner, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,214,129,.32)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(mid);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff0cc';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 4;
    ctx.font = `900 ${mult >= 15 ? 10 : 11}px "IBM Plex Mono", monospace`;
    ctx.fillText(`x${mult}`, (trackInner + outerR) / 2, 1);
    ctx.restore();

    const ledR = outerR - 1;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(mid) * ledR, cy + Math.sin(mid) * ledR, mult >= 15 ? 2.7 : 1.6, 0, Math.PI * 2);
    ctx.fillStyle = mult >= 15 ? '#fff4a8' : '#20110b';
    ctx.fill();

    if (idx === winningIdx) {
      ctx.save();
      ctx.shadowColor = '#fff5bc';
      ctx.shadowBlur = 18;
      ctx.strokeStyle = '#fff5bc';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.restore();
    }
    angle += slice;
  });

  ctx.strokeStyle = '#7a311b';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#d98a43';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  for (let i = 0; i < 12; i++) {
    const a = i / 12 * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * (hubR - 4), cy + Math.sin(a) * (hubR - 4));
    ctx.lineTo(cx + Math.cos(a) * trackInner, cy + Math.sin(a) * trackInner);
    ctx.strokeStyle = i % 3 === 0 ? '#9acb47' : '#3c2918';
    ctx.lineWidth = i % 3 === 0 ? 2 : 1;
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(Math.PI / 8);
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    const x = Math.cos(a) * hubR;
    const y = Math.sin(a) * hubR;
    if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const hub = ctx.createRadialGradient(-12, -18, 3, 0, 0, hubR);
  hub.addColorStop(0, '#48563b');
  hub.addColorStop(0.5, '#172016');
  hub.addColorStop(1, '#35190f');
  ctx.fillStyle = hub;
  ctx.fill();
  ctx.strokeStyle = '#b36c31';
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '900 19px "Rubik Mono One", sans-serif';
  ctx.fillStyle = '#f1e7c3';
  ctx.fillText('BRAIN', cx, cy - 8);
  ctx.fillStyle = '#83e84e';
  ctx.fillText('BET', cx, cy + 14);

  ctx.save();
  ctx.shadowColor = '#ff3b22';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.moveTo(cx, 27);
  ctx.lineTo(cx - 13, 5);
  ctx.lineTo(cx + 13, 5);
  ctx.closePath();
  ctx.fillStyle = '#ff4527';
  ctx.fill();
  ctx.strokeStyle = '#ffd270';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function redrawThemeGameSurfaces() {
  wheelRenderState.forEach((state, canvasId) => {
    drawWheel(canvasId, state.players, state.highlightIdx, state.rotation);
  });

  if (typeof mrBuildSectors === 'function') mrBuildSectors();
  if (typeof mrBuildMultBtns === 'function') mrBuildMultBtns();
  if (typeof mrRenderState === 'function' && mrState) mrRenderState(mrState);
  else if (typeof mrDrawWheel === 'function') mrDrawWheel();

  if (typeof ensureUpgraderWheelTheme === 'function') ensureUpgraderWheelTheme();
  if (typeof upgUpdateWheel === 'function' && upgData) upgUpdateWheel();
}

function mrBuildSectors() {
  const wrap = document.getElementById('mr-sectors');
  if (!wrap) return;
  wrap.innerHTML = MR_MULTS.map(m => `
    <div class="mr-sector" id="mr-sec-${m}" style="border-color:${mrColor(m)}">
      <div class="mr-sec-mult" style="color:${mrColor(m)}">x${m}</div>
      <div class="mr-sec-pool" id="mr-sec-pool-${m}">0 🧠</div>
    </div>
  `).join('');
}

// ── Кнопки множителей ──
function mrBuildMultBtns() {
  const wrap = document.getElementById('mr-mult-btns');
  if (!wrap) return;
  wrap.innerHTML = MR_MULTS.map(m => `
    <button class="mr-mbtn${mrSelectedMult === m ? ' active' : ''}" id="mr-mbtn-${m}"
      style="border-color:${mrColor(m)};color:${mrColor(m)};background:${mrSelectedMult === m ? mrColor(m) + '33' : 'transparent'}"
      onclick="mrSelectMult(${m})">
      x${m}
      <span class="mr-my-bet" id="mr-mybetlbl-${m}"></span>
    </button>
  `).join('');
}

function mrSelectMult(mult) {
  mrSelectedMult = mult;
  document.querySelectorAll('.mr-mbtn').forEach(b => {
    b.classList.remove('active');
    b.style.background = 'transparent';
  });
  const btn = document.getElementById(`mr-mbtn-${mult}`);
  if (btn) {
    btn.classList.add('active');
    btn.style.background = mrColor(mult) + '33';
  }
}

// ── Обновить UI ──
function mrUpdateUI(data) {
  mrState   = data;
  mrRoundId = data.round_id;
  // Дедлайн строим от серверного seconds_left, а не от data.spin_at.
  // spin_at — это серверный time.time(); если часы на телефоне спешат,
  // разница получалась 0 и клиент мгновенно дёргал spin.
  if (typeof data.seconds_left === 'number') {
    mrSpinAt = Date.now() / 1000 + data.seconds_left;
  } else if (data.spin_at) {
    mrSpinAt = data.spin_at;
  }

  mrRenderState(data);
  mrStartTimer();
}

// Presentation only: theme changes must not recalculate a round's deadline.
function mrRenderState(data) {
  const bets     = data.bets_by_mult  || {};
  const myBets   = data.my_bets       || {};

  if (!mrSpinning) mrDrawWheel();

  MR_MULTS.forEach(m => {
    const pool = bets[m] || 0;
    const poolEl = document.getElementById(`mr-sec-pool-${m}`);
    if (poolEl) poolEl.textContent = Math.floor(pool) + ' 🧠';

    const myLbl = document.getElementById(`mr-mybetlbl-${m}`);
    if (myLbl) myLbl.textContent = myBets[m] ? `(${Math.floor(myBets[m])})` : '';
  });

  if (data.recent_results) mrRenderHistory(data.recent_results);
  if (data.players)        mrRenderPlayers(data.players);

}

// ── История последних результатов (кружки без текста) ──
function mrRenderHistory(results) {
  const wrap = document.getElementById('mr-history');
  if (!wrap) return;
  if (!results.length) {
    wrap.innerHTML = '<div class="mr-history-empty">Пока нет спинов</div>';
    return;
  }
  // Самый новый — слева
  wrap.innerHTML = results.map(m => {
    const color = m ? mrColor(m) : '#3a3a45';
    return `<div class="mr-hist-dot" style="background:${color};box-shadow:0 0 6px ${color}88" title="${m ? 'x' + m : '—'}"></div>`;
  }).join('');
}

// ── Список игроков раунда: ник, ставка, множитель ──
function mrRenderPlayers(players) {
  const wrap = document.getElementById('mr-players-list');
  if (!wrap) return;
  if (!players.length) {
    wrap.innerHTML = '<div class="mr-players-empty">Пока никто не поставил</div>';
    return;
  }
  wrap.innerHTML = players.map(p => {
    const color = mrColor(p.mult) || '#888';
    const isMe  = p.tg_id === tg_id;
    const name  = p.roblox_username || `Игрок #${p.tg_id}`;
    return `
      <div class="mr-player-row">
        <span class="mr-player-name">${playerProfileLink(p.tg_id, name, isMe)}</span>
        <span class="mr-player-bet">${Math.floor(p.bet)} 🧠</span>
        <span class="mr-player-mult" style="color:${color};border-color:${color}">x${p.mult}</span>
      </div>
    `;
  }).join('');
}

// ── Таймер ──
function mrStartTimer() {
  if (mrTimerHandle) clearInterval(mrTimerHandle);
  mrTimerHandle = setInterval(() => {
    if (!isGameActive('mr')) return;
    if (!mrSpinAt) return;
    const left = Math.max(0, Math.ceil(mrSpinAt - Date.now() / 1000));
    const el = document.getElementById('mr-timer');
    if (el) el.textContent = left + 's';
    if (left <= 0 && !mrSpinning && mrRoundId) {
      clearInterval(mrTimerHandle);
      mrTriggerSpin();
    }
  }, 500);
}

// ── Запуск спина ──
async function mrTriggerSpin() {
  if (mrSpinning || mrWaitingForResult) return;
  mrWaitingForResult = true;

  let result;
  try {
    const r = await fetch(`${API}/api/mr/spin`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({round_id: mrRoundId})
    });

    if (r.status === 400) {
      let err = null;
      try { err = await r.json(); } catch (e) {}
      mrWaitingForResult = false;
      if (err && err.error === 'too_early') {
        // Рассинхрон часов или вкладка была свёрнута — берём время сервера и ждём честно
        mrSpinAt = Date.now() / 1000 + (err.seconds_left || 1);
        mrStartTimer();
        return;
      }
      // Спин уже запущен другим клиентом — ждём результат через поллинг
      mrWatchForResult();
      return;
    }

    result = await r.json();
  } catch (e) {
    mrWaitingForResult = false;
    mrPoll();
    return;
  }

  if (result.error) {
    mrWaitingForResult = false;
    mrWatchForResult();
    return;
  }

  mrWaitingForResult = false;
  mrAnimateSpin(result.result_mult, result);
}

// ── Ждём результата (для клиентов которые не были инициатором спина) ──
async function mrWatchForResult() {
  if (mrSpinning) return; // анимация уже идёт
  const watchRoundId = mrRoundId; // запоминаем текущий раунд

  // Быстрый поллинг пока раунд не завершится
  async function poll() {
    if (mrSpinning) return; // кто-то уже запустил анимацию

    let data;
    try {
      const r = await fetch(`${API}/api/mr/status?tg_id=` + (tg_id || ''));
      data = await r.json();
    } catch (e) {
      setTimeout(poll, 500);
      return;
    }

    // Раунд сменился или завершился — берём последний результат из истории
    const roundDone = data.round_id !== watchRoundId || data.status === 'none' || data.status === 'finished';
    if (roundDone && data.recent_results && data.recent_results.length > 0) {
      const winMult = data.recent_results[0]; // самый свежий результат — первый в массиве
      if (winMult && mrLastSpunRoundId !== watchRoundId) {
        // ВАЖНО: подменяем round_id на наблюдаемый раунд. Раньше сюда уходил data
        // со свежим round_id НОВОГО раунда → mrAnimateSpin помечал НОВЫЙ раунд как
        // "уже прокрученный" (mrLastSpunRoundId), и когда его таймер доходил до нуля,
        // анимация блокировалась — результат выскакивал мгновенно без кручения.
        mrAnimateSpin(winMult, {...data, round_id: watchRoundId});
      } else {
        // Нет результата (все заблокированы) — просто показываем финал
        mrPoll();
      }
      return;
    }

    // Раунд ещё крутится — ждём
    if (!roundDone) {
      setTimeout(poll, 400);
      return;
    }

    // Раунд сменился но истории нет — просто поллим
    mrPoll();
  }

  setTimeout(poll, 300);
}

// ── Анимация ──
function mrAnimateSpin(winMult, result) {
  // Защита от двойного запуска одной и той же анимации
  const animRound = result.round_id || mrRoundId;
  if (animRound && mrLastSpunRoundId === animRound) return;
  if (mrSpinning) return;
  if (animRound) mrLastSpunRoundId = animRound;
  mrSpinning = true;

  const canvas = document.getElementById('mr-canvas');
  if (!canvas) { mrAfterSpin(winMult, result); return; }

  const n       = MR_CELLS.length;
  const slice   = (2 * Math.PI) / n;

  // Выбираем ячейку детерминированно через round_id — у всех клиентов один и тот же результат.
  // Если round_id недоступен — fallback на случайный выбор.
  const animRoundId = (result && result.round_id) || mrRoundId || 0;
  function seededPick(arr, seed) {
    // простой детерминированный выбор: seed mod длина массива
    return arr[Math.abs(seed) % arr.length];
  }
  let targetIdx;
  let targetAngleMod; // угол (mod 2π), при котором центр нужной ячейки под стрелкой
  if (winMult) {
    const indices = MR_CELLS.reduce((acc, m, i) => { if (m === winMult) acc.push(i); return acc; }, []);
    targetIdx = seededPick(indices, animRoundId);
    targetAngleMod = -targetIdx * slice;
  } else {
    targetIdx = null;
    // Для null-результата тоже детерминированный угол
    targetAngleMod = (animRoundId * 1.7) % (2 * Math.PI);
  }
  const TWO_PI = 2 * Math.PI;
  targetAngleMod = ((targetAngleMod % TWO_PI) + TWO_PI) % TWO_PI;

  // Колесо крутится ДАЛЬШЕ от текущего положения (не сбрасывается в 0) —
  // находим ближайший угол >= mrCurrentAngle + несколько оборотов, который mod 2π совпадает с целевым.
  const startAngle = mrCurrentAngle;
  const extraSpins  = 5; // полных оборотов для красивой анимации
  const currentMod  = ((startAngle % TWO_PI) + TWO_PI) % TWO_PI;
  let deltaToTarget = targetAngleMod - currentMod;
  if (deltaToTarget <= 0) deltaToTarget += TWO_PI;
  const finalAngle = startAngle + extraSpins * TWO_PI + deltaToTarget;

  const duration = 7000;
  const start    = performance.now();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

  function frame(now) {
    const t     = Math.min((now - start) / duration, 1);
    const angle = startAngle + easeOut(t) * (finalAngle - startAngle);
    if (isGameActive('mr')) mrDrawWheel(angle, null); // скрытый canvas не перерисовываем
    if (t < 1) {
      requestAnimationFrame(frame);
    } else {
      mrCurrentAngle = finalAngle;
      mrWinningIdx   = targetIdx;
      mrDrawWheel(mrCurrentAngle, mrWinningIdx); // финальный кадр — с обводкой
      mrAfterSpin(winMult, result);
    }
  }
  requestAnimationFrame(frame);
}

// ── После спина ──
function mrAfterSpin(winMult, result) {
  mrSpinning = false;

  // Небольшая задержка чтобы финальный кадр колеса успел отрисоваться прежде чем появятся кружки
  setTimeout(() => {
    if (result.recent_results) mrRenderHistory(result.recent_results);
  }, 600);
  mrRenderPlayers([]); // раунд завершён — список ставок очищаем

  const resEl = document.getElementById('mr-result');
  if (resEl) {
    resEl.style.display = 'block';
    if (!winMult) {
      resEl.className = 'result-box lose';
      resEl.innerHTML = '💀 Все множители заблокированы — все проиграли';
    } else {
      const myBet = (mrState?.my_bets || {})[winMult] || 0;
      if (myBet > 0) {
        const payout = Math.floor(myBet * winMult);
        resEl.className = 'result-box win';
        resEl.innerHTML = `🎉 Выпало <b>x${winMult}</b>! Ты выиграл <b>${payout} 🧠</b>`;
        loadInit();
      } else {
        resEl.className = 'result-box lose';
        resEl.innerHTML = `Выпало <b>x${winMult}</b> — твой множитель не выпал`;
      }
    }
    setTimeout(() => { if (resEl) resEl.style.display = 'none'; }, 5000);
  }

  setTimeout(() => {
    mrRoundId   = null;
    mrSpinAt    = null;
    mrState     = null;
    mrWinningIdx = null;
    mrDrawWheel(); // перерисовываем без обводки, угол сохраняется
    mrPoll();
  }, 3000);
}

// ── Поллинг ──
async function mrPoll() {
  if (mrPolling) clearTimeout(mrPolling);
  if (!isGameActive('mr')) {
    mrPolling = null;
    return;
  }
  try {
    const r    = await fetch(`${API}/api/mr/status?tg_id=${tg_id}`);
    const data = await r.json();

    if (data.status === 'none' || data.status === 'finished' || data.status === 'spinning') {
      // Не обновляем историю пока идёт анимация — кружки появятся раньше остановки колеса
      if (!mrSpinning) {
        mrDrawWheel();
        if (data.recent_results) mrRenderHistory(data.recent_results);
        if (data.status === 'none') mrRenderPlayers([]);
      }
      mrPolling = setTimeout(mrPoll, 2000);
      return;
    }

    mrUpdateUI(data);
    if (!mrSpinning) mrPolling = setTimeout(mrPoll, 2000);
  } catch (e) {
    mrPolling = setTimeout(mrPoll, 3000);
  }
}

// ── Поставить ──
async function mrPlaceBet() {
  if (mrSpinning) { showToast('Идёт крутение!', 'lose'); return; }
  if (!mrSelectedMult) { showToast('Выбери множитель', 'lose'); return; }

  const bet = parseFloat(document.getElementById('mr-bet').value);
  if (!bet || bet <= 0) { showToast('Введи ставку', 'lose'); return; }

  try {
    const r = await fetch(`${API}/api/mr/bet`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tg_id, mult: mrSelectedMult, bet})
    });
    const data = await r.json();
    if (data.error) {
      const msgs = {
        insufficient_balance: 'Недостаточно мозгов',
        bet_too_low:          `Минимальная ставка — ${data.min_bet || 10} 🧠`,
        max_mults_reached:    `Можно ставить максимум на ${data.max_mults || 3} разных множителя за раунд`,
        invalid_mult:         'Неверный множитель',
        invalid_bet:          'Неверная ставка',
        missing_params:       'Не все данные заполнены',
      };
      showToast(msgs[data.error] || data.error, 'lose');
      return;
    }
    updateBalanceDisplay(data.balance);
    showToast(`Поставлено ${Math.floor(bet)} 🧠 на x${mrSelectedMult}`, 'win');

    // Обновляем локальный стейт без лишнего поллинга
    const myBets = {...(mrState?.my_bets || {}),
      [mrSelectedMult]: ((mrState?.my_bets || {})[mrSelectedMult] || 0) + bet};
    mrUpdateUI({
      ...mrState,
      round_id:      data.round_id,
      spin_at:       data.spin_at,
      bets_by_mult:  data.bets_by_mult,
      my_bets:       myBets,
      players:       data.players,
    });
  } catch (e) {
    showToast('Ошибка', 'lose');
  }
}

// ================================================
// 🚀 УПГРЕЙДЕР
// ================================================
let upgData = null;            // {catalog, inventory, balance, ...}
let upgStakeIds = new Set();   // выбранные предметы-ставка
let upgTargetName = null;      // выбранная цель
let upgSpinning = false;
let upgLoadSeq = 0;
let upgNeonWheelMarkup = '';
const UPG_WHEEL_STYLE_KEY = 'bb_upg_wheel_style_v1';
const UPG_ANIMATION_MODE_KEY = 'bb_upg_animation_mode';
const UPG_ANIMATION_PROFILES = Object.freeze({
  normal: Object.freeze({ duration: 7800, spins: 6, tick: 48, revealWin: 850, revealLose: 1150 }),
  instant: Object.freeze({ duration: 560, spins: 1, tick: 8, revealWin: 90, revealLose: 120 }),
});
let upgAnimationMode = (() => {
  try { return localStorage.getItem(UPG_ANIMATION_MODE_KEY) === 'instant' ? 'instant' : 'normal'; }
  catch (e) { return 'normal'; }
})();
let upgWheelStyle = (() => {
  try {
    const saved = localStorage.getItem(UPG_WHEEL_STYLE_KEY);
    if (saved === 'reactor') {
      localStorage.setItem(UPG_WHEEL_STYLE_KEY, 'neon');
      return 'neon';
    }
    return saved === 'classic' ? 'classic' : 'neon';
  } catch (e) {
    return 'neon';
  }
})();

function syncUpgWheelStyleControl() {
  const control = document.getElementById('upg-style-control');
  if (!control) return;
  control.dataset.style = upgWheelStyle;
  control.classList.toggle('is-locked', upgSpinning);
  for (const style of ['classic', 'neon']) {
    const button = document.getElementById(`upg-style-${style}`);
    if (!button) continue;
    const active = style === upgWheelStyle;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = upgSpinning;
  }
}

function setUpgWheelStyle(style) {
  if (upgSpinning) return;
  const nextStyle = style === 'neon' ? 'neon' : 'classic';
  if (nextStyle === upgWheelStyle) {
    ensureUpgraderWheelTheme();
    return;
  }
  upgWheelStyle = nextStyle;
  try { localStorage.setItem(UPG_WHEEL_STYLE_KEY, upgWheelStyle); } catch (e) {}
  ensureUpgraderWheelTheme(true);
  if (upgData) upgUpdateWheel();
}

function syncUpgAnimationModeControl() {
  const control = document.getElementById('upg-speed-control');
  if (!control) return;
  control.dataset.mode = upgAnimationMode;
  control.classList.toggle('is-locked', upgSpinning);
  for (const mode of ['normal', 'instant']) {
    const button = document.getElementById(`upg-speed-${mode}`);
    if (!button) continue;
    const active = mode === upgAnimationMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
    button.disabled = upgSpinning;
  }
}

function setUpgAnimationMode(mode) {
  if (upgSpinning) return;
  upgAnimationMode = mode === 'instant' ? 'instant' : 'normal';
  try { localStorage.setItem(UPG_ANIMATION_MODE_KEY, upgAnimationMode); } catch (e) {}
  syncUpgAnimationModeControl();
}

function upgAnimationProfile(mode = upgAnimationMode) {
  const profile = UPG_ANIMATION_PROFILES[mode] || UPG_ANIMATION_PROFILES.normal;
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return profile;
  return { ...profile, duration: Math.min(profile.duration, 420), spins: 1, revealWin: 60, revealLose: 60 };
}

function currentUpgWheelTheme() {
  // A theme switch must never replace the pointer/arc during an active spin.
  const runningTheme = upgSpinning && document.querySelector('#screen-upgrader .upg-wheel-wrap')?.dataset.wheelTheme;
  return runningTheme || (uiTheme === 'modern' ? 'modern' : upgWheelStyle);
}

function ensureUpgraderWheelTheme(force = false) {
  if (upgSpinning) return;
  const wrap = document.querySelector('#screen-upgrader .upg-wheel-wrap');
  if (!wrap) return;
  if (!upgNeonWheelMarkup) upgNeonWheelMarkup = wrap.innerHTML;

  const desired = currentUpgWheelTheme();
  if (!force && wrap.dataset.wheelTheme === desired) {
    syncUpgWheelStyleControl();
    return;
  }

  if (desired === 'classic' || desired === 'modern') {
    const template = document.getElementById(`upg-wheel-${desired}-template`);
    if (template) wrap.innerHTML = template.innerHTML;
  } else {
    wrap.innerHTML = upgNeonWheelMarkup;
  }
  wrap.dataset.wheelTheme = desired;
  syncUpgWheelStyleControl();
}

const UPG_RARITY_COLORS = {
  common:    '#8a9bb0',
  rare:      '#3fa9f5',
  epic:      '#a656f0',
  legendary: '#ffb02e',
  mythic:    '#ff4466',
  god:       '#22ffcc',
  secret:    '#ff2244',
};

async function upgLoad() {
  ensureUpgraderWheelTheme();
  syncUpgAnimationModeControl();
  const requestSeq = ++upgLoadSeq;
  try {
    await ensureTelegramAuth();
    const res = await fetch(`${API}/api/upgrader/data?tg_id=${tg_id}&_=${Date.now()}-${requestSeq}`, {
      cache: 'no-store'
    });
    const data = await res.json();
    if (requestSeq !== upgLoadSeq) return;
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    upgData = data;
    adminAbuseFreeOffers = Array.isArray(data.free_offers) ? data.free_offers : adminAbuseFreeOffers;
    // Чистим выбор от предметов, которых больше нет
    const ids = new Set((upgData.inventory || []).map(i => i.id));
    upgStakeIds = new Set([...upgStakeIds].filter(id => ids.has(id)));
    upgRenderInventory();
    upgRenderTargets();
    upgRenderShop();
    upgUpdateWheel();
  } catch (e) {
    if (requestSeq === upgLoadSeq) showToast('Ошибка загрузки упгрейдера', 'lose');
  }
}

function upgShowTab(tab) {
  document.getElementById('upg-tab-inv').classList.toggle('active', tab === 'inv');
  document.getElementById('upg-tab-shop').classList.toggle('active', tab === 'shop');
  document.getElementById('upg-inv-block').style.display  = tab === 'inv'  ? '' : 'none';
  document.getElementById('upg-shop-block').style.display = tab === 'shop' ? '' : 'none';
}

function upgStakeValue() {
  if (!upgData) return 0;
  return (upgData.inventory || [])
    .filter(i => upgStakeIds.has(i.id))
    .reduce((s, i) => s + i.value, 0);
}

function upgItemCard(item, selected, extraHtml = '') {
  const color = UPG_RARITY_COLORS[item.rarity] || 'var(--text-dim)';
  return `
    <div class="inv-item upg-item ${selected ? 'selected' : ''}" style="border-color:${selected ? 'var(--gold)' : color}">
      ${caseImgHtml(item.item_name || item.name, 48)}
      <div class="upg-item-name">${item.item_name || item.name}</div>
      <div class="upg-item-value" style="color:${color}">${item.value} 🧠</div>
      ${extraHtml}
    </div>`;
}

// ── Инвентарь (ставка) ─────────────────────────────────────
function upgRenderInventory() {
  const grid = document.getElementById('upg-inv-grid');
  const inv = upgData.inventory || [];
  if (inv.length === 0) {
    grid.innerHTML = '<div class="inv-empty">Пусто. Купи материалы в 🛒 МАГАЗИНЕ ниже</div>';
  } else {
    grid.innerHTML = inv.map(i => `
      <div onclick="upgToggleStake(${i.id})" style="position:relative">
        ${upgItemCard(i, upgStakeIds.has(i.id),
          `<button class="upg-sell-btn" onclick="event.stopPropagation();upgSell(${i.id})"><span class="upg-sell-led"></span><span>ПРОДАТЬ</span></button>`)}
      </div>`).join('');
  }
  const counter = document.getElementById('upg-inv-counter');
  counter.textContent = `Материалы: ${upgStakeValue()} 🧠 (${upgStakeIds.size} шт.)`;
  counter.style.color = upgStakeIds.size ? 'var(--gold)' : 'var(--text-dim)';
}

function upgKeepValidTarget() {
  if (!upgTargetName || !upgData) return;
  const target = (upgData.catalog || []).find(item => item.name === upgTargetName);
  const stake = upgStakeValue();
  if (!target || (stake > 0 && target.value <= stake)) upgTargetName = null;
}

function upgResetSelectionAfterAttempt(win, attemptedTargetName) {
  upgStakeIds = new Set();
  upgTargetName = win ? null : attemptedTargetName;
}

function upgToggleStake(id) {
  if (upgSpinning) return;
  if (upgStakeIds.has(id)) {
    upgStakeIds.delete(id);
  } else {
    if (upgStakeIds.size >= (upgData.max_stake_items || 10)) {
      showToast(`Максимум ${upgData.max_stake_items || 10} материалов в одном апгрейде!`, 'lose');
      return;
    }
    upgStakeIds.add(id);
  }
  upgKeepValidTarget();
  upgRenderInventory();
  upgRenderTargets();
  upgUpdateWheel();
}

// ── Цели ───────────────────────────────────────────────────
async function upgRenderTargets() {
  const grid = document.getElementById('upg-target-grid');
  const hint = document.getElementById('upg-target-hint');
  const stake = upgStakeValue();
  if (!stake) {
    grid.innerHTML = '';
    hint.textContent = 'Сначала выбери материалы';
    return;
  }
  // affordable считается на сервере, клиенту отдаётся только итоговый флаг
  let targets = [];
  try {
    const res = await fetch(`${API}/api/upgrader/targets?stake=${stake}`);
    const data = await res.json();
    targets = data.targets || [];
  } catch (e) {
    grid.innerHTML = '';
    hint.textContent = 'Ошибка загрузки целей';
    return;
  }
  if (targets.length === 0) {
    grid.innerHTML = '';
    hint.textContent = 'Нет результатов дороже твоих материалов';
    return;
  }
  hint.textContent = 'Выбери, во что апгрейднуть:';
  grid.innerHTML = targets.map(t => {
    const chance = upgChanceFor(stake, t.value);
    const locked = !t.affordable;
    return `
      <div onclick="${locked ? '' : `upgPickTarget('${t.name.replace(/'/g, "\\'")}')`}"
           style="position:relative;${locked ? 'opacity:.35;filter:grayscale(1)' : ''}">
        ${upgItemCard(t, upgTargetName === t.name,
          `<div class="upg-item-chance">${locked ? '🔒' : (chance * 100).toFixed(2) + '%'}</div>`)}
      </div>`;
  }).join('');
}

function upgChanceFor(stake, target) {
  const raw = (stake / target) * (1 - (upgData.commission ?? 0.50));
  return Math.min(upgData.max_chance ?? 0.80, raw);
}

function upgPickTarget(name) {
  if (upgSpinning) return;
  upgTargetName = (upgTargetName === name) ? null : name;
  upgRenderTargets();
  upgUpdateWheel();
}

// Вертикальный уровень шанса внутри круглого циферблата.
function upgFillGeom(chance) {
  const pct = Math.max(0, Math.min(1, chance));
  const classic = currentUpgWheelTheme() === 'classic';
  const top = classic ? 18 : 22;
  const bottom = classic ? 202 : 198;
  const rawHeight = (bottom - top) * pct;
  // A real sub-1% chance is less than one SVG pixel and disappears after
  // scaling on phones. Keep a small visual marker without changing the
  // numeric chance or any server-side result calculation.
  const height = pct > 0 ? Math.max(rawHeight, 4) : 0;
  return { y: bottom - height, height };
}

function upgPhiMaxDeg(chance) {
  const pct = Math.max(0, Math.min(1, chance));
  const cosValue = Math.max(-1, Math.min(1, 1 - 2 * pct));
  return Math.acos(cosValue) * 180 / Math.PI;
}

function upgUpdateClassicChanceArc(chance) {
  const arc = document.getElementById('upg-chance-arc');
  if (!arc) return;
  const pct = Math.max(0, Math.min(1, Number(chance) || 0));
  const chanceLength = pct * 100;
  // Keep very small non-zero chances visible as an arc rather than a single
  // anti-aliased dot. This value is presentation-only; the label and spin
  // still use the exact chance.
  const visualLength = chanceLength > 0 ? Math.max(chanceLength, 2) : 0;
  const halfSpanDeg = visualLength * 1.8;
  // SVG circles start at three o'clock. Rotate the arc so the real chance
  // remains centred on the bottom, matching the pointer result angles.
  arc.setAttribute('stroke-dasharray', `${visualLength} ${100 - visualLength}`);
  arc.setAttribute('transform', `rotate(${90 - halfSpanDeg} 110 110)`);
  arc.setAttribute('aria-label', `Шанс ${(pct * 100).toFixed(2)}%`);
}

// ── Колесо апгрейда: заливка и голограмма результата ──
function upgUpdateWheel() {
  const stake = upgStakeValue();
  const target = (upgData.catalog || []).find(t => t.name === upgTargetName);
  const chance = (stake && target) ? upgChanceFor(stake, target.value) : 0;

  const fillGeom = upgFillGeom(chance);
  const fillRect = document.getElementById('upg-fill-rect');
  const wheelTheme = currentUpgWheelTheme();
  const classicWheel = wheelTheme === 'classic';
  const neonWheel = wheelTheme === 'neon';
  const roundWheel = classicWheel || neonWheel;
  if (fillRect) {
    fillRect.setAttribute('x', roundWheel ? '10' : '22');
    fillRect.setAttribute('width', roundWheel ? '200' : '176');
    fillRect.setAttribute('y', fillGeom.y);
    fillRect.setAttribute('height', fillGeom.height);
  }
  const loseZone = document.querySelector('#screen-upgrader .upg-zone-lose');
  const wheelFill = document.getElementById('upg-wheel-fill');
  const wheelRing = document.getElementById('upg-wheel-ring');
  if (loseZone) loseZone.setAttribute('r', roundWheel ? '82' : '88');
  // Classic fill uses the full 92-radius disc (18..202), matching its
  // vertical chance calculation. Only the neon wheel has an inset disc.
  if (wheelFill) wheelFill.setAttribute('r', classicWheel ? '92' : neonWheel ? '82' : '88');
  if (wheelRing) wheelRing.setAttribute('r', roundWheel ? '92' : '88');
  if (neonWheel) upgUpdateClassicChanceArc(chance);
  const isLow = chance > 0 && chance < 0.05;
  const wheelWrap = document.querySelector('#screen-upgrader .upg-wheel-wrap');
  if (wheelWrap) wheelWrap.classList.toggle('upg-low-chance', isLow);

  document.getElementById('upg-chance-text').textContent = chance ? (chance * 100).toFixed(2) + '%' : '—';
  document.getElementById('upg-mult-text').textContent =
    (stake && target) ? `ценность материалов ${stake} 🧠 → результат ${target.value} 🧠` : '';

  // Голограмма результата в камере
  const holo = document.getElementById('upg-holo');
  holo.classList.toggle('has-target', Boolean(target));
  const upgDefaultIcon = wheelTheme === 'modern'
    ? '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M24 4 41 14 41 34 24 44 7 34 7 14Z" fill="#182012" stroke="#d6873e" stroke-width="2"/><path d="M24 8 37 16 24 24 11 16Z" fill="#e5ff78"/><path d="M11 18 23 25 23 40 11 32Z" fill="#ff4b2b"/><path d="M37 18 25 25 25 40 37 32Z" fill="#67d83b"/></svg>'
    : '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M24 5 41 23H31V43H17V23H7Z" fill="#a656f0" stroke="#ffd700" stroke-width="2"/></svg>';
  if (!upgSpinning) holo.innerHTML = target ? caseImgHtml(target.name, 64) : upgDefaultIcon;

  const summary = document.getElementById('upg-summary');
  if (!stake) summary.textContent = 'Выбери материалы для апгрейда';
  else if (!target) summary.textContent = `Материалы на ${stake} 🧠 — выбери результат или быстрый шанс под кнопкой`;
  else summary.innerHTML = `Материалы <b>${stake} 🧠</b> → <b>${escHtml(target.name)}</b> (${target.value} 🧠)`;

  document.getElementById('upg-go-btn').disabled = !(stake && target) || upgSpinning;
  syncUpgWheelStyleControl();
  syncUpgAnimationModeControl();
}

// ── Быстрый подбор цели под нужный шанс ────────────────────
async function upgQuick(wantChance) {
  if (upgSpinning) return;
  const stake = upgStakeValue();
  if (!stake) { showToast('Сначала выбери материалы для апгрейда'); return; }
  // affordable считается на сервере, клиенту отдаётся только итоговый флаг
  let candidates = [];
  try {
    const res = await fetch(`${API}/api/upgrader/targets?stake=${stake}`);
    const data = await res.json();
    candidates = (data.targets || []).filter(t => t.affordable);
  } catch (e) {
    showToast('Ошибка загрузки целей', 'lose');
    return;
  }
  let best = null, bestDiff = Infinity;
  for (const t of candidates) {
    const diff = Math.abs(upgChanceFor(stake, t.value) - wantChance);
    if (diff < bestDiff) { bestDiff = diff; best = t; }
  }
  if (!best) { showToast('Нет подходящего результата под этот процент', 'lose'); return; }
  upgTargetName = best.name;
  upgRenderTargets();
  upgUpdateWheel();
  showToast(`🎯 ${best.name} — ${(upgChanceFor(stake, best.value) * 100).toFixed(2)}%`);
}

// ── Выбор итогового угла указателя ──────────────────────────
// В neon выигрышная дуга показывает линейную долю окружности.
// В classic сохраняется прежняя геометрия вертикальной заливки. В обоих
// вариантах указатель останавливается строго в зоне серверного результата.
function upgPickFinalAngle(result, chance) {
  if (currentUpgWheelTheme() === 'neon') {
    const pct = Math.max(0, Math.min(1, Number(chance) || 0));
    const halfSpan = pct * 180;
    if (result === 'win') {
      const margin = Math.min(2.5, halfSpan * 0.18);
      const span = Math.max(halfSpan - margin, halfSpan * 0.45);
      return 180 + (Math.random() * 2 - 1) * span;
    }
    const margin = Math.min(3, Math.max((180 - halfSpan) * 0.08, 0.6));
    const loseStart = 180 + halfSpan + margin;
    const loseSpan = Math.max(360 - halfSpan * 2 - margin * 2, 1);
    return (loseStart + Math.random() * loseSpan) % 360;
  }
  const phiMax = upgPhiMaxDeg(chance);
  if (result === 'win') {
    const margin = Math.min(2, phiMax * 0.2);
    const span = Math.max(phiMax - margin, phiMax * 0.5);
    const offset = (Math.random() * 2 - 1) * span;
    return 180 + offset;
  }
  const margin = Math.min(3, Math.max((180 - phiMax) * 0.1, 0.5));
  const loseStart = 180 + phiMax + margin;
  const loseSpan = Math.max(360 - phiMax * 2 - margin * 2, 1);
  return (loseStart + Math.random() * loseSpan) % 360;
}

// ── Процесс апгрейда — колесо крутится с долгим "нервным" замедлением ────
// Исход и шанс уже известны с сервера, поэтому указатель заранее
// "знает", куда ему нужно приехать — win-зона внизу, lose — сверху.

function upgSynth(result, chance, animationMode, onDone) {
  const wheelWrap = document.querySelector('.upg-wheel-wrap');
  const pointer   = document.getElementById('upg-pointer');
  const profile = upgAnimationProfile(animationMode);

  wheelWrap.classList.remove('upg-wheel-win', 'upg-wheel-fail');
  wheelWrap.classList.add('upg-is-spinning');
  pointer.classList.add('spinning');
  SND.playLegacy('whoosh');

  const finalAngle = upgPickFinalAngle(result, chance);
  const spins = profile.spins;
  const totalRotation = spins * 360 + finalAngle;
  const duration = profile.duration;
  const easing = animationMode === 'instant'
    ? 'cubic-bezier(.18,.74,.22,1)'
    : 'cubic-bezier(.32,.32,.42,1)';
  SND.spinTicksLegacy(duration, profile.tick);

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    pointer.style.transform = `translate3d(0,0,0) rotate(${finalAngle}deg)`;
    pointer.classList.remove('spinning');
    wheelWrap.classList.remove('upg-is-spinning');
    onDone();
  }

  if (typeof pointer.animate === 'function') {
    const animation = pointer.animate(
      [
        { transform: 'translate3d(0,0,0) rotate(0deg)' },
        { transform: `translate3d(0,0,0) rotate(${totalRotation}deg)` }
      ],
      { duration, easing, fill: 'forwards' }
    );
    animation.onfinish = () => {
      animation.cancel();
      finish();
    };
    return;
  }

  pointer.style.transition = `transform ${duration}ms ${easing}`;
  requestAnimationFrame(() => {
    pointer.style.transform = `translate3d(0,0,0) rotate(${totalRotation}deg)`;
  });
  setTimeout(finish, duration + 50);
}

function upgResetLab() {
  const wheelWrap = document.querySelector('.upg-wheel-wrap');
  const pointer   = document.getElementById('upg-pointer');
  const holo      = document.getElementById('upg-holo');
  pointer.getAnimations?.().forEach(animation => animation.cancel());
  wheelWrap.classList.remove('upg-wheel-win', 'upg-wheel-fail');
  wheelWrap.classList.remove('upg-is-spinning');
  pointer.style.transition = 'none';
  pointer.style.transform = 'translate3d(0,0,0) rotate(0deg)';
  void pointer.getBoundingClientRect(); // форсируем перерасчёт стилей перед новым кручением
  pointer.style.transition = '';
  holo.style.opacity = '1';
  holo.style.transform = 'translate(-50%, -50%)';
  holo.style.filter = '';
  document.getElementById('upg-wheel-glow').style.opacity = '';
  document.getElementById('upg-puff').classList.remove('on');
}

// ── Апгрейд ────────────────────────────────────────────────
async function upgGo() {
  if (upgSpinning || !upgTargetName || upgStakeIds.size === 0) return;
  const attemptedTargetName = upgTargetName;
  const animationMode = upgAnimationMode;
  const animationProfile = upgAnimationProfile(animationMode);
  upgSpinning = true;
  document.getElementById('upg-go-btn').disabled = true;
  syncUpgWheelStyleControl();
  syncUpgAnimationModeControl();
  const box = document.getElementById('upg-result');
  box.style.display = 'none';

  try {
    const res = await fetch(`${API}/api/upgrader/upgrade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, stake_ids: [...upgStakeIds], target_name: upgTargetName })
    });
    const data = await res.json();
    if (data.error) {
      showToast(data.error, 'lose');
      upgSpinning = false;
      ensureUpgraderWheelTheme();
      upgUpdateWheel();
      return;
    }

    upgResetLab();
    const stakeCount = upgStakeIds.size;
    // Держим голограмму результата в колесе на время апгрейда
    document.getElementById('upg-holo').innerHTML = caseImgHtml(data.target_name, 64);
    upgSynth(data.result, data.chance, animationMode, () => {
      const win = data.result === 'win';
      const wheelWrap = document.querySelector('.upg-wheel-wrap');
      const holo = document.getElementById('upg-holo');
      SND.playLegacy(win ? 'upgWin' : 'upgLose');

      if (win) {
        wheelWrap.classList.add('upg-wheel-win');
        holo.style.filter = 'drop-shadow(0 0 14px rgba(34,204,102,.9))';
      } else {
        wheelWrap.classList.add('upg-wheel-fail');
        document.getElementById('upg-puff').classList.add('on');
        holo.style.transition = 'transform .8s ease, opacity .8s, filter .8s';
        holo.style.transform = 'translate(-50%, -50%) scale(0.1) rotate(80deg)';
        holo.style.opacity = '0';
        holo.style.filter = 'grayscale(1)';
      }

      setTimeout(() => {
        const box = document.getElementById('upg-result');
        box.style.display = 'block';
        box.className = `result-box ${win ? 'result-win' : 'result-lose'}`;
        box.innerHTML = win ? `
          <div class="result-title">⬆️ АПГРЕЙД ЗАВЕРШЁН!</div>
          <div class="result-detail">
            ${caseImgHtml(data.target_name, 72)}<br>
            <b>${data.stake_names}</b> → <b>${data.target_name}</b><br>
            ${data.stake_value} 🧠 → <b>${data.target_value} 🧠</b> · шанс был ${(data.chance * 100).toFixed(2)}%
          </div>` : `
          <div class="result-title">☁️ АПГРЕЙД НЕ УДАЛСЯ</div>
          <div class="result-detail">
            Материал${stakeCount > 1 ? 'ы' : ''} <b>${data.stake_names}</b> потерян${stakeCount > 1 ? 'ы' : ''}...<br>
            Шанс был ${(data.chance * 100).toFixed(2)}% — собери новые и попробуй ещё!
          </div>`;
        showToast(win ? '⬆️ Апгрейд завершён!' : '☁️ Апгрейд не удался', win ? 'win' : 'lose');

        upgResetSelectionAfterAttempt(win, attemptedTargetName);
        upgSpinning = false;
        syncUpgWheelStyleControl();
        syncUpgAnimationModeControl();
        upgResetLab();
        upgLoad();
        loadInit();
      }, win ? animationProfile.revealWin : animationProfile.revealLose);
    });
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
    upgSpinning = false;
    ensureUpgraderWheelTheme();
    upgUpdateWheel();
  }
}

// ── Магазин упгрейдера ─────────────────────────────────────
function upgRenderShop() {
  const grid = document.getElementById('upg-shop-grid');
  if (!grid || !upgData) return;
  const catalog = upgData.shop_catalog || [];
  const fullCatalog = upgData.catalog || [];
  const freeHtml = adminAbuseFreeOffers.map(offer => {
    const offerId = Number(offer.id);
    const catalogItem = fullCatalog.find(item => item.name === offer.item_name) || {};
    const claiming = adminAbuseClaimingOffers.has(offerId);
    return `<article class="upg-free-offer">
      <div class="upg-free-offer-mark"><b>ADMIN</b><span>ABUSE</span></div>
      <div class="upg-free-offer-image">${caseImgHtml(String(offer.item_name || ''), 72)}</div>
      <div class="upg-free-offer-copy">
        <small>БЕСПЛАТНО · ОДНА ШТУКА В РУКИ</small>
        <strong>${escHtml(offer.item_name || '')}</strong>
        <span>${Number(catalogItem.value || 0)} 🧠 · осталось ${Number(offer.remaining_stock || 0)}</span>
      </div>
      <button class="abuse-free-claim" type="button" ${claiming ? 'disabled' : ''}
        onclick="claimAdminAbuseFreeOffer(this, ${offerId})">${claiming ? '...' : 'ЗАБРАТЬ'}</button>
    </article>`;
  }).join('');
  grid.innerHTML = freeHtml + catalog.map(t => `
    <div style="position:relative">
      ${upgItemCard(t, false,
        `<button class="upg-buy-btn" onclick="upgBuy('${t.name.replace(/'/g, "\\'")}')">Купить</button>`)}
    </div>`).join('');
}

async function upgBuy(name) {
  try {
    const res = await fetch(`${API}/api/upgrader/buy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, item_name: name })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'lose'); return; }
    showToast(`✅ Куплен ${data.item_name} за ${data.price} 🧠`, 'win');
    upgLoad();
    loadInit();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}

async function upgSell(itemId) {
  if (upgSpinning) return;
  try {
    const res = await fetch(`${API}/api/upgrader/sell`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tg_id, item_id: itemId })
    });
    const data = await res.json();
    if (data.error) { showToast(data.error, 'lose'); return; }
    upgStakeIds.delete(itemId);
    showToast(`💰 Продан ${data.item_name} за ${data.price} 🧠`, 'win');
    upgLoad();
    loadInit();
  } catch (e) {
    showToast('Ошибка сервера', 'lose');
  }
}

// ══════════════════════════════════════════
// 🔴 LIVE WINS — лента живых выигрышей
// ══════════════════════════════════════════
var lwLastId  = 0;      // id последнего показанного выигрыша (инкрементальный поллинг)
var lwStarted = false;
var lwPolling = false;
var LW_MAX_CHIPS = 14;
var LW_POLL_MS   = 5000;

var LW_GAME_META = {
  coin:         ['🪙', 'Монетка'],
  resonance:    ['◈', 'РотДек'],
  mines:        ['◆', 'Мины'],
  slots:        ['🎲', 'Dice'],
  brain_slots:  ['🎰', 'Слоты'],
  mr:           ['🎰', 'Рулетка'],
  duel_1v1:     ['🎡', '1vs1'],
  ffa_roulette: ['🌀', 'Jackpot'],
  ffa_queue:    ['🌀', 'Jackpot'],
  upgrader:     ['🚀', 'Апгрейд'],
  craft:        ['⚒', 'Крафт'],
};

// ================================================
// CRAFT CONTRACT — shared with upgrader_inventory
// ================================================
let craftData = null;
let craftSelectedIds = new Set();
let craftBusy = false;
let craftLoadSeq = 0;
let craftMode = 'normal';
let craftEventRecipeId = null;

function craftActiveEvent() {
  const state = craftData?.event_craft;
  return state?.active && state?.event ? state.event : null;
}

function craftEventRecipes() {
  const recipes = craftActiveEvent()?.recipes;
  return Array.isArray(recipes) ? recipes : [];
}

function craftSelectedEventRecipe() {
  return craftEventRecipes().find(recipe => recipe.id === craftEventRecipeId) || null;
}

function craftCurrentRules() {
  const event = craftMode === 'event' ? craftActiveEvent() : null;
  if (event) {
    const recipe = craftSelectedEventRecipe();
    const requiredCount = recipe ? Math.max(0, Number(recipe.required_count || 0)) : 0;
    return {
      minItems: requiredCount,
      maxItems: requiredCount,
      event,
      recipe
    };
  }
  return {
    minItems: craftData?.min_items || 3,
    maxItems: craftData?.max_items || 10,
    event: null,
    recipe: null
  };
}

function craftVisibleInventory() {
  const inventory = craftData?.inventory || [];
  if (craftMode !== 'event') {
    return inventory.filter(item => item.rarity !== 'secret' || item.event_item);
  }
  const recipe = craftSelectedEventRecipe();
  if (!recipe) return [];
  const allowedNames = new Set((recipe.ingredients || []).map(item => String(item.name)));
  return inventory.filter(item => allowedNames.has(item.item_name));
}

function craftRecipePartHtml(item, target = false) {
  const count = Math.max(1, Number(item.count || 1));
  const unitValue = Math.max(0, Number(item.value || 0));
  const displayValue = target ? unitValue : unitValue * count;
  const valueText = Math.floor(displayValue).toLocaleString('ru-RU');
  const unitText = !target && count > 1
    ? ` · ${Math.floor(unitValue).toLocaleString('ru-RU')} за шт.`
    : '';
  const caseOnly = !target && item.from_event_case
    ? '<em class="craft-event-case-only">ТОЛЬКО ИЗ ИВЕНТ-КЕЙСА</em>'
    : '';
  return `<span class="craft-event-recipe-part ${target ? 'target' : ''} ${item.from_event_case ? 'event-case-material' : ''}">
    ${caseImgHtml(item.name, target ? 38 : 30)}
    <span><b>${target ? escHtml(item.name) : `x${count} ${escHtml(item.name)}`}</b><small>${valueText} 🧠${unitText}</small>${caseOnly}</span>
  </span>`;
}

function craftChooseEventRecipe(recipeId) {
  if (craftBusy || !craftActiveEvent()) return;
  const recipe = craftEventRecipes().find(entry => entry.id === recipeId);
  if (!recipe) return;
  if (Number(recipe.attempts_left || 0) <= 0) {
    showToast('Все попытки этой схемы уже использованы', 'lose');
    return;
  }
  craftEventRecipeId = recipe.id;
  craftSelectedIds.clear();
  document.getElementById('craft-machine')?.classList.remove('craft-up', 'craft-down', 'craft-even');
  document.getElementById('craft-result-core')?.classList.remove('craft-has-result');
  const resultBox = document.getElementById('craft-result');
  if (resultBox) resultBox.style.display = 'none';
  SND.play('craftSelect', 0.7);
  craftRender();
}

function craftRenderEventCard() {
  const event = craftActiveEvent();
  const card = document.getElementById('craft-event-card');
  const normalTab = document.getElementById('craft-mode-normal');
  const eventTab = document.getElementById('craft-mode-event');
  if (!card || !normalTab || !eventTab) return;

  if (!event && craftMode === 'event') {
    craftMode = 'normal';
    craftEventRecipeId = null;
    craftSelectedIds.clear();
  }
  normalTab.classList.toggle('active', craftMode === 'normal');
  normalTab.setAttribute('aria-selected', String(craftMode === 'normal'));
  eventTab.classList.toggle('active', craftMode === 'event');
  eventTab.disabled = !event;
  eventTab.setAttribute('aria-selected', String(craftMode === 'event'));
  eventTab.textContent = event ? 'ИВЕНТ · LIVE' : 'ИВЕНТОВЫЙ КРАФТ';

  if (!event || craftMode !== 'event') {
    card.hidden = true;
    return;
  }

  const recipes = craftEventRecipes();
  const currentRecipe = craftSelectedEventRecipe();
  if (
    (!currentRecipe || Number(currentRecipe.attempts_left || 0) <= 0)
    && recipes.length
  ) {
    craftEventRecipeId = recipes.find(recipe => Number(recipe.attempts_left || 0) > 0)?.id || null;
  }
  const selectedId = craftEventRecipeId;
  const recipeCards = recipes.map((recipe, recipeIndex) => {
    const active = recipe.id === selectedId;
    const ingredients = (recipe.ingredients || []).map(item => craftRecipePartHtml(item)).join('');
    const target = craftRecipePartHtml(recipe.target || {}, true);
    const chance = Math.max(0, Number(recipe.success_chance || 0));
    const attemptsLeft = Math.max(0, Number(recipe.attempts_left || 0));
    const attemptLimit = Math.max(0, Number(recipe.attempt_limit || 0));
    const materialsValue = Math.max(0, Number(recipe.materials_value || 0));
    const exhausted = attemptsLeft <= 0;
    const eventCaseRule = recipe.requires_event_case_item
      ? '<span class="craft-event-case-rule">ОБЯЗАТЕЛЕН РЕЛИКТ ИЗ ИВЕНТ-КЕЙСА</span>'
      : '';
    const attemptPercent = attemptLimit > 0
      ? Math.max(0, Math.min(100, attemptsLeft * 100 / attemptLimit))
      : 0;
    return `<button class="craft-event-recipe ${active ? 'selected' : ''}" type="button"
      aria-pressed="${String(active)}" ${exhausted ? 'disabled' : ''} onclick="craftChooseEventRecipe('${escHtml(recipe.id)}')">
      <span class="craft-event-recipe-index">СХЕМА ${String(recipeIndex + 1).padStart(2, '0')}</span>
      <span class="craft-event-recipe-top"><b>${escHtml(recipe.title || 'СХЕМА')}</b><strong>${chance.toFixed(2)}% ШАНС</strong></span>
      <small class="craft-event-recipe-copy">${escHtml(recipe.subtitle || 'Точный набор секретных предметов.')}</small>
      <span class="craft-event-recipe-value">ЦЕНА НАБОРА <b>${Math.floor(materialsValue).toLocaleString('ru-RU')} 🧠</b></span>
      ${eventCaseRule}
      <span class="craft-event-formula">
        <span class="craft-event-side"><em>НУЖНО · 10 ПРЕДМЕТОВ</em><span class="craft-event-inputs">${ingredients}</span></span>
        <i aria-hidden="true">→</i>
        <span class="craft-event-side craft-event-output"><em>РЕЗУЛЬТАТ ПРИ УСПЕХЕ</em>${target}</span>
      </span>
      <span class="craft-event-recipe-foot"><b>ОСТАЛОСЬ ${attemptsLeft} ИЗ ${attemptLimit}</b><i><u style="width:${attemptPercent.toFixed(2)}%"></u></i></span>
    </button>`;
  }).join('');
  card.hidden = false;
  card.innerHTML = `
    <div class="craft-event-head">
      <div>
        <small>LIVE · ОГРАНИЧЕННЫЕ СХЕМЫ</small>
        <b>${escHtml(event.title || 'СЕКРЕТНЫЕ СХЕМЫ')}</b>
      </div>
      <strong class="craft-event-quota">ОБЩИЕ ЛИМИТЫ</strong>
    </div>
    <p>${escHtml(event.subtitle || 'Собери точную схему из секретных предметов.')}</p>
    <div class="craft-event-callout"><b>КАК ЭТО РАБОТАЕТ</b><span>Выбери схему, собери ровно 10 указанных предметов и запусти контракт. Полученные ивентовые предметы можно использовать, продавать и вкладывать в другие игры без ограничений.</span></div>
    <div class="craft-event-rules">
      <span><b>${recipes.length}</b> СХЕМ НА ВЫБОР</span>
      <span>КАЖДАЯ ПОПЫТКА УЧИТЫВАЕТСЯ ДЛЯ ВСЕХ ИГРОКОВ</span>
    </div>
    <div class="craft-event-recipes">${recipeCards || '<div class="inv-empty">Схемы ещё не загружены.</div>'}</div>`;
}

function craftSetMode(mode) {
  if (craftBusy || !craftData || (mode !== 'normal' && mode !== 'event')) return;
  if (mode === 'event' && !craftActiveEvent()) {
    showToast('Сейчас нет доступных ивентовых схем', 'lose');
    return;
  }
  if (craftMode === mode) return;
  craftMode = mode;
  craftSelectedIds.clear();
  if (mode === 'normal') craftEventRecipeId = null;
  document.getElementById('craft-machine')?.classList.remove('craft-up', 'craft-down', 'craft-even');
  document.getElementById('craft-result-core')?.classList.remove('craft-has-result');
  const resultBox = document.getElementById('craft-result');
  if (resultBox) resultBox.style.display = 'none';
  SND.play('craftSelect', 0.35);
  craftRender();
}

async function craftLoad() {
  const requestSeq = ++craftLoadSeq;
  try {
    await ensureTelegramAuth();
    const res = await fetch(`${API}/api/craft/data?tg_id=${tg_id}&_=${Date.now()}-${requestSeq}`, {
      cache: 'no-store'
    });
    const data = await res.json();
    if (requestSeq !== craftLoadSeq) return;
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    craftData = data;
    if (craftMode === 'event' && !craftActiveEvent()) {
      craftMode = 'normal';
      craftEventRecipeId = null;
      craftSelectedIds.clear();
    }
    if (craftMode === 'event' && craftEventRecipeId && !craftSelectedEventRecipe()) {
      craftEventRecipeId = null;
      craftSelectedIds.clear();
    }
    const validIds = new Set((data.inventory || []).map(item => item.id));
    craftSelectedIds = new Set([...craftSelectedIds].filter(id => validIds.has(id)));
    craftRender();
  } catch (error) {
    if (requestSeq === craftLoadSeq) showToast('Ошибка загрузки крафта', 'lose');
  }
}

function craftSelectedItems() {
  if (!craftData) return [];
  return (craftData.inventory || []).filter(item => craftSelectedIds.has(item.id));
}

function craftTotalValue() {
  return craftSelectedItems().reduce((sum, item) => sum + item.value, 0);
}

function craftToggleItem(id) {
  if (craftBusy || !craftData) return;
  const item = (craftData.inventory || []).find(entry => entry.id === id);
  if (!item || !craftVisibleInventory().some(entry => entry.id === id)) return;
  document.getElementById('craft-machine')?.classList.remove('craft-up', 'craft-down', 'craft-even');
  document.getElementById('craft-result-core')?.classList.remove('craft-has-result');
  const resultBox = document.getElementById('craft-result');
  if (resultBox) resultBox.style.display = 'none';
  const wasSelected = craftSelectedIds.has(id);
  if (wasSelected) {
    craftSelectedIds.delete(id);
  } else {
    const rules = craftCurrentRules();
    if (rules.event && !rules.recipe) {
      showToast('Сначала выбери ивентовую схему', 'lose');
      return;
    }
    const maxItems = rules.maxItems;
    if (craftSelectedIds.size >= maxItems) {
      showToast(`В один крафт помещается максимум ${maxItems} предметов`, 'lose');
      return;
    }
    if (rules.event && rules.recipe) {
      const wantedCounts = Object.fromEntries((rules.recipe.ingredients || []).map(entry => [
        String(entry.name), Math.max(1, Number(entry.count || 1))
      ]));
      const selectedCount = craftSelectedItems()
        .filter(selected => selected.item_name === item.item_name).length;
      if (!wantedCounts[item.item_name] || selectedCount >= wantedCounts[item.item_name]) {
        showToast('Для этой схемы столько таких предметов не нужно', 'lose');
        return;
      }
    }
    craftSelectedIds.add(id);
  }
  SND.play('craftSelect', wasSelected ? -1 : 1);
  craftRender();
}

function craftClear() {
  if (craftBusy) return;
  document.getElementById('craft-machine')?.classList.remove('craft-up', 'craft-down', 'craft-even');
  document.getElementById('craft-result-core')?.classList.remove('craft-has-result');
  const resultBox = document.getElementById('craft-result');
  if (resultBox) resultBox.style.display = 'none';
  craftSelectedIds.clear();
  craftRender();
}

function craftRender() {
  const grid = document.getElementById('craft-inventory-grid');
  const orbit = document.getElementById('craft-input-orbit');
  if (!grid || !orbit || !craftData) return;

  craftRenderEventCard();
  const rules = craftCurrentRules();
  const inventory = craftVisibleInventory();
  const selected = craftSelectedItems();
  const isEvent = Boolean(rules.event);
  const eventRecipe = rules.recipe;
  const machine = document.getElementById('craft-machine');
  machine?.classList.toggle('craft-event-mode', isEvent);
  document.querySelector('.craft-machine-label').textContent = isEvent ? 'EVENT CONTRACT' : 'CONTRACT UNIT';
  if (!inventory.length) {
    grid.innerHTML = isEvent && !eventRecipe
      ? '<div class="inv-empty">Выбери схему выше: здесь появятся только нужные для неё секретные материалы.</div>'
      : isEvent
        ? '<div class="inv-empty">Не хватает нужных секретных материалов для этой схемы.</div>'
      : '<div class="inv-empty">Инвентарь пуст. Предметы можно купить в апгрейдере или сохранить после открытия кейса.</div>';
  } else {
    grid.innerHTML = inventory.map(item => {
      const isSelected = craftSelectedIds.has(item.id);
      const color = UPG_RARITY_COLORS[item.rarity] || 'var(--text-dim)';
      return `
        <button class="craft-item ${isSelected ? 'selected' : ''}" type="button"
                onclick="craftToggleItem(${item.id})" style="--craft-rarity:${color}">
          <span class="craft-item-check">${isSelected ? '✓' : '+'}</span>
          ${caseImgHtml(item.item_name, 56)}
          <b>${item.item_name}</b>
          <small>${item.value} 🧠</small>
        </button>`;
    }).join('');
  }

  orbit.innerHTML = selected.map((item, index) => `
    <span class="craft-orbit-item" style="--angle:${index * 360 / Math.max(selected.length, 3)}deg;--reverse-angle:${-(index * 360 / Math.max(selected.length, 3))}deg">
      ${caseImgHtml(item.item_name, 34)}
    </span>`).join('');

  const minItems = rules.minItems;
  const maxItems = rules.maxItems;
  document.getElementById('craft-count').textContent = isEvent && !eventRecipe
    ? '— / —'
    : `${selected.length} / ${maxItems}`;
  document.getElementById('craft-value').textContent = `${craftTotalValue()} 🧠`;
  if (!craftBusy) {
    document.getElementById('craft-machine-state').textContent =
      isEvent && !eventRecipe
        ? 'ВЫБЕРИ СХЕМУ'
        : selected.length < minItems ? `ЕЩЁ ${minItems - selected.length}` : 'ГОТОВ';
  }
  document.getElementById('craft-run-btn').disabled =
    craftBusy || (isEvent && !eventRecipe) || selected.length < minItems || selected.length > maxItems;
  document.querySelector('#craft-run-btn span').textContent = isEvent
    ? (eventRecipe ? 'ЗАПУСТИТЬ СХЕМУ' : 'ВЫБЕРИ СХЕМУ')
    : 'ЗАПУСТИТЬ КРАФТ';
  const inventoryTitle = document.querySelector('#screen-craft .craft-inventory-head b');
  const inventoryHint = document.querySelector('#screen-craft .craft-inventory-head small');
  if (inventoryTitle) inventoryTitle.textContent = isEvent ? 'МАТЕРИАЛЫ СХЕМЫ' : 'МАТЕРИАЛЫ';
  if (inventoryHint) inventoryHint.textContent = isEvent
    ? (eventRecipe ? 'Бери ровно те предметы и в том количестве, что указано в схеме' : 'Выбери точную схему выше')
    : 'Нажимай на предметы для добавления';

  const core = document.getElementById('craft-result-core');
  if (!craftBusy && !core.classList.contains('craft-has-result')) {
    core.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><use href="#bb-icon-craft"></use></svg>';
  }
}

async function craftRun() {
  if (craftBusy || !craftData) return;
  const rules = craftCurrentRules();
  if (rules.event && !rules.recipe) {
    showToast('Сначала выбери ивентовую схему', 'lose');
    return;
  }
  const minItems = rules.minItems;
  const maxItems = rules.maxItems;
  const selectedIds = [...craftSelectedIds];
  if (selectedIds.length < minItems || selectedIds.length > maxItems) {
    showToast(rules.event
      ? `Для схемы нужны ровно ${minItems} предмета из её списка`
      : `Выбери от ${minItems} до ${maxItems} предметов`, 'lose');
    return;
  }

  craftBusy = true;
  document.getElementById('craft-run-btn').disabled = true;
  document.getElementById('craft-result').style.display = 'none';
  const machine = document.getElementById('craft-machine');
  const state = document.getElementById('craft-machine-state');
  const core = document.getElementById('craft-result-core');
  core.classList.remove('craft-has-result');
  machine.classList.remove('craft-up', 'craft-down', 'craft-even');
  machine.classList.add('craft-running');
  state.textContent = rules.event ? 'РАЗЛОМ' : 'СИНТЕЗ';
  SND.play('craftStart');

  try {
    const res = await fetch(`${API}${rules.event ? '/api/craft/event/run' : '/api/craft/run'}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({tg_id, item_ids: selectedIds})
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

    await new Promise(resolve => setTimeout(resolve, rules.event ? 3100 : 2300));
    machine.classList.remove('craft-running');
    machine.classList.add('craft-resolving');
    state.textContent = rules.event ? 'КОЛЛАПС' : 'СТАБИЛИЗАЦИЯ';
    await new Promise(resolve => setTimeout(resolve, 520));
    const visualResult = data.event ? (data.success ? 'up' : 'down') : data.result;
    const resultName = String(data.item_name || data.target_name || 'Неизвестный результат');
    const resultValue = Number(data.item_value || (data.success ? data.target_value : 0) || 0);
    machine.classList.add(`craft-${visualResult}`);
    machine.classList.remove('craft-resolving');
    state.textContent = data.event
      ? (data.success ? 'СХЕМА СРАБОТАЛА' : 'СХЕМА РАСПАЛАСЬ')
      : (data.result === 'up' ? 'ПОВЫШЕНИЕ' : (data.result === 'down' ? 'ПОНИЖЕНИЕ' : 'РАВНО'));
    core.classList.add('craft-has-result');
    core.innerHTML = data.success === false
      ? '<span class="craft-fail-core">×</span>'
      : `<span class="craft-reveal">${caseImgHtml(resultName, 84)}</span>`;
    SND.play(visualResult === 'down' ? 'upgLose' : 'craftResult');

    const box = document.getElementById('craft-result');
    box.style.display = 'block';
    box.className = `result-box ${visualResult === 'up' ? 'result-win' : 'result-lose'}`;
    const sign = data.difference > 0 ? '+' : '';
    const resultTitle = data.event
      ? `${data.event_title}: ${data.success ? 'СХЕМА УДАЛАСЬ' : 'СХЕМА НЕ СРАБОТАЛА'}`
      : (data.result === 'up' ? 'КРАФТ УСИЛЕН' : (data.result === 'down' ? 'КРАФТ ОСЛАБЛЕН' : 'РАВНЫЙ ОБМЕН'));
    const eventMeta = data.event ? `<em>${data.success ? 'Эксклюзив добавлен в игровой инвентарь' : 'Материалы израсходованы. Попробуй ещё раз, когда соберёшь схему.'}</em>` : '';
    box.innerHTML = `
      <div class="result-title">${resultTitle}</div>
      <div class="result-detail craft-result-detail">
        ${data.success === false ? '<span class="craft-result-fail-mark">РАЗЛОМ</span>' : caseImgHtml(resultName, 82)}
        <b>${data.success === false ? `Цель: ${resultName}` : resultName}</b>
        <span>${data.stake_value} 🧠 → ${resultValue} 🧠</span>
        <strong>${sign}${data.difference} 🧠${data.success === false ? '' : ` · x${Number(data.multiplier || 0).toFixed(2)}`}</strong>
        ${eventMeta}
      </div>`;
    showToast(data.success === false
      ? `Схема не сработала: -${Math.abs(Number(data.stake_value || 0))} 🧠`
      : `${resultName}: ${sign}${data.difference} 🧠`, visualResult === 'up' ? 'win' : 'lose');

    craftSelectedIds.clear();
    craftBusy = false;
    await craftLoad();
    machine.classList.add(`craft-${visualResult}`);
    state.textContent = data.event
      ? (data.success ? 'СХЕМА СРАБОТАЛА' : 'СХЕМА РАСПАЛАСЬ')
      : (data.result === 'up' ? 'ПОВЫШЕНИЕ' : (data.result === 'down' ? 'ПОНИЖЕНИЕ' : 'РАВНО'));
    core.classList.add('craft-has-result');
    core.innerHTML = data.success === false
      ? '<span class="craft-fail-core">×</span>'
      : `<span class="craft-reveal">${caseImgHtml(resultName, 84)}</span>`;
    loadInit();
  } catch (error) {
    machine.classList.remove('craft-running');
    state.textContent = 'ОШИБКА';
    craftBusy = false;
    if (rules.event && String(error.message || '').includes('закончился')) {
      craftMode = 'normal';
      craftSelectedIds.clear();
      await craftLoad();
    }
    craftRender();
    showToast(error.message || 'Ошибка сервера', 'lose');
  }
}

function lwGameMeta(gt) {
  if (gt && gt.startsWith('case_')) return ['📦', 'Кейс'];
  return LW_GAME_META[gt] || ['🏆', 'Игра'];
}

function lwChip(w, isNew) {
  const [emoji, game] = lwGameMeta(w.game_type);
  const div = document.createElement('div');
  div.className = 'lw-chip' + (isNew ? ' lw-new' : '');
  const targetId = Number(w.tg_id);
  if (Number.isSafeInteger(targetId) && targetId > 0) {
    const playerName = String(w.name || 'Игрок');
    div.classList.add('profile-link');
    div.tabIndex = 0;
    div.setAttribute('role', 'button');
    div.setAttribute('title', `Открыть профиль ${playerName}`);
    div.setAttribute('aria-label', `Открыть профиль ${playerName}`);
    div.addEventListener('click', () => openPublicProfile(targetId));
    div.addEventListener('keydown', event => openPublicProfileFromKey(event, targetId));
  }
  div.innerHTML =
    `<span>${emoji}</span>` +
    `<span class="lw-amt">+${Math.floor(w.payout)} 🧠</span>` +
    `<span style="opacity:.6">${game}</span>`;
  return div;
}

async function lwPoll() {
  const track = document.getElementById('live-wins-track');
  if (!track || document.hidden || lwPolling || !hasClientIdentity() || !termsAccepted) return;
  lwPolling = true;
  try {
    const r    = await fetch(`${API}/api/live_wins?since_id=${lwLastId}`);
    const data = await r.json();
    if (data.admin_abuse) syncAdminAbuseState(data.admin_abuse);
    const wins = data.wins || [];

    if (wins.length) {
      const firstLoad = lwLastId === 0;
      lwLastId = Math.max(lwLastId, ...wins.map(w => w.id));

      const empty = track.querySelector('.lw-empty');
      if (empty) empty.remove();

      // Сервер отдаёт новые первыми — вставляем от старых к новым,
      // чтобы самый свежий выигрыш оказался в начале ленты слева
      [...wins].reverse().forEach(w => {
        track.insertBefore(lwChip(w, !firstLoad), track.firstChild);
      });

      // Обрезаем хвост
      while (track.children.length > LW_MAX_CHIPS) {
        track.removeChild(track.lastChild);
      }
    } else if (lwLastId === 0 && !track.children.length) {
      track.innerHTML = '<div class="lw-empty">Здесь появятся выигрыши игроков…</div>';
    }
  } catch (e) { /* тихо — лента не критична */ }
  finally { lwPolling = false; }
}

function lwInit() {
  if (lwStarted) return;
  lwStarted = true;
  lwPoll();
  setInterval(lwPoll, LW_POLL_MS);
}

// ══════════════════════════════════════════
// 🔊 SOUND ENGINE — эффекты и музыка проходят через независимые Web Audio каналы.
// MP3 остаётся зацикленным media element, но его громкость регулирует GainNode для iOS.
// ══════════════════════════════════════════
const SND = (() => {
  let ctx = null, master = null, gameOut = null, uiOut = null, activeOut = null;
  let musicOut = null, musicSource = null, musicUsesWebAudio = false;
  const SAMPLE_FILES = Object.freeze({
    slot_bet: 'slots-cinema-v1-bet.mp3',
    slot_spin: 'slots-cinema-v2-spin.mp3',
    slot_stop: 'slots-cinema-v2-stop.mp3',
    slot_line: 'slots-cinema-v1-line.mp3',
    slot_bonus: 'slots-cinema-v1-bonus.mp3',
    slot_wheel: 'slots-cinema-v1-wheel.mp3',
    slot_award: 'slots-cinema-v1-award.mp3',
    slot_win: 'slots-cinema-v1-win.mp3',
    slot_big: 'slots-cinema-v1-big.mp3',
    slot_mega: 'slots-cinema-v1-mega.mp3',
    slot_end: 'slots-cinema-v1-end.mp3',
    tap: 'ui-tap.mp3',
    bet: 'bet-lock.mp3',
    toastWin: 'toast-win.mp3',
    err: 'error.mp3',
    lose: 'lose.mp3',
    win: 'win.mp3',
    bigwin: 'big-win.mp3',
    coin: 'coin-flip.mp3',
    cash: 'cash.mp3',
    whoosh: 'spin-whoosh.mp3',
    rouletteSpin: 'roulette-spin.mp3',
    duelSpin: 'duel-spin.mp3',
    jackpotSpin: 'jackpot-spin.mp3',
    slotsSpin: 'slots-spin.mp3',
    drawSpin: 'draw-spin.mp3',
    reveal: 'case-reveal.mp3',
    beep: 'countdown.mp3',
    tick: 'wheel-tick.mp3',
    dicePip: 'dice-land.mp3',
    diceBlip: 'dice-roll.mp3',
    mineSafe: 'mine-safe.mp3',
    mineExplode: 'mine-explode.mp3',
    upgWin: 'upgrade-win.mp3',
    upgLose: 'upgrade-lose.mp3',
    craftStart: 'craft-start.mp3',
    craftSelect: 'craft-select.mp3',
    craftResult: 'craft-result.mp3',
    rocketCountdown: 'rocket-countdown.mp3',
    rocketLaunch: 'rocket-launch.mp3',
    rocketEject: 'rocket-eject.mp3',
    rocketCrash: 'rocket-crash.mp3',
  });
  const SAMPLE_GAINS = Object.freeze({
    tap: 0.58, tick: 0.5, diceBlip: 0.58, beep: 0.64,
    whoosh: 0.76, rouletteSpin: 0.8, duelSpin: 0.8, jackpotSpin: 0.82,
    slotsSpin: 0.76, drawSpin: 0.78, coin: 0.82, bet: 0.78, reveal: 0.88,
    win: 0.88, bigwin: 0.92, lose: 0.82, err: 0.68,
    mineExplode: 0.86, craftSelect: 0.72, rocketLaunch: 0.86, rocketCrash: 0.88,
  });
  const sampleBuffers = new Map();
  const sampleLoads = new Map();
  const sampleLastPlayed = new Map();
  const slotVoices = new Set();
  const slotEpochs = {motion:0,reward:0,detail:0};
  function stopSlotSounds(group) {
    for (const key of Object.keys(slotEpochs)) if (!group || group === key) slotEpochs[key]++;
    for (const voice of [...slotVoices]) {
      if (group && voice.group !== group) continue;
      try {
        voice.gain.gain.setTargetAtTime?.(0,ctx.currentTime,.012);
        voice.source.stop(ctx.currentTime+.055);
      } catch (_) {}
      slotVoices.delete(voice);
    }
  }
  async function playSlot(name) {
    const sample = `slot_${name}`;
    if (!SAMPLE_FILES[sample] || !gameOn || document.hidden || !ensure()) return;
    const group = ['spin','wheel'].includes(name) ? 'motion' : ['stop','line'].includes(name) ? 'detail' : 'reward';
    if (group !== 'detail') stopSlotSounds(group);
    const epoch = slotEpochs[group], started = performance.now();
    const buffer = await loadSample(sample);
    // Dedicated MP3 only. Never fall back to the old browser synth.
    if (!buffer || !gameOn || document.hidden || slotEpochs[group] !== epoch || performance.now()-started > 650) return;
    if (slotVoices.size >= 8) return;
    const source = ctx.createBufferSource(), gain = ctx.createGain();
    source.buffer = buffer;
    gain.gain.value = .95;
    source.connect(gain); gain.connect(gameOut);
    const voice = {source,gain,group}; slotVoices.add(voice);
    source.onended = () => {slotVoices.delete(voice); source.disconnect?.(); gain.disconnect?.();};
    source.start();
  }
  let samplesPrimed = false;
  let gameOn = true;
  let uiOn = true;
  let hapticOn = true;
  try {
    const legacyFx = localStorage.getItem('bb_snd');
    const savedGame = localStorage.getItem('bb_game_snd');
    gameOn = savedGame !== null ? savedGame !== '0' : legacyFx !== '0';
    uiOn = localStorage.getItem('bb_ui_snd') !== '0';
    hapticOn = localStorage.getItem('bb_haptic') !== '0';
  } catch (e) {}

  let gameVol = 1;
  let uiVol = 0.72;
  try {
    const legacyVol = localStorage.getItem('bb_vol');
    const savedGameVol = localStorage.getItem('bb_game_vol');
    const savedUiVol = localStorage.getItem('bb_ui_vol');
    if (savedGameVol !== null) gameVol = parseFloat(savedGameVol);
    else if (legacyVol !== null) gameVol = parseFloat(legacyVol);
    if (savedUiVol !== null) uiVol = parseFloat(savedUiVol);
  } catch (e) {}
  if (!(gameVol >= 0 && gameVol <= 1)) gameVol = 1;
  if (!(uiVol >= 0 && uiVol <= 1)) uiVol = 0.72;

  function ensure() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.3;
      master.connect(ctx.destination);

      gameOut = ctx.createGain();
      gameOut.gain.value = gameVol;
      gameOut.connect(master);

      uiOut = ctx.createGain();
      uiOut.gain.value = uiVol;
      uiOut.connect(master);

      try {
        musicOut = ctx.createGain();
        musicOut.gain.value = musicVol;
        musicOut.connect(ctx.destination);
        musicSource = ctx.createMediaElementSource(musicEl);
        musicSource.connect(musicOut);
        musicUsesWebAudio = true;
        musicEl.volume = 1;
      } catch (e) {
        musicUsesWebAudio = false;
        musicOut = null;
        musicSource = null;
        musicEl.volume = musicVol;
      }
    }
    if (ctx.state === 'suspended') ctx.resume();
    primeSamples();
    return true;
  }

  function loadSample(name) {
    if (!ctx || !SAMPLE_FILES[name]) return Promise.resolve(null);
    if (sampleBuffers.has(name)) return Promise.resolve(sampleBuffers.get(name));
    if (sampleLoads.has(name)) return sampleLoads.get(name);
    const request = fetch(`sfx/${SAMPLE_FILES[name]}`, { cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error(`SFX ${response.status}: ${SAMPLE_FILES[name]}`);
        return response.arrayBuffer();
      })
      .then(data => ctx.decodeAudioData(data.slice(0)))
      .then(buffer => {
        sampleBuffers.set(name, buffer);
        sampleLoads.delete(name);
        return buffer;
      })
      .catch(error => {
        sampleLoads.delete(name);
        console.warn('[SND] MP3 fallback:', name, error.message || error);
        return null;
      });
    sampleLoads.set(name, request);
    return request;
  }

  function primeSamples() {
    if (!ctx || samplesPrimed) return;
    samplesPrimed = true;
    Object.keys(SAMPLE_FILES).filter(name => !name.startsWith('slot_')).forEach(name => loadSample(name));
  }

  function playSample(channel, name, args = []) {
    if (!ctx || !sampleBuffers.has(name)) {
      loadSample(name);
      return false;
    }
    const nowMs = performance.now();
    if (name === 'tap' && nowMs - (sampleLastPlayed.get(name) || 0) < 32) return true;
    sampleLastPlayed.set(name, nowMs);

    const source = ctx.createBufferSource();
    const gain = ctx.createGain();
    const delay = name === 'tick' ? Math.max(0, Number(args[0]) || 0) : 0;
    const variant = Number(args[0]) || 0;
    source.buffer = sampleBuffers.get(name);
    if (name === 'tick') source.playbackRate.value = 0.92 + ((Math.round(delay * 100) % 5) * 0.025);
    else if (name === 'diceBlip') source.playbackRate.value = 0.9 + ((variant % 4) * 0.055);
    else if (name === 'dicePip') source.playbackRate.value = 0.94 + ((variant % 4) * 0.035);
    else if (name === 'craftSelect') source.playbackRate.value = variant < 0 ? 0.86 : 1.08;
    gain.gain.value = SAMPLE_GAINS[name] || 0.8;
    source.connect(gain);
    gain.connect(channel === 'ui' ? uiOut : gameOut);
    source.start(ctx.currentTime + delay);
    return true;
  }
  // iOS/Telegram WebView требуют разблокировки аудио первым касанием
  document.addEventListener('pointerdown', () => {
    if (gameOn || uiOn || musicOn) ensure();
    if (musicOn) musicStart();
  }, { capture: true });

  // Простой тон: частота f0 (→ f1 если задано), длительность, тип волны
  function tone(f0, dur, o = {}) {
    if (!ensure()) return;
    const t = ctx.currentTime + (o.at || 0);
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    const v = (o.vol || 1) * 0.5;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(activeOut || gameOut);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  // Шум через фильтр — для тиков, вжухов, "денежного" шелеста
  function noise(dur, o = {}) {
    if (!ensure()) return;
    const t = ctx.currentTime + (o.at || 0);
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = o.ftype || 'bandpass';
    flt.frequency.setValueAtTime(o.f0 || 1000, t);
    if (o.f1) flt.frequency.exponentialRampToValueAtTime(o.f1, t + dur);
    flt.Q.value = o.q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime((o.vol || 1) * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(activeOut || gameOut);
    src.start(t); src.stop(t + dur + 0.05);
  }

  let rocketEngineNodes = null;

  function rocketEngineStop(fade = 0.16) {
    if (!rocketEngineNodes || !ctx) return;
    const nodes = rocketEngineNodes;
    rocketEngineNodes = null;
    const t = ctx.currentTime;
    try {
      nodes.gain.gain.cancelScheduledValues(t);
      nodes.gain.gain.setValueAtTime(Math.max(0.0001, nodes.gain.gain.value), t);
      nodes.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
      nodes.low.stop(t + fade + 0.04);
      nodes.throb.stop(t + fade + 0.04);
      nodes.rumble.stop(t + fade + 0.04);
      nodes.flame.stop(t + fade + 0.04);
    } catch (e) {}
  }

  function rocketEngineStart(multiplier = 1) {
    if (!gameOn || !ensure()) {
      rocketEngineStop();
      return;
    }
    if (rocketEngineNodes) return;
    const t = ctx.currentTime;
    const low = ctx.createOscillator();
    const throb = ctx.createOscillator();
    const rumble = ctx.createBufferSource();
    const flame = ctx.createBufferSource();
    const rumbleFilter = ctx.createBiquadFilter();
    const flameFilter = ctx.createBiquadFilter();
    const lowGain = ctx.createGain();
    const throbGain = ctx.createGain();
    const rumbleGain = ctx.createGain();
    const flameGain = ctx.createGain();
    const gain = ctx.createGain();
    const len = Math.max(1, Math.floor(ctx.sampleRate * 1.5));
    const rumbleBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const flameBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const rumbleData = rumbleBuffer.getChannelData(0);
    const flameData = flameBuffer.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      brown = (brown + 0.018 * white) / 1.018;
      rumbleData[i] = Math.max(-1, Math.min(1, brown * 3.2));
      flameData[i] = white * 0.72 + (Math.random() * 2 - 1) * 0.28;
    }

    low.type = 'sine';
    throb.type = 'sine';
    rumble.buffer = rumbleBuffer;
    rumble.loop = true;
    flame.buffer = flameBuffer;
    flame.loop = true;
    rumbleFilter.type = 'lowpass';
    rumbleFilter.Q.value = 0.55;
    flameFilter.type = 'bandpass';
    flameFilter.Q.value = 0.42;
    lowGain.gain.value = 0.18;
    throbGain.gain.value = 0.045;
    rumbleGain.gain.value = 0.72;
    flameGain.gain.value = 0.09;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.055, t + 0.5);

    low.connect(lowGain);
    lowGain.connect(gain);
    throb.connect(throbGain);
    throbGain.connect(gain);
    rumble.connect(rumbleFilter);
    rumbleFilter.connect(rumbleGain);
    rumbleGain.connect(gain);
    flame.connect(flameFilter);
    flameFilter.connect(flameGain);
    flameGain.connect(gain);
    gain.connect(gameOut);
    low.start(t);
    throb.start(t);
    rumble.start(t);
    flame.start(t);
    rocketEngineNodes = {
      low, throb, rumble, flame, rumbleFilter, flameFilter,
      lowGain, throbGain, rumbleGain, flameGain, gain
    };
    rocketEngineUpdate(multiplier);
  }

  function rocketEngineUpdate(multiplier = 1) {
    if (!gameOn) {
      rocketEngineStop();
      return;
    }
    if (!rocketEngineNodes) rocketEngineStart(multiplier);
    if (!rocketEngineNodes || !ctx) return;
    const pressure = Math.max(0, Math.min(1, Math.log(Math.max(1, Number(multiplier) || 1)) / Math.log(100)));
    const t = ctx.currentTime;
    rocketEngineNodes.low.frequency.setTargetAtTime(34 + pressure * 14, t, 0.12);
    rocketEngineNodes.throb.frequency.setTargetAtTime(61 + pressure * 24, t, 0.12);
    rocketEngineNodes.rumbleFilter.frequency.setTargetAtTime(380 + pressure * 520, t, 0.16);
    rocketEngineNodes.flameFilter.frequency.setTargetAtTime(820 + pressure * 1050, t, 0.16);
    rocketEngineNodes.flameGain.gain.setTargetAtTime(0.08 + pressure * 0.07, t, 0.18);
    rocketEngineNodes.gain.gain.setTargetAtTime(0.052 + pressure * 0.026, t, 0.18);
  }

  function relay(at = 0, weight = 1) {
    noise(0.026, {f0:1800 * weight, vol:.22, at, q:5});
    tone(92 * weight, 0.045, {type:'square', vol:.16, f1:58 * weight, at});
  }

  function metal(f, at = 0, strength = 1) {
    tone(f, 0.12, {type:'triangle', vol:.24 * strength, f1:f * .72, at});
    tone(f * 2.13, 0.075, {type:'sine', vol:.13 * strength, f1:f * 1.35, at:at + .008});
    noise(0.055, {f0:f * 2.6, vol:.1 * strength, at, q:7});
  }

  const fxMechanical = {
    tap() {
      relay(0, 1.05);
      tone(340, 0.035, {type:'triangle', vol:.1, f1:240, at:.012});
    },
    craftSelect(direction = 1) {
      metal(direction < 0 ? 360 : 520, 0, .55);
      tone(direction < 0 ? 540 : 760, 0.08, {type:'triangle', vol:.12, f1:direction < 0 ? 310 : 1080, at:.025});
    },
    bet() {
      metal(760, 0, .9);
      tone(170, 0.11, {type:'square', vol:.16, f1:115, at:.045});
      relay(.075, .8);
    },
    toastWin() {
      relay();
      metal(1180, .035, .9);
      metal(1570, .11, .75);
    },
    err() {
      tone(148, 0.14, {type:'square', vol:.22, f1:121});
      tone(112, 0.12, {type:'sawtooth', vol:.12, f1:78, at:.09});
      relay(.02, .65);
    },
    lose() {
      tone(238, 0.42, {type:'sawtooth', vol:.25, f1:54});
      tone(119, 0.48, {type:'square', vol:.12, f1:42, at:.04});
      noise(0.34, {f0:740, f1:95, vol:.16, ftype:'lowpass', at:.03});
      relay(.32, .65);
    },
    win() {
      [392, 523, 659, 784].forEach((f, i) => {
        metal(f, i * .075, i === 3 ? 1.1 : .72);
        tone(f / 2, 0.18, {type:'square', vol:.1, at:i * .075});
      });
    },
    bigwin() {
      [330, 440, 523, 659, 880, 1175].forEach((f, i) => {
        metal(f, i * .08, i > 3 ? 1.05 : .75);
        tone(f / 2, 0.24, {type:'triangle', vol:.14, at:i * .08});
      });
      noise(0.72, {f0:1700, f1:7600, vol:.12, ftype:'highpass', at:.26});
      [0, .08, .16, .24].forEach((at, i) => relay(.48 + at, 1.2 - i * .12));
    },
    coin() {
      metal(1320, 0, 1.05);
      tone(280, 0.1, {type:'triangle', vol:.16, f1:170, at:.075});
      metal(1860, .105, .55);
    },
    cash() {
      [1420, 1780, 2210, 1640].forEach((f, i) => metal(f, i * .045, .72));
      noise(0.26, {f0:4200, f1:6900, vol:.11, at:.04, ftype:'highpass'});
      relay(.2, 1.15);
    },
    whoosh() {
      tone(82, 0.7, {type:'sawtooth', vol:.15, f1:310});
      noise(0.72, {f0:240, f1:3100, vol:.22, q:1.2});
      relay(.02, .75);
    },
    reveal() {
      relay(0, 1.3);
      tone(96, 0.18, {type:'square', vol:.2, f1:62});
      metal(920, .055, 1.05);
      metal(1480, .15, .75);
    },
    beep() {
      tone(780, 0.055, {type:'square', vol:.2});
      tone(1170, 0.045, {type:'square', vol:.1, at:.055});
    },
    tick(at) {
      const when = at || 0;
      relay(when, .72);
      tone(390, 0.025, {type:'square', vol:.07, f1:250, at:when});
    },
    dicePip(i) {
      const f = [420, 510, 620, 760][i % 4];
      tone(105, 0.085, {type:'square', vol:.15, f1:62});
      metal(f, .018, .72);
    },
    diceBlip(step) {
      const f = [240, 305, 375, 455][step % 4];
      tone(f, 0.038, {type:'square', vol:.1, f1:f * .82});
      noise(0.02, {f0:1250 + step * 170, vol:.06, q:5});
    },
    upgWin() {
      tone(72, 0.75, {type:'sawtooth', vol:.14, f1:430});
      [330, 495, 660, 990, 1480].forEach((f, i) => metal(f, .08 + i * .07, i > 2 ? 1.05 : .7));
      noise(0.56, {f0:2100, f1:8500, vol:.13, ftype:'highpass', at:.17});
    },
    upgLose() {
      relay(0, 1.3);
      tone(210, 0.62, {type:'sawtooth', vol:.26, f1:38});
      tone(96, 0.7, {type:'square', vol:.11, f1:32, at:.04});
      noise(0.52, {f0:960, f1:70, vol:.18, ftype:'lowpass', at:.03});
      relay(.48, .55);
    },
  };

  // Тики замедляющегося колеса: durMs — длительность анимации,
  // расписание совпадает с easeOutCubic (тики чаще в начале, реже к концу)
  const fx = {
    tap()      { tone(620, 0.05, {type:'triangle', vol:.3}); tone(930, 0.05, {type:'triangle', vol:.18, at:.025}); },
    bet()      { tone(520, 0.06, {type:'square', vol:.22}); tone(780, 0.08, {type:'square', vol:.22, at:.055}); },
    toastWin() { tone(880, 0.09, {vol:.3}); tone(1320, 0.12, {vol:.3, at:.07}); },
    err()      { tone(220, 0.12, {type:'square', vol:.22}); },
    lose()     { tone(300, 0.3, {type:'sawtooth', vol:.28, f1:110}); tone(150, 0.35, {type:'triangle', vol:.2, f1:70, at:.05}); },
    win()      { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.15, {vol:.4, at:i*.085})); },
    bigwin()   {
      [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => {
        tone(f, 0.22, {vol:.45, at:i*.1});
        tone(f/2, 0.22, {type:'triangle', vol:.22, at:i*.1});
      });
      noise(0.9, {f0:3000, f1:9000, vol:.1, ftype:'highpass', at:.45});
    },
    coin()     { tone(1250, 0.32, {type:'triangle', vol:.32, f1:1900}); },
    cash()     { tone(1568, 0.1, {vol:.32}); tone(2093, 0.26, {vol:.32, at:.09}); noise(0.28, {f0:5200, vol:.14, at:.05, ftype:'highpass'}); },
    whoosh()   { noise(0.65, {f0:350, f1:2600, vol:.28, q:.8}); },
    reveal()   { tone(660, 0.12, {vol:.32}); tone(990, 0.2, {vol:.32, at:.1}); },
    beep()     { tone(1000, 0.09, {type:'square', vol:.26}); },
    tick(at)   { noise(0.03, {f0:2500, vol:.28, at: at || 0, q: 3}); },
    dicePip(i) { const f = [659, 784, 988, 1319][i % 4]; tone(f, 0.13, {type:'triangle', vol:.32, f1: f * 1.2}); },
    diceBlip(step) { const f = [587, 740, 880, 988][step % 4]; tone(f, 0.045, {type:'triangle', vol:.16}); },
    upgWin()   { [440, 660, 880, 1320, 1760].forEach((f, i) => tone(f, 0.18, {type:'triangle', vol:.4, at:i*.06})); noise(0.5, {f0:4000, f1:9000, vol:.12, ftype:'highpass', at:.2}); },
    upgLose()  { tone(180, 0.5, {type:'sawtooth', vol:.3, f1:40}); noise(0.35, {f0:800, f1:120, vol:.2, ftype:'lowpass'}); },
    rocketCountdown() {
      tone(260, 0.08, {type:'sine', vol:.11, f1:220});
      noise(0.025, {f0:620, vol:.045, q:1.2});
    },
    rocketLaunch() {
      tone(34, 1.2, {type:'sine', vol:.24, f1:48});
      noise(1.25, {f0:110, f1:620, vol:.25, ftype:'lowpass'});
      noise(0.72, {f0:520, f1:1350, vol:.09, q:.45, at:.22});
    },
    rocketEject() {
      noise(0.38, {f0:480, f1:2300, vol:.16, q:.55});
      tone(145, 0.2, {type:'triangle', vol:.11, f1:410});
      tone(620, 0.1, {type:'sine', vol:.09, at:.16});
    },
    rocketCrash() {
      tone(68, 0.72, {type:'sine', vol:.24, f1:29});
      noise(0.72, {f0:580, f1:72, vol:.23, ftype:'lowpass'});
      tone(118, 0.24, {type:'triangle', vol:.08, f1:54, at:.08});
    },
    rouletteSpin() { noise(0.75, {f0:320, f1:2700, vol:.25, q:.9}); },
    duelSpin() { noise(0.65, {f0:260, f1:1900, vol:.2, q:1.2}); tone(88, 0.65, {type:'sawtooth', vol:.15, f1:280}); },
    jackpotSpin() { noise(0.9, {f0:120, f1:1100, vol:.28, ftype:'lowpass'}); tone(46, 0.85, {type:'sawtooth', vol:.2, f1:190}); },
    slotsSpin() { [0, .08, .16, .24, .32, .4].forEach((at, i) => metal(390 + (i % 3) * 130, at, .55)); },
    drawSpin() { noise(1.1, {f0:120, f1:2200, vol:.2}); tone(62, 1.0, {type:'triangle', vol:.15, f1:350}); },
    mineSafe() { tone(560, 0.1, {type:'triangle', vol:.2}); tone(1180, 0.22, {type:'triangle', vol:.22, at:.05}); },
    mineExplode() { tone(82, 0.75, {type:'sine', vol:.3, f1:28}); noise(0.78, {f0:520, f1:55, vol:.32, ftype:'lowpass'}); },
    craftStart() { noise(0.8, {f0:260, f1:3600, vol:.24}); tone(92, 0.75, {type:'sawtooth', vol:.16, f1:920}); },
    craftResult() { [440, 660, 880, 1320].forEach((f, i) => tone(f, 0.18, {type:'triangle', vol:.34, at:i*.07})); },
  };

  function emitHaptic(kind, value) {
    if (!hapticOn) return;
    const feedback = window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.HapticFeedback;
    try {
      if (feedback) {
        if (kind === 'selection' && typeof feedback.selectionChanged === 'function') feedback.selectionChanged();
        else if (kind === 'notification' && typeof feedback.notificationOccurred === 'function') feedback.notificationOccurred(value);
        else if (kind === 'impact' && typeof feedback.impactOccurred === 'function') feedback.impactOccurred(value);
        return;
      }
      if (navigator.vibrate) navigator.vibrate(kind === 'notification' ? [24, 24, 36] : value === 'heavy' ? 34 : 18);
    } catch (e) {}
  }

  function hapticFor(name, channel) {
    if (['win', 'toastWin', 'upgWin', 'craftResult', 'mineSafe'].includes(name)) emitHaptic('notification', 'success');
    else if (['lose', 'err', 'upgLose', 'mineExplode'].includes(name)) emitHaptic('notification', 'error');
    else if (name === 'bigwin') emitHaptic('impact', 'heavy');
    else if (name === 'rocketCrash') emitHaptic('notification', 'error');
    else if (['bet', 'coin', 'cash', 'reveal', 'dicePip', 'craftSelect', 'craftStart', 'rocketLaunch', 'rocketEject'].includes(name)) emitHaptic('impact', name === 'craftSelect' ? 'light' : 'medium');
    else if (channel === 'ui' || name === 'tap') emitHaptic('selection');
  }

  function playChannel(channel, name, args) {
    hapticFor(name, channel);
    const enabled = channel === 'ui' ? uiOn : gameOn;
    if (!enabled || !ensure()) return;
    // Keep the original crisp synthesized UI click. Longer game events use MP3.
    if (name !== 'tap' && playSample(channel, name, args)) return;
    if (!fx[name]) return;
    const previousOut = activeOut;
    activeOut = channel === 'ui' ? uiOut : gameOut;
    try { fx[name](...args); } finally { activeOut = previousOut; }
  }

  function playLegacyChannel(channel, name, args) {
    hapticFor(name, channel);
    const enabled = channel === 'ui' ? uiOn : gameOn;
    if (!enabled || !ensure() || !fx[name]) return;
    const previousOut = activeOut;
    activeOut = channel === 'ui' ? uiOut : gameOut;
    try { fx[name](...args); } finally { activeOut = previousOut; }
  }

  function spinTicksLegacy(durMs, count = 26) {
    if (!gameOn || !ensure()) return;
    const previousOut = activeOut;
    activeOut = gameOut;
    try {
      for (let i = 1; i <= count; i++) {
        const p = i / count;
        const t = 1 - Math.cbrt(1 - p);
        fx.tick(t * durMs / 1000);
      }
    } finally { activeOut = previousOut; }
  }

  function spinTicks(durMs, count = 26) {
    if (!gameOn || !ensure()) return;
    if (sampleBuffers.has('tick')) {
      for (let i = 1; i <= count; i++) {
        const p = i / count;
        const t = 1 - Math.cbrt(1 - p);
        playSample('game', 'tick', [t * durMs / 1000]);
      }
      return;
    }
    spinTicksLegacy(durMs, count);
  }

  function setGameVolume(v) {
    gameVol = Math.max(0, Math.min(1, v));
    try {
      localStorage.setItem('bb_game_vol', String(gameVol));
      localStorage.setItem('bb_vol', String(gameVol));
    } catch (e) {}
    if (gameOut) gameOut.gain.setTargetAtTime(gameVol, ctx.currentTime, 0.05);
  }

  function setUiVolume(v) {
    uiVol = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('bb_ui_vol', String(uiVol)); } catch (e) {}
    if (uiOut) uiOut.gain.setTargetAtTime(uiVol, ctx.currentTime, 0.05);
  }

  // ── Фоновая музыка: MP3 через GainNode, поскольку iOS игнорирует audio.volume ──
  let musicOn = true;
  try { musicOn = localStorage.getItem('bb_music') !== '0'; } catch (e) {}

  const MUSIC_URL = 'music.mp3';

  // Громкость музыки — отдельный микшер, не зависит от слайдера эффектов
  let musicVol = 0.5;
  try { const sv = localStorage.getItem('bb_music_vol'); if (sv !== null) musicVol = parseFloat(sv); } catch (e) {}
  if (!(musicVol >= 0 && musicVol <= 1)) musicVol = 0.5;

  const musicEl = new Audio();
  musicEl.crossOrigin = 'anonymous';
  musicEl.src = MUSIC_URL;
  musicEl.loop = true;
  musicEl.preload = 'auto';
  musicEl.setAttribute('playsinline', '');
  musicEl.volume = musicVol;

  function setMusicVolume(v) {
    musicVol = Math.max(0, Math.min(1, v));
    try { localStorage.setItem('bb_music_vol', String(musicVol)); } catch (e) {}
    if (musicUsesWebAudio && musicOut && ctx) {
      musicOut.gain.setTargetAtTime(musicVol, ctx.currentTime, 0.035);
      musicEl.volume = 1;
    } else musicEl.volume = musicVol;
  }

  function musicStart() {
    if (!musicOn || !musicEl.paused) return;
    ensure();
    musicEl.play().catch(() => {}); // автоплей заблокирован до первого тапа — см. pointerdown ниже
  }

  function musicStop() {
    musicEl.pause();
  }

  function musicToggle() {
    musicOn = !musicOn;
    try { localStorage.setItem('bb_music', musicOn ? '1' : '0'); } catch (e) {}
    if (musicOn) musicStart(); else musicStop();
    return musicOn;
  }

  return {
    playSlot(name) { return playSlot(name).catch(() => {}); },
    stopSlotSounds,
    play(name, ...a) { try { playChannel('game', name, a); } catch (e) {} },
    async prepareSamples(names) {
      if (!gameOn || !ensure()) return;
      await Promise.all(names.map(name => loadSample(name)));
    },
    playUi(name, ...a) { try { playChannel('ui', name, a); } catch (e) {} },
    playLegacy(name, ...a) { try { playLegacyChannel('game', name, a); } catch (e) {} },
    playUiLegacy(name, ...a) { try { playLegacyChannel('ui', name, a); } catch (e) {} },
    spinTicks,
    spinTicksLegacy,
    rocketEngineStart,
    rocketEngineUpdate,
    rocketEngineStop,
    setVolume: setGameVolume,
    setGameVolume,
    setUiVolume,
    setMusicVolume,
    musicToggle,
    get on() { return gameOn; },
    get gameOn() { return gameOn; },
    get uiOn() { return uiOn; },
    get hapticOn() { return hapticOn; },
    get musicOn() { return musicOn; },
    get volume() { return gameVol; },
    get gameVolume() { return gameVol; },
    get uiVolume() { return uiVol; },
    get musicVolume() { return musicVol; },
    get anyAudioOn() { return gameOn || uiOn || musicOn; },
    toggle() { return this.gameToggle(); },
    gameToggle() {
      gameOn = !gameOn;
      try {
        localStorage.setItem('bb_game_snd', gameOn ? '1' : '0');
        localStorage.setItem('bb_snd', gameOn ? '1' : '0');
      } catch (e) {}
      if (gameOn) ensure();
      else { rocketEngineStop(); stopSlotSounds(); }
      return gameOn;
    },
    uiToggle() {
      uiOn = !uiOn;
      try { localStorage.setItem('bb_ui_snd', uiOn ? '1' : '0'); } catch (e) {}
      if (uiOn) ensure();
      return uiOn;
    },
    hapticToggle() {
      hapticOn = !hapticOn;
      try { localStorage.setItem('bb_haptic', hapticOn ? '1' : '0'); } catch (e) {}
      if (hapticOn) emitHaptic('impact', 'medium');
      return hapticOn;
    },
  };
})();

const CLIENT_METRICS_VERSION = '38';
let clientMetricsTimer = null;
let clientMetricsSessionPending = false;

function clientPlatform() {
  const tg = window.Telegram && window.Telegram.WebApp;
  if (tg && tg.platform) return String(tg.platform).toLowerCase();
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'web';
}

function collectClientMetrics(sessionStart = false) {
  const tg = window.Telegram && window.Telegram.WebApp;
  return {
    ui_theme: uiTheme,
    game_sound: SND.gameOn ? 1 : 0,
    ui_sound: SND.uiOn ? 1 : 0,
    music_sound: SND.musicOn ? 1 : 0,
    haptic: SND.hapticOn ? 1 : 0,
    game_volume: Math.round(SND.gameVolume * 100),
    ui_volume: Math.round(SND.uiVolume * 100),
    music_volume: Math.round(SND.musicVolume * 100),
    display_mode: telegramDisplayMode,
    platform: clientPlatform(),
    telegram_version: tg && tg.version ? String(tg.version) : '',
    screen_width: Math.round(window.screen && window.screen.width || window.innerWidth || 0),
    screen_height: Math.round(window.screen && window.screen.height || window.innerHeight || 0),
    client_version: CLIENT_METRICS_VERSION,
    session_start: sessionStart ? 1 : 0,
  };
}

async function flushClientMetrics() {
  clientMetricsTimer = null;
  if (!hasClientIdentity() || !termsAccepted) return;
  const sessionStart = clientMetricsSessionPending;
  clientMetricsSessionPending = false;
  try {
    await fetch(`${API}/api/client/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectClientMetrics(sessionStart)),
      keepalive: true,
    });
  } catch (e) {}
}

function queueClientMetrics(sessionStart = false) {
  if (!hasClientIdentity() || !termsAccepted) return;
  clientMetricsSessionPending = clientMetricsSessionPending || sessionStart;
  if (clientMetricsTimer) clearTimeout(clientMetricsTimer);
  clientMetricsTimer = setTimeout(flushClientMetrics, sessionStart ? 1000 : 650);
}

function sndUpdateIcon() {
  const btn = document.getElementById('snd-toggle');
  if (!btn) return;
  const audibleVolumes = [
    SND.gameOn ? SND.gameVolume : 0,
    SND.uiOn ? SND.uiVolume : 0,
    SND.musicOn ? SND.musicVolume : 0,
  ];
  const peak = Math.max(...audibleVolumes);
  const muted = !SND.anyAudioOn || peak === 0;
  btn.textContent = '⚙';
  btn.classList.toggle('audio-muted', muted);
  btn.dataset.audioState = muted ? 'muted' : 'audible';
  btn.setAttribute('aria-label', muted ? 'Настройки, звук выключен' : 'Настройки');
  btn.title = muted ? 'Настройки · звук выключен' : 'Настройки';
}

function sndSetSwitchState(id, enabled) {
  const button = document.getElementById(id);
  if (!button) return;
  button.classList.toggle('on', enabled);
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

function sndOpenSettings() {
  sndUpdateIcon();
  const modal = document.getElementById('snd-settings-modal');
  if (!modal) return;
  sndSetSwitchState('snd-game-switch', SND.gameOn);
  sndSetSwitchState('snd-ui-switch', SND.uiOn);
  sndSetSwitchState('snd-music-switch', SND.musicOn);
  sndSetSwitchState('snd-haptic-switch', SND.hapticOn);
  document.getElementById('snd-game-vol-slider').value = Math.round(SND.gameVolume * 100);
  document.getElementById('snd-game-vol-val').textContent = Math.round(SND.gameVolume * 100) + '%';
  document.getElementById('snd-ui-vol-slider').value = Math.round(SND.uiVolume * 100);
  document.getElementById('snd-ui-vol-val').textContent = Math.round(SND.uiVolume * 100) + '%';
  document.getElementById('snd-music-vol-slider').value = Math.round(SND.musicVolume * 100);
  document.getElementById('snd-music-vol-val').textContent = Math.round(SND.musicVolume * 100) + '%';
  updateTelegramDisplayControls();
  modal.style.display = 'flex';
}

function sndCloseSettings() {
  const modal = document.getElementById('snd-settings-modal');
  if (modal) modal.style.display = 'none';
}

function sndToggleGame() {
  const isOn = SND.gameToggle();
  sndSetSwitchState('snd-game-switch', isOn);
  sndUpdateIcon();
  queueClientMetrics();
}

function sndToggleFx() { sndToggleGame(); }

function sndToggleUi() {
  const isOn = SND.uiToggle();
  sndSetSwitchState('snd-ui-switch', isOn);
  sndUpdateIcon();
  queueClientMetrics();
}

function sndToggleMusic() {
  const isOn = SND.musicToggle();
  sndSetSwitchState('snd-music-switch', isOn);
  sndUpdateIcon();
  queueClientMetrics();
}

function sndToggleHaptic() {
  const isOn = SND.hapticToggle();
  sndSetSwitchState('snd-haptic-switch', isOn);
  queueClientMetrics();
}

function sndSetGameVolume(v) {
  const vol = Math.max(0, Math.min(100, v)) / 100;
  SND.setGameVolume(vol);
  document.getElementById('snd-game-vol-val').textContent = Math.round(vol * 100) + '%';
  sndUpdateIcon();
  queueClientMetrics();
}

function sndSetVolume(v) { sndSetGameVolume(v); }

function sndSetUiVolume(v) {
  const vol = Math.max(0, Math.min(100, v)) / 100;
  SND.setUiVolume(vol);
  document.getElementById('snd-ui-vol-val').textContent = Math.round(vol * 100) + '%';
  sndUpdateIcon();
  queueClientMetrics();
}

function sndSetMusicVolume(v) {
  const vol = Math.max(0, Math.min(100, v)) / 100;
  SND.setMusicVolume(vol);
  document.getElementById('snd-music-vol-val').textContent = Math.round(vol * 100) + '%';
  sndUpdateIcon();
  queueClientMetrics();
}

sndUpdateIcon();
queueClientMetrics(true);

// ══════════════════════════════════════════
// 🔊 SOUND HOOKS — оборачиваем существующие функции,
// не трогая их код. before — до вызова, after — после
// (для async — после завершения промиса).
// ══════════════════════════════════════════
(function attachSounds() {
  function wrap(name, before, after) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (...args) {
      try { before && before(...args); } catch (e) {}
      const r = orig.apply(this, args);
      if (after) {
        if (r && typeof r.then === 'function') r.then(v => { try { after(v, ...args); } catch (e) {} });
        else { try { after(r, ...args); } catch (e) {} }
      }
      return r;
    };
  }

  // ── Навигация и уведомления (покрывает ставки/ошибки во всех играх) ──
  wrap('showGame', () => SND.playUi('tap'));
  wrap('faqToggle', () => SND.playUi('tap'));
  wrap('showToast', (msg, type) => {
    if (type === 'win') SND.playUi('toastWin');
    else if (type === 'lose') SND.playUi('err');
  });

  // ── Универсальный бокс результата (Dice и др.) ──
  wrap('showResult', (boxId, opts) => {
    if (opts && opts.win) SND.play((opts.amount || 0) >= 500 ? 'bigwin' : 'win');
    else SND.play('lose');
  });

  // ── Монетка ──
  wrap('playCoin',       () => SND.play('coin'));
  wrap('coinNextStep',   () => SND.play('coin'));
  wrap('coinTakePayout', () => SND.play('cash'));

  // ── Мульти-рулетка: вжух + тики 7 сек, итог по своей ставке ──
  wrap('mrAnimateSpin', () => { SND.play('rouletteSpin'); SND.spinTicks(7000, 28); });
  wrap('mrAfterSpin', (winMult) => {
    const my = ((mrState && mrState.my_bets) || {})[winMult] || 0;
    if (winMult && my > 0) SND.play('bigwin');
    else SND.play('lose');
  });

  // ── Колесо 1v1 / Jackpot (анимация ~6.3 сек) ──
  wrap('animateWheel', (canvasId) => {
    SND.play(canvasId === 'ffa-canvas' ? 'jackpotSpin' : 'duelSpin');
    SND.spinTicks(6300, 26);
  });

  // ── Кейсы: трещотка на прокрутке, "реведил" в конце ──
  wrap('runCaseAnimation',      () => { SND.playLegacy('whoosh'); SND.spinTicksLegacy(6300, 34); },
                                () => SND.playLegacy('reveal'));
  wrap('runMultiCaseAnimation', () => { SND.playLegacy('whoosh'); SND.spinTicksLegacy(6300, 34); },
                                () => SND.playLegacy('reveal'));
  wrap('openCaseFast',          () => SND.playLegacy('reveal'));

  // ── Dice / freeslots / Lucky Draw / Апгрейдер ──
  wrap('playSlotsGame',     () => SND.play('bet'));
  wrap('animateReelsNormal', () => SND.play('slotsSpin'));
  wrap('fsSpin',            () => SND.play('slotsSpin'));
  wrap('runLuckyDraw',      () => { SND.play('jackpotSpin'); SND.spinTicks(LD_SPIN_DURATION, 56); });

  // ── Магазин ──
  wrap('buyItem', () => SND.play('bet'), (r) => SND.play('cash'));
  wrap('sellInvItem', () => SND.play('bet'), () => SND.play('cash'));

  wrap('mrPlaceBet',           () => SND.play('bet'));
  wrap('playRoulette1v1',      () => SND.play('bet'));
  wrap('playRouletteFFA',      () => SND.play('bet'));
  wrap('joinRoom1v1',          () => SND.play('bet'));
  wrap('csmDoOpen',            () => SND.playLegacy('bet'));
  wrap('upgGo',                () => SND.playLegacy('bet'));
  wrap('upgQuick',             () => SND.playLegacy('bet'));
  wrap('upgBuy',               () => SND.playLegacy('bet'));
  wrap('confirmWithdraw',      () => SND.play('bet'));
  wrap('confirmExtraWithdraw', () => SND.play('bet'));
  wrap('startWithdrawMode',    () => SND.play('bet'));
  wrap('submitTicketCreate',   () => SND.play('bet'));
  wrap('ticketSendReply',      () => SND.play('bet'));
  wrap('submitUsernameChange', () => SND.play('bet'));

  wrap('faqTab',             () => SND.playUi('tap'));
  wrap('navScroll',          () => SND.playUi('tap'));
  wrap('closeCaseModal',     () => SND.playUi('tap'));
  wrap('closeCaseOverlay',   () => SND.playUi('tap'));
  wrap('closePlayerModal',   () => SND.playUi('tap'));
  wrap('closePlayerProfile', () => SND.playUi('tap'));
  wrap('closeTicketCreate',  () => SND.playUi('tap'));
  wrap('closeTicketModal',   () => SND.playUi('tap'));
  wrap('closeLuckyDraw',     () => SND.playUi('tap'));
  wrap('csmSetCount',        () => SND.playUi('tap'));
  wrap('diceSetMode',        () => SND.playUi('tap'));
  wrap('fsSetMode',          () => SND.playUi('tap'));
  wrap('fsPick',             () => SND.playUi('tap'));
  wrap('lbSetPeriod',        () => SND.playUi('tap'));
  wrap('setQuickBet',        () => SND.playUi('tap'));
  wrap('showCaseModal',      () => SND.playUi('tap'));
  wrap('showTicketCreate',   () => SND.playUi('tap'));
  wrap('slotsPickColor',     () => SND.playUi('tap'));
  wrap('ticketCloseCancel',  () => SND.playUi('tap'));
  wrap('ticketCloseConfirm', () => SND.playUi('tap'));
  wrap('ticketClose',        () => SND.playUi('tap'));
  wrap('ticketsSetFilter',   () => SND.playUi('tap'));
  wrap('upgShowTab',         () => SND.playUi('tap'));
  wrap('upgToggleStake',     () => SND.playUi('tap'));
  wrap('toggleWithdrawItem', () => SND.playUi('tap'));
  wrap('cancelWithdraw',     () => SND.playUi('tap'));
  wrap('cancelR1Wait',       () => SND.playUi('tap'));
  wrap('mrSelectMult',       () => SND.playUi('tap'));
  wrap('openPlayerModal',    () => SND.playUi('tap'));
  wrap('openPlayerProfile',  () => SND.playUi('tap'));
  wrap('openTicketModal',    () => SND.playUi('tap'));
  wrap('adminPanelSearch',   () => SND.playUi('tap'));
  wrap('adminSearchPlayers', () => SND.playUi('tap'));
  wrap('apmSaveBalance',     () => SND.playUi('tap'));
  wrap('apmSaveNick',        () => SND.playUi('tap'));
  wrap('apmDeleteItem',      () => SND.playUi('tap'));
  wrap('apmCancelWithdraw',  () => SND.playUi('tap'));
  wrap('sndOpenSettings',    () => SND.playUi('tap'));
  wrap('sndCloseSettings',   () => SND.playUi('tap'));
  wrap('sndToggleGame',      () => SND.playUi('tap'));
  wrap('sndToggleUi',        () => SND.playUi('tap'));
  wrap('sndToggleMusic',     () => SND.playUi('tap'));
  wrap('sndToggleHaptic',    () => SND.playUi('tap'));
  wrap('setTelegramDisplayMode', () => SND.playUi('tap'));

  // ── Бип-обратный отсчёт последних 3 секунд мульти-рулетки ──
  let lastBeep = null;
  setInterval(() => {
    if (typeof mrSpinAt === 'undefined' || !mrSpinAt || (typeof mrSpinning !== 'undefined' && mrSpinning)) return;
    const tEl = document.getElementById('mr-timer');
    if (!tEl || !tEl.offsetParent) return; // вкладка рулетки не видна
    const left = Math.ceil(mrSpinAt - Date.now() / 1000);
    if (left >= 1 && left <= 3 && left !== lastBeep) {
      lastBeep = left;
      SND.play('beep');
    }
  }, 250);
})();
