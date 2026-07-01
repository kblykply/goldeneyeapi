export interface EnrollmentParams {
  pan: string;
  expiryYYMM: string; // YYMM format, e.g. "2603"
  amountCents: number;
  mpiTransactionId: string; // VerifyEnrollmentRequestId — our UUID
  cardholderName: string;
}

export interface EnrollmentResult {
  status: 'Y' | 'N' | 'U' | 'E';
  acsUrl?: string;
  pareq?: string;
  md?: string;
  termUrl?: string; // MPI's own TermUrl — must be used in ACS form, NOT our callback URL
  errorCode?: string;
  errorMessage?: string;
}

export interface VposParams {
  pan: string;
  expiryYYMM: string; // YYMM format
  amountCents: number;
  cvv?: string; // Temporarily stored in encrypted cardToken; cleared after VPos
  eci: string;  // 05/06/07 for VISA; 02/01 for MC
  cavv: string; // Empty string when not applicable (MC + Status A per doc section 5.7)
  mpiTransactionId: string;
  clientIp: string;
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
