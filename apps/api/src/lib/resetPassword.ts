/**
 * Sets a new password on an account from the command line, for an owner who
 * has been locked out of the web app.
 *
 * Everything here takes its database, hasher and terminal through arguments,
 * so the command can be run against test doubles.
 */
import { validatePassword } from "@vault/types";

export type ParsedArgs = { email?: string; password?: string };

/** Reads the email and password options out of `argv`. Both `--email x` and `--email=x` are accepted, and anything else is ignored. */
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

/** Everything the reset needs from outside itself. `readPassword` is only consulted when no password was passed on the command line. */
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

/**
 * Sets the account's password and returns the exit code the command should
 * finish with.
 *
 * 0 means the password was changed, 1 that the account or password was
 * rejected, and 2 that the command was invoked wrongly. Nothing here reads or
 * writes process state.
 */
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
    // Raising tokenVersion stops every session opened before this reset from
    // renewing itself.
    data: {
      passwordHash: hash,
      tokenVersion: { increment: 1 },
    },
  });

  log(`Password updated for ${user.email}. Existing sessions will be evicted on their next token refresh.`);
  return 0;
}
