import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAuthSchema, getAuth, getSession } from "../auth/better-auth";
import { openDatabase } from "../db/database";
import * as admin from "./admin";
import { runAdminCli } from "./admin";

const SCRIPT = join(import.meta.dir, "admin.ts");
const ORIGIN = "http://localhost:4111"; // the dev default BETTER_AUTH_URL
const ENV = { NODE_ENV: "test" } as const;

// Distinctive passwords: if either string shows up in any output, a test fails.
const PW = "Zq7-MARKER-pw-9931";
const NEW_PW = "Vx3-MARKER-new-4417";
const OTHER_PW = "Kd9-MARKER-other-2208";
// A secret typed by mistake as (part of) an option: it must never come back in any output.
const ARG_SECRET = "Hunter2Secret";
const MARKERS = [PW, NEW_PW, OTHER_PW, ARG_SECRET];

let dir: string;
let db: Database;
const opened: Database[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "admin-cli-"));
  db = openDatabase(join(dir, "app.db"));
  opened.push(db);
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    try {
      handle.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

type Result = { code: number; stdout: string[]; stderr: string[]; thrown: unknown };
type RunOptions = {
  env?: Record<string, string | undefined>;
  prompt?: () => Promise<string>;
  database?: Database;
};

/**
 * Runs the CLI in-process. Every run also asserts that no password used in this file
 * appears in stdout, stderr or a thrown error, whatever the outcome.
 */
async function run(argv: string[], options: RunOptions = {}): Promise<Result> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let code = -1;
  let thrown: unknown;
  try {
    code = await runAdminCli(argv, {
      db: options.database ?? db,
      env: options.env ?? { ...ENV, ADMIN_PASSWORD: PW },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      promptPassword: options.prompt,
    });
  } catch (error) {
    thrown = error;
  }
  const everything = [
    ...stdout,
    ...stderr,
    thrown instanceof Error ? `${thrown.message}\n${thrown.stack ?? ""}` : String(thrown ?? ""),
  ].join("\n");
  for (const marker of MARKERS) expect(everything).not.toContain(marker);
  return { code, stdout, stderr, thrown };
}

const auth = () => getAuth({ db }, ENV);

/** A pre-existing (non-CLI) user, created the way a normal sign-up creates one. */
async function seedContributor(email: string, password = PW, name = "Contrib") {
  await ensureAuthSchema(auth(), db);
  await auth().api.signUpEmail({ body: { email, password, name } });
}

const signIn = (email: string, password: string): Promise<Response> =>
  auth().handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    }),
  );

const cookieOf = (res: Response): string =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

const sessionFor = (cookie: string) => getSession(auth(), new Headers({ cookie }));

type UserRow = { id: string; email: string; role: string | null; isAnonymous: number | null };
const userRow = (email: string) =>
  db.query("SELECT id, email, role, isAnonymous FROM user WHERE email = ?").get(email) as UserRow | null;
const userCount = () =>
  db.query("SELECT name FROM sqlite_master WHERE name = 'user'").get() === null
    ? 0 // the CLI has not created the auth tables (yet)
    : (db.query("SELECT count(*) AS n FROM user").get() as { n: number }).n;
const passwordHash = (email: string) =>
  (
    db
      .query(
        "SELECT a.password AS hash FROM account a JOIN user u ON u.id = a.userId WHERE u.email = ? AND a.providerId = 'credential'",
      )
      .get(email) as { hash: string } | null
  )?.hash;
const sessionCount = (email: string) =>
  (
    db
      .query("SELECT count(*) AS n FROM session s JOIN user u ON u.id = s.userId WHERE u.email = ?")
      .get(email) as { n: number }
  ).n;

const createAdmin = (email: string, name = "Ada Admin", options?: RunOptions) =>
  run(["create", "--email", email, "--name", name], options);

describe("create", () => {
  test("creates the first admin on a database that has no auth tables yet", async () => {
    const result = await createAdmin("ada@example.com");

    expect(result.code).toBe(0);
    expect(result.stdout.join("\n")).toContain("ada@example.com");
    const row = userRow("ada@example.com");
    expect(row?.role).toBe("admin");
    expect(row?.isAnonymous).toBe(0);
  });

  test("the created admin signs in through the real auth handler and the session says admin", async () => {
    await createAdmin("ada@example.com");

    const res = await signIn("ada@example.com", PW);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string; isAnonymous: boolean } };
    expect(body.user.role).toBe("admin");
    const session = await sessionFor(cookieOf(res));
    expect(session?.user.role).toBe("admin");
    expect(session?.user.isAnonymous).toBe(false);
  });

  test("a wrong password still does not sign the new admin in", async () => {
    await createAdmin("ada@example.com");

    expect((await signIn("ada@example.com", "definitely-wrong-1")).status).toBe(401);
  });

  test("leaves no session behind for the new admin", async () => {
    await createAdmin("ada@example.com");

    expect(sessionCount("ada@example.com")).toBe(0);
  });

  test("normalises the email to lower case like a normal sign-up", async () => {
    const result = await createAdmin("Ada@Example.COM");

    expect(result.code).toBe(0);
    expect(userRow("ada@example.com")?.role).toBe("admin");
    expect((await signIn("ada@example.com", PW)).status).toBe(200);
  });

  test("more than one admin can be created", async () => {
    expect((await createAdmin("one@example.com", "One")).code).toBe(0);
    expect((await createAdmin("two@example.com", "Two")).code).toBe(0);

    expect(userRow("one@example.com")?.role).toBe("admin");
    expect(userRow("two@example.com")?.role).toBe("admin");
  });

  test("a duplicate admin email is refused without touching the existing admin", async () => {
    await createAdmin("ada@example.com");
    const before = passwordHash("ada@example.com");

    const result = await createAdmin("ada@example.com", "Impostor", {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("ada@example.com");
    expect(userCount()).toBe(1);
    expect(passwordHash("ada@example.com")).toBe(before);
    expect((await signIn("ada@example.com", PW)).status).toBe(200);
  });

  test("the duplicate check ignores email case", async () => {
    await createAdmin("ada@example.com");

    const result = await createAdmin("ADA@example.com");

    expect(result.code).toBe(1);
    expect(userCount()).toBe(1);
  });

  test("an existing contributor with that email is not promoted, renamed or re-passworded", async () => {
    await seedContributor("carol@example.com", OTHER_PW, "Carol");
    const before = passwordHash("carol@example.com");

    const result = await createAdmin("carol@example.com", "Carol Admin", {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(1);
    const message = result.stderr.join("\n");
    expect(message).toContain("carol@example.com");
    expect(message).toMatch(/promot/i); // says why: create never promotes an existing account
    expect(userRow("carol@example.com")?.role).toBe("contributor");
    expect(db.query("SELECT name FROM user WHERE email = ?").get("carol@example.com")).toEqual({
      name: "Carol",
    });
    expect(passwordHash("carol@example.com")).toBe(before);
    expect((await signIn("carol@example.com", OTHER_PW)).status).toBe(200);
    expect((await signIn("carol@example.com", NEW_PW)).status).toBe(401);
  });

  test("takes the password from ADMIN_PASSWORD without prompting", async () => {
    let prompts = 0;
    const prompt = async () => {
      prompts += 1;
      return OTHER_PW;
    };

    const result = await createAdmin("ada@example.com", "Ada", { prompt });

    expect(result.code).toBe(0);
    expect(prompts).toBe(0);
    expect((await signIn("ada@example.com", PW)).status).toBe(200);
  });

  test("prompts for the password when ADMIN_PASSWORD is unset or blank", async () => {
    let prompts = 0;
    const prompt = async () => {
      prompts += 1;
      return NEW_PW;
    };

    const unset = await createAdmin("one@example.com", "One", { env: { ...ENV }, prompt });
    const blank = await createAdmin("two@example.com", "Two", {
      env: { ...ENV, ADMIN_PASSWORD: "  " },
      prompt,
    });

    expect(unset.code).toBe(0);
    expect(blank.code).toBe(0);
    expect(prompts).toBe(2);
    expect((await signIn("one@example.com", NEW_PW)).status).toBe(200);
    expect((await signIn("two@example.com", NEW_PW)).status).toBe(200);
  });

  test("fails with a clear message when there is no password source", async () => {
    const result = await createAdmin("ada@example.com", "Ada", { env: { ...ENV } });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("ADMIN_PASSWORD");
    expect(userCount()).toBe(0);
  });

  test("refuses a password below Better Auth's minimum length of 8, without echoing it", async () => {
    const short = "Ab1-xyz"; // 7 characters

    const result = await createAdmin("ada@example.com", "Ada", { env: { ...ENV, ADMIN_PASSWORD: short } });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("8");
    expect(result.stderr.join("\n")).not.toContain(short);
    expect(userCount()).toBe(0);
  });

  test("accepts a password of exactly 8 characters", async () => {
    const result = await createAdmin("ada@example.com", "Ada", { env: { ...ENV, ADMIN_PASSWORD: "Ab1-xyz9" } });

    expect(result.code).toBe(0);
    expect((await signIn("ada@example.com", "Ab1-xyz9")).status).toBe(200);
  });

  test("refuses to run with production config missing, naming the variable and never the password", async () => {
    const result = await createAdmin("ada@example.com", "Ada", { env: { ADMIN_PASSWORD: PW } });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("BETTER_AUTH_SECRET");
    expect(userCount()).toBe(0);
  });
});

describe("output scrubbing", () => {
  test("an error from a lower layer that contains the password is redacted", async () => {
    await ensureAuthSchema(auth(), db);
    const spy = spyOn(auth().api, "signUpEmail").mockRejectedValue(new Error(`upstream rejected ${NEW_PW}`));
    try {
      const result = await createAdmin("ada@example.com", "Ada", { env: { ...ENV, ADMIN_PASSWORD: NEW_PW } });

      expect(result.code).toBe(1);
      const message = result.stderr.join("\n");
      expect(message).toContain("upstream rejected [redacted]");
      expect(message).not.toContain(NEW_PW);
    } finally {
      spy.mockRestore();
    }
  });

  test("a line that does not contain the password is printed exactly as it is", async () => {
    const result = await createAdmin("ada@example.com", "Ada", { env: { ...ENV, ADMIN_PASSWORD: "longpass123" } });

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual(["Created admin ada@example.com (Ada)."]);
  });
});

describe("the hidden password reader", () => {
  function fakeTerminal() {
    const calls: string[] = [];
    const written: string[] = [];
    const input = Object.assign(new EventEmitter(), {
      setRawMode: (mode: boolean) => void calls.push(`raw:${mode}`),
      resume: () => void calls.push("resume"),
      pause: () => void calls.push("pause"),
    });
    const write = (text: string) => void written.push(text);
    const send = (...chunks: string[]) => {
      for (const chunk of chunks) input.emit("data", Buffer.from(chunk));
    };
    return { input, calls, written, write, send };
  }

  test("collects typed characters, ends on Enter, restores the terminal and never echoes", async () => {
    const term = fakeTerminal();
    const line = admin.readHiddenLine(term.input, "Password: ", term.write);

    term.send("hun", "ter2\r");

    expect(await line).toBe("hunter2");
    expect(term.calls).toEqual(["raw:true", "resume", "raw:false", "pause"]);
    expect(term.written).toEqual(["Password: ", "\n"]);
    expect(term.input.listenerCount("data")).toBe(0);
  });

  test("arrow keys and other escape sequences are swallowed, not typed into the password", async () => {
    const term = fakeTerminal();
    const line = admin.readHiddenLine(term.input, "Password: ", term.write);

    term.send("ab\x1b[A\x1b[Bc\x1b[1;5Cd\x1bOAe\x1bxf\r");

    expect(await line).toBe("abcdef");
  });

  test("an escape sequence split across chunks is still swallowed", async () => {
    const term = fakeTerminal();
    const line = admin.readHiddenLine(term.input, "Password: ", term.write);

    term.send("ab\x1b", "[1;", "5Cd\r");

    expect(await line).toBe("abd");
  });

  test("backspace deletes the last character", async () => {
    const term = fakeTerminal();
    const line = admin.readHiddenLine(term.input, "Password: ", term.write);

    term.send("abc\x7fd\r");

    expect(await line).toBe("abd");
  });

  test("Ctrl-C cancels and restores the terminal", async () => {
    const term = fakeTerminal();
    const line = admin.readHiddenLine(term.input, "Password: ", term.write);

    term.send("abc\x03");

    await expect(line).rejects.toThrow("cancelled");
    expect(term.calls.slice(-2)).toEqual(["raw:false", "pause"]);
    expect(term.written).toEqual(["Password: ", "\n"]);
  });
});

describe("passwords are never accepted as arguments", () => {
  test.each([
    ["--password value", ["create", "--email", "ada@example.com", "--name", "Ada", "--password", PW]],
    ["--password=value", ["create", "--email", "ada@example.com", "--name", "Ada", `--password=${PW}`]],
    ["reset --password", ["reset-password", "--email", "ada@example.com", "--password", NEW_PW]],
  ])("%s is a usage error that explains why, and does not touch the database", async (_label, argv) => {
    const result = await run(argv);

    expect(result.code).toBe(2);
    const message = result.stderr.join("\n");
    expect(message).toContain("--password");
    expect(message).toContain("ADMIN_PASSWORD");
    expect(message).toContain("shell history"); // a phrase only the --password reason contains, not USAGE
    const tables = db.query("SELECT name FROM sqlite_master WHERE name = 'user'").all();
    expect(tables).toEqual([]);
  });

  test.each([
    ["-pVALUE", [`-p${ARG_SECRET}`]],
    ["-p VALUE", ["-p", ARG_SECRET]],
    ["--passwordVALUE", [`--password${ARG_SECRET}`]],
    ["--password=VALUE", [`--password=${ARG_SECRET}`]],
    ["--pass VALUE", ["--pass", ARG_SECRET]],
    ["--pwd=VALUE", [`--pwd=${ARG_SECRET}`]],
  ])("%s: exit 2 with the password-option reason, and the value is never echoed", async (_label, tokens) => {
    const result = await run(["create", "--email", "ada@example.com", "--name", "Ada", ...tokens]);

    expect(result.code).toBe(2);
    expect(result.stderr.join("\n")).toContain("shell history");
    expect(result.stdout.join("\n")).not.toContain(ARG_SECRET);
    expect(result.stderr.join("\n")).not.toContain(ARG_SECRET);
  });

  test("a completely unknown option exits 2 and its text is never echoed", async () => {
    const result = await run(["create", "--email", "ada@example.com", "--name", "Ada", `--foo=${ARG_SECRET}`]);

    expect(result.code).toBe(2);
    const message = result.stderr.join("\n");
    expect(message).toMatch(/unknown option/i);
    expect(message).toContain("create");
    expect(message).not.toContain("--foo");
    expect(message).not.toContain("shell history");
  });
});

describe("usage", () => {
  test("no arguments print usage on stderr and exit 2", async () => {
    const result = await run([]);

    expect(result.code).toBe(2);
    expect(result.stdout).toEqual([]);
    const usage = result.stderr.join("\n");
    expect(usage).toContain("Usage:");
    for (const command of ["create", "reset-password", "list"]) expect(usage).toContain(command);
    expect(usage).not.toContain("shell history"); // only the --password reason says this
  });

  test("an unknown subcommand exits 2 and is not echoed", async () => {
    const result = await run([PW]);

    expect(result.code).toBe(2);
    expect(result.stderr.join("\n")).toContain("Usage:");
  });

  test("create needs --email and --name", async () => {
    expect((await run(["create", "--name", "Ada"])).code).toBe(2);
    expect((await run(["create", "--email", "ada@example.com"])).code).toBe(2);
    expect((await run(["create", "--email", "", "--name", "Ada"])).code).toBe(2);
  });

  test("a malformed email is a usage error", async () => {
    expect((await run(["create", "--email", "not-an-email", "--name", "Ada"])).code).toBe(2);
    expect((await run(["reset-password", "--email", "nope"])).code).toBe(2);
  });

  test("an unknown option or a stray argument exits 2 and never echoes what was passed", async () => {
    const option = await run(["list", `--passwd=${PW}`]);
    const positional = await run(["create", "--email", "ada@example.com", "--name", "Ada", NEW_PW]);

    expect(option.code).toBe(2);
    expect(positional.code).toBe(2);
    expect(userCount()).toBe(0);
  });

  test("argument errors are reported before the database or the environment is touched", async () => {
    const explosive = new Proxy(
      {},
      {
        get() {
          throw new Error("touched before argument validation");
        },
      },
    );

    const stderr: string[] = [];
    const code = await runAdminCli(["bogus"], {
      db: explosive as unknown as Database,
      env: explosive as Record<string, string | undefined>,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("Usage:");
  });
});

describe("reset-password", () => {
  async function adminWithSessions(email = "ada@example.com") {
    await createAdmin(email);
    const first = cookieOf(await signIn(email, PW));
    const second = cookieOf(await signIn(email, PW));
    return { first, second };
  }

  test("an unknown email fails and changes nothing", async () => {
    await createAdmin("ada@example.com");
    const before = passwordHash("ada@example.com");

    const result = await run(["reset-password", "--email", "ghost@example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("ghost@example.com");
    expect(passwordHash("ada@example.com")).toBe(before);
    expect(userCount()).toBe(1);
  });

  test("sets the new password: the old one stops working and the new one signs in", async () => {
    await createAdmin("ada@example.com");

    const result = await run(["reset-password", "--email", "ada@example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(0);
    expect((await signIn("ada@example.com", PW)).status).toBe(401);
    const fresh = await signIn("ada@example.com", NEW_PW);
    expect(fresh.status).toBe(200);
    expect(((await fresh.json()) as { user: { role: string } }).user.role).toBe("admin");
  });

  test("revokes every session of that admin: existing cookies stop resolving", async () => {
    const { first, second } = await adminWithSessions();
    expect((await sessionFor(first))?.user.role).toBe("admin");
    expect((await sessionFor(second))?.user.role).toBe("admin");
    expect(sessionCount("ada@example.com")).toBe(2);

    const result = await run(["reset-password", "--email", "ada@example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(0);
    expect(sessionCount("ada@example.com")).toBe(0);
    expect(await sessionFor(first)).toBeNull();
    expect(await sessionFor(second)).toBeNull();
  });

  test("does not touch other users' sessions", async () => {
    await adminWithSessions();
    await seedContributor("carol@example.com", OTHER_PW, "Carol");
    const carol = cookieOf(await signIn("carol@example.com", OTHER_PW));
    const sessionsBefore = sessionCount("carol@example.com"); // sign-up opened one, sign-in another
    expect(sessionsBefore).toBeGreaterThan(0);

    await run(["reset-password", "--email", "ada@example.com"], { env: { ...ENV, ADMIN_PASSWORD: NEW_PW } });

    expect((await sessionFor(carol))?.user.email).toBe("carol@example.com");
    expect(sessionCount("carol@example.com")).toBe(sessionsBefore);
  });

  test("uses the password from the prompt when ADMIN_PASSWORD is unset", async () => {
    await createAdmin("ada@example.com");
    let prompts = 0;

    const result = await run(["reset-password", "--email", "ada@example.com"], {
      env: { ...ENV },
      prompt: async () => {
        prompts += 1;
        return NEW_PW;
      },
    });

    expect(result.code).toBe(0);
    expect(prompts).toBe(1);
    expect((await signIn("ada@example.com", NEW_PW)).status).toBe(200);
  });

  test("email case does not matter", async () => {
    await createAdmin("ada@example.com");

    const result = await run(["reset-password", "--email", "ADA@Example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(0);
    expect((await signIn("ada@example.com", NEW_PW)).status).toBe(200);
  });

  test("a too-short new password is refused and nothing changes", async () => {
    const { first } = await adminWithSessions();
    const before = passwordHash("ada@example.com");

    const result = await run(["reset-password", "--email", "ada@example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: "short1" },
    });

    expect(result.code).toBe(1);
    expect(passwordHash("ada@example.com")).toBe(before);
    expect((await sessionFor(first))?.user.role).toBe("admin");
  });

  test("refuses a contributor: not an admin, password and sessions untouched", async () => {
    await seedContributor("carol@example.com", OTHER_PW, "Carol");
    const carol = cookieOf(await signIn("carol@example.com", OTHER_PW));
    const before = passwordHash("carol@example.com");

    const result = await run(["reset-password", "--email", "carol@example.com"], {
      env: { ...ENV, ADMIN_PASSWORD: NEW_PW },
    });

    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toMatch(/not an admin/i);
    expect(passwordHash("carol@example.com")).toBe(before);
    expect((await signIn("carol@example.com", OTHER_PW)).status).toBe(200);
    expect((await signIn("carol@example.com", NEW_PW)).status).toBe(401);
    expect(await sessionFor(carol)).not.toBeNull();
  });

  test("refuses an anonymous player", async () => {
    await ensureAuthSchema(auth(), db);
    const res = await auth().handler(
      new Request(`${ORIGIN}/api/auth/sign-in/anonymous`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }),
    );
    const { user } = (await res.json()) as { user: { id: string } };
    const email = (db.query("SELECT email FROM user WHERE id = ?").get(user.id) as { email: string }).email;

    const result = await run(["reset-password", "--email", email], { env: { ...ENV, ADMIN_PASSWORD: NEW_PW } });

    expect(result.code).toBe(1);
    expect(await sessionFor(cookieOf(res))).not.toBeNull();
    expect(sessionCount(email)).toBe(1);
  });

  test("does not promote or demote anyone", async () => {
    await createAdmin("ada@example.com");

    await run(["reset-password", "--email", "ada@example.com"], { env: { ...ENV, ADMIN_PASSWORD: NEW_PW } });

    expect(userRow("ada@example.com")?.role).toBe("admin");
  });
});

describe("list", () => {
  test("on a database with no auth tables yet it prints nothing and succeeds", async () => {
    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([]);
  });

  test("prints admins only, one per line as email, name and created date", async () => {
    await createAdmin("ada@example.com", "Ada Admin");
    await createAdmin("bob@example.com", "Bob Boss");
    await seedContributor("carol@example.com", OTHER_PW, "Carol Contributor");
    await auth().handler(
      new Request(`${ORIGIN}/api/auth/sign-in/anonymous`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{}",
      }),
    );

    const result = await run(["list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(2);
    const [ada, bob] = result.stdout.map((line) => line.split("\t"));
    expect(ada?.slice(0, 2)).toEqual(["ada@example.com", "Ada Admin"]);
    expect(bob?.slice(0, 2)).toEqual(["bob@example.com", "Bob Boss"]);
    expect(ada?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ada).toHaveLength(3);
    const output = result.stdout.join("\n");
    expect(output).not.toContain("carol@example.com");
    expect(output).not.toMatch(/temp/i);
  });

  test("never prints password hashes or user ids", async () => {
    await createAdmin("ada@example.com");

    const output = (await run(["list"])).stdout.join("\n");

    expect(output).not.toContain(passwordHash("ada@example.com") as string);
    expect(output).not.toContain(userRow("ada@example.com")?.id as string);
    expect(output).not.toContain(":"); // Better Auth hashes are "salt:key"
  });

  test("list rejects arguments it does not take", async () => {
    expect((await run(["list", "--email", "ada@example.com"])).code).toBe(2);
  });
});

describe("as a real process", () => {
  const decode = async (stream: ReadableStream<Uint8Array>) => new Response(stream).text();

  async function spawnCli(args: string[], env: Record<string, string>, stdin?: string) {
    const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? dir, ...env },
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([decode(proc.stdout), decode(proc.stderr), proc.exited]);
    return { stdout, stderr, code };
  }

  test("no arguments: exit 2 with a usage line on stderr, before any database is opened", async () => {
    const dbPath = join(dir, "never", "app.db");

    const result = await spawnCli([], { APP_DB_PATH: dbPath });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.stdout).toBe("");
    expect(existsSync(join(dir, "never"))).toBe(false);
  });

  test("a mistyped password option is never echoed by the real process", async () => {
    const dbPath = join(dir, "never", "app.db");

    const result = await spawnCli(
      ["create", `-p${ARG_SECRET}`, "--email", "a@x.com", "--name", "A"],
      { NODE_ENV: "test", APP_DB_PATH: dbPath },
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("shell history");
    expect(result.stdout).not.toContain(ARG_SECRET);
    expect(result.stderr).not.toContain(ARG_SECRET);
  });

  test("an unopenable APP_DB_PATH is a one-line error and exit 1, not a stack trace", async () => {
    const blocker = join(dir, "afile");
    writeFileSync(blocker, "not a directory");

    const result = await spawnCli(["list"], { NODE_ENV: "test", APP_DB_PATH: join(blocker, "x.db") });

    expect(result.code).toBe(1);
    const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("Error:");
    expect(result.stderr).not.toMatch(/^\s+at /m);
    expect(result.stdout).toBe("");
  });

  test("create, list and reset-password work under production config, reading the password from stdin", async () => {
    const dbPath = join(dir, "prod.db");
    const env = {
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: `${crypto.randomUUID()}${crypto.randomUUID()}`,
      BETTER_AUTH_URL: "https://coach.example",
      APP_DB_PATH: dbPath,
    };

    const created = await spawnCli(["create", "--email", "ada@example.com", "--name", "Ada"], env, `${PW}\n`);
    const listed = await spawnCli(["list"], env);
    const reset = await spawnCli(["reset-password", "--email", "ada@example.com"], { ...env, ADMIN_PASSWORD: NEW_PW });
    const missingSecret = await spawnCli(["list"], { NODE_ENV: "production", APP_DB_PATH: dbPath });

    expect(created.code).toBe(0);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("ada@example.com");
    expect(reset.code).toBe(0);
    expect(missingSecret.code).toBe(1);
    for (const result of [created, listed, reset, missingSecret]) {
      for (const marker of MARKERS) {
        expect(result.stdout).not.toContain(marker);
        expect(result.stderr).not.toContain(marker);
      }
    }
    const handle = openDatabase(dbPath);
    opened.push(handle);
    const row = handle.query("SELECT role FROM user WHERE email = 'ada@example.com'").get() as { role: string };
    expect(row.role).toBe("admin");
  }, 60_000);
});
