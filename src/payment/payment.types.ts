export interface EnrollmentParams {
  pan: string;
  expiryYYMM: string;
  amountCents: number;
  mpiTransactionId: string;
  cardholderName: string;
  locale?: string;
  // Banka mesaj log'unu işleme bağlamak için (kanıt/mutabakat)
  posTransactionId?: string;
  contractId?: string;
}

export interface EnrollmentResult {
  status: 'Y' | 'N' | 'U' | 'E';
  acsUrl?: string;
  pareq?: string;
  md?: string;
  termUrl?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface VposParams {
  pan: string;
  expiryYYMM: string;
  amountCents: number;
  cvv?: string;
  eci: string;
  cavv: string;
  clientIp: string;
  mpiTransactionId: string;
  // Banka mesaj log'unu işleme bağlamak için (kanıt/mutabakat)
  posTransactionId?: string;
  contractId?: string;
}

export interface VposResult {
  approved: boolean;
  responseCode: string;
  responseText: string;
  hostReference?: string;
}

export interface MpiHashParams {
  verifyEnrollmentRequestId: string;
  merchantId: string;
  currencyCode: string;
  amount: string;
  eci: string;
  cavv: string;
  mdStatus: string;
  paresStatus: string;
  mpiPassword: string;
}
