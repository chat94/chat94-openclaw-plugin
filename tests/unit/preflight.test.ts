import { describe, expect, it } from "vitest";
import { formatPreflight, type UpdatePreflight } from "../../src/update/preflight.js";

const base: UpdatePreflight = {
  packageName: "@chat4000/openclaw-plugin",
  currentVersion: "2.0.0",
  latestVersion: "2.1.0",
  updatable: true,
  newerAvailable: true,
  restartMethod: "docker",
  probes: [
    { name: "version", status: "ok", detail: "newer version 2.1.0 available (have 2.0.0)" },
    { name: "writable", status: "ok", detail: "install dir is writable" },
  ],
};

describe("formatPreflight", () => {
  it("renders YES when updatable", () => {
    const out = formatPreflight(base);
    expect(out).toContain("current: 2.0.0");
    expect(out).toContain("latest:  2.1.0");
    expect(out).toContain("updatable: YES");
  });

  it("renders 'up to date' when nothing newer", () => {
    const out = formatPreflight({
      ...base,
      latestVersion: "2.0.0",
      updatable: false,
      newerAvailable: false,
    });
    expect(out).toContain("already up to date");
  });

  it("renders blocked when newer exists but a probe blocks", () => {
    const out = formatPreflight({
      ...base,
      updatable: false,
      probes: [
        { name: "version", status: "ok", detail: "newer 2.1.0" },
        { name: "writable", status: "blocked", detail: "install dir is not writable" },
      ],
    });
    expect(out).toContain("a probe is blocking");
    expect(out).toContain("✗ writable");
  });
});
