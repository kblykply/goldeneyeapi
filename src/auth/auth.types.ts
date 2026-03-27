export type Role = "ADMIN" | "REGIONAL_MANAGER" | "REGIONAL_LEADER" | "AGENCY" | "SPECIAL" | "AUTHORITY" | "USER";

export type AuthedUser = {
  id: string;
  fullName: string;
  role: Role;
  level: number;
};