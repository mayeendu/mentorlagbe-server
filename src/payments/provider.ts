export type UpgradeRole = "student" | "tutor";
export type FinalStatus = "paid" | "failed" | "canceled";

export type CheckoutAttempt = {
  attemptId: string;
  userId: string;
  role: UpgradeRole;
  amount: number;
  currency: "usd";
  stripeSessionId?: string;
};

export type StripeReceipt = CheckoutAttempt & {
  eventId: string;
  sessionId: string;
  paymentIntentId?: string;
  status: FinalStatus;
  testMode: boolean;
};

export type PaymentProvider = {
  open(attempt: CheckoutAttempt, origin: string): Promise<{ url: string | null; sessionId?: string }>;
} & (
  | { name: "mock"; testMode: true }
  | {
    name: "stripe";
    testMode: boolean;
    cancel(sessionId: string): Promise<boolean>;
    verifyWebhook(raw: Buffer, signature: string): StripeReceipt | null;
  }
);

export const mockProvider: PaymentProvider = {
  name: "mock",
  testMode: true,
  async open(attempt, origin) {
    return { url: origin + "/payments/mock?attempt_id=" + attempt.attemptId };
  },
};
