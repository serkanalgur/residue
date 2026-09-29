/**
 * Tests for data directory resolution with injected environment.
 *
 * @module test/paths
 */

import { describe, it, expect } from "bun:test";
import { resolveDataDir, type Env } from "../src/paths.js";

/**
 * Create a mock Env with controllable behavior.
 */
function createMockEnv(overrides: Partial<Env> = {}): Env & { writableDirs: Set<string> } {
  const writableDirs = new Set<string>();
  const env: Env & { writableDirs: Set<string> } = {
    env: (_name: string) => undefined,
    homedir: () => "/home/testuser",
    tmpdir: () => "/tmp",
    isWritable: async (path: string) => writableDirs.has(path),
    writableDirs,
    ...overrides,
  };
  // Make sure override's writableDirs is the one we use
  env.writableDirs = writableDirs;
  env.isWritable = async (path: string) => writableDirs.has(path);
  return env;
}

describe("resolveDataDir", () => {
  it("uses XDG_DATA_HOME when set and writable", async () => {
    const env = createMockEnv();
    env.env = (name: string) => (name === "XDG_DATA_HOME" ? "/custom/xdg" : undefined);
    env.writableDirs.add("/custom/xdg/residue");

    const paths = await resolveDataDir({ dataDir: "xdg" }, "proj-123", "/my/project", env);
    expect(paths.base).toBe("/custom/xdg/residue");
    expect(paths.globalDb).toContain("global.db");
    expect(paths.projectDb).toContain("project-proj-123.db");
  });

  it("falls back to ~/.local/share when XDG is not writable", async () => {
    const env = createMockEnv();
    env.writableDirs.add("/home/testuser/.local/share/residue");

    const paths = await resolveDataDir({ dataDir: "xdg" }, "proj-456", "/my/project", env);
    expect(paths.base).toBe("/home/testuser/.local/share/residue");
  });

  it("falls back to tmpdir when home is not writable", async () => {
    const env = createMockEnv();
    // Ensure mkdir succeeds for tmpdir
    env.writableDirs.add("/tmp/residue");

    const paths = await resolveDataDir({ dataDir: "xdg" }, "proj-789", "/my/project", env);
    expect(paths.base).toBe("/tmp/residue");
  });

  it("uses project dir when dataDir=project and writable", async () => {
    const warnings: string[] = [];
    const env = createMockEnv();
    const projectDir = "/my/project";
    env.writableDirs.add(`${projectDir}/.opencode/residue`);

    const paths = await resolveDataDir(
      { dataDir: "project" },
      "proj-proj",
      projectDir,
      env,
      (msg: string) => warnings.push(msg),
    );
    expect(paths.base).toBe(`${projectDir}/.opencode/residue`);
    expect(warnings.some((w) => w.includes("project directory"))).toBe(true);
  });

  it("warns about temp directory usage", async () => {
    const warnings: string[] = [];
    const env = createMockEnv();
    env.writableDirs.add("/tmp/residue");

    await resolveDataDir(
      { dataDir: "xdg" },
      "proj-temp",
      "/my/project",
      env,
      (msg: string) => warnings.push(msg),
    );
    expect(warnings.some((w) => w.includes("temp directory"))).toBe(true);
  });
});
