/**
 * Admin CLI — reset a user's password directly in the database.
 *
 * This is Vault's recovery path (Immich-style): there is no self-service
 * emailed reset, so an admin with host access sets the password here. No reset
 * token is ever generated or put in transit.
 *
 * Usage (run from apps/api):
 *   pnpm reset-password --email user@example.com
 *   pnpm reset-password --email user@example.com --password 'NewSecret123'
 *
 * In Docker (a TTY is needed for the hidden prompt — note the -it):
 *   docker compose exec -it api pnpm reset-password --email user@example.com
 *
 * --password is provided for non-interactive use; note it leaks into shell
 * history, so the interactive prompt is preferred.
 *
 * Testable core lives in src/lib/resetPassword.ts.
 */
import path from "node:path";
import readline from "node:readline";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { prisma } from "@vault/db";
import { createPasswordHasher } from "../src/adapters/passwordHasher.js";
import { parseArgs, run } from "../src/lib/resetPassword.js";

// Mirror the server's env loading exactly (see apps/api/src/index.ts). cwd for
// this script is apps/api, so it resolves apps/api/.env just like `npm start`.
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? path.join(process.cwd(), ".env") });

/** Read a line from stdin without echoing it (routes readline output to a no-op sink). */
function promptHidden(question: string): Promise<string> {
  const muted = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => {
    process.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/** Interactive prompt + confirm, re-prompting on mismatch. */
async function readNewPasswordInteractive(): Promise<string> {
  for (;;) {
    const pw = await promptHidden("New password: ");
    const confirm = await promptHidden("Confirm new password: ");
    if (pw !== confirm) {
      process.stderr.write("Passwords do not match — try again.\n");
      continue;
    }
    return pw;
  }
}

async function main(): Promise<void> {
  const code = await run(parseArgs(process.argv.slice(2)), {
    prisma,
    hasher: createPasswordHasher(),
    readPassword: readNewPasswordInteractive,
    isTTY: Boolean(process.stdin.isTTY),
  });
  await prisma.$disconnect();
  process.exit(code);
}

// Only run when invoked directly (not when imported).
const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch(async (err) => {
    process.stderr.write(`reset-password failed: ${err instanceof Error ? err.message : String(err)}\n`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
}
