import { createHmac, timingSafeEqual } from "crypto";

// Sunum sonunda satışçının müşteri adına ödeme takip sayfasını OTP'siz açabilmesi
// için kısa ömürlü, HMAC imzalı, stateless token. DB'de saklanmaz.
export interface PortalTokenPayload {
  customerId: string;
  contractId: string;
  expiresAt: number; // epoch ms
}

// İmzalama ve doğrulama tarafı aynı sırrı kullanmak zorunda; fallback kuralı
// token formatının yanında tek yerde durur.
export function getPortalSecret(config: {
  get<T = string>(key: string): T | undefined;
  getOrThrow<T = string>(key: string): T;
}): string {
  return config.get("PORTAL_TOKEN_SECRET") ?? config.getOrThrow("CARD_TOKEN_SECRET");
}

export function createPortalToken(payload: PortalTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyPortalToken(token: string, secret: string): PortalTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as PortalTokenPayload;
    if (!payload.customerId || !payload.contractId) return null;
    if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}
