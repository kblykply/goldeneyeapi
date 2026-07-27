// Bankaya giden/gelen mesajlar mutabakat kanıtı olarak saklanır; ancak ham
// gövdede kart numarası, son kullanma, CVV ve üye işyeri şifresi geçer.
// PCI DSS gereği bunlar ASLA kalıcı yazılamaz (CVV hiçbir koşulda, PAN yalnızca
// maskeli). Bu dosya, gövdeyi veritabanına yazmadan önce tek geçişte temizler.
//
// Maskeleme kalıcı yazımdan önceki son adımdır: yeni bir hassas alan eklenirse
// önce buradaki listeye eklenmelidir.

// Tam gizlenir — değeri hiçbir şekilde saklanmaz
const REDACT_FIELDS = [
  "Password",
  "MerchantPassword",
  "MpiPassword",
  "Cvv",
  "Cvv2",
  "CVV",
  "CVV2",
  "CardCvv",
  "Expiry",
  "ExpiryDate",
  "cardExpiry",
  "cardCvv",
];

// Yalnızca ilk 6 + son 4 hane saklanır (PCI DSS'in izin verdiği azami bilgi)
const PAN_FIELDS = ["Pan", "PAN", "CardNumber", "cardNumber"];

// Uzun base64 bloklar — mutabakat için gerekmez, satır boyutunu şişirir
const TRUNCATE_FIELDS = ["PaReq", "PARes", "MD"];
const TRUNCATE_AT = 120;

const REDACTED = "***";

export function maskPan(pan: string): string {
  // Zaten maskelenmiş değeri tekrar maskeleme — yıldızları sayı sanıp
  // uzunluk bilgisini bozmasın (idempotent)
  if (pan.includes("*")) return pan;
  const digits = pan.replace(/\D/g, "");
  if (digits.length < 10) return REDACTED;
  return `${digits.slice(0, 6)}${"*".repeat(digits.length - 10)}${digits.slice(-4)}`;
}

function truncate(value: string): string {
  return value.length <= TRUNCATE_AT ? value : `${value.slice(0, TRUNCATE_AT)}…[${value.length}]`;
}

// XML (<Tag>değer</Tag>) ve form-urlencoded (Alan=değer) gövdelerin ikisini de
// aynı alan listesiyle temizler. Maskeleme hiçbir koşulda hata fırlatmamalı —
// log yazımı ödeme akışını bozamaz; sorun olursa gövde tümüyle gizlenir.
export function maskBankPayload(body: string): string {
  if (!body) return "";

  try {
    let out = body;

    const apply = (fields: string[], transform: (value: string) => string) => {
      // Regex'ler case-insensitive; aynı alanın büyük/küçük harf varyantları
      // ("Pan" ve "PAN") tekilleştirilmezse değer iki kez maskelenir
      for (const field of [...new Map(fields.map((f) => [f.toLowerCase(), f])).values()]) {
        // XML: <Pan>123</Pan>
        out = out.replace(
          new RegExp(`(<${field}>)([^<]*)(</${field}>)`, "gi"),
          (_m, open, value, close) => `${open}${transform(value)}${close}`,
        );
        // form-urlencoded: Pan=123&...
        out = out.replace(
          new RegExp(`(^|&)(${field})=([^&]*)`, "gi"),
          (_m, sep, name, value) =>
            `${sep}${name}=${transform(decodeURIComponent(value.replace(/\+/g, " ")))}`,
        );
      }
    };

    apply(REDACT_FIELDS, () => REDACTED);
    apply(PAN_FIELDS, maskPan);
    apply(TRUNCATE_FIELDS, truncate);

    return out;
  } catch {
    return "[MASKELEME HATASI — gövde saklanmadı]";
  }
}
