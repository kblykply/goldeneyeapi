import * as crypto from 'crypto';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import type { MpiHashParams } from './payment.types';

const CIPHER = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}

export function encryptCardToken(pan: string, expiry: string, secret: string, cvv?: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(CIPHER, key, iv) as crypto.CipherGCM;
  const payload = JSON.stringify({ pan, expiry, ...(cvv ? { cvv } : {}) });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptCardToken(token: string, secret: string): { pan: string; expiry: string; cvv?: string } {
  const key = deriveKey(secret);
  const buf = Buffer.from(token, 'base64');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  return JSON.parse(decrypted) as { pan: string; expiry: string; cvv?: string };
}

export function calculateMpiHash(params: MpiHashParams): string {
  const raw = [
    params.verifyEnrollmentRequestId,
    params.merchantId,
    params.currencyCode,
    params.amount,
    params.eci,
    params.cavv,
    params.mdStatus,
    params.paresStatus,
    params.mpiPassword,
  ].join('');

  return crypto
    .createHash('sha256')
    .update(Buffer.from(raw, 'latin1'))
    .digest('base64');
}

export function formatExpiryForVpos(yymm: string): string {
  return `20${yymm.substring(0, 2)}${yymm.substring(2)}`;
}

export function centsToDecimalString(cents: number): string {
  return (cents / 100).toFixed(2);
}

// Banka/ACS bazı sürümlerde tutarı TR locale ("1.234,56") formatında echo'layabilir;
// Number() bunu doğrudan parse edemez (virgül nedeniyle NaN döner) ve her seferinde
// yanlışlıkla AMOUNT_MISMATCH tetiklenir. Bu yüzden ayırıcılar normalize edilir.
export function parseLocaleAmount(raw: string): number {
  const trimmed = raw.trim();
  const hasComma = trimmed.includes(',');
  const hasDot = trimmed.includes('.');
  let normalized = trimmed;
  if (hasComma && hasDot) {
    normalized =
      trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')
        ? trimmed.replace(/\./g, '').replace(',', '.')
        : trimmed.replace(/,/g, '');
  } else if (hasComma) {
    normalized = trimmed.replace(',', '.');
  }
  return Number(normalized);
}

// Callback'te echo'lanan tutarı bekleneni ile karşılaştırır. Doğrulanmış gerçek örnek
// (bkz. destek kaydı): ACS PurchAmount'ı ondalıksız, ana para biriminin küsuratı atılmış
// tam sayısı olarak echo'luyor (100.50 EUR için "100" döner) — dokümanda bu format hiç
// belirtilmiyordu. Ayrıca TR locale ondalık ("1.234,56") ve küçük birim tam sayı
// ("10000") formatları da olası olduğundan hepsi denenir.
export function amountMatchesExpected(echoedAmount: string, amountCents: number): boolean {
  const expectedDecimal = amountCents / 100;
  const parsedDecimal = parseLocaleAmount(echoedAmount);
  if (Number.isFinite(parsedDecimal)) {
    if (Math.abs(parsedDecimal - expectedDecimal) < 0.005) {
      return true;
    }
    // Ondalık ayraç yoksa (örn. "100"), ACS küsuratı atmış olabilir — tam sayı kısmı
    // (trunc) veya en yakın tam sayıya (round) eşitse kabul et.
    const hasFraction = /[.,]/.test(echoedAmount.trim());
    if (
      !hasFraction &&
      (parsedDecimal === Math.trunc(expectedDecimal) || parsedDecimal === Math.round(expectedDecimal))
    ) {
      return true;
    }
  }

  const digitsOnly = echoedAmount.replace(/[^\d]/g, '');
  if (digitsOnly && Number(digitsOnly) === amountCents) {
    return true;
  }

  return false;
}

export function detectBrandName(pan: string): '100' | '200' {
  return pan.trim().startsWith('4') ? '100' : '200';
}

export function detectBrand(pan: string): 'VISA' | 'MC' {
  return pan.trim().startsWith('4') ? 'VISA' : 'MC';
}

export function parseXmlResponse(xml: string): Record<string, any> {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  return parser.parse(xml) as Record<string, any>;
}

export function buildXmlBody(rootTag: string, fields: Record<string, string>): string {
  const builder = new XMLBuilder({ ignoreAttributes: false });
  return `<?xml version="1.0" encoding="utf-8"?>${builder.build({ [rootTag]: fields })}`;
}
