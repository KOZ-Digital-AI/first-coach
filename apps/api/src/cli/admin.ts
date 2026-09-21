// Admin CLI: the only way an admin is provisioned or recovered (no email in v0.1).
//
//   bun apps/api/src/cli/admin.ts create --email <email> --name <name>
//   bun apps/api/src/cli/admin.ts reset-password --email <email>
//   bun apps/api/src/cli/admin.ts list
//
// Run it on the server, where NODE_ENV=production and BETTER_AUTH_SECRET / BETTER_AUTH_URL
// are set: auth config comes from the environment exactly like the server's (fail-closed).
//
// PASSWORD. Read from ADMIN_PASSWORD, else prompted without echo when stdin is a terminal
// (typed twice), else, when stdin is not a terminal (a pipe), one line is read from stdin.
// It is never a command-line argument (shell history and `ps` would keep it) and it never
// appears in output: every line is scrubbed of the password before printing.
//
// This is a library plus a thin entry: `runAdminCli` returns the exit code (0 ok, 1 failure,
// 2 usage) and takes its I/O as arguments. Arguments are validated before the database or
// the environment is touched.
import type { Database } from "bun:sqlite";
import { getAuth, ensureAuthSchema, ROLE_ADMIN, type Auth } from "../auth/better-auth";
import { openDatabase } from "../db/database";
import { parseEnv } from "../env";

export type AdminCliIo = {
  db: Database;
  env: Record<string, string | undefined>;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Used when ADMIN_PASSWORD is unset or blank. */
  promptPassword?: () => Promise<string>;
};

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

const USAGE = [
  "Usage: bun apps/api/src/cli/admin.ts <command> [options]",
  "",
  "Commands:",
  "  create --email <email> --name <name>   create an admin account",
  "  reset-password --email <email>         set a new password for an admin and revoke its sessions",
  "  list                                   list admins (email, name, created date)",
  "",
  "The password is read from the ADMIN_PASSWORD environment variable, or prompted for",
  "(hidden) when it is unset. It is never a command-line argument.",
];

const PASSWORD_OPTION_REASON =
  "--password is not supported: a password on the command line ends up in shell history and " +
  "the process list. Set ADMIN_PASSWORD in the environment, or leave it unset to be prompted.";

type Command =
  | { command: "create"; email: string; name: string }
  | { command: "reset-password"; email: string }
  | { command: "list" };
export type ParsedArgs = ({ ok: true } & Command) | { ok: false; message?: string };

const COMMAND_OPTIONS: Record<Command["command"], readonly string[]> = {
  create: ["email", "name"],
  "reset-password": ["email"],
  list: [],
};
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;

/**
 * Pure argument parsing. Error messages never echo any user-supplied token (option text,
 * values, stray arguments): a mistyped password could be any of them, and the output
 * scrubber cannot help because the password is not known yet at parse time.
 */
export function parseAdminArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined) return { ok: false };
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) return { ok: false, message: "unknown command" };
  const allowed = COMMAND_OPTIONS[command as Command["command"]];

  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (!token.startsWith("-")) return { ok: false, message: "unexpected argument (options are --name value)" };
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    // Anything that looks like a password option (-p, -pSECRET, --pass, --pwd=SECRET, --password...)
    // gets the fixed explanation. The token itself is never printed: it may hold the password.
    if (/^-{1,2}p/i.test(flag)) return { ok: false, message: PASSWORD_OPTION_REASON };
    const name = flag.replace(/^--/, "");
    if (!flag.startsWith("--") || !allowed.includes(name)) {
      return { ok: false, message: `unknown option for ${command}` }; // no token text, by design
    }
    let value: string | undefined;
    if (eq !== -1) value = token.slice(eq + 1);
    else if (rest[i + 1] !== undefined && !(rest[i + 1] as string).startsWith("--")) value = rest[++i];
    if (value === undefined || value.trim() === "") return { ok: false, message: `--${name} needs a value` };
    values[name] = value.trim();
  }

  const email = values.email?.toLowerCase();
  if (command === "list") return { ok: true, command };
  if (email === undefined) return { ok: false, message: "--email is required" };
  if (!EMAIL_SHAPE.test(email)) return { ok: false, message: "--email is not a valid email address" };
  if (command === "reset-password") return { ok: true, command, email };
  if (values.name === undefined) return { ok: false, message: "--name is required" };
  return { ok: true, command: "create", email, name: values.name };
}

function reportUsage(parsed: { message?: string }, stderr: (line: string) => void): number {
  if (parsed.message) stderr(`Error: ${parsed.message}`);
  for (const line of USAGE) stderr(line);
  return EXIT_USAGE;
}

/** An expected failure whose message is safe to print. */
class CliError extends Error {}

const messageOf = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "unexpected failure";

const hasRole = (roles: string | null, role: string): boolean =>
  roles !== null && roles.split(",").map((r) => r.trim()).includes(role);

const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f]/g, " ");

type UserRow = { id: string; email: string; name: string; role: string | null; createdAt: string | number };

export async function runAdminCli(argv: string[], io: AdminCliIo): Promise<number> {
  const parsed = parseAdminArgs(argv);
  if (!parsed.ok) return reportUsage(parsed, io.stderr);

  // Defence in depth: a lower layer's error text might quote the password. Only lines that
  // contain it are touched. Known trade-off: an innocent line containing the password as a
  // substring (password "longpass123", email "longpass123@x.com") is redacted too.
  let secret = "";
  const scrub = (line: string): string =>
    secret !== "" && line.includes(secret) ? line.split(secret).join("[redacted]") : line;
  const out = (line: string): void => io.stdout(scrub(line));
  const err = (line: string): void => io.stderr(scrub(line));

  async function readPassword(auth: Auth): Promise<string> {
    const fromEnv = io.env.ADMIN_PASSWORD;
    let password: string;
    if (fromEnv !== undefined && fromEnv.trim() !== "") password = fromEnv;
    else if (io.promptPassword) password = await io.promptPassword();
    else throw new CliError("no password: set ADMIN_PASSWORD, or run in a terminal to be prompted");
    secret = password;
    const { minPasswordLength, maxPasswordLength } = (await auth.$context).password.config;
    if (password.length < minPasswordLength) {
      throw new CliError(`the password must be at least ${minPasswordLength} characters`);
    }
    if (password.length > maxPasswordLength) {
      throw new CliError(`the password must be at most ${maxPasswordLength} characters`);
    }
    return password;
  }

  const findUser = (email: string): UserRow | null =>
    io.db
      .query("SELECT id, email, name, role, createdAt FROM user WHERE lower(email) = ?")
      .get(email) as UserRow | null;

  try {
    const auth = getAuth({ db: io.db }, io.env);
    await ensureAuthSchema(auth, io.db);

    if (parsed.command === "list") {
      const rows = io.db
        .query("SELECT id, email, name, role, createdAt FROM user WHERE role IS NOT NULL ORDER BY createdAt, email")
        .all() as UserRow[];
      for (const row of rows.filter((r) => hasRole(r.role, ROLE_ADMIN))) {
        const created = new Date(row.createdAt);
        const date = Number.isNaN(created.getTime()) ? String(row.createdAt) : created.toISOString().slice(0, 10);
        out([clean(row.email), clean(row.name), date].join("\t"));
      }
      return EXIT_OK;
    }

    if (parsed.command === "create") {
      const { email, name } = parsed;
      if (findUser(email)) {
        throw new CliError(
          `a user with email ${email} already exists; create never promotes or modifies an existing account`,
        );
      }
      const password = await readPassword(auth);
      let userId: string;
      try {
        userId = (await auth.api.signUpEmail({ body: { email, password, name } })).user.id;
      } catch (error) {
        const code = (error as { body?: { code?: string } }).body?.code;
        if (code?.startsWith("USER_ALREADY_EXISTS")) {
          throw new CliError(
            `a user with email ${email} already exists; create never promotes or modifies an existing account`,
          );
        }
        throw error;
      }
      // Known gap: a crash between sign-up above and this UPDATE leaves a plain contributor
      // with this email, which `create` then refuses forever (it never promotes). Recovery is
      // manual SQL (delete that user row, or set its role to admin).
      try {
        io.db.transaction(() => {
          io.db.query("UPDATE user SET role = ?, updatedAt = ? WHERE id = ?").run(ROLE_ADMIN, new Date().toISOString(), userId);
          io.db.query("DELETE FROM session WHERE userId = ?").run(userId); // sign-up opened one
        })();
      } catch (error) {
        io.db.query("DELETE FROM user WHERE id = ?").run(userId); // never leave a half-made account
        throw error;
      }
      out(`Created admin ${email} (${clean(name)}).`);
      return EXIT_OK;
    }

    const { email } = parsed;
    const user = findUser(email);
    if (!user) throw new CliError(`no user with email ${email}`);
    if (!hasRole(user.role, ROLE_ADMIN)) {
      throw new CliError(`${email} is not an admin; reset-password only works for admins`);
    }
    const credential = io.db
      .query("SELECT id FROM account WHERE userId = ? AND providerId = 'credential'")
      .get(user.id) as { id: string } | null;
    if (!credential) throw new CliError(`${email} has no password sign-in to reset`);

    const password = await readPassword(auth);
    const hash = await (await auth.$context).password.hash(password);
    io.db.transaction(() => {
      io.db
        .query("UPDATE account SET password = ?, updatedAt = ? WHERE id = ?")
        .run(hash, new Date().toISOString(), credential.id);
      io.db.query("DELETE FROM session WHERE userId = ?").run(user.id);
    })();
    out(`Password reset for ${email}; all its sessions were revoked.`);
    return EXIT_OK;
  } catch (error) {
    err(`Error: ${messageOf(error)}`);
    return EXIT_FAILURE;
  }
}

/** What `readHiddenLine` needs from a terminal; process.stdin (in raw-mode capable form) fits. */
export type HiddenInput = {
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

/**
 * One hidden line from a terminal: raw mode, nothing echoed (only `label` and a final newline
 * are written), backspace works, Ctrl-C cancels. Escape sequences (arrow keys: ESC [ ... final
 * byte; SS3: ESC O x; Alt-key: ESC x) are swallowed, also when split across chunks.
 */
export function readHiddenLine(
  input: HiddenInput,
  label: string,
  write: (text: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let chars: string[] = [];
    let state: "text" | "esc" | "csi" | "ss3" = "text";
    const finish = (settle: () => void): void => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      write("\n");
      settle();
    };
    function onData(chunk: Buffer | string): void {
      for (const ch of chunk.toString()) {
        if (state === "esc") {
          if (ch === "[") state = "csi";
          else if (ch === "O") state = "ss3";
          else state = "text";
          if (ch >= " ") continue; // a control byte right after ESC is handled as typed
        } else if (state === "csi") {
          if (ch >= " " && ch <= "?") continue; // parameter / intermediate bytes
          state = "text";
          if (ch >= "@" && ch <= "~") continue; // the final byte ends the sequence
        } else if (state === "ss3") {
          state = "text";
          if (ch >= " ") continue;
        }
        if (ch === "\u001b") state = "esc";
        else if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish(() => resolve(chars.join("")));
        else if (ch === "\u0003") return finish(() => reject(new Error("cancelled")));
        else if (ch === "\u007f" || ch === "\b") chars = chars.slice(0, -1);
        else if (ch >= " ") chars.push(ch);
      }
    }
    write(label);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

const readHidden = (label: string): Promise<string> =>
  readHiddenLine(process.stdin as unknown as HiddenInput, label, (text) => void process.stderr.write(text));

/** From a pipe: the first line of stdin, without its line ending. */
async function readLineFromStdin(): Promise<string> {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk.toString();
    const newline = buffer.indexOf("\n");
    if (newline !== -1) {
      buffer = buffer.slice(0, newline);
      break;
    }
  }
  return buffer.replace(/\r$/, "");
}

/** Terminal: hidden prompt, typed twice. Pipe: one line from stdin. */
export async function promptPasswordFromTerminal(): Promise<string> {
  if (!process.stdin.isTTY) return readLineFromStdin();
  const first = await readHidden("Password: ");
  const second = await readHidden("Confirm password: ");
  if (first !== second) throw new Error("the passwords do not match");
  return first;
}

/** Real entry: validates arguments first, then opens the database named by APP_DB_PATH. */
export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const parsed = parseAdminArgs(argv);
  if (!parsed.ok) return reportUsage(parsed, console.error);
  let db: Database;
  try {
    db = openDatabase(parseEnv(env).APP_DB_PATH);
  } catch (error) {
    console.error(`Error: ${messageOf(error)}`); // bad env or an unopenable path: one line, no stack
    return EXIT_FAILURE;
  }
  try {
    return await runAdminCli(argv, {
      db,
      env,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
      promptPassword: promptPasswordFromTerminal,
    });
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
