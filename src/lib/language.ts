/** Map a file path to a Monaco language id. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  json: "json",
  jsonc: "json",
  json5: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "html",
  svelte: "html",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sql: "sql",
  lua: "lua",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  dart: "dart",
  r: "r",
  scala: "scala",
  pl: "perl",
  dockerfile: "dockerfile",
  graphql: "graphql",
  gql: "graphql",
};

const FILENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "plaintext",
  ".gitignore": "plaintext",
  ".env": "plaintext",
};

export function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (FILENAME_TO_LANG[name]) return FILENAME_TO_LANG[name];
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return EXT_TO_LANG[ext] ?? "plaintext";
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirname(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/");
}

/** Monaco language id -> the LSP server id (from the main-process registry). */
export function serverIdForLanguage(lang: string): string | null {
  switch (lang) {
    case "typescript":
    case "javascript":
      return "typescript";
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust-analyzer";
    case "json":
      return "json";
    case "html":
      return "html";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "shell":
      return "bash";
    default:
      return null;
  }
}
