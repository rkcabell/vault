/**
 * Core logic for the admin `reset-password` CLI (apps/api/scripts/reset-password.ts).
 *
 * Kept in src/ (within tsconfig rootDir) so it can be unit-tested; the script
 * is a thin shell that wires real dependencies (prisma, argon2, a TTY prompt).
 */
import { validatePassword } from "@vault/types";

export type ParsedArgs = { email?: string; password?: string };

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--email") out.email = argv[++i];
    else if (arg === "--password") out.password = argv[++i];
    else if (arg.startsWith("--email=")) out.email = arg.slice("--email=".length);
    else if (arg.startsWith("--password=")) out.password = arg.slice("--password=".length);
  }
  return out;
}

type UserRecord = { id: string; email: string };

export type ResetDeps = {
  prisma: {
    user: {
      findUnique: (args: { where: { email: string } }) => Promise<UserRecord | null>;
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  hasher: { hash: (plain: string) => Promise<string> };
  readPassword: () => Promise<string>;
  isTTY: boolean;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
};

/** Resets a user's password. Returns a process exit code; no global/process state. */
export async function run(args: ParsedArgs, deps: ResetDeps): Promise<number> {
  const log = deps.log ?? ((m: string) => process.stdout.write(m + "\n"));
  const error = deps.error ?? ((m: string) => process.stderr.write(m + "\n"));

  if (!args.email) {
    error("Missing required --email <address>");
    return 2;
  }

  const user = await deps.prisma.user.findUnique({ where: { email: args.email } });
  if (!user) {
    error(`No user found with email: ${args.email}`);
    return 1;
  }

  let password = args.password;
  if (password === undefined) {
    if (!deps.isTTY) {
      error("No interactive terminal available. Pass --password <value> for non-interactive use.");
      return 2;
    }
    password = await deps.readPassword();
  }

  const check = validatePassword(password);
  if (!check.ok) {
    error(check.reason);
    return 1;
  }

  const hash = await deps.hasher.hash(password);
  await deps.prisma.user.update({
    where: { id: user.id },
    // resetToken/resetTokenExpiry are nulled defensively even though the
    // self-service reset flow is gone. Bumping tokenVersion evicts any sessions
    // that predate this reset (rejected at /auth/refresh).
    data: {
      passwordHash: hash,
      resetToken: null,
      resetTokenExpiry: null,
      tokenVersion: { increment: 1 },
    },
  });

  log(`Password updated for ${user.email}. Existing sessions will be evicted on their next token refresh.`);
  return 0;
}
