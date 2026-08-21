export type BreadcrumbKind = "folder" | "file";

export interface BreadcrumbItem {
  label: string;
  path: string;
  kind: BreadcrumbKind;
}

function joinCanonical(directory: string, relativePath: string): string {
  const base = canonicalPath(directory);
  const relative = relativePath.replace(/^\/+/, "");
  return canonicalPath(`${base === "/" ? "" : base}/${relative}`);
}

/** Use one separator for comparisons and renderer-side filesystem calls. */
export function canonicalPath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

export function pathIsWithin(path: string, directory: string): boolean {
  const candidate = canonicalPath(path);
  const parent = canonicalPath(directory);
  const caseInsensitive =
    /^[A-Za-z]:\//.test(candidate) || /^[A-Za-z]:\//.test(parent);
  const comparableCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
  const comparableParent = caseInsensitive ? parent.toLowerCase() : parent;
  if (comparableParent === "/") return comparableCandidate.startsWith("/");
  return (
    comparableCandidate === comparableParent ||
    comparableCandidate.startsWith(`${comparableParent}/`)
  );
}

export function workspaceRootForPath(
  path: string,
  workspaceFolders: string[],
  fallbackRoot: string | null,
): string | null {
  const roots = [
    ...workspaceFolders,
    ...(fallbackRoot ? [fallbackRoot] : []),
  ]
    .map(canonicalPath)
    .filter((root, index, all) => all.indexOf(root) === index)
    .filter((root) => pathIsWithin(path, root))
    .sort((left, right) => right.length - left.length);
  return roots[0] ?? null;
}

export function buildBreadcrumbs(
  path: string,
  workspaceFolders: string[],
  fallbackRoot: string | null,
): BreadcrumbItem[] {
  const filePath = canonicalPath(path);
  const workspaceRoot = workspaceRootForPath(
    filePath,
    workspaceFolders,
    fallbackRoot,
  );
  const relativePath = workspaceRoot
    ? filePath.slice(workspaceRoot.length).replace(/^\/+/, "")
    : filePath.replace(/^\/+/, "");
  const segments = relativePath.split("/").filter(Boolean);

  return segments.map((label, index) => {
    const isFile = index === segments.length - 1;
    const itemPath = workspaceRoot
      ? joinCanonical(
          workspaceRoot,
          segments.slice(0, index + 1).join("/"),
        )
      : filePath.startsWith("/")
        ? `/${segments.slice(0, index + 1).join("/")}`
        : segments.slice(0, index + 1).join("/");
    return {
      label,
      path: canonicalPath(itemPath),
      kind: isFile ? "file" : "folder",
    };
  });
}

export function directoriesToReveal(
  path: string,
  isDirectory: boolean,
  workspaceRoot: string,
): string[] {
  const root = canonicalPath(workspaceRoot);
  const target = canonicalPath(path);
  const directory = isDirectory
    ? target
    : target.includes("/")
      ? target.slice(0, target.lastIndexOf("/")) || "/"
      : target;
  if (!pathIsWithin(directory, root)) return [];
  const relative = directory.slice(root.length).replace(/^\/+/, "");
  const segments = relative.split("/").filter(Boolean);
  const directories = [root];
  for (let index = 0; index < segments.length; index += 1) {
    directories.push(
      joinCanonical(root, segments.slice(0, index + 1).join("/")),
    );
  }
  return directories;
}
