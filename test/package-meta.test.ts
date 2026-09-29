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
import { readFile } from "node:fs/promises";
import pkg from "../package.json" with { type: "json" };

describe("Package metadata — scoped name", () => {
  it("package.json name is the scoped @serkanalgur/residue", () => {
    expect(pkg.name).toBe("@serkanalgur/residue");
  });

  it("repository.url points at the GitHub repo", () => {
    expect(pkg.repository.url).toBe("git+https://github.com/serkanalgur/residue.git");
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

describe("Package metadata — exports map", () => {
  it('exports["."] points at ./src/index.ts', () => {
    expect(pkg.exports["."]).toBe("./src/index.ts");
  });

  it('exports["./package.json"] points at ./package.json', () => {
    expect(pkg.exports["./package.json"]).toBe("./package.json");
  });

  it("every export value is covered by the files allowlist (or implicitly included)", () => {
    // npm always includes package.json regardless of the files array, so treat
    // it as implicitly covered even though it is not listed in files.
    const IMPLICITLY_INCLUDED = new Set(["package.json"]);

    for (const [key, target] of Object.entries(pkg.exports)) {
      const relative = (target as string).replace(/^\.\//, "");

      if (IMPLICITLY_INCLUDED.has(relative)) continue;

      // Extract the top-level directory or exact filename from the target path.
      const segments = relative.split("/");
      const dirOrFile = segments.length > 1 ? segments[0] + "/" : relative;

      expect(
        pkg.files,
        `Export "${key}" -> "${target}" is not covered by the files allowlist`,
      ).toContain(dirOrFile);
    }
  });

  it("version is a valid semver string and is not 0.0.0", () => {
    // Strict semver: MAJOR.MINOR.PATCH with optional pre-release / build metadata.
    const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;
    expect(pkg.version).toMatch(SEMVER_RE);
    expect(pkg.version).not.toBe("0.0.0");
  });
});

describe("Package metadata — changelog", () => {
  it("files includes CHANGELOG.md", () => {
    expect(pkg.files).toContain("CHANGELOG.md");
  });

  it("version is a valid semver string and is not 0.0.0", () => {
    const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;
    expect(pkg.version).toMatch(SEMVER_RE);
    expect(pkg.version).not.toBe("0.0.0");
  });

  it("README contains a link to the changelog", async () => {
    const readme = await readFile("README.md", "utf-8");
    expect(readme).toContain("CHANGELOG.md");
  });
});
