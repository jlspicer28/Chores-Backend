/**
 * ChoresApp — Complete Stripe Backend + Push Notifications
 * Stack: Node.js + Express
 * Deploy: Render (set env vars in Render dashboard)
 *
 * ENV VARS NEEDED:
 *   STRIPE_SECRET_KEY      — sk_live_...
 *   STRIPE_WEBHOOK_SECRET  — whsec_...  (from Stripe Dashboard > Webhooks)
 *   SUPABASE_URL           — https://xxx.supabase.co
 *   SUPABASE_SERVICE_KEY   — service_role key from Supabase
 *   APNS_KEY_ID            — Key ID from Apple Developer Portal
 *   APNS_TEAM_ID           — Team ID from Apple Developer Portal
 *   APNS_KEY_BASE64        — Base64-encoded .p8 APNs key file contents
 *   APNS_BUNDLE_ID         — com.choresapp.Chores
 *   PORT                   — Render sets this automatically
 */

const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { createClient } = require("@supabase/supabase-js");
const http2 = require("http2");
const crypto = require("crypto");
const app = express();

// Supabase client (for device tokens table)
const supabase = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// ─────────────────────────────────────────────────────────────────────────────
// APNs PUSH NOTIFICATION SENDER (HTTP/2)
// ─────────────────────────────────────────────────────────────────────────────

function createApnsJwt() {
  const keyBase64 = process.env.APNS_KEY_BASE64;
  if (!keyBase64) return null;

  const key = Buffer.from(keyBase64, "base64").toString("utf8");
  const header = Buffer.from(JSON.stringify({
    alg: "ES256",
    kid: process.env.APNS_KEY_ID,
  })).toString("base64url");

  const claims = Buffer.from(JSON.stringify({
    iss: process.env.APNS_TEAM_ID,
    iat: Math.floor(Date.now() / 1000),
  })).toString("base64url");

  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key, "base64url");

  return `${header}.${claims}.${signature}`;
}

async function sendPushNotification(deviceToken, title, body, data = {}) {
  if (!process.env.APNS_KEY_BASE64) {
    console.log("[APNs] Skipping push — APNS_KEY_BASE64 not configured");
    return;
  }

  const jwt = createApnsJwt();
  if (!jwt) return;

  const bundleId = process.env.APNS_BUNDLE_ID || "com.choresapp.Chores";
  const host = process.env.NODE_ENV === "production"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";

  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${host}`);

    const payload = JSON.stringify({
      aps: {
        alert: { title, body },
        sound: "default",
        badge: 1,
      },
      ...data,
    });

    const headers = {
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      "authorization": `bearer ${jwt}`,
      "apns-topic": bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    };

    const req = client.request(headers);
    let responseData = "";

    req.on("response", (headers) => {
      const status = headers[":status"];
      if (status === 200) {
        console.log(`[APNs] Push sent to ${deviceToken.substring(0, 8)}...`);
        resolve(true);
      } else {
        console.log(`[APNs] Push failed: status ${status}`);
      }
    });

    req.on("data", (chunk) => { responseData += chunk; });
    req.on("end", () => {
      client.close();
      if (responseData) {
        try {
          const parsed = JSON.parse(responseData);
          if (parsed.reason) console.log(`[APNs] Error: ${parsed.reason}`);
        } catch {}
      }
      resolve(false);
    });

    req.on("error", (err) => {
      console.log(`[APNs] Request error: ${err.message}`);
      client.close();
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

// Send push to a user by their userId (looks up their device tokens)
async function sendPushToUser(userId, title, body, data = {}) {
  if (!supabase) return;

  const { data: tokens, error } = await supabase
    .from("device_tokens")
    .select("device_token")
    .eq("user_id", userId);

  if (error || !tokens || tokens.length === 0) return;

  for (const row of tokens) {
    await sendPushNotification(row.device_token, title, body, data);
  }
}

// ─── IMPORTANT: Raw body needed for webhook signature verification ────────────
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. CHARGE (Create escrow — funds held, not captured yet)
//    Called when poster books a worker and pays
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/charge", async (req, res) => {
  const { paymentMethodId, amountCents, jobId, jobTitle, posterCustomerId } = req.body;

  try {
    // If poster has a saved Stripe Customer, attach method to them
    // Otherwise create a one-off PaymentIntent
    const intentParams = {
      amount: amountCents,
      currency: "usd",
      payment_method: paymentMethodId,
      confirm: true,
      capture_method: "manual",      // ← KEY: this holds funds without capturing
      metadata: { jobId, jobTitle },
      return_url: "https://yourdomain.com", // required for some card types
    };

    if (posterCustomerId) {
      intentParams.customer = posterCustomerId;
    }

    const intent = await stripe.paymentIntents.create(intentParams);

    // If requires_action (3D Secure), send back client_secret so frontend can handle it
    if (intent.status === "requires_action") {
      return res.json({
        requiresAction: true,
        clientSecret: intent.client_secret,
        intentId: intent.id,
      });
    }

    if (intent.status !== "requires_capture") {
      return res.json({ error: "Payment did not authorize. Please try a different card." });
    }

    res.json({ intentId: intent.id, status: intent.status });
  } catch (err) {
    console.error("Charge error:", err.message);
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. RELEASE (Capture escrow + transfer to worker via Stripe Connect)
//    Called when both parties confirm job completion
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/release", async (req, res) => {
  // intentId — the PaymentIntent ID from /api/charge
  // workerConnectId — the worker's Stripe Connected Account ID (stored in your DB)
  // workerAmountCents — what the worker receives (job amount minus your 8% fee)
  const { intentId, workerConnectId, workerAmountCents } = req.body;

  try {
    // Step 1: Capture the held funds
    const intent = await stripe.paymentIntents.capture(intentId);

    if (intent.status !== "succeeded") {
      return res.json({ error: "Capture failed — payment did not succeed." });
    }

    // Step 2: Transfer worker's cut to their Connected Account
    const transfer = await stripe.transfers.create({
      amount: workerAmountCents,          // e.g. job is $35, fee 8% = $2.80, worker gets $32.20 → 3220
      currency: "usd",
      destination: workerConnectId,       // e.g. "acct_1ABC123..."
      transfer_group: intentId,           // ties the transfer to this job's payment
      metadata: { intentId },
    });

    res.json({ success: true, transferId: transfer.id });
  } catch (err) {
    console.error("Release error:", err.message);
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. REFUND (Cancel escrow and return money to poster)
//    Called on disputes resolved in poster's favor, worker no-shows, etc.
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/refund", async (req, res) => {
  const { intentId, reason } = req.body;
  // reason: "fraudulent" | "duplicate" | "requested_by_customer"

  try {
    // If still in requires_capture state (never captured), just cancel it
    const intent = await stripe.paymentIntents.retrieve(intentId);

    if (intent.status === "requires_capture") {
      await stripe.paymentIntents.cancel(intentId);
      return res.json({ success: true, method: "cancelled" });
    }

    // If already captured, issue a full refund
    const refund = await stripe.refunds.create({
      payment_intent: intentId,
      reason: reason || "requested_by_customer",
    });

    res.json({ success: true, refundId: refund.id, method: "refunded" });
  } catch (err) {
    console.error("Refund error:", err.message);
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. STRIPE CONNECT — Onboard a new worker
//    Call this when a worker signs up and wants to receive payments
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/connect/onboard", async (req, res) => {
  const { workerEmail, workerId } = req.body;

  try {
    // Create a Stripe Express account for this worker
    const account = await stripe.accounts.create({
      type: "express",
      email: workerEmail,
      capabilities: {
        transfers: { requested: true },
      },
      metadata: { workerId },
    });

    // Create a one-time onboarding link (expires after ~10 min)
    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: "https://yourdomain.com/connect/refresh",  // if they need to restart
      return_url:  "https://yourdomain.com/connect/complete", // after they finish
      type: "account_onboarding",
    });

    // ⚠️ IMPORTANT: Save account.id to your database tied to workerId
    // You'll need it for every future transfer
    // e.g. db.workers.update({ id: workerId }, { stripeConnectId: account.id })

    res.json({
      connectId: account.id,
      onboardingUrl: accountLink.url, // Send this URL to the worker — open it in browser
    });
  } catch (err) {
    console.error("Connect onboard error:", err.message);
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. STRIPE CONNECT — Check if worker's account is fully verified
//    Call this before allowing a worker to accept jobs
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/connect/status", async (req, res) => {
  const { connectId } = req.body;

  try {
    const account = await stripe.accounts.retrieve(connectId);

    const isReady =
      account.details_submitted &&
      account.charges_enabled &&
      account.payouts_enabled;

    res.json({
      ready: isReady,
      detailsSubmitted: account.details_submitted,
      chargesEnabled: account.charges_enabled,
      payoutsEnabled: account.payouts_enabled,
      // If not ready, tell the worker what's missing:
      requirements: account.requirements?.currently_due || [],
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. SAVED CARDS — Create or retrieve a Stripe Customer for a poster
//    Call this on poster signup so they can save cards
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/customer/create", async (req, res) => {
  const { email, name, userId } = req.body;

  try {
    const customer = await stripe.customers.create({
      email,
      name,
      metadata: { userId },
    });

    // ⚠️ Save customer.id to your DB tied to userId
    res.json({ customerId: customer.id });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Attach a new card to an existing customer (after they enter card details)
app.post("/api/customer/save-card", async (req, res) => {
  const { customerId, paymentMethodId } = req.body;

  try {
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });

    // Set as default
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);

    res.json({
      success: true,
      card: {
        brand: pm.card.brand,
        last4: pm.card.last4,
        expMonth: pm.card.exp_month,
        expYear: pm.card.exp_year,
      },
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// List a customer's saved cards
app.post("/api/customer/cards", async (req, res) => {
  const { customerId } = req.body;

  try {
    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    const cards = paymentMethods.data.map((pm) => ({
      id: pm.id,
      brand: pm.card.brand,
      last4: pm.card.last4,
      expMonth: pm.card.exp_month,
      expYear: pm.card.exp_year,
    }));

    res.json({ cards });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. AUTO-RELEASE CRON — Release escrow after 48hrs with no dispute
//    Call this endpoint from a Railway cron job every hour
//    In Railway: add a Cron Job service, set schedule "0 * * * *", command:
//    curl -X POST https://your-backend.railway.app/api/cron/auto-release
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/cron/auto-release", async (req, res) => {
  // ⚠️ In production, protect this with a secret header:
  // if (req.headers["x-cron-secret"] !== process.env.CRON_SECRET) return res.sendStatus(401);

  try {
    // Fetch all PaymentIntents still in requires_capture
    // that were created more than 48 hours ago
    const fortyEightHoursAgo = Math.floor(Date.now() / 1000) - 48 * 60 * 60;

    const intents = await stripe.paymentIntents.list({
      limit: 100,
      created: { lte: fortyEightHoursAgo },
    });

    const toRelease = intents.data.filter(
      (i) => i.status === "requires_capture"
    );

    const results = [];

    for (const intent of toRelease) {
      try {
        // Check metadata for worker info — you'd store this when creating the intent
        const workerConnectId = intent.metadata.workerConnectId;
        const workerAmountCents = parseInt(intent.metadata.workerAmountCents);

        // Capture
        await stripe.paymentIntents.capture(intent.id);

        // Transfer to worker if we have their Connect ID
        if (workerConnectId && workerAmountCents) {
          await stripe.transfers.create({
            amount: workerAmountCents,
            currency: "usd",
            destination: workerConnectId,
            transfer_group: intent.id,
          });
        }

        results.push({ id: intent.id, status: "released" });
      } catch (err) {
        results.push({ id: intent.id, status: "error", error: err.message });
      }
    }

    res.json({ processed: results.length, results });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. WEBHOOKS — Stripe calls this URL when async events happen
//    Set this URL in Stripe Dashboard → Developers → Webhooks:
//    https://your-backend.railway.app/api/webhook
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,                             // must be raw Buffer, NOT parsed JSON
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature failed:", err.message);
    return res.sendStatus(400);
  }

  switch (event.type) {

    // ── Payment held successfully in escrow ───────────────────────────────────
    case "payment_intent.amount_capturable_updated": {
      const intent = event.data.object;
      console.log(`✅ Escrow live: ${intent.id} — $${intent.amount / 100}`);
      // TODO: update your DB escrow record to status="held"
      // TODO: push notification to worker that job is funded
      break;
    }

    // ── Payment failed (card declined, etc.) ─────────────────────────────────
    case "payment_intent.payment_failed": {
      const intent = event.data.object;
      const reason = intent.last_payment_error?.message || "Unknown error";
      console.log(`❌ Payment failed: ${intent.id} — ${reason}`);
      // TODO: update your DB record
      // TODO: notify poster their payment failed, job is unbooked
      break;
    }

    // ── Worker's Connect account was updated (verified, restricted, etc.) ─────
    case "account.updated": {
      const account = event.data.object;
      const isReady = account.charges_enabled && account.payouts_enabled;
      console.log(`🔄 Connect account updated: ${account.id} — ready: ${isReady}`);
      // TODO: update worker's "payoutReady" field in your DB
      // TODO: if newly ready, notify worker they can now accept jobs
      break;
    }

    // ── Transfer to worker failed ─────────────────────────────────────────────
    case "transfer.failed": {
      const transfer = event.data.object;
      console.log(`⚠️ Transfer failed: ${transfer.id} to ${transfer.destination}`);
      // TODO: flag in your DB, notify admin, possibly hold funds and retry
      break;
    }

    // ── Payout to worker's bank failed ────────────────────────────────────────
    case "payout.failed": {
      const payout = event.data.object;
      console.log(`⚠️ Payout failed: ${payout.id} — ${payout.failure_message}`);
      // TODO: notify worker to update their bank info in Stripe Express dashboard
      break;
    }

    // ── Refund completed ─────────────────────────────────────────────────────
    case "charge.refunded": {
      const charge = event.data.object;
      console.log(`💸 Refund complete: charge ${charge.id}`);
      // TODO: update escrow record to status="refunded", notify poster
      break;
    }

    default:
      // Ignore unhandled event types
      break;
  }

  res.sendStatus(200); // Always return 200 quickly or Stripe will retry
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. EMAIL VERIFICATION (already exists on your backend, included for reference)
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/verify/email/send  — send a 6-digit code to user's email
// POST /api/verify/email/check — verify the code

// ─────────────────────────────────────────────────────────────────────────────
// 10. IDENTITY VERIFICATION (Stripe Identity)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/api/verify/identity/start", async (req, res) => {
  try {
    const session = await stripe.identity.verificationSessions.create({
      type: "document",
      metadata: { userId: req.body.userId },
      options: {
        document: {
          allowed_types: ["driving_license", "passport", "id_card"],
          require_id_number: true,
          require_live_capture: true,
          require_matching_selfie: true,
        },
      },
    });

    // Send client_secret to frontend — it opens Stripe's identity flow
    res.json({ clientSecret: session.client_secret, sessionId: session.id });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.post("/api/verify/identity/check", async (req, res) => {
  const { sessionId } = req.body;

  try {
    const session = await stripe.identity.verificationSessions.retrieve(sessionId);

    res.json({
      status: session.status,              // "verified" | "processing" | "requires_input"
      verified: session.status === "verified",
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUSH NOTIFICATIONS — Device Token Registration
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/push/register", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.json({ error: "No token provided" });

  const { deviceToken, platform } = req.body;
  if (!deviceToken) return res.json({ error: "deviceToken required" });

  if (!supabase) return res.json({ error: "Database not configured" });

  try {
    // Decode JWT to get user ID
    const jwt = authHeader.replace("Bearer ", "");
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    const userId = payload.sub;

    // Upsert device token (avoid duplicates)
    const { error } = await supabase
      .from("device_tokens")
      .upsert(
        {
          user_id: userId,
          device_token: deviceToken,
          platform: platform || "ios",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "device_token" }
      );

    if (error) {
      console.log("[Push] Token registration error:", error.message);
      return res.json({ error: error.message });
    }

    console.log(`[Push] Token registered for user ${userId.substring(0, 8)}...`);
    res.json({ success: true });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// Test push endpoint (for development)
app.post("/api/push/test", async (req, res) => {
  const { userId, title, body } = req.body;
  if (!userId) return res.json({ error: "userId required" });

  await sendPushToUser(userId, title || "Test", body || "This is a test push notification", { type: "test" });
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ChoresApp backend running on port ${PORT}`));
