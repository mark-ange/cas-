import { PrismaClient } from "@prisma/client";
import config from "../config/index.js";

let prisma: PrismaClient | undefined;

if (config.nodeEnv === "production") {
  if (!prisma) {
    prisma = new PrismaClient({
      log: ["query", "error", "warn"],
    });
  }
} else {
  if (!(global as unknown as { prisma?: PrismaClient }).prisma) {
    (global as unknown as { prisma: PrismaClient }).prisma = new PrismaClient({
      log: ["error", "warn"],
    });
  }
  prisma = (global as unknown as { prisma: PrismaClient }).prisma;
}

export default prisma!;
