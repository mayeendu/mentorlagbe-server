export function paymentMode(env = process.env) {
  const mode = env.PAYMENT_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "mock" && mode !== "stripe") throw new Error("Invalid PAYMENT_MODE");
  if (mode === "mock" && env.NODE_ENV === "production") throw new Error("Mock payments cannot run in production");
  return mode;
}

export function paymentDatabase(env = process.env) {
  const mode = paymentMode(env);
  if (mode === "mock") return "mentorlagbe_mock";
  if (mode === "stripe" && env.NODE_ENV !== "production") return "mentorlagbe_stripe_test";
  return "mentorlagbe";
}
