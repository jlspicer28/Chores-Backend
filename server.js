const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

const app = express();

// ─────────────────────────────────────────────────────────────
// SECURITY & MIDDLEWARE
// ─────────────────────────────────────────────────────────────
app.use(cors({ origin: process.env.FRONTEND_URL || "*", methods: ["GET", "POST"] }));

app.use((req, res, next) => {
  if (req.path === "/api/webhook") return next();
  express.json()(req, res, next);
});

// Rate limiter — no extra packages needed
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxRequests) {
      return res.status(429).json({ error: "Too many requests — please wait a moment." });
    }
    entry.count++;
    next();
  };
}

// In-memory email code store (resets on server restart — fine for MVP)
const emailCodes = new Map();

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "Chores API running ✅", domain: "choresnearme.com" });
});

// ─────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — send code (max 3 per 10 mins)
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/email/send", rateLimit(3, 10 * 60 * 1000), async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Invalid email address" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 10 * 60 * 1000;
    emailCodes.set(email.toLowerCase(), { code, expires, attempts: 0 });

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Chores <verify@choresnearme.com>",
        to: [email],
        subject: "Your Chores verification code",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fff;">
            <div style="margin-bottom:24px;">
              <span style="font-family:Georgia,serif;font-size:28px;font-weight:400;color:#1A2E22;letter-spacing:-1px;">chores</span>
              <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#52B788;margin-left:2px;vertical-align:middle;"></span>
            </div>
            <p style="color:#374151;font-size:15px;margin-bottom:8px;">Hi ${name || "there"},</p>
            <p style="color:#6B7280;font-size:14px;margin-bottom:28px;">Here's your verification code:</p>
            <div style="background:#F0FAF4;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
              <div style="font-size:48px;font-weight:900;letter-spacing:14px;color:#2D6A4F;font-family:monospace;">${code}</div>
              <div style="font-size:12px;color:#9CA3AF;margin-top:12px;">Expires in 10 minutes</div>
            </div>
            <p style="color:#9CA3AF;font-size:12px;">If you didn't sign up on choresnearme.com, ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error("Resend error:", err);
      return res.status(400).json({ error: "Failed to send email — please try again." });
    }

    res.json({ sent: true });
  } catch (err) {
    console.error("Email send error:", err.message);
    res.status(500).json({ error: "Server error — please try again." });
  }
});

// ─────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — check code (max 5 attempts)
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/email/check", rateLimit(10, 5 * 60 * 1000), async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.status(400).json({ error: "Email and code required" });

    const stored = emailCodes.get(email.toLowerCase());
    if (!stored) return res.json({ verified: false, error: "No code found — request a new one" });
    if (Date.now() > stored.expires) {
      emailCodes.delete(email.toLowerCase());
      return res.json({ verified: false, error: "Code expired — request a new one" });
    }

    stored.attempts = (stored.attempts || 0) + 1;
    if (stored.attempts > 5) {
      emailCodes.delete(email.toLowerCase());
      return res.json({ verified: false, error: "Too many attempts — request a new code" });
    }
    if (stored.code !== code.trim()) {
      return res.json({ verified: false, error: "Incorrect code" });
    }

    emailCodes.delete(email.toLowerCase());
    res.json({ verified: true });
  } catch (err) {
    console.error("Email check error:", err.message);
    res.status(500).json({ error: "Server error — please try again." });
  }
});

// ─────────────────────────────────────────────────────────────
// STRIPE IDENTITY — government ID verification
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/identity/start", async (req, res) => {
  try {
    const { userId, name } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: { userId, name: name || "", platform: "choresnearme.com" },
      options: {
        document: {
          allowed_types: ["driving_license", "passport", "id_card"],
          require_id_number: true,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      return_url: `${process.env.FRONTEND_URL || "https://choresnearme.com"}?verified=1`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Identity start error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// CHARGE — hold payment in escrow
// ─────────────────────────────────────────────────────────────
app.post("/api/charge", async (req, res) => {
  try {
    const { paymentMethodId, amountCents, jobId, jobTitle } = req.body;
    if (!paymentMethodId || !amountCents) {
      return res.status(400).json({ error: "Missing paymentMethodId or amountCents" });
    }
    if (amountCents < 100) {
      return res.status(400).json({ error: "Minimum charge is $1.00" });
    }

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      payment_method: paymentMethodId,
      capture_method: "manual",
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      metadata: { jobId: jobId || "", jobTitle: jobTitle || "", platform: "choresnearme.com" },
    });

    res.json({ intentId: intent.id, status: intent.status, amount: intent.amount });
  } catch (err) {
    console.error("Charge error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// RELEASE — job done, move money
// ─────────────────────────────────────────────────────────────
app.post("/api/release", async (req, res) => {
  try {
    const { intentId } = req.body;
    if (!intentId) return res.status(400).json({ error: "Missing intentId" });
    const intent = await stripe.paymentIntents.capture(intentId);
    res.json({ status: intent.status, amount: intent.amount_received });
  } catch (err) {
    console.error("Release error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// REFUND — dispute or no-show
// ─────────────────────────────────────────────────────────────
app.post("/api/refund", async (req, res) => {
  try {
    const { intentId, reason } = req.body;
    if (!intentId) return res.status(400).json({ error: "Missing intentId" });
    const validReasons = ["duplicate", "fraudulent", "requested_by_customer"];
    const refund = await stripe.refunds.create({
      payment_intent: intentId,
      reason: validReasons.includes(reason) ? reason : "requested_by_customer",
    });
    res.json({ refundId: refund.id, status: refund.status, amount: refund.amount });
  } catch (err) {
    console.error("Refund error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// SETUP INTENT — save card without charging
// ─────────────────────────────────────────────────────────────
app.post("/api/setup-intent", async (req, res) => {
  try {
    const { customerId } = req.body;
    const params = { usage: "off_session" };
    if (customerId) params.customer = customerId;
    const setupIntent = await stripe.setupIntents.create(params);
    res.json({ clientSecret: setupIntent.client_secret });
  } catch (err) {
    console.error("SetupIntent error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STRIPE WEBHOOK
// Add this URL in Stripe Dashboard → Developers → Webhooks:
// https://chores-backend-production-2051.up.railway.app/api/webhook
// ─────────────────────────────────────────────────────────────
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("⚠️ STRIPE_WEBHOOK_SECRET not set — skipping verification");
    return res.json({ received: true });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
      console.log("💰 Escrow held:", event.data.object.id, "| Job:", event.data.object.metadata?.jobTitle);
      break;
    case "payment_intent.succeeded":
      console.log("✅ Payment released:", event.data.object.id, "| $" + (event.data.object.amount_received / 100).toFixed(2));
      break;
    case "payment_intent.payment_failed":
      console.log("❌ Payment failed:", event.data.object.last_payment_error?.message);
      break;
    case "charge.refunded":
      console.log("↩️ Refund processed:", event.data.object.id);
      break;
    case "identity.verification_session.verified":
      console.log("🪪 ID verified:", event.data.object.metadata?.userId);
      // TODO: mark user as idVerified:true in your database
      break;
    case "identity.verification_session.requires_input":
      console.log("❌ ID verification failed:", event.data.object.last_error?.reason);
      break;
    default:
      console.log("Stripe event:", event.type);
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ Chores API running on port ${PORT}`);
  console.log(`   Stripe:  ${process.env.STRIPE_SECRET_KEY ? "✅ connected" : "❌ missing STRIPE_SECRET_KEY"}`);
  console.log(`   Resend:  ${process.env.RESEND_API_KEY ? "✅ connected" : "❌ missing RESEND_API_KEY"}`);
  console.log(`   Webhook: ${process.env.STRIPE_WEBHOOK_SECRET ? "✅ secured" : "⚠️  missing STRIPE_WEBHOOK_SECRET"}`);
});
