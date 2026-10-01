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

describe("Package metadata — main entry", () => {
  it("main points at a file that actually exists", async () => {
    // Regression: `main` was "index.js", which does not exist. Tools that
    // resolve only `main` (ignoring the `exports` map) therefore failed to
    // load the plugin — opencode silently skipped it with no error, which is
    // why the plugin could not be used as a path plugin without a wrapper.
    const mainPath = new URL(`../${pkg.main}`, import.meta.url);
    await expect(readFile(mainPath, "utf8")).resolves.toBeDefined();
  });

  it("main and exports['.'] agree on the entry point", () => {
    const normalize = (p: string) => p.replace(/^\.\//, "");
    expect(normalize(pkg.main)).toBe(normalize(pkg.exports["."] as string));
  });
});

describe("Package metadata — entrypoint coverage", () => {
  /**
   * npm `files` semantics: an entry is published if it exactly matches an
   * allowlist entry, or if it sits inside an allowlisted directory prefix
   * (e.g. "src/" covers "src/index.ts"). package.json is always published
   * regardless.
   */
  function coveredByFiles(relativePath: string): boolean {
    const p = relativePath.replace(/^\.\//, "");
    if (p === "package.json") return true;
    return pkg.files.some((entry) => {
      if (entry === p) return true;
      if (entry.endsWith("/")) return p.startsWith(entry);
      // An allowlisted file cannot implicitly cover a different path.
      return false;
    });
  }

  it("every entrypoint is covered by the files allowlist", () => {
    // The opencode path-plugin loader resolves a local directory to
    // `<dir>/index.*` and NEVER reads package.json `main`. So `index.ts` is a
    // genuine runtime entrypoint and must be published, otherwise a local/dev
    // install works while the published package silently fails to load.
    const PATH_PLUGIN_ENTRY = "index.ts";

    const entrypoints = [
      { name: "main", target: pkg.main },
      { name: 'exports["."]', target: pkg.exports["."] as string },
      { name: 'exports["./package.json"]', target: pkg.exports["./package.json"] as string },
      { name: "opencode path-plugin entry", target: PATH_PLUGIN_ENTRY },
    ];

    for (const { name, target } of entrypoints) {
      expect(
        coveredByFiles(target),
        `Entrypoint ${name} -> "${target}" is NOT covered by the files allowlist, ` +
          `so it would be missing from the published package`,
      ).toBe(true);
    }
  });

  it("the path-plugin entrypoint exists on disk", async () => {
    // Guards the allowlist entry against pointing at a file that isn't there.
    await expect(
      readFile(new URL("../index.ts", import.meta.url), "utf8"),
    ).resolves.toBeDefined();
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

describe("Package metadata — version consistency", () => {
  it("package.json version is a valid semver string", () => {
    const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?(?:\+[a-zA-Z0-9.]+)?$/;
    expect(pkg.version).toMatch(SEMVER_RE);
  });

  it("source files do not contain hardcoded version strings", async () => {
    const indexSrc = await readFile("src/index.ts", "utf-8");
    const registerSrc = await readFile("src/tools/register.ts", "utf-8");
    // The only version string should come from package.json import, not a literal.
    // Pattern: a quoted semver that is NOT inside an import statement.
    const HARDCODED_RE = /(?<!import\s.*from\s.*)"[0-9]+\.[0-9]+\.[0-9]+"/g;
    expect(indexSrc).not.toMatch(HARDCODED_RE);
    expect(registerSrc).not.toMatch(HARDCODED_RE);
  });

  it("both source files import version from package.json", async () => {
    const indexSrc = await readFile("src/index.ts", "utf-8");
    const registerSrc = await readFile("src/tools/register.ts", "utf-8");
    expect(indexSrc).toContain('from "../package.json"');
    expect(registerSrc).toContain('from "../../package.json"');
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
