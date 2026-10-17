import { Router } from "express";
import authRoutes from "./auth.routes.js";
import userRoutes from "./user.routes.js";
import localityRoutes from "./locality.routes.js";
import advisoryRoutes from "./advisory.routes.js";
import adminRoutes from "./admin.routes.js";
import type { Request, Response, NextFunction } from "express";

const router = Router();

// Health check endpoint
router.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "Community Alert System API",
  });
});

// API routes
router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/localities", localityRoutes);
router.use("/advisories", advisoryRoutes);
router.use("/dashboard", adminRoutes);

// Resident notification inbox
import { getMyNotifications, markNotificationRead, markAllNotificationsRead, getNotificationStats } from "../services/advisory.service.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

router.get(
  "/notifications/me",
  (_req: Request, _res: Response, next: NextFunction): void => {
    if (!_req.session?.user) {
      _res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  },
  asyncHandler(async (req: Request, _res: Response): Promise<void> => {
    const userId = req.session!.user.id;
    const { type, unreadOnly, limit, offset } = req.query as any;
    const result = await getMyNotifications(userId, {
      type,
      unreadOnly: unreadOnly === "true",
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    _res.status(200).json({ data: result });
  })
);

router.patch(
  "/notifications/:id/read",
  (_req: Request, res: Response, next: NextFunction): void => {
    if (!_req.session?.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  },
  asyncHandler(async (req: Request, _res: Response): Promise<void> => {
    await markNotificationRead(req.session!.user.id, req.params.id!);
    _res.status(200).json({ data: null, message: "Notification marked as read" });
  })
);

router.post(
  "/notifications/read-all",
  (_req: Request, res: Response, next: NextFunction): void => {
    if (!_req.session?.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  },
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const result = await markAllNotificationsRead(_req.session!.user.id);
    res.status(200).json({ data: result, message: "All notifications marked as read" });
  })
);

router.get(
  "/notifications/stats",
  (_req: Request, res: Response, next: NextFunction): void => {
    if (!_req.session?.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    next();
  },
  asyncHandler(async (_req: Request, res: Response): Promise<void> => {
    const stats = await getNotificationStats(_req.session!.user.id);
    res.status(200).json({ data: stats });
  })
);

export default router;
