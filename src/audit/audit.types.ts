export interface AuditLogInput {
  action: string;
  entityType: string;
  entityId: string;
  presentationId?: string;
  contractId?: string;
  meta?: Record<string, unknown>;
}

export interface RequestContext {
  actorId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}
