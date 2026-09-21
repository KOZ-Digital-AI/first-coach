import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";

function Greeting({ name }: { name: string }) {
  return <p>Hello, {name}</p>;
}

describe("web test setup", () => {
  test("renders a component into the happy-dom document", () => {
    render(<Greeting name="coach" />);

    expect(screen.getByText("Hello, coach")).toBeTruthy();
    expect(screen.getAllByText("Hello, coach")).toHaveLength(1);
  });

  test("cleans up the previous test's DOM so only one match exists", () => {
    render(<Greeting name="coach" />);

    expect(screen.getByText("Hello, coach")).toBeTruthy();
    expect(screen.getAllByText("Hello, coach")).toHaveLength(1);
  });
});

/*
 * Cross-file hygiene of the shared preload (fc-mol-eay.15). Every web test file runs in ONE process with ONE happy-dom window, and
 * happy-dom records every element query it answers in bookkeeping on the document, <html>, <body> (`affectsCache`,
 * `affectsComputedStyleCache`) and on the window (`querySelectorCache`) without ever trimming it. Files with thousands of Testing
 * Library queries left 6k-22k entries there, which made a later file's failing `expect(element)` (bun pretty-prints the element
 * with those caches) run for seconds and blow its timeout. setup.ts empties them after every test.
 */
const CACHE_NAMES = ["affectsCache", "affectsComputedStyleCache", "querySelectorCache"];

/** The number of entries happy-dom's query bookkeeping holds right now (0 when this happy-dom version has none of it). */
function happyDomCacheEntries(): number {
  let total = 0;
  for (const target of [document, document.documentElement, document.body, window] as object[]) {
    for (const symbol of Object.getOwnPropertySymbols(target)) {
      if (!CACHE_NAMES.includes(symbol.description ?? "")) continue;
      const value: unknown = (target as Record<symbol, unknown>)[symbol];
      if (Array.isArray(value)) total += value.length;
      else if (value instanceof Map) total += value.size;
    }
  }
  return total;
}

describe("web test setup: happy-dom query bookkeeping does not pile up across tests", () => {
  test("a heavy render and many queries do fill happy-dom's bookkeeping (the precondition of the next test)", () => {
    render(
      <ul>
        {Array.from({ length: 40 }, (_, i) => (
          <li key={i} className={`row-${i}`}>
            row {i}
          </li>
        ))}
      </ul>,
    );
    for (let i = 0; i < 120; i++) {
      screen.queryByText(`row ${i % 40}`);
      screen.queryAllByRole("listitem");
      document.querySelectorAll(`.row-${i % 40}`);
    }

    expect(happyDomCacheEntries()).toBeGreaterThan(100);
  });

  test("the next test starts with that bookkeeping emptied", () => {
    expect(happyDomCacheEntries()).toBe(0);
  });
});
