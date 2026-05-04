export type Role = "ADMIN" | "REGIONAL_MANAGER" | "REGIONAL_LEADER" | "AGENCY" | "SPECIAL" | "AUTHORITY" | "USER" | "PANELUSER";

export type AuthedUser = {
  id: string;
  fullName: string;
  role: Role;
  level: number;
};