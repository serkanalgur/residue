/**
 * Regression tests for package.json metadata.
 *
 * Ensures the published package name stays scoped and that required
 * npm registry metadata is present. These tests will fail if the name
 * is reverted to the unscoped "residue" form.
 *
 * @module test/package-meta
 */

import { describe, it, expect } from "bun:test";
import pkg from "../package.json" with { type: "json" };

describe("Package metadata — scoped name", () => {
  it("package.json name is the scoped @serkanalgur/residue", () => {
    expect(pkg.name).toBe("@serkanalgur/residue");
  });

  it("repository.url points at the GitHub repo", () => {
    expect(pkg.repository.url).toBe("https://github.com/serkanalgur/residue.git");
  });

  it("publishConfig.access is public", () => {
    expect(pkg.publishConfig.access).toBe("public");
  });

  it("bugs.url is set to the GitHub issues page", () => {
    expect(pkg.bugs.url).toBe("https://github.com/serkanalgur/residue/issues");
  });

  it("homepage points at the GitHub repo", () => {
    expect(pkg.homepage).toBe("https://github.com/serkanalgur/residue");
  });
});
