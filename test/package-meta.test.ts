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

describe("Package metadata — files allowlist", () => {
  it("files array is defined", () => {
    expect(Array.isArray(pkg.files)).toBe(true);
  });

  it("files includes src/", () => {
    expect(pkg.files).toContain("src/");
  });

  it("files includes README.md", () => {
    expect(pkg.files).toContain("README.md");
  });

  it("files includes LICENSE", () => {
    expect(pkg.files).toContain("LICENSE");
  });

  it("files does NOT include test/", () => {
    expect(pkg.files).not.toContain("test/");
  });

  it("files does NOT include .github", () => {
    expect(pkg.files).not.toContain(".github");
  });

  it("files does NOT include node_modules", () => {
    expect(pkg.files).not.toContain("node_modules");
  });

  it("exports target is inside a file listed in files", () => {
    const exportTarget = Object.values(pkg.exports)[0] as string;
    // The export target starts with "./src/" which is covered by the "src/" entry
    const exportDir = exportTarget.replace(/^\.\//, "").split("/")[0] + "/";
    expect(pkg.files).toContain(exportDir);
  });
});
