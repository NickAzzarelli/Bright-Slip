require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const USERS_FILE = path.join(__dirname, 'data', 'users.json');
const FORTUNES_FILE = path.join(__dirname, 'data', 'fortunes.json');
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me';
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- Credit packs & subscription ------------------------------------------
const PACKS = {
  small: { label: '5 fortunes', priceCents: 99, credits: 5 },
  medium: { label: '30 fortunes', priceCents: 499, credits: 30, popular: true },
  large: { label: '75 fortunes', priceCents: 999, credits: 75 },
};
const SUBSCRIPTION = { label: 'Unlimited, monthly', priceCents: 299 };

// One-time trial credits for a brand-new visitor — not recurring. There is
// no free daily fortune anymore; every draw after this costs a credit
// (or is covered by an active subscription).
const NEW_VISITOR_TRIAL_CREDITS = 2;

const REFERRAL_BONUS_FOR_NEW_USER = 1;
const REFERRAL_BONUS_FOR_REFERRER = 1;

// ---- Tiny JSON "database" --------------------------------------------------
function readUsers() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

let writeQueue = Promise.resolve();
function writeUsers(users) {
  writeQueue = writeQueue.then(
    () => fs.promises.writeFile(USERS_FILE, JSON.stringify(users, null, 2))
  );
  return writeQueue;
}

function makeRefCode() {
  return uuidv4().slice(0, 8);
}

function findUidByRefCode(users, refCode) {
  return Object.keys(users).find((uid) => users[uid].refCode === refCode);
}

function findUidBySubscriptionId(users, subscriptionId) {
  return Object.keys(users).find((uid) => users[uid].subscriptionId === subscriptionId);
}

function newUserRecord(email) {
  return {
    email: email || null,
    credits: NEW_VISITOR_TRIAL_CREDITS,
    seenFortunes: [],
    favorites: [],
    createdAt: new Date().toISOString(),
    refCode: makeRefCode(),
    referredBy: null,
    referralRewarded: false,
    fulfilledSessions: [],
    subscriptionActive: false,
    subscriptionId: null,
  };
}

function accountUidFor(email) {
  return `acct:${email.toLowerCase().trim()}`;
}

const FORTUNES = JSON.parse(fs.readFileSync(FORTUNES_FILE, 'utf8'));

// ---- Email sending ----------------------------------------------------------
async function sendMagicLinkEmail(email, link) {
  if (process.env.RESEND_API_KEY) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM || 'Bright Slip <onboarding@resend.dev>',
          to: email,
          subject: 'Your Bright Slip login link',
          html: `<p>Tap below to log in. This link works once and expires in 15 minutes.</p>
                 <p><a href="${link}">${link}</a></p>`,
        }),
      });
    } catch (err) {
      console.error('Failed to send login email:', err.message);
    }
  } else {
    console.log(`\n[dev] Magic login link for ${email}:\n${link}\n`);
  }
}

// ---- Stripe webhook must see the RAW body ------------------------------------
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;
    try {
      const sig = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature check failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      const packId = session.metadata?.packId;

      const users = readUsers();
      if (!users[uid]) users[uid] = newUserRecord();
      const user = users[uid];

      if (session.mode === 'subscription') {
        user.subscriptionActive = true;
        user.subscriptionId = session.subscription;
        await writeUsers(users);
      } else if (uid && packId) {
        const pack = PACKS[packId];
        if (pack) {
          user.fulfilledSessions = user.fulfilledSessions || [];
          if (!user.fulfilledSessions.includes(session.id)) {
            const isFirstPurchase = user.fulfilledSessions.length === 0;
            user.credits += pack.credits;
            user.fulfilledSessions.push(session.id);

            if (isFirstPurchase && user.referredBy && !user.referralRewarded) {
              const referrer = users[user.referredBy];
              if (referrer) {
                referrer.credits += REFERRAL_BONUS_FOR_REFERRER;
                user.referralRewarded = true;
              }
            }
            await writeUsers(users);
          }
        }
      }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const users = readUsers();
      const uid = findUidBySubscriptionId(users, sub.id);
      if (uid) {
        users[uid].subscriptionActive = sub.status === 'active' || sub.status === 'trialing';
        await writeUsers(users);
      }
    }

    res.json({ received: true });
  }
);

// ---- Normal middleware --------------------------------------------------------
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use(async (req, res, next) => {
  const sessionToken = req.cookies.session;
  if (sessionToken) {
    try {
      const payload = jwt.verify(sessionToken, SESSION_SECRET);
      if (payload.purpose === 'session') {
        req.uid = accountUidFor(payload.email);
        req.email = payload.email;
        return next();
      }
    } catch {
      // fall through to guest handling
    }
  }

  let uid = req.cookies.uid;
  let isNew = false;
  if (!uid) {
    uid = uuidv4();
    isNew = true;
    res.cookie('uid', uid, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 24 * 365 * 2,
    });
  }
  req.uid = uid;

  if (isNew) {
    const users = readUsers();
    if (!users[uid]) {
      const user = newUserRecord();
      const refCode = req.query.ref;
      if (refCode && refCode !== user.refCode) {
        const referrerUid = findUidByRefCode(users, refCode);
        if (referrerUid && referrerUid !== uid) {
          user.referredBy = referrerUid;
          user.credits += REFERRAL_BONUS_FOR_NEW_USER;
        }
      }
      users[uid] = user;
      await writeUsers(users);
    }
  }

  next();
});

function getOrCreateUser(users, uid) {
  if (!users[uid]) {
    users[uid] = newUserRecord(uid.startsWith('acct:') ? uid.slice(6) : null);
  }
  const u = users[uid];
  if (u.seenFortunes === undefined) u.seenFortunes = [];
  if (u.favorites === undefined) u.favorites = [];
  if (u.refCode === undefined) u.refCode = makeRefCode();
  if (u.referredBy === undefined) u.referredBy = null;
  if (u.referralRewarded === undefined) u.referralRewarded = false;
  if (u.fulfilledSessions === undefined) u.fulfilledSessions = [];
  if (u.email === undefined) u.email = null;
  if (u.subscriptionActive === undefined) u.subscriptionActive = false;
  if (u.subscriptionId === undefined) u.subscriptionId = null;
  return u;
}

// ---- Auth: magic link ------------------------------------------------------
app.post('/api/auth/request-login', async (req, res) => {
  const email = (req.body?.email || '').trim().toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return res.status(400).json({ error: 'Enter a valid email address' });

  const token = jwt.sign({ email, purpose: 'login' }, SESSION_SECRET, { expiresIn: '15m' });
  const link = `${BASE_URL}/auth/verify?token=${token}`;
  await sendMagicLinkEmail(email, link);

  const response = { sent: true };
  if (!IS_PROD) response.devLink = link;
  res.json(response);
});

app.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  let payload;
  try {
    payload = jwt.verify(token, SESSION_SECRET);
    if (payload.purpose !== 'login') throw new Error('wrong token purpose');
  } catch {
    return res.status(400).send('This login link is invalid or has expired. Go back and request a new one.');
  }

  const email = payload.email;
  const targetUid = accountUidFor(email);
  const users = readUsers();

  if (!users[targetUid]) {
    users[targetUid] = newUserRecord(email);
  }
  const account = getOrCreateUser(users, targetUid);

  const guestUid = req.cookies.uid;
  if (guestUid && guestUid !== targetUid && users[guestUid] && !users[guestUid].mergedInto) {
    const guest = getOrCreateUser(users, guestUid);
    account.credits += guest.credits;
    account.seenFortunes = Array.from(new Set([...account.seenFortunes, ...guest.seenFortunes]));
    account.favorites = [...account.favorites, ...guest.favorites.filter(
      (gf) => !account.favorites.some((af) => af.text === gf.text)
    )];
    if (!account.referredBy && guest.referredBy) account.referredBy = guest.referredBy;
    guest.mergedInto = targetUid;
    guest.credits = 0;
  }

  await writeUsers(users);

  const sessionToken = jwt.sign({ email, purpose: 'session' }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie('session', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  });
  res.redirect('/?loggedin=success');
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ loggedOut: true });
});

app.get('/api/auth/session', (req, res) => {
  res.json({ loggedIn: !!req.email, email: req.email || null });
});

// ---- API --------------------------------------------------------------------

app.get('/api/me', async (req, res) => {
  const users = readUsers();
  const user = getOrCreateUser(users, req.uid);
  await writeUsers(users);
  res.json({
    credits: user.credits,
    refLink: `${BASE_URL}/?ref=${user.refCode}`,
    loggedIn: !!req.email,
    email: req.email || null,
    subscriptionActive: user.subscriptionActive,
    favoriteCount: user.favorites.length,
  });
});

app.get('/api/packs', (req, res) => {
  res.json({
    packs: Object.entries(PACKS).map(([id, p]) => ({
      id,
      label: p.label,
      price: `$${(p.priceCents / 100).toFixed(2)}`,
      popular: !!p.popular,
    })),
    subscription: {
      label: SUBSCRIPTION.label,
      price: `$${(SUBSCRIPTION.priceCents / 100).toFixed(2)}/mo`,
    },
  });
});

app.post('/api/checkout', async (req, res) => {
  const { packId, subscribe } = req.body;

  try {
    if (subscribe) {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Bright Slip — Unlimited' },
              unit_amount: SUBSCRIPTION.priceCents,
              recurring: { interval: 'month' },
            },
            quantity: 1,
          },
        ],
        customer_email: req.email || undefined,
        subscription_data: { metadata: { uid: req.uid } },
        metadata: { uid: req.uid },
        success_url: `${BASE_URL}/?purchase=success`,
        cancel_url: `${BASE_URL}/?purchase=cancelled`,
      });
      return res.json({ url: session.url });
    }

    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ error: 'Unknown pack' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `Bright Slip — ${pack.label}` },
            unit_amount: pack.priceCents,
          },
          quantity: 1,
        },
      ],
      customer_email: req.email || undefined,
      metadata: { uid: req.uid, packId },
      success_url: `${BASE_URL}/?purchase=success`,
      cancel_url: `${BASE_URL}/?purchase=cancelled`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout session failed:', err.message);
    res.status(500).json({ error: 'Could not start checkout' });
  }
});

app.post('/api/fortune', async (req, res) => {
  const users = readUsers();
  const user = getOrCreateUser(users, req.uid);
  const category = req.body?.category || null;

  const hasUnlimited = user.subscriptionActive;
  if (!hasUnlimited && user.credits <= 0) {
    return res.status(402).json({ error: 'No credits left' });
  }

  let pool = FORTUNES
    .map((f, i) => ({ ...f, index: i }))
    .filter((f) => !category || f.category === category);

  // Weight toward the longer "premium" pool when it's available, so a
  // credit buys something that reads differently, not just more of the
  // same short lines.
  const premiumPool = pool.filter((f) => f.tier === 'premium');
  if (premiumPool.length > 0 && Math.random() < 0.7) pool = premiumPool;

  const poolIndexes = pool.map((f) => f.index);
  let available = poolIndexes.filter((i) => !user.seenFortunes.includes(i));
  if (available.length === 0) {
    const lastIndex = user.seenFortunes[user.seenFortunes.length - 1];
    user.seenFortunes = user.seenFortunes.filter((i) => !poolIndexes.includes(i));
    available = poolIndexes.filter((i) => i !== lastIndex);
    if (available.length === 0) available = poolIndexes;
  }

  const chosenIndex = available[Math.floor(Math.random() * available.length)];
  user.seenFortunes.push(chosenIndex);
  const chosen = FORTUNES[chosenIndex];

  if (!hasUnlimited) user.credits -= 1;

  await writeUsers(users);

  res.json({
    fortune: chosen.text,
    category: chosen.category,
    type: chosen.type,
    tier: chosen.tier,
    credits: user.credits,
    subscriptionActive: hasUnlimited,
  });
});

// ---- Favorites ----------------------------------------------------------------
app.get('/api/favorites', async (req, res) => {
  const users = readUsers();
  const user = getOrCreateUser(users, req.uid);
  await writeUsers(users);
  res.json({ favorites: user.favorites });
});

app.post('/api/favorites', async (req, res) => {
  const { text, category, type } = req.body || {};
  if (!text) return res.status(400).json({ error: 'Missing fortune text' });

  const users = readUsers();
  const user = getOrCreateUser(users, req.uid);
  if (!user.favorites.some((f) => f.text === text)) {
    user.favorites.unshift({ text, category, type, savedAt: new Date().toISOString() });
  }
  await writeUsers(users);
  res.json({ favorites: user.favorites });
});

app.delete('/api/favorites', async (req, res) => {
  const { text } = req.body || {};
  const users = readUsers();
  const user = getOrCreateUser(users, req.uid);
  user.favorites = user.favorites.filter((f) => f.text !== text);
  await writeUsers(users);
  res.json({ favorites: user.favorites });
});

app.listen(PORT, () => {
  console.log(`Bright Slip running at ${BASE_URL}`);
});
