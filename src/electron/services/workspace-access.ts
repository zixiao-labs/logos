import { promises as fs } from "node:fs";
import path from "node:path";

export type WorkspaceAccessMode = "read" | "write";

interface PathGrant {
  path: string;
  modes: ReadonlySet<WorkspaceAccessMode>;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalizeCandidate(candidate: string): Promise<string> {
  if (
    !path.isAbsolute(candidate) ||
    candidate.includes("\0") ||
    candidate.length > 4_096
  ) {
    throw new Error("File access requires a valid absolute path.");
  }

  const resolved = path.resolve(candidate);
  let cursor = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const real = await fs.realpath(cursor);
      return path.resolve(real, ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * Main-process authority for workbench file access. Renderer-provided paths are
 * accepted only below the canonical workspace root or through an exact path
 * grant created by a native file dialog.
 */
export class WorkspaceAccessController {
  private root: string | null = null;
  private grants: PathGrant[] = [];
  private initialization: Promise<void> = Promise.resolve();

  setInitialization(initialization: Promise<unknown>): void {
    this.initialization = initialization.then(() => undefined);
  }

  currentRoot(): string | null {
    return this.root;
  }

  async canonicalize(candidate: string): Promise<string> {
    return canonicalizeCandidate(candidate);
  }

  async restoreWorkspaceRoot(candidate: string | null): Promise<string | null> {
    if (candidate == null) {
      this.root = null;
      this.grants = [];
      return null;
    }
    const canonical = await canonicalizeCandidate(candidate);
    const stat = await fs.stat(canonical);
    if (!stat.isDirectory()) throw new Error("Workspace root must be a directory.");
    this.root = canonical;
    this.grants = [];
    return canonical;
  }

  async grantPath(
    candidate: string,
    modes: readonly WorkspaceAccessMode[] = ["read", "write"],
  ): Promise<string> {
    await this.initialization;
    const canonical = await canonicalizeCandidate(candidate);
    const existing = this.grants.find(grant => grant.path === canonical);
    const combined = new Set<WorkspaceAccessMode>([
      ...(existing?.modes ?? []),
      ...modes,
    ]);
    this.grants = [
      ...this.grants.filter(grant => grant.path !== canonical),
      { path: canonical, modes: combined },
    ];
    return canonical;
  }

  async assertPath(
    candidate: string,
    mode: WorkspaceAccessMode = "read",
  ): Promise<string> {
    await this.initialization;
    const canonical = await canonicalizeCandidate(candidate);
    if (this.root && isInside(this.root, canonical)) return canonical;
    if (
      this.grants.some(
        grant => grant.path === canonical && grant.modes.has(mode),
      )
    ) {
      return canonical;
    }
    throw new Error("File access is outside the current workspace or dialog grant.");
  }

  async assertWorkspaceRoot(candidate: string): Promise<string> {
    await this.initialization;
    if (!this.root) throw new Error("No workspace is open.");
    const canonical = await canonicalizeCandidate(candidate);
    if (canonical !== this.root) {
      throw new Error("Request root does not match the current workspace.");
    }
    return canonical;
  }
}
