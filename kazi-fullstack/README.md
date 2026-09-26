# Kazi — full-stack (real hosting, real accounts, real M-Pesa)

This is the version to use if you want an actual public website — anyone in
Kenya can create an account, no Claude sign-in involved. It's two pieces:

- **`backend/`** — a Node/Express API with its own Postgres database
  (accounts, tasks, offers, reviews, chat, payments) and a real Safaricom
  Daraja M-Pesa integration.
- **`frontend/`** — one static `index.html` (no build step) that calls that
  API. Drop it on any static host.

Nothing here depends on Claude or claude.ai — once deployed, it runs on its
own, on your own domain.

---

## 1. Get a database (5 minutes)

Any managed Postgres works. Easiest free options:
- **Neon** (neon.tech) — free tier, instant setup, gives you a `DATABASE_URL`.
- **Supabase** (supabase.com) — also free tier, same idea.

Copy the connection string it gives you — you'll need it in step 2.

## 2. Deploy the backend

Pick any Node host — **Render** (render.com) is the easiest for a first
launch (free/cheap web service, auto-deploys from GitHub).

1. Push the `backend/` folder to a GitHub repo (or deploy the folder
   directly if your host allows it).
2. On Render: New → Web Service → point at the repo → root directory
   `backend` → build command `npm install` → start command `npm start`.
3. Add environment variables (from `.env.example`):
   - `DATABASE_URL` — from step 1
   - `JWT_SECRET` — generate with `openssl rand -hex 32`
   - `FRONTEND_URL` — you'll fill this in after step 3 (your frontend's URL)
   - `MPESA_*` — from Safaricom's developer portal, see below
   - `FEE_POSTER_SUB=500`, `FEE_PRO_SUB=250`, `FEE_BID=50` (change any time)
4. Deploy. Visit `https://your-api.onrender.com/api/health` — you should see
   `{"ok":true}`. The database tables are created automatically on first
   boot (see `src/db.js`) — no separate migration step.

## 3. Deploy the frontend

The whole frontend is one file: `frontend/index.html`. Any static host works:
**Netlify** (drag-and-drop the file in their dashboard), **Vercel**, **GitHub
Pages**, or even your domain registrar's basic hosting.

Before deploying, open `index.html` and set the API URL near the top of the
`<script>` block:
```html
<script>
window.KAZI_API_BASE = "https://your-api.onrender.com";
</script>
```
(Add that line just before the existing `<script>` tag, or edit the
`API_BASE` default inside the script — either works.)

Then go back to your backend's `FRONTEND_URL` environment variable and set it
to wherever this frontend ends up living, so the API's CORS check allows it.

## 4. Point your domain at it

- Buy a domain from any registrar (e.g. a `.co.ke` or `.com` — Kenya's
  registry is at kenic.or.ke, or use Namecheap/GoDaddy for `.com`).
- In your DNS settings, point your domain (e.g. `kazi.co.ke`) at your
  frontend host's custom-domain instructions (Netlify/Vercel both walk you
  through this with a CNAME record), and a subdomain (e.g.
  `api.kazi.co.ke`) at your backend host the same way.
- Update `KAZI_API_BASE` and `FRONTEND_URL` to the final domains once DNS is
  live.

## 5. Safaricom Daraja (M-Pesa) setup

1. Create an account at https://developer.safaricom.co.ke
2. Under "My Apps," create an app — you get sandbox `Consumer Key` /
   `Consumer Secret` immediately, for testing with fake money.
3. Sandbox shortcode is `174379`; use the sample passkey Safaricom publishes
   on the "Lipa na M-Pesa Online" docs page.
4. For real payments: apply for a Paybill or Buy Goods (Till) number.
   Safaricom issues production credentials once approved — swap
   `MPESA_ENV=production` and the new credentials into your backend's env
   vars.
5. `MPESA_CALLBACK_URL` must be your **deployed** backend's public URL —
   Safaricom needs to reach it over the internet, so this only works once
   step 2 is live (not on localhost).

## Local development

```bash
# backend
cd backend
npm install
cp .env.example .env   # fill in DATABASE_URL and Daraja keys
npm start               # http://localhost:4000

# frontend — just open frontend/index.html in a browser,
# or serve it: npx serve frontend
```
M-Pesa callbacks need a public HTTPS URL even in development — tunnel your
local backend with something like `ngrok http 4000` and put that URL in
`MPESA_CALLBACK_URL` while testing.

## What's already wired up
- Real signup/login (bcrypt-hashed passwords, JWT sessions) — no Claude
  account needed.
- Posting a task requires an active **KSh 500/month** poster plan.
- Sending an offer costs a **KSh 50** bidding fee.
- **Kazi Pro (KSh 250/month)** gives taskers 2-hour early access to new
  tasks and top placement in the poster's offer list.
- All four charges run through one real Safaricom STK Push flow
  (`backend/src/routes/payments.js`) — the database is only updated once
  Safaricom's callback confirms the payment actually succeeded, so a
  cancelled or failed prompt can't create a free post/offer/subscription.
- Task chat, star ratings/reviews, and profile editing all work the same
  way they did in the Claude Artifact demo.

## What you'll still want to add before a real public launch
- **Paying taskers out.** This starter only *collects* payment from
  posters (M-Pesa STK Push). Actually disbursing a tasker's share needs
  Daraja's separate B2C product, which requires Safaricom's approval on
  your shortcode — see the comment at the bottom of
  `backend/src/mpesa.js`.
- **Rate limiting & abuse protection** on the auth and payment endpoints.
- **Password reset** (email or SMS-based) — not included yet.
- **Input validation hardening** — the current checks are basic; consider
  a library like `zod` if the API grows.
- **Real-time chat** — messages currently refresh by polling every 4
  seconds, which is fine at small scale; swap in WebSockets if you need it
  snappier.
