import prisma from "../utils/prisma.js";
import logger from "../utils/logger.js";

export interface ActivityLogEntry {
  actorId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, unknown> | string;
}

/**
 * Write an activity log entry.
 * Called by services after performing an action.
 */
export async function logActivity(entry: ActivityLogEntry): Promise<void> {
  try {
    const metadata = entry.metadata
      ? typeof entry.metadata === "string"
        ? entry.metadata
        : JSON.stringify(entry.metadata)
      : undefined;

    await prisma.activityLog.create({
      data: {
        actorId: entry.actorId ?? undefined,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        metadata,
      },
    });
  } catch (error) {
    logger.error("Failed to write activity log", { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Fetch recent activity logs (admin-only).
 */
export async function getActivityLogs(params: { limit?: number; actorId?: string }): Promise<any[]> {
  const where: any = {};
  if (params.actorId) where.actorId = params.actorId;

  return prisma.activityLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: params.limit ?? 50,
    include: {
      actor: { select: { id: true, email: true, fullName: true, role: true } },
    },
  });
}
