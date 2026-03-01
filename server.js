const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// In-memory code store (replace with your DB in production)
const emailCodes = new Map(); // email -> { code, expires }

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Chores API running ✅" }));

// ─────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — send code
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/email/send", async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
    emailCodes.set(email, { code, expires });

    // Send via Resend (free tier: 3,000/month)
    // Sign up at resend.com, get API key, add RESEND_API_KEY to Railway
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
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
            <h1 style="color:#2D6A4F;font-size:28px;margin-bottom:8px;">Chores.</h1>
            <p style="color:#666;margin-bottom:24px;">Hi ${name || "there"}, here's your verification code:</p>
            <div style="background:#F0FAF4;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
              <div style="font-size:48px;font-weight:900;letter-spacing:12px;color:#2D6A4F;">${code}</div>
            </div>
            <p style="color:#999;font-size:13px;">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
          </div>
        `,
      }),
    });

    if (!response.ok) {
      const err = await response.json();
      console.error("Resend error:", err);
      return res.status(400).json({ error: "Failed to send email" });
    }

    res.json({ sent: true });
  } catch (err) {
    console.error("Email send error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// EMAIL VERIFICATION — check code
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/email/check", async (req, res) => {
  try {
    const { email, code } = req.body;
    const stored = emailCodes.get(email);

    if (!stored) return res.json({ verified: false, error: "No code sent to this email" });
    if (Date.now() > stored.expires) {
      emailCodes.delete(email);
      return res.json({ verified: false, error: "Code expired — request a new one" });
    }
    if (stored.code !== code) return res.json({ verified: false });

    emailCodes.delete(email); // one-time use
    res.json({ verified: true });
  } catch (err) {
    console.error("Email check error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// STRIPE IDENTITY — start ID verification session
// ─────────────────────────────────────────────────────────────
app.post("/api/verify/identity/start", async (req, res) => {
  try {
    const { userId, name } = req.body;

    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: { userId: userId || "unknown", name: name || "" },
      options: {
        document: {
          allowed_types: ["driving_license", "passport", "id_card"],
          require_id_number: true,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
      // Where Stripe redirects after verification
      return_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}?verified=1`,
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Identity start error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 1. CHARGE — poster pays to hire a worker
//    Frontend sends: { paymentMethodId, amountCents, jobId, jobTitle }
//    Use capture_method:'manual' so money is HELD not yet moved (real escrow)
// ─────────────────────────────────────────────────────────────
app.post("/api/charge", async (req, res) => {
  try {
    const { paymentMethodId, amountCents, jobId, jobTitle } = req.body;

    if (!paymentMethodId || !amountCents) {
      return res.status(400).json({ error: "Missing paymentMethodId or amountCents" });
    }

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,            // e.g. 3500 = $35.00
      currency: "usd",
      payment_method: paymentMethodId,
      capture_method: "manual",       // HOLD funds — don't move yet
      confirm: true,                  // authorize immediately
      automatic_payment_methods: {
        enabled: true,
        allow_redirects: "never",
      },
      metadata: { jobId: jobId || "", jobTitle: jobTitle || "" },
    });

    res.json({
      intentId: intent.id,
      status: intent.status,          // "requires_capture" = held successfully
      amount: intent.amount,
    });

  } catch (err) {
    console.error("Charge error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 2. RELEASE — both sides confirmed, move money to platform
//    Frontend sends: { intentId }
//    Call this when BOTH poster + worker have confirmed job done
// ─────────────────────────────────────────────────────────────
app.post("/api/release", async (req, res) => {
  try {
    const { intentId } = req.body;

    if (!intentId) return res.status(400).json({ error: "Missing intentId" });

    const intent = await stripe.paymentIntents.capture(intentId);

    res.json({
      status: intent.status,          // "succeeded" = money moved
      amount: intent.amount_received,
    });

  } catch (err) {
    console.error("Release error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 3. REFUND — dispute or no-show, return money to poster
//    Frontend sends: { intentId, reason? }
// ─────────────────────────────────────────────────────────────
app.post("/api/refund", async (req, res) => {
  try {
    const { intentId, reason } = req.body;

    if (!intentId) return res.status(400).json({ error: "Missing intentId" });

    const refund = await stripe.refunds.create({
      payment_intent: intentId,
      reason: reason || "requested_by_customer",
    });

    res.json({
      refundId: refund.id,
      status: refund.status,          // "succeeded" = poster refunded
      amount: refund.amount,
    });

  } catch (err) {
    console.error("Refund error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// 4. SAVE CARD — create a SetupIntent so user can save a card
//    without charging it yet
//    Frontend sends: {} (optional: { customerId })
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
// 5. STRIPE WEBHOOK — listen for async events from Stripe
//    Set this URL in your Stripe Dashboard → Webhooks
//    e.g. https://your-app.railway.app/api/webhook
// ─────────────────────────────────────────────────────────────
app.post("/api/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
      console.log("💰 Escrow held:", event.data.object.id);
      break;
    case "payment_intent.succeeded":
      console.log("✅ Payment released:", event.data.object.id);
      break;
    case "charge.refunded":
      console.log("↩️ Refund processed:", event.data.object.id);
      break;
    case "payment_intent.payment_failed":
      console.log("❌ Payment failed:", event.data.object.last_payment_error?.message);
      break;
    case "identity.verification_session.verified":
      // ✅ ID verified — mark user as verified in your database
      const verifiedSession = event.data.object;
      console.log("🪪 ID verified for:", verifiedSession.metadata.userId);
      // TODO: update your DB: users.update({ idVerified: true }) where userId = verifiedSession.metadata.userId
      break;
    case "identity.verification_session.requires_input":
      // ❌ Verification failed (blurry photo, expired ID, etc.)
      console.log("❌ ID verification failed:", event.data.object.last_error?.reason);
      break;
    default:
      console.log("Webhook event:", event.type);
  }

  res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Chores API running on port ${PORT}`));
