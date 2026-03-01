# Chores App — Stripe Backend

Express server that handles all Stripe operations securely.
Your secret key never touches the frontend.

---

## Deploy to Railway (5 minutes, free)

### Step 1 — Create a Railway account
Go to https://railway.app and sign up with GitHub.

### Step 2 — Push this folder to GitHub
```bash
cd chores-backend
git init
git add .
git commit -m "Initial backend"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/chores-backend.git
git push -u origin main
```

### Step 3 — Deploy on Railway
1. Go to https://railway.app/dashboard
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your `chores-backend` repo
4. Railway auto-detects Node.js and deploys it

### Step 4 — Add your environment variables
In Railway dashboard → your project → **Variables** tab, add:

| Key | Value |
|-----|-------|
| `STRIPE_SECRET_KEY` | `sk_live_...` (your real secret key) |
| `STRIPE_WEBHOOK_SECRET` | (get this in Step 5) |
| `FRONTEND_URL` | URL of your React app |

### Step 5 — Set up Stripe Webhook
1. Go to https://dashboard.stripe.com/webhooks
2. Click **Add endpoint**
3. URL: `https://YOUR-APP.railway.app/api/webhook`
4. Select events:
   - `payment_intent.amount_capturable_updated`
   - `payment_intent.succeeded`
   - `charge.refunded`
   - `payment_intent.payment_failed`
5. Copy the **Signing secret** → paste as `STRIPE_WEBHOOK_SECRET` in Railway

### Step 6 — Update your React app
Replace the comment in `ChoresApp_V6.jsx` that says:
```js
// ── At this point send result.paymentMethod.id to your backend ──
```

With a real fetch call:
```js
const res = await fetch("https://YOUR-APP.railway.app/api/charge", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    paymentMethodId: result.paymentMethod.id,
    amountCents: Math.round(total * 100),
    jobId: job.id,
    jobTitle: job.title,
  }),
});
const { intentId, status } = await res.json();
// Store intentId — you'll need it to release or refund later
```

---

## API Endpoints

| Method | Endpoint | What it does |
|--------|----------|--------------|
| `GET` | `/` | Health check |
| `POST` | `/api/charge` | Authorize + hold payment (escrow) |
| `POST` | `/api/release` | Capture held payment (release escrow) |
| `POST` | `/api/refund` | Refund poster (dispute/no-show) |
| `POST` | `/api/setup-intent` | Create SetupIntent for saving a card |
| `POST` | `/api/webhook` | Stripe event listener |

### /api/charge
```json
Request:  { "paymentMethodId": "pm_xxx", "amountCents": 3500, "jobId": "5", "jobTitle": "Mow Lawn" }
Response: { "intentId": "pi_xxx", "status": "requires_capture", "amount": 3500 }
```
`status: "requires_capture"` means the money is held. Card was authorized but not charged yet.

### /api/release
```json
Request:  { "intentId": "pi_xxx" }
Response: { "status": "succeeded", "amount": 3500 }
```
Call this when both poster and worker confirm the job is done.

### /api/refund
```json
Request:  { "intentId": "pi_xxx", "reason": "requested_by_customer" }
Response: { "refundId": "re_xxx", "status": "succeeded", "amount": 3500 }
```

---

## Running locally

```bash
npm install
cp .env.example .env
# Fill in your real keys in .env
npm run dev
```

Test with Stripe test cards:
- ✅ Success: `4242 4242 4242 4242`
- ❌ Decline: `4000 0000 0000 0002`
- 🔐 3D Secure: `4000 0025 0000 3155`

Any expiry date in the future, any CVC, any ZIP.
