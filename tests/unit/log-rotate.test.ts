import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rolloverIfTooLarge, DEFAULT_LOG_CAP_BYTES } from "../../src/log-rotate.js";

const tmpDirs: string[] = [];

function makeTmpFile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "chat4000-log-rotate-"));
  tmpDirs.push(dir);
  return path.join(dir, "test.log");
}

afterEach(() => {
  // Best-effort cleanup; OS clears tmpdir eventually if anything leaks.
  for (const dir of tmpDirs.splice(0)) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("rolloverIfTooLarge", () => {
  it("does nothing when the file is below the cap", () => {
    const file = makeTmpFile();
    writeFileSync(file, "abc\n");
    rolloverIfTooLarge(file, 1000);
    expect(readFileSync(file, "utf8")).toBe("abc\n");
  });

  it("does nothing when the file does not exist", () => {
    const file = makeTmpFile();
    expect(() => rolloverIfTooLarge(file, 1000)).not.toThrow();
  });

  it("truncates to a single marker line when at or above the cap", () => {
    const file = makeTmpFile();
    writeFileSync(file, "x".repeat(2000));
    rolloverIfTooLarge(file, 1000);
    const after = readFileSync(file, "utf8");
    expect(after).toMatch(/log\.rolled_over previous_size=2000 cap=1000/);
    expect(statSync(file).size).toBeLessThan(1000);
  });

  it("uses a 10 MB default cap", () => {
    expect(DEFAULT_LOG_CAP_BYTES).toBe(10 * 1024 * 1024);
  });

  it("re-rolls a file that has grown back above the cap", () => {
    const file = makeTmpFile();
    writeFileSync(file, "x".repeat(2000));
    rolloverIfTooLarge(file, 1000);
    writeFileSync(file, "y".repeat(2000));
    rolloverIfTooLarge(file, 1000);
    const after = readFileSync(file, "utf8");
    expect(after).toMatch(/log\.rolled_over previous_size=2000 cap=1000/);
    expect(after).not.toContain("yyyy");
  });
});
