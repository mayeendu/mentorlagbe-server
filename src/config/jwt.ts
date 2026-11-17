import { jwt } from "better-auth/plugins";

export const jwtAlgorithm = "EdDSA";

export function apiJwt(baseURL: string) {
  return jwt({
    disableSettingJwtHeader: true,
    jwks: { keyPairConfig: { alg: jwtAlgorithm, crv: "Ed25519" } },
    jwt: {
      issuer: baseURL,
      audience: baseURL,
      expirationTime: "5m",
      definePayload: () => ({}),
    },
  });
}
