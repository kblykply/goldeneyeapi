export type Role = "ADMIN" | "REGIONAL_MANAGER" | "AUTHORITY" | "USER";

export type AuthedUser = {
  id: string;
  fullName: string;
  role: Role;
  level: number;
};