import type { authenticate } from "../auth.js";
import type { ResetMailConfig } from "../password-reset.js";
import type { VapidConfig } from "../push.js";
import type { createFailureLimiter } from "../rate-limit.js";
import type { AuthRepository } from "../repository.js";

export type RouteDeps = {
  repo: () => AuthRepository;
  auth: ReturnType<typeof authenticate>;
  limit: ReturnType<typeof createFailureLimiter>;
  resetLimit: ReturnType<typeof createFailureLimiter>;
  vapid: VapidConfig;
  jwtSecret: string;
  resetMail?: ResetMailConfig;
  backgroundTask?: (task: Promise<void>) => void;
};
