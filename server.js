const express = require("express");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "Chores API running ✅" }));

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
      // Funds are held and ready to capture
      console.log("💰 Escrow held:", event.data.object.id);
      break;
    case "payment_intent.succeeded":
      // Money has moved — job payment released
      console.log("✅ Payment released:", event.data.object.id);
      break;
    case "charge.refunded":
      // Refund went through
      console.log("↩️ Refund processed:", event.data.object.id);
      break;
    case "payment_intent.payment_failed":
      // Card declined
      console.log("❌ Payment failed:", event.data.object.last_payment_error?.message);
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
