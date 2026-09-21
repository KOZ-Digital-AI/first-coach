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
