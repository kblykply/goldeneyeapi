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
