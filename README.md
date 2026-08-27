# Bright Slip — backend + payments

A small Node/Express server that serves the site, tracks each visitor's
credit balance, and sells credit packs through Stripe Checkout.

Pricing: $1 = 5 fortunes (base rate), with two bigger packs that include a
bonus. Edit the `PACKS` object at the top of `server.js` to change prices
or amounts.

## How it works

- Each visitor gets an anonymous id in a cookie — no account/login needed.
- Credits are stored in `data/users.json` (a flat JSON file — fine for one
  server; swap for a real database like Postgres if you outgrow it).
- Buying a pack redirects to a Stripe-hosted Checkout page.
- When payment completes, Stripe calls your `/webhook` endpoint, which is
  what actually credits the account — never the success redirect, since
  that can be skipped or replayed.

## 1. Install dependencies

```
npm install
```

## 2. Set up Stripe

1. Create a free account at https://stripe.com if you don't have one.
2. In the Stripe Dashboard, grab your **test** secret key from
   https://dashboard.stripe.com/test/apikeys.
3. Copy `.env.example` to `.env` and paste it in as `STRIPE_SECRET_KEY`.

## 3. Forward webhooks while developing locally

Stripe needs to reach your webhook endpoint. Locally, use the Stripe CLI:

```
stripe login
stripe listen --forward-to localhost:3000/webhook
```

That command prints a webhook signing secret (`whsec_...`) — put that in
`.env` as `STRIPE_WEBHOOK_SECRET`.

## 4. Run it

```
npm start
```

Visit http://localhost:3000. Use Stripe's test card `4242 4242 4242 4242`,
any future expiry date, and any CVC to complete a test purchase.

## 5. Going live

- Switch to your **live** Stripe keys in production's environment
  variables (never commit `.env`).
- In the Stripe Dashboard, add a live webhook endpoint pointing at
  `https://yourdomain.com/webhook`, subscribed to the
  `checkout.session.completed`, `customer.subscription.updated`, and
  `customer.subscription.deleted` events (the last two keep the
  Unlimited plan's status in sync if someone's card fails or they
  cancel), and use *its* signing secret for `STRIPE_WEBHOOK_SECRET` in
  production.
- Set `BASE_URL` to your real domain and `NODE_ENV=production`.
- Deploy anywhere that runs a persistent Node process — Render, Railway,
  Fly.io, or a small VPS all work. (This can't run as a static site or a
  browser-only artifact, since the Stripe secret key and credit ledger
  have to live on a server.)

## Accounts (email magic links)

No passwords. A visitor types their email, gets a one-time login link,
and clicking it logs them in for 30 days.

- **Guests still work.** Someone can use the app fully (free daily
  fortune, buying credits) before ever creating an account — the
  anonymous cookie from before still applies to them.
- **Logging in merges history.** The moment someone logs in for the
  first time, whatever credits/streak/seen-fortunes exist on their guest
  cookie get folded into their new account, once, automatically. They
  don't lose anything by signing up.
- **No email setup required to test locally.** If `RESEND_API_KEY` is
  unset, the login link is printed to your server console *and* handed
  back directly in the API response (only outside production) so you
  can click straight through without configuring email at all.
- **To send real emails**, sign up at https://resend.com (free tier is
  fine to start), grab an API key, and put it in `.env` as
  `RESEND_API_KEY`. Their sandbox sender (`onboarding@resend.dev`) works
  without verifying your own domain — good enough until you want a
  branded "from" address.
- Set `SESSION_SECRET` in `.env` to a long random string — this is what
  signs login links and session cookies, so treat it like a password.
  The command to generate one is in `.env.example`.

## Monetization model: no free daily fortune

This changed from an earlier version of this app that gave everyone one
free fortune per day forever. That built a nice daily habit, but it also
meant nobody ever had a reason to pay — why buy something you already
get free, every day, indefinitely? The current model:

- **No recurring free tier.** Every draw costs a credit, or requires
  the Unlimited subscription. There's no daily reset that gives it back.
- **One-time trial credits for new visitors.** A brand-new guest starts
  with `NEW_VISITOR_TRIAL_CREDITS` (2, set in `server.js`) so they can
  actually try the product before being asked to pay — just not
  forever. Tune this number based on your funnel data once you have
  some: too low and people bounce before getting a feel for it, too
  high and you've just rebuilt the old daily-free problem with extra
  steps.
- **Content tiers still matter.** Every fortune in `data/fortunes.json`
  has a `tier` of `free` or `premium`. Every paid draw is weighted
  (70%) toward the longer, two-sentence `premium` pool, so spending a
  credit reads differently from a leftover trial credit, not just "the
  same thing again."
- **All categories are available on any paid draw** — Love / Career /
  Luck aren't gated separately anymore, since there's no free tier left
  to gate them against.

The tradeoff worth knowing: removing the daily free fortune also
removes the built-in "come back tomorrow" habit loop that free tier
created. If new-visitor conversion turns out too low, the trial-credit
count is the first lever to pull before rebuilding any kind of ongoing
free tier.

## The reveal ritual and favorites

- **The reveal ritual.** Tapping the button doesn't swap text in
  instantly — there's a short "•••" pulse (about 650ms, in `app.js`'s
  `drawFortune`) before the fortune fades in. It's a small thing, but
  it's the difference between "database lookup" and "something was
  drawn for you."
- **Favorites.** Any fortune can be saved with "☆ Save this one" and
  reviewed later by tapping the ☆ icon top-right of the card, which
  opens them as a full overlay. This is what gives a purchased pack
  lasting value beyond the ten seconds someone reads each fortune.
- **Unlimited subscription.** A $3/month plan (edit `SUBSCRIPTION` in
  `server.js`) gets every category, the premium pool, and no per-draw
  cost. It's implemented as a real Stripe subscription — see the
  webhook events noted above for keeping it in sync.

## Installing it as a phone app (PWA)

The site is installable straight from the browser — no App Store, no
review process. `public/manifest.json` and `public/sw.js` handle this;
they're already wired into `index.html` and served automatically once
deployed (nothing extra to configure).

To install it on a phone: open the live URL in Safari (iOS) or Chrome
(Android), then:
- **iOS Safari**: tap the Share icon → "Add to Home Screen"
- **Android Chrome**: tap the ⋮ menu → "Install app" (or you'll see an
  automatic install prompt/banner)

It'll launch full-screen with its own icon, no browser address bar —
functionally indistinguishable from a "real" downloaded app for the
person using it. If you want actual App Store / Google Play listings
later, that's a separate, bigger project (native wrapper via something
like Capacitor, developer accounts, store review) — this PWA setup
doesn't block that path, it's just not the same thing.

## Growth features included

- **No repeats** — a person won't see the same fortune twice until
  they've seen every one in their chosen category.
- **Categories** (love / career / luck / general) — lets you target
  content and gives you natural landing-page angles for SEO later
  ("love fortunes", etc).
- **Share cards** — after a draw, "Share this fortune" renders a
  branded image (matching the site's look) and opens the native share
  sheet on mobile, or downloads the image on desktop.
- **Referrals** — every visitor gets a personal invite link
  (`?ref=CODE`). Following it grants the new visitor 1 bonus credit
  immediately, and credits the referrer 1 fortune once their friend
  makes their first purchase.
- **"Best value" badge** on the $5 pack nudges people away from the
  smallest, lowest-margin option.

## Notes / next steps

- `data/users.json` is a simple flat file. It works for one server
  instance; if you ever run multiple instances behind a load balancer,
  move credits to a real database so writes don't race each other. The
  referral-code lookup is a full scan of this file too — fine at small
  scale, worth indexing later.
- Accounts are now in (see above) — logged-in users keep their credits
  across devices. Guests who never log in still only have cookie-based
  persistence, same limitation as before.
- The referral bonus for a *new* visitor stacks with the one-time trial
  credits (2 trial + 1 referral = 3 credits for someone who arrives via
  a link), and it's granted the moment they land on the link, before
  any purchase — simple, but technically someone could refresh with
  cleared cookies to keep re-claiming both. Fine for an MVP; if abuse
  shows up, gate the referral bonus behind the new visitor's first
  purchase too, same as the referrer's reward already is.
- The fortune list lives in `data/fortunes.json`, each with a
  `category` — edit or extend it any time.
