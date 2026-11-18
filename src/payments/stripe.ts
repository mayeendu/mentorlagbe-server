import Stripe from "stripe";
import { paymentMode } from "../config/payment-mode.js";
import { mockProvider, type FinalStatus, type PaymentProvider } from "./provider.js";

type StripeGateway = Pick<Stripe, "checkout" | "webhooks">;
const purpose = "mentorlagbe_pro";

function sessionStatus(type: string, checkout: Stripe.Checkout.Session): FinalStatus | null {
  if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
    return checkout.status === "complete" && checkout.payment_status === "paid" ? "paid" : null;
  }
  if (checkout.payment_status === "paid") return null;
  if (type === "checkout.session.expired" && checkout.status === "expired") return "canceled";
  if (type === "checkout.session.async_payment_failed") return "failed";
  return null;
}

export function stripeProvider(stripe: StripeGateway, secret: string, testMode: boolean): PaymentProvider {
  const sessionPrefix = testMode ? "cs_test_" : "cs_live_";
  return {
    name: "stripe",
    testMode,
    async open(attempt, origin) {
      const checkout = attempt.stripeSessionId
        ? await stripe.checkout.sessions.retrieve(attempt.stripeSessionId)
        : await stripe.checkout.sessions.create({
          mode: "payment",
          adaptive_pricing: { enabled: false },
          line_items: [{ quantity: 1, price_data: {
            currency: attempt.currency, unit_amount: attempt.amount,
            product_data: { name: attempt.role === "student" ? "MentorLagbe Student Pro" : "MentorLagbe Tutor Pro" },
          } }],
          client_reference_id: attempt.userId,
          metadata: { purpose, attemptId: attempt.attemptId, userId: attempt.userId, role: attempt.role },
          success_url: origin + "/payments/success?session_id={CHECKOUT_SESSION_ID}",
          cancel_url: origin + "/payments/cancel?attempt_id=" + attempt.attemptId,
        }, { idempotencyKey: purpose + "_" + attempt.attemptId });
      if (checkout.livemode !== !testMode || !checkout.id.startsWith(sessionPrefix)) throw new Error("Unexpected Stripe session mode");
      const url = checkout.status === "open" && checkout.url && new URL(checkout.url).origin === "https://checkout.stripe.com"
        ? checkout.url : null;
      return { sessionId: checkout.id, url };
    },
    async cancel(sessionId) {
      const checkout = await stripe.checkout.sessions.retrieve(sessionId);
      if (checkout.livemode !== !testMode || !checkout.id.startsWith(sessionPrefix)) return false;
      if (checkout.status === "open") await stripe.checkout.sessions.expire(checkout.id);
      else if (checkout.status !== "expired") return false;
      return true;
    },
    verifyWebhook(raw, signature) {
      const event = stripe.webhooks.constructEvent(raw, signature, secret);
      const checkout = event.data.object;
      if (event.livemode !== !testMode || checkout.object !== "checkout.session" || checkout.livemode !== !testMode ||
        checkout.mode !== "payment" || checkout.metadata?.purpose !== purpose) return null;
      const status = sessionStatus(event.type, checkout);
      if (!status) return null;
      const { attemptId, userId, role } = checkout.metadata;
      const paymentIntentId = typeof checkout.payment_intent === "string" ? checkout.payment_intent : checkout.payment_intent?.id;
      if (!attemptId || !userId || (role !== "student" && role !== "tutor") ||
        checkout.client_reference_id !== userId || !checkout.id.startsWith(sessionPrefix) ||
        checkout.currency !== "usd" || checkout.amount_total === null || (status === "paid" && !paymentIntentId)) {
        throw new Error("Invalid Stripe payment details");
      }
      return { eventId: event.id, attemptId, userId, role, amount: checkout.amount_total, currency: "usd",
        sessionId: checkout.id, paymentIntentId, status, testMode };
    },
  };
}

export function configurePayments(env = process.env): PaymentProvider | null {
  const mode = paymentMode(env);
  if (mode === "mock") return mockProvider;
  if (mode !== "stripe") return null;

  const testMode = env.NODE_ENV !== "production";
  const key = env.STRIPE_SECRET_KEY;
  const secret = env.STRIPE_WEBHOOK_SECRET;
  const keyPattern = testMode ? /^sk_test_[A-Za-z0-9]{16,}$/ : /^sk_live_[A-Za-z0-9]{16,}$/;
  if (!key || !keyPattern.test(key) || !secret || !/^whsec_[A-Za-z0-9]{16,}$/.test(secret)) return null;
  return stripeProvider(new Stripe(key, { maxNetworkRetries: 2, timeout: 12_000 }), secret, testMode);
}
