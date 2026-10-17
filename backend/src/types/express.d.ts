import "express";
import type { AuthenticatedUser, SessionInfo } from "../middleware/auth.js";

declare global {
  namespace Express {
    interface Request {
      session?: SessionInfo;
      user?: AuthenticatedUser;
    }
  }
}
