import { z } from 'zod';

const placeholder = (value: string): boolean => value.startsWith('replace-with');

/**
 * Startup environment validation. All model names and credentials come from the environment; nothing is hard-coded.
 * AGENT_RUNTIME=deterministic runs the governed tool sequence without a model (no ANTHROPIC_API_KEY needed);
 * evidence resolution then fails closed because it requires a model.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AGENT_RUNTIME: z.enum(['claude', 'deterministic']).default('claude'),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_MODEL: z.string().optional(),
  DATABASE_URL: z.string().min(1),
  APP_BASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  UPLOAD_DIR: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  /** Comma-separated addresses / CIDRs of trusted reverse proxies (e.g. "10.0.0.0/8,127.0.0.1"); empty = X-Forwarded-For is ignored. */
  TRUST_PROXY: z.string().default('').transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean)),
}).superRefine((env, context) => {
  if (env.AGENT_RUNTIME === 'claude') {
    if (!env.ANTHROPIC_API_KEY || placeholder(env.ANTHROPIC_API_KEY)) context.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'ANTHROPIC_API_KEY is required (or set AGENT_RUNTIME=deterministic)' });
    if (!env.CLAUDE_MODEL || placeholder(env.CLAUDE_MODEL)) context.addIssue({ code: 'custom', path: ['CLAUDE_MODEL'], message: 'CLAUDE_MODEL is required (or set AGENT_RUNTIME=deterministic)' });
  }
  if (placeholder(env.SESSION_SECRET)) context.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'SESSION_SECRET is still the .env.example placeholder' });
});
export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((issue) => `- ${issue.path.join('.')}: ${issue.message}`).join('\n')}`);
  return parsed.data;
}
