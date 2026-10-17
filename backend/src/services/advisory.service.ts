import type { Priority, ServiceType } from "@prisma/client";
import crypto from "node:crypto";
import prisma from "../utils/prisma.js";
import logger from "../utils/logger.js";
import { logActivity } from "./activityLog.service.js";
import { getRecipientsForAdvisory, type AdvisoryTargetInput } from "./recipient.service.js";
import { simulateBulkSms, formatAdvisoryMessage, formatStatusMessage, type SmsRecipient, type SmsMessage } from "./smsSimulator.service.js";
import { AppError, BadRequestError, ForbiddenError, NotFoundError } from "../utils/appError.js";
import { checkServicePermission } from "../middleware/servicePermission.js";
import { ALLOWED_STATUS_TRANSITIONS } from "../types/index.js";
import type { AuthenticatedUser } from "../middleware/auth.js";

export interface CreateAdvisoryPayload {
  serviceType: ServiceType;
  priority: Priority;
  title: string;
  reason?: string;
  message: string;
  startAt: string;
  endAt?: string | null;
  targets: Array<{
    barangayId: string;
    purokIds?: string[];
  }>;
}

export interface AdvisoryWithTargets {
  id: string;
  serviceType: string;
  priority: string;
  title: string;
  reason: string | null;
  message: string;
  startAt: Date;
  endAt: Date | null;
  status: string;
  createdBy: { id: string; fullName: string; email: string };
  publishedAt: Date | null;
  canceledAt: Date | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  targets: Array<{
    id: string;
    barangayId: string;
    barangayName: string;
    purokId: string | null;
    purokName: string | null;
  }>;
  recipientCount: number;
}

export interface AdvisoryPreview {
  previewId: string;
  serviceType: string;
  priority: string;
  title: string;
  reason: string | null;
  message: string;
  startAt: Date;
  endAt: Date | null;
  targets: Array<{
    barangayId: string;
    purokIds?: string[];
  }>;
  estimatedRecipients: number;
  status: string;
  messagePreview: string;
}

/**
 * Create an advisory draft (preview). Validates the payload and estimates
 * the number of recipients who will receive SMS notifications.
 */
export async function createAdvisoryDraft(
  payload: CreateAdvisoryPayload,
  currentUser: AuthenticatedUser
): Promise<AdvisoryPreview> {
  const serviceType = payload.serviceType as string;

  // Permission check for dispatchers
  if (["WATER_DISPATCHER", "POWER_DISPATCHER"].includes(currentUser.role)) {
    if (!checkServicePermission(currentUser.role, serviceType)) {
      throw new ForbiddenError(
        `You do not have permission to create ${serviceType.toLowerCase()} advisories`
      );
    }
  }

  // Validate start time is in the future
  const startAt = new Date(payload.startAt);
  if (startAt < new Date()) {
    throw new BadRequestError("Start time must be in the future");
  }

  // Validate end time is after start time
  if (payload.endAt) {
    const endAt = new Date(payload.endAt);
    if (endAt <= startAt) {
      throw new BadRequestError("End time must be after start time");
    }
  }

  // Estimate recipients
  const targetInputs: AdvisoryTargetInput[] = payload.targets;
  const estimatedCount = await getEstimatedCount(targetInputs, serviceType);

  // Generate a preview ID for the draft
  const previewId = crypto.randomUUID();

  // Build a message preview (sample)
  const barangayName = "";
  const purokName = null;
  const messagePreview = formatAdvisoryMessage(
    payload.title,
    serviceType,
    startAt,
    payload.endAt ? new Date(payload.endAt) : null,
    barangayName,
    purokName,
    payload.priority as string
  );

  return {
    previewId,
    serviceType,
    priority: payload.priority as string,
    title: payload.title,
    reason: payload.reason ?? null,
    message: payload.message,
    startAt,
    endAt: payload.endAt ? new Date(payload.endAt) : null,
    targets: payload.targets,
    estimatedRecipients: estimatedCount,
    status: "SCHEDULED",
    messagePreview,
  };
}

async function getEstimatedCount(
  targets: AdvisoryTargetInput[],
  serviceType: string
): Promise<number> {
  try {
    const recipients = await getRecipientsForAdvisory(
      targets,
      serviceType as "WATER" | "POWER"
    );
    return recipients.length;
  } catch (error) {
    logger.error("Failed to estimate recipients", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

/**
 * Publish an advisory draft — creates the Advisory record and its targets
 * in the database, then sends simulated SMS notifications to all recipients.
 */
export async function publishAdvisory(
  draft: AdvisoryPreview,
  currentUser: AuthenticatedUser
): Promise<AdvisoryWithTargets> {
  const serviceType = draft.serviceType as ServiceType;

  // Permission check
  if (["WATER_DISPATCHER", "POWER_DISPATCHER"].includes(currentUser.role)) {
    if (!checkServicePermission(currentUser.role, draft.serviceType)) {
      throw new ForbiddenError(
        `You do not have permission to publish ${draft.serviceType.toLowerCase()} advisories`
      );
    }
  }

  const startAt = new Date(draft.startAt);
  const endAt = draft.endAt ? new Date(draft.endAt) : null;

  // Determine initial status
  const now = new Date();
  const initialStatus = startAt <= now ? "ACTIVE" : "SCHEDULED";

  // Build target create operations
  const targetCreates: any[] = [];
  for (const target of draft.targets) {
    if (target.purokIds && target.purokIds.length > 0) {
      for (const purokId of target.purokIds) {
        targetCreates.push({ barangayId: target.barangayId, purokId });
      }
    } else {
      targetCreates.push({ barangayId: target.barangayId, purokId: null });
    }
  }

  const advisory = await prisma.advisory.create({
    data: {
      serviceType,
      priority: draft.priority as Priority,
      title: draft.title,
      reason: draft.reason,
      message: draft.message,
      startAt,
      endAt,
      status: initialStatus as any,
      publishedAt: now,
      createdById: currentUser.id,
      targets: { create: targetCreates },
    },
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      targets: true,
    },
  });

  // Get recipients and send SMS notifications
  const recipients = await getRecipientsForAdvisory(
    draft.targets,
    draft.serviceType as "WATER" | "POWER"
  );

  await sendAdvisoryNotifications(advisory.id, recipients, draft, serviceType as string);

  await logActivity({
    actorId: currentUser.id,
    action: "advisory_published",
    entityType: "advisory",
    entityId: advisory.id,
    metadata: {
      title: draft.title,
      serviceType: serviceType,
      priority: draft.priority,
      recipientCount: recipients.length,
      status: initialStatus,
    },
  });

  logger.info("Advisory published", {
    advisoryId: advisory.id,
    title: draft.title,
    recipients: recipients.length,
    status: initialStatus,
  });

      const fullAdvisory = await getFullAdvisory(advisory.id);
  return mapAdvisoryWithTargets(fullAdvisory, recipients.length);
}

/**
 * Send simulated SMS notifications for a newly published advisory.
 */
async function sendAdvisoryNotifications(
  advisoryId: string,
  recipients: any[],
  draft: AdvisoryPreview,
  _serviceType: string
): Promise<void> {
  if (recipients.length === 0) return;

  const smsRecipients: SmsRecipient[] = recipients.map((r) => ({
    userId: r.userId,
    phoneNumber: r.phoneNumber,
    fullName: r.fullName,
    barangay: r.barangay,
    purok: r.purok,
  }));

  const smsBody =
    draft.message.length <= 160
      ? draft.message
      : draft.message.substring(0, 157) + "...";

  const smsMessage: SmsMessage = { to: "", body: smsBody, type: "ADVISORY" };
  const results = await simulateBulkSms(smsRecipients, smsMessage);

  const notifications: any[] = [];
  for (let i = 0; i < recipients.length; i++) {
    const recip = recipients[i];
    const result = results[i]!;
    notifications.push({
      advisoryId,
      userId: recip.userId,
      phoneNumber: result.phoneNumber,
      messageContent: result.messageContent,
      notificationType: "ADVISORY",
      deliveryStatus: result.deliveryStatus as any,
      deliveredAt: result.deliveredAt,
    });
  }

  await prisma.notification.createMany({ data: notifications });
}

/**
 * Fetch a fully-populated advisory record from the database.
 */
async function getFullAdvisory(id: string): Promise<any> {
  return prisma.advisory.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      targets: {
        include: {
          barangay: { select: { name: true } },
          purok: { select: { name: true } },
        },
      },
    },
  });
}

/**
 * Map a Prisma advisory to the AdvisoryWithTargets DTO.
 */
function mapAdvisoryWithTargets(advisory: any, recipientCount: number): AdvisoryWithTargets {
  return {
    id: advisory.id,
    serviceType: advisory.serviceType,
    priority: advisory.priority,
    title: advisory.title,
    reason: advisory.reason,
    message: advisory.message,
    startAt: advisory.startAt,
    endAt: advisory.endAt,
    status: advisory.status,
    createdBy: advisory.createdBy
      ? { id: advisory.createdBy.id, fullName: advisory.createdBy.fullName, email: advisory.createdBy.email }
      : { id: "", fullName: "", email: "" },
    publishedAt: advisory.publishedAt,
    canceledAt: advisory.canceledAt,
    cancellationReason: advisory.cancellationReason,
    createdAt: advisory.createdAt,
    updatedAt: advisory.updatedAt,
    targets: advisory.targets
      ? advisory.targets.map((t: any) => ({
          id: t.id,
          barangayId: t.barangayId,
          barangayName: t.barangay?.name ?? "",
          purokId: t.purokId ?? null,
          purokName: t.purok?.name ?? null,
        }))
      : [],
        recipientCount,
  };
}

// ============================================================================
// PUBLIC API — Query operations
// ============================================================================

/**
 * Get an advisory by ID, with permission checks.
 */
export async function getAdvisoryById(
  id: string,
  currentUser: AuthenticatedUser
): Promise<AdvisoryWithTargets> {
  const advisory = await getFullAdvisory(id);
  if (!advisory) throw new NotFoundError("Advisory not found");

  if (currentUser.role !== "ADMIN" && advisory.createdById !== currentUser.id) {
    throw new ForbiddenError("You do not have permission to view this advisory");
  }

  return mapAdvisoryWithTargets(advisory, 0);
}

/**
 * List advisories with optional filters.
 */
export async function listAdvisories(params: {
  serviceType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{ data: AdvisoryWithTargets[]; total: number }> {
  const where: any = {};

  if (params.serviceType) where.serviceType = params.serviceType;
  if (params.status) where.status = params.status;

  if (params.dateFrom || params.dateTo) {
    where.startAt = {};
    if (params.dateFrom) where.startAt.gte = new Date(params.dateFrom);
    if (params.dateTo) where.startAt.lte = new Date(params.dateTo);
  }

    if (params.search) {
    where.OR = [
      { title: { contains: params.search } },
      { message: { contains: params.search } },
      { reason: { contains: params.search } },
        ];
  }

  const [data, total] = await Promise.all([
    prisma.advisory.findMany({
      where,
      orderBy: { startAt: "desc" },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
      include: { createdBy: true, targets: true },
    }),
    prisma.advisory.count({ where }),
  ]);

  return {
    data: data.map((a) => mapAdvisoryWithTargets(a, 0)),
    total,
  };
}

// ============================================================================
// PUBLIC API — Status management
// ============================================================================

/**
 * Transition an advisory to a new status, enforcing valid transitions.
 * Automatically generates restoration/cancellation notifications.
 */
export async function updateAdvisoryStatus(
  id: string,
  status: string,
  currentUser: AuthenticatedUser,
  reason?: string
): Promise<AdvisoryWithTargets> {
  const advisory = await getFullAdvisory(id);
  if (!advisory) throw new NotFoundError("Advisory not found");

  // Permission check — only dispatchers/admin can change status
  if (!["WATER_DISPATCHER", "POWER_DISPATCHER", "ADMIN"].includes(currentUser.role)) {
    throw new ForbiddenError("Only dispatchers can update advisory status");
  }

  if (!checkServicePermission(currentUser.role, advisory.serviceType)) {
    throw new ForbiddenError(
      `You do not have permission to modify ${advisory.serviceType.toLowerCase()} advisories`
    );
  }

  const currentStatus = advisory.status as string;

  if (!isAllowedTransition(currentStatus, status)) {
    throw new BadRequestError(
      `Cannot transition advisory from ${currentStatus} to ${status}`
    );
  }

  const updateData: any = {
    status: status as any,
    updatedAt: new Date(),
  };

  if (status === "CANCELLED") {
    updateData.canceledAt = new Date();
    updateData.cancellationReason = reason;
  }

  if (status === "ACTIVE" && !advisory.publishedAt) {
    updateData.publishedAt = new Date();
  }

  const updated = await prisma.advisory.update({
    where: { id },
    data: updateData,
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      targets: {
        include: {
          barangay: { select: { name: true } },
          purok: { select: { name: true } },
        },
      },
    },
  });

  await generateStatusNotifications(updated, currentUser, status, reason);

  await logActivity({
    actorId: currentUser.id,
    action: `advisory_${status.toLowerCase()}`,
    entityType: "advisory",
    entityId: id,
    metadata: { from: currentStatus, to: status, reason: reason ?? null },
  });

  logger.info("Advisory status updated", {
    advisoryId: id,
    from: currentStatus,
    to: status,
    by: currentUser.id,
  });

  return mapAdvisoryWithTargets(updated, 0);
}

function isAllowedTransition(current: string, next: string): boolean {
  const allowed = ALLOWED_STATUS_TRANSITIONS[current as keyof typeof ALLOWED_STATUS_TRANSITIONS];
  return allowed ? allowed.includes(next as any) : false;
}

/**
 * Generate restoration/cancellation notifications for all recipients of an advisory.
 */
async function generateStatusNotifications(
  advisory: any,
  _currentUser: AuthenticatedUser,
  newStatus: string,
  reason?: string
): Promise<void> {
  // Only generate notifications for RESOLVED or CANCELLED
  if (newStatus !== "RESOLVED" && newStatus !== "CANCELLED") return;

  // Find all recipients who received the original advisory notification
  const originalNotifications = await prisma.notification.findMany({
    where: {
      advisoryId: advisory.id,
      notificationType: "ADVISORY",
    },
    include: { user: true },
  });

  if (originalNotifications.length === 0) return;

  // Build the status message
  const notificationType = newStatus === "RESOLVED" ? "RESTORATION" : "CANCELLATION";
  const barangayName = advisory.targets[0]?.barangay?.name ?? "";
  const purokName = advisory.targets[0]?.purok?.name ?? null;

  const statusMessage = formatStatusMessage(
    advisory.title,
    newStatus,
    reason ?? advisory.cancellationReason ?? null,
    barangayName,
    purokName
  );

  // Create new notifications
  const notifications: any[] = originalNotifications.map((n) => ({
    advisoryId: advisory.id,
    userId: n.userId,
    phoneNumber: n.phoneNumber,
    messageContent: statusMessage,
    notificationType,
    deliveryStatus: "SIMULATED",
    deliveredAt: new Date(Date.now() + 5000),
  }));

  await prisma.notification.createMany({ data: notifications });

  logger.info("Status notifications generated", {
    advisoryId: advisory.id,
    status: newStatus,
    count: notifications.length,
  });
}

/**
 * Get the currently-active advisories for a resident, based on their
 * location and service-type opt-in preferences.
 */
export async function getResidentAdvisories(currentUser: AuthenticatedUser): Promise<AdvisoryWithTargets[]> {
  const { barangayId, purokId, waterOptIn, powerOptIn } = currentUser;

  if (!barangayId) return [];

  const serviceTypes = [
    ...(waterOptIn ? ["WATER"] : []),
    ...(powerOptIn ? ["POWER"] : []),
  ];

  const where: any = {
    status: { in: ["SCHEDULED", "ACTIVE"] },
    startAt: { lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }, // within 7 days
    serviceType: { in: serviceTypes },
  };

  const data = await prisma.advisory.findMany({
    where,
    orderBy: [{ priority: "desc" }, { startAt: "asc" }],
    include: {
      createdBy: { select: { id: true, fullName: true, email: true } },
      targets: {
        where: {
          OR: [
            { barangayId, purokId }, // exact purok match
            ...(purokId ? [] : []), // if no purok, barangay-wide targets match
          ],
        },
        include: { barangay: { select: { name: true } }, purok: { select: { name: true } } },
      },
    },
  });

  // Filter: only include advisories that target this resident's barangay+purok
  const filtered = data.filter((advisory) => {
    return advisory.targets.some((target) => {
      if (target.barangayId !== barangayId) return false;
      // Match: purokId is null (barangay-wide) OR target.purokId matches
      if (target.purokId === null) return true; // barangay-wide advisory
      if (purokId && target.purokId === purokId) return true;
      return false;
    });
  });

  return filtered.map((a) => mapAdvisoryWithTargets(a, 0));
}

/**
 * Get the dispatcher's own advisories with filters.
 */
export async function getDispatcherAdvisories(
  currentUser: AuthenticatedUser,
  params: { status?: string; serviceType?: string; limit?: number; offset?: number }
): Promise<{ data: AdvisoryWithTargets[]; total: number }> {
      const where: any = { createdById: currentUser.id };
  if (params.status) where.status = params.status;
  if (params.serviceType) where.serviceType = params.serviceType;

  const [data, total] = await Promise.all([
    prisma.advisory.findMany({
      where,
      orderBy: { startAt: "desc" },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
      include: { createdBy: true, targets: true },
    }),
    prisma.advisory.count({ where }),
  ]);

  return {
    data: data.map((a) => mapAdvisoryWithTargets(a, 0)),
    total,
  };
}

// ============================================================================
// PUBLIC API — Resident notifications
// ============================================================================

export interface NotificationDto {
  id: string;
  advisoryId: string;
  advisoryTitle: string;
  advisoryServiceType: string;
  phoneNumber: string | null;
  messageContent: string;
  notificationType: string;
  deliveryStatus: string;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export async function getMyNotifications(
  userId: string,
  params: { type?: string; unreadOnly?: boolean; limit?: number; offset?: number }
) {
  const where: any = { userId };
  if (params.type) where.notificationType = params.type;
  if (params.unreadOnly) where.readAt = null;

  const [data, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
      include: { advisory: { select: { title: true, serviceType: true, startAt: true, endAt: true } } },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  return {
    data: data.map((n) => ({
      id: n.id,
      advisoryId: n.advisoryId,
      advisoryTitle: n.advisory?.title ?? "",
      advisoryServiceType: n.advisory?.serviceType ?? "",
      phoneNumber: n.phoneNumber,
      messageContent: n.messageContent,
      notificationType: n.notificationType,
      deliveryStatus: n.deliveryStatus,
      deliveredAt: n.deliveredAt,
      readAt: n.readAt,
      createdAt: n.createdAt,
    })),
    total,
    unreadCount,
  };
}

export async function markNotificationRead(userId: string, notificationId: string): Promise<void> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification) throw new NotFoundError("Notification not found");
  if (notification.userId !== userId) throw new AppError("You do not have permission", 403);
  await prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}

export async function markAllNotificationsRead(userId: string): Promise<{ count: number }> {
  const result = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return { count: result.count };
}

export async function getNotificationStats(userId: string): Promise<any> {
  const [total, unread, advisory, restoration, cancellation, waterCount, powerCount] = await Promise.all([
    prisma.notification.count({ where: { userId } }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.count({ where: { userId, notificationType: "ADVISORY" } }),
    prisma.notification.count({ where: { userId, notificationType: "RESTORATION" } }),
    prisma.notification.count({ where: { userId, notificationType: "CANCELLATION" } }),
    prisma.notification.count({ where: { userId, advisory: { serviceType: "WATER" } } }),
    prisma.notification.count({ where: { userId, advisory: { serviceType: "POWER" } } }),
  ]);
  return { total, unread, advisory, restoration, cancellation, waterCount, powerCount };
}

export async function getRecipientsForAdvisoryPublic(
  advisoryId: string,
  currentUser: AuthenticatedUser
) {
  const advisory = await getFullAdvisory(advisoryId);
  if (!advisory) throw new NotFoundError("Advisory not found");
  if (currentUser.role !== "ADMIN" && advisory.createdById !== currentUser.id) {
    throw new ForbiddenError("You do not have permission to view recipients");
  }
  const notifications = await prisma.notification.findMany({
    where: { advisoryId },
    include: { user: { select: { id: true, email: true, fullName: true, phone: true } } },
    distinct: ["userId"],
  });
  return notifications.map((n) => ({
    userId: n.user.id,
    email: n.user.email,
    fullName: n.user.fullName,
    phone: n.user.phone ?? "",
    barangay: "",
    purok: null,
  }));
}


