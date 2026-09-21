import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (name: string): string => readFileSync(join(repoRoot, name), "utf8");

describe("LICENSE (software, MIT)", () => {
  test("starts with the MIT License heading", () => {
    expect(read("LICENSE").split("\n")[0]).toBe("MIT License");
  });

  test("contains the MIT permission grant marker", () => {
    expect(read("LICENSE")).toContain("Permission is hereby granted, free of charge");
  });

  test("names the copyright holder", () => {
    expect(read("LICENSE")).toContain(
      "Copyright (c) 2026 KOZ AI and FIRST COACH contributors",
    );
  });
});

describe("CONTENT-LICENSE.md (knowledge, CC BY-SA 4.0)", () => {
  test("links the CC BY-SA 4.0 licence URL", () => {
    expect(read("CONTENT-LICENSE.md")).toContain(
      "https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });

  test("states that config/commons content is CC BY-SA 4.0", () => {
    const text = read("CONTENT-LICENSE.md");
    expect(text).toContain("config/commons");
    expect(text).toContain("CC BY-SA 4.0");
  });

  test("gives the attribution line to use", () => {
    expect(read("CONTENT-LICENSE.md")).toContain(
      "Source: Open Sport Commons by FIRST COACH (KOZ AI) and contributors, licensed CC BY-SA 4.0 — https://creativecommons.org/licenses/by-sa/4.0/",
    );
  });

  test("points the software to the MIT LICENSE file", () => {
    const text = read("CONTENT-LICENSE.md");
    expect(text).toContain("MIT");
    expect(text).toContain("LICENSE");
  });
});
