import { createHmac, timingSafeEqual } from "crypto";

// Kısa ömürlü, HMAC imzalı, stateless portal token'ı — DB'de saklanmaz.
//   LINK    : sunum sonunda/WhatsApp ile paylaşılan, OTP'siz giriş sağlayan tek
//             sözleşmelik bağlantı (contractId zorunlu).
//   SESSION : giriş yapmış müşterinin verisini tazelemesi için (contractId
//             opsiyoneldir; LINK ile girildiyse o sözleşme listede kalsın diye taşınır).
// Amaç ayrımı, giriş bağlantısının veri uçlarında serbestçe kullanılmasını engeller.
export type PortalTokenPurpose = "LINK" | "SESSION";

// Üretim tarafı: amaç zorunlu ve LINK daima bir sözleşmeye bağlı — etiketsiz
// token basmak derleme zamanında engellenir.
export type PortalTokenInput = { customerId: string; expiresAt: number } & (
  | { purpose: "LINK"; contractId: string }
  | { purpose: "SESSION"; contractId?: string }
);

// Çözümleme tarafı: gövde dışarıdan geldiği için her alan şüphelidir
export interface PortalTokenPayload {
  customerId: string;
  contractId?: string;
  purpose?: PortalTokenPurpose;
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

export function createPortalToken(payload: PortalTokenInput, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

// expectedPurpose ZORUNLUDUR: her doğrulayan neyi kabul ettiğini açıkça yazar.
// Varsayılan bırakılsaydı, parametreyi unutan yeni bir uç giriş bağlantısını
// sessizce kabul ederdi — amaç ayrımının tam olarak engellediği şey.
export function verifyPortalToken(
  token: string,
  secret: string,
  expectedPurpose: PortalTokenPurpose,
): PortalTokenPayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as PortalTokenPayload;
    if (!payload.customerId) return null;
    // `?? "LINK"`: bu alan eklenmeden önce basılmış token'lar için. En uzun LINK
    // ömrü 24 saat olduğundan, deploy'dan 24 saat sonra silinebilir.
    if ((payload.purpose ?? "LINK") !== expectedPurpose) return null;
    // LINK token'ı daima bir sözleşmeye bağlıdır; SESSION için opsiyonel
    if (expectedPurpose === "LINK" && !payload.contractId) return null;
    if (typeof payload.expiresAt !== "number" || Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}
