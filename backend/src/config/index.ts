import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from the project root (parent of backend/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

dotenv.config({ path: path.join(rootDir, ".env") });

function getEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function getEnvNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  nodeEnv: getEnv("NODE_ENV", "development") as "development" | "production" | "test",
  backendHost: getEnv("BACKEND_HOST", "127.0.0.1"),
  backendPort: getEnvNumber("BACKEND_PORT", 4000),
  databaseUrl: getEnv("DATABASE_URL", "postgresql://postgres:password@localhost:5432/cas_dev?schema=public"),
  jwtSecret: getEnv("JWT_SECRET", "dev-secret-change-me"),
  jwtExpiresIn: getEnv("JWT_EXPIRES_IN", "7d"),
  corsOrigins: getEnv("CORS_ORIGINS", "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  rateLimitWindowMs: getEnvNumber("RATE_LIMIT_WINDOW_MS", 900000),
  rateLimitMax: getEnvNumber("RATE_LIMIT_MAX", 100),
  initialAdminEmail: getEnv("INITIAL_ADMIN_EMAIL", "admin@cas.local"),
  initialAdminPassword: getEnv("INITIAL_ADMIN_PASSWORD", "ChangeMeNow!123"),
  isProduction: getEnv("NODE_ENV", "development") === "production",
  rootDir,
} as const;

export default config;
