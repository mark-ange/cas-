/**
 * Shared types used across the backend and frontend.
 * These mirror the Prisma schema but are kept framework-agnostic.
 */

export enum Role {
  RESIDENT = "RESIDENT",
  WATER_DISPATCHER = "WATER_DISPATCHER",
  POWER_DISPATCHER = "POWER_DISPATCHER",
  ADMIN = "ADMIN",
}

export enum ServiceType {
  WATER = "WATER",
  POWER = "POWER",
}

export enum Priority {
  ROUTINE = "ROUTINE",
  PLANNED = "PLANNED",
  URGENT = "URGENT",
  EMERGENCY = "EMERGENCY",
}

export enum AdvisoryStatus {
  SCHEDULED = "SCHEDULED",
  ACTIVE = "ACTIVE",
  RESOLVED = "RESOLVED",
  CANCELLED = "CANCELLED",
}

export enum NotificationType {
  ADVISORY = "ADVISORY",
  RESTORATION = "RESTORATION",
  CANCELLATION = "CANCELLATION",
}

export enum DeliveryStatus {
  QUEUED = "QUEUED",
  SIMULATED = "SIMULATED",
  FAILED = "FAILED",
}

// Display label maps
export const STATUS_LABELS: Record<AdvisoryStatus, string> = {
  [AdvisoryStatus.SCHEDULED]: "Scheduled",
  [AdvisoryStatus.ACTIVE]: "Active",
  [AdvisoryStatus.RESOLVED]: "Resolved",
  [AdvisoryStatus.CANCELLED]: "Cancelled",
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  [Priority.ROUTINE]: "Routine",
  [Priority.PLANNED]: "Planned",
  [Priority.URGENT]: "Urgent",
  [Priority.EMERGENCY]: "Emergency",
};

export const SERVICE_LABELS: Record<ServiceType, string> = {
  [ServiceType.WATER]: "Water",
  [ServiceType.POWER]: "Power",
};

export const NOTIFICATION_TYPE_LABELS: Record<NotificationType, string> = {
  [NotificationType.ADVISORY]: "Advisory",
  [NotificationType.RESTORATION]: "Restoration Update",
  [NotificationType.CANCELLATION]: "Cancellation Notice",
};

// Valid status transitions: status -> set of allowed next statuses
export const ALLOWED_STATUS_TRANSITIONS: Record<AdvisoryStatus, AdvisoryStatus[]> = {
  [AdvisoryStatus.SCHEDULED]: [AdvisoryStatus.ACTIVE, AdvisoryStatus.CANCELLED],
  [AdvisoryStatus.ACTIVE]: [AdvisoryStatus.RESOLVED, AdvisoryStatus.CANCELLED],
  [AdvisoryStatus.RESOLVED]: [],
  [AdvisoryStatus.CANCELLED]: [],
};

// Permission matrix
export const PERMISSIONS = {
  // Service-specific dispatch roles
  WATER_DISPATCH_ROLES: [Role.WATER_DISPATCHER, Role.ADMIN] as Role[],
  POWER_DISPATCH_ROLES: [Role.POWER_DISPATCHER, Role.ADMIN] as Role[],
  ANY_DISPATCH_ROLES: [Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN] as Role[],
  // Admin-only
  ADMIN_ROLES: [Role.ADMIN] as Role[],
  // Any authenticated user
  ANY_USER_ROLES: [Role.RESIDENT, Role.WATER_DISPATCHER, Role.POWER_DISPATCHER, Role.ADMIN] as Role[],
} as const;

// Philippine phone number regex (shared)
export const PHONE_REGEX = /^(?:\+63|0)9\d{9}$/;
