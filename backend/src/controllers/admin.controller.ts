import type { Request, Response } from "express";
import prisma from "../utils/prisma.js";
import { sendSuccess, HttpStatus } from "../utils/apiResponse.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getResidentAdvisories, getNotificationStats } from "../services/advisory.service.js";

/**
 * GET /api/dashboard/admin
 * Get admin dashboard statistics.
 */
export const getAdminStats = asyncHandler(async (_req: Request, res: Response) => {
  const [
    userCount,
    activeDispatchers,
    barangayCount,
    purokCount,
    advisoryCount,
    activeAdvisories,
    notificationCount,
    unreadNotifications,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { role: { in: ["WATER_DISPATCHER", "POWER_DISPATCHER"] } } }),
    prisma.barangay.count(),
    prisma.purok.count(),
    prisma.advisory.count(),
    prisma.advisory.count({ where: { status: "ACTIVE" } }),
    prisma.notification.count(),
    prisma.notification.count({ where: { readAt: null } }),
  ]);

  const serviceBreakdown = await prisma.advisory.groupBy({
    by: ["serviceType"],
    _count: { _all: true },
  });

  const statusBreakdown = await prisma.advisory.groupBy({
    by: ["status"],
    _count: { _all: true },
  });

  sendSuccess(res, HttpStatus.OK, {
    users: {
      total: userCount,
      activeDispatchers,
      residents: userCount - activeDispatchers, // rough estimate
    },
    localities: {
      barangays: barangayCount,
      puroks: purokCount,
    },
    advisories: {
      total: advisoryCount,
      active: activeAdvisories,
      byService: serviceBreakdown,
      byStatus: statusBreakdown,
    },
    notifications: {
      total: notificationCount,
      unread: unreadNotifications,
    },
  });
});

/**
 * GET /api/dashboard/dispatcher
 * Get dispatcher dashboard statistics.
 */
export const getDispatcherStats = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.session!.user.id;

  const [myAdvisories, myActive, myScheduled, notifications, unreadCount] = await Promise.all([
    prisma.advisory.count({ where: { createdById: userId } }),
    prisma.advisory.count({ where: { createdById: userId, status: "ACTIVE" } }),
    prisma.advisory.count({ where: { createdById: userId, status: "SCHEDULED" } }),
    prisma.notification.count({
      where: { user: { residentProfile: { barangay: { id: req.session!.user.barangayId ?? "" } } } },
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);

  sendSuccess(res, HttpStatus.OK, {
    myAdvisories,
    myActive,
    myScheduled,
    recentNotifications: notifications,
    unreadCount,
  });
});

/**
 * GET /api/dashboard/resident
 * Get resident dashboard data (active advisories + notification stats).
 */
export const getResidentDashboard = asyncHandler(async (req: Request, res: Response): Promise<void> => {
  const user = req.session!.user;

  const [advisories, stats] = await Promise.all([
    user.barangayId
      ? getResidentAdvisories(user)
      : [],
    getNotificationStats(user.id),
  ]);

  sendSuccess(res, HttpStatus.OK, {
    activeAdvisories: advisories,
    notificationStats: stats,
  });
});

/**
 * GET /api/dashboard/localities
 * Get barangay/purok statistics for admin.
 */
export const getLocalityStats = asyncHandler(async (_req: Request, res: Response) => {
  const barangays = await prisma.barangay.findMany({
    where: { active: true },
    include: {
      _count: {
        select: { puroks: true, residentProfiles: true },
      },
    },
    orderBy: { name: "asc" },
  });

  const result = barangays.map((b) => ({
    id: b.id,
    name: b.name,
    purokCount: b._count.puroks,
    residentCount: b._count.residentProfiles,
  }));

  sendSuccess(res, HttpStatus.OK, result);
});
