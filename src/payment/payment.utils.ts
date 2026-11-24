// Kart numarası işleyen yardımcılar (kart token şifreleme, MPI hash, kart markası)
// 24.11.2026'da kaldırıldı: sistem artık kart bilgisi almıyor. Kalanlar tutar ve
// XML yardımcılarıdır; PayFlex Ortak Ödeme Sayfası entegrasyonunda kullanılacak.
import { XMLParser, XMLBuilder } from 'fast-xml-parser';

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

export function parseXmlResponse(xml: string): Record<string, any> {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
  return parser.parse(xml) as Record<string, any>;
}

export function buildXmlBody(rootTag: string, fields: Record<string, string>): string {
  const builder = new XMLBuilder({ ignoreAttributes: false });
  return `<?xml version="1.0" encoding="utf-8"?>${builder.build({ [rootTag]: fields })}`;
}
