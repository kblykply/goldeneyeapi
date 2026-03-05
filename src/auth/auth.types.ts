export type Role = "ADMIN" | "AUTHORITY" | "USER";

export type AuthedUser = {
  id: string;
  fullName: string;
  role: Role;
  level: number;
};