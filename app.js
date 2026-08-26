const creditCountEl = document.getElementById('credit-count');
const creditLine = document.getElementById('credit-line');
const fortuneDisplay = document.getElementById('fortune-display');
const getFortuneBtn = document.getElementById('get-fortune');
const shareBtn = document.getElementById('share-btn');
const favoriteBtn = document.getElementById('favorite-btn');
const favoritesOpen = document.getElementById('favorites-open');
const favoritesClose = document.getElementById('favorites-close');
const favoritesOverlay = document.getElementById('favorites-overlay');
const favoritesList = document.getElementById('favorites-list');
const favBadge = document.getElementById('fav-badge');
const packsEl = document.getElementById('packs');
const subscribeBtn = document.getElementById('subscribe-btn');
const statusLine = document.getElementById('status-line');
const categoriesEl = document.getElementById('categories');
const copyRefBtn = document.getElementById('copy-ref');
const shareCanvas = document.getElementById('share-canvas');
const accountSection = document.getElementById('account-section');

let selectedCategory = '';
let currentFortune = null; // { text, category, type }
let refLink = '';
let me = { credits: 0, subscriptionActive: false };

function updateFavBadge(count) {
  favBadge.textContent = count;
  favBadge.classList.toggle('hidden', count === 0);
}

function updateControls() {
  if (me.subscriptionActive) {
    getFortuneBtn.textContent = 'Get a fortune — unlimited plan';
    getFortuneBtn.disabled = false;
  } else if (me.credits > 0) {
    getFortuneBtn.textContent = 'Get a fortune — 1 credit';
    getFortuneBtn.disabled = false;
  } else {
    getFortuneBtn.textContent = 'Buy credits to continue';
    getFortuneBtn.disabled = true;
  }
}

async function refreshMe() {
  const res = await fetch('/api/me');
  const data = await res.json();
  me = data;
  creditCountEl.textContent = data.credits;
  creditLine.classList.toggle('hidden', data.subscriptionActive);
  updateFavBadge(data.favoriteCount);
  refLink = data.refLink;
  updateControls();
  return data;
}

async function loadPacks() {
  const res = await fetch('/api/packs');
  const data = await res.json();
  packsEl.innerHTML = '';
  data.packs.forEach((pack) => {
    const btn = document.createElement('button');
    btn.className = 'pack-btn' + (pack.popular ? ' popular' : '');
    btn.innerHTML =
      (pack.popular ? '<span class="pack-badge">Best value</span>' : '') +
      `<span>${pack.label}</span><span class="pack-price">${pack.price}</span>`;
    btn.addEventListener('click', () => buyPack(pack.id));
    packsEl.appendChild(btn);
  });
  subscribeBtn.textContent = `${data.subscription.label} — ${data.subscription.price}`;
}

async function buyPack(packId) {
  statusLine.textContent = 'Redirecting to checkout…';
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ packId }),
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
  else statusLine.textContent = 'Something went wrong starting checkout.';
}

async function buySubscription() {
  statusLine.textContent = 'Redirecting to checkout…';
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscribe: true }),
  });
  const data = await res.json();
  if (data.url) window.location.href = data.url;
  else statusLine.textContent = 'Something went wrong starting checkout.';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drawFortune() {
  getFortuneBtn.disabled = true;
  favoriteBtn.classList.add('hidden');
  shareBtn.classList.add('hidden');
  fortuneDisplay.innerHTML = `<p class="reveal-dots">•••</p>`;

  const fetchPromise = fetch('/api/fortune', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category: selectedCategory || null }),
  }).then((r) => r.json().then((data) => ({ ok: r.ok, data })));

  const [{ ok, data }] = await Promise.all([fetchPromise, delay(650)]);

  if (!ok) {
    fortuneDisplay.innerHTML = `<p class="fortune-placeholder">You're out of credits. Buy a pack below.</p>`;
    await refreshMe();
    return;
  }

  currentFortune = { text: data.fortune, category: data.category, type: data.type };
  fortuneDisplay.classList.remove('revealing');
  void fortuneDisplay.offsetWidth; // restart animation
  fortuneDisplay.innerHTML = `<p class="fortune-text">${data.fortune}</p>`;
  fortuneDisplay.classList.add('revealing');

  favoriteBtn.classList.remove('hidden');
  favoriteBtn.textContent = '☆ Save this one';
  favoriteBtn.disabled = false;
  shareBtn.classList.remove('hidden');

  me.credits = data.credits;
  me.subscriptionActive = data.subscriptionActive;
  creditCountEl.textContent = data.credits;
  updateControls();
  statusLine.textContent = '';
}

favoriteBtn.addEventListener('click', async () => {
  if (!currentFortune) return;
  favoriteBtn.disabled = true;
  const res = await fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(currentFortune),
  });
  const data = await res.json();
  favoriteBtn.textContent = '★ Saved';
  updateFavBadge(data.favorites.length);
});

async function renderFavorites() {
  const res = await fetch('/api/favorites');
  const data = await res.json();
  if (data.favorites.length === 0) {
    favoritesList.innerHTML = `<p class="favorites-empty">Nothing saved yet — tap "Save this one" under a fortune you like.</p>`;
    return;
  }
  favoritesList.innerHTML = data.favorites
    .map(
      (f) => `
      <div class="favorite-item" data-text="${encodeURIComponent(f.text)}">
        <p>${f.text}</p>
        <button class="remove-fav">remove</button>
      </div>`
    )
    .join('');
  favoritesList.querySelectorAll('.remove-fav').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const item = e.target.closest('.favorite-item');
      const text = decodeURIComponent(item.dataset.text);
      const res = await fetch('/api/favorites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      updateFavBadge(data.favorites.length);
      renderFavorites();
    });
  });
}

favoritesOpen.addEventListener('click', async () => {
  favoritesOverlay.classList.remove('hidden');
  await renderFavorites();
});

favoritesClose.addEventListener('click', () => {
  favoritesOverlay.classList.add('hidden');
});

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  const lines = [];
  words.forEach((word) => {
    const test = line + word + ' ';
    if (ctx.measureText(test).width > maxWidth && line !== '') {
      lines.push(line.trim());
      line = word + ' ';
    } else {
      line = test;
    }
  });
  lines.push(line.trim());
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
}

function renderShareCard() {
  const ctx = shareCanvas.getContext('2d');
  const w = shareCanvas.width, h = shareCanvas.height;
  ctx.fillStyle = '#fafafa'; ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 2; ctx.strokeRect(60, 60, w - 120, h - 120);
  ctx.fillStyle = '#8a8a8a'; ctx.font = '24px Georgia'; ctx.textAlign = 'center';
  ctx.fillText('BRIGHT SLIP', w / 2, 160);
  ctx.fillStyle = '#1a1a1a'; ctx.font = '36px Georgia';
  wrapText(ctx, currentFortune.text, w / 2, h / 2 - 40, w - 220, 50);
  ctx.fillStyle = '#b3b3b3'; ctx.font = '20px Georgia';
  ctx.fillText('Get your own fortune →', w / 2, h - 140);
}

async function shareFortune() {
  if (!currentFortune) return;
  renderShareCard();
  shareCanvas.toBlob(async (blob) => {
    const file = new File([blob], 'fortune.png', { type: 'image/png' });
    if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'My fortune', text: currentFortune.text });
        return;
      } catch (e) {}
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'fortune.png'; a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

categoriesEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.cat-btn');
  if (!btn) return;
  selectedCategory = btn.dataset.category;
  document.querySelectorAll('.cat-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
});

getFortuneBtn.addEventListener('click', drawFortune);
shareBtn.addEventListener('click', shareFortune);
subscribeBtn.addEventListener('click', buySubscription);

copyRefBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(refLink);
    statusLine.textContent = 'Invite link copied.';
  } catch {
    statusLine.textContent = refLink;
  }
});

function renderLoggedOut() {
  accountSection.innerHTML = `
    <p class="account-copy">Save your credits to your email, so they don't live only in this browser.</p>
    <div class="account-row">
      <input type="email" id="login-email" placeholder="you@example.com" autocomplete="email" />
      <button id="send-login-link">Send link</button>
    </div>
  `;
  document.getElementById('send-login-link').addEventListener('click', sendLoginLink);
  document.getElementById('login-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendLoginLink();
  });
}

function renderLoggedIn(email) {
  accountSection.innerHTML = `
    <div class="account-status">
      <span class="email">Logged in as ${email}</span>
      <button id="logout-btn">Log out</button>
    </div>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.reload();
  });
}

async function sendLoginLink() {
  const input = document.getElementById('login-email');
  const email = input.value.trim();
  if (!email) return;

  const btn = document.getElementById('send-login-link');
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const res = await fetch('/api/auth/request-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const data = await res.json();

  if (!res.ok) {
    statusLine.textContent = data.error || 'Something went wrong.';
    btn.disabled = false;
    btn.textContent = 'Send link';
    return;
  }

  accountSection.innerHTML = `<p class="account-copy">Check your email for a login link. It works once and expires in 15 minutes.</p>`;
  if (data.devLink) {
    accountSection.innerHTML += `<p class="account-copy"><a href="${data.devLink}">[dev] Click to log in</a></p>`;
  }
}

async function refreshAccountSection() {
  const res = await fetch('/api/auth/session');
  const data = await res.json();
  if (data.loggedIn) renderLoggedIn(data.email);
  else renderLoggedOut();
}

const params = new URLSearchParams(window.location.search);
if (params.get('purchase') === 'success') {
  statusLine.textContent = 'Payment received.';
  window.history.replaceState({}, '', '/');
} else if (params.get('purchase') === 'cancelled') {
  statusLine.textContent = 'Checkout cancelled.';
  window.history.replaceState({}, '', '/');
} else if (params.get('loggedin') === 'success') {
  statusLine.textContent = "You're logged in. Anything from this browser has been saved to your account.";
  window.history.replaceState({}, '', '/');
}

refreshMe();
loadPacks();
refreshAccountSection();
