import type {
  ExtensionRegistryIndex,
  ExtensionRegistryPackage,
  LogosExtensionManifest,
} from "@logos-editor/extension-api";
import { z } from "zod";

const MANIFEST_MAX_BYTES = 1024 * 1024;
const REGISTRY_MAX_BYTES = 2 * 1024 * 1024;
const JSON_MAX_DEPTH = 32;
const JSON_MAX_NODES = 20_000;
const JSON_MAX_ARRAY_ITEMS = 4_096;
const JSON_MAX_OBJECT_FIELDS = 1_024;
const JSON_MAX_STRING_BYTES = 256 * 1024;

const packagePart = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/, "must use lowercase letters, digits, and hyphens");
const extensionId = z
  .string()
  .min(3)
  .max(129)
  .regex(
    /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/,
    "must be publisher.name",
  );
const semanticVersion = z
  .string()
  .max(128)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
const logosEngineRange = z
  .string()
  .max(64)
  .regex(
    /^(?:\*|[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/,
    "must be *, an exact version, or a ^/~ version range",
  );
const shortText = z.string().min(1).max(256).refine(value => !value.includes("\0"));
const description = z.string().min(1).max(4_096).refine(value => !value.includes("\0"));
const reason = z.string().min(1).max(512).refine(value => !value.includes("\0"));
const logicalId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._-]*$/);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function normalizeSafePackagePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Invalid ${label}: expected a relative POSIX path.`);
  }
  const parts = value.split("/");
  if (parts.some(part => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Invalid ${label}: path traversal is not allowed.`);
  }
  return parts.join("/");
}

function safePackagePath(label: string) {
  return z.string().transform((value, context) => {
    try {
      return normalizeSafePackagePath(value, label);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : `Invalid ${label}.`,
      });
      return z.NEVER;
    }
  });
}

const glob = z
  .string()
  .min(1)
  .max(256)
  .refine(value => !value.includes("\0") && !value.includes("\\"))
  .refine(value => !value.startsWith("/") && !/^[A-Za-z]:/.test(value))
  .refine(value =>
    !value.split("/").some(part => part.length === 0 || part === "." || part === ".."),
  );
const globList = z.array(glob).min(1).max(128);
const exactOrigin = z.string().max(512).transform((value, context) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be an absolute URL origin" });
    return z.NEVER;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.includes("*")
  ) {
    context.addIssue({
      code: "custom",
      message: "must be an exact HTTPS origin without credentials or path",
    });
    return z.NEVER;
  }
  if (!url.hostname.startsWith("[") && url.hostname.endsWith(".")) {
    url.hostname = url.hostname.slice(0, -1);
  }
  return url.origin;
});
const originList = z.array(exactOrigin).min(1).max(64);

const workspaceReadPermission = z
  .object({
    id: z.literal("workspace.read"),
    scope: z
      .object({
        globs: globList,
        maxBytes: positiveInteger.optional(),
        includeHidden: z.boolean().optional(),
        sensitive: z.literal(false).optional(),
      })
      .strict(),
    reason,
  })
  .strict();
const workspaceWritePermission = z
  .object({
    id: z.literal("workspace.write"),
    scope: z
      .object({
        globs: globList,
        operations: z
          .array(z.enum(["create", "modify", "delete"]))
          .min(1)
          .max(3),
      })
      .strict(),
    reason,
  })
  .strict();
const workspaceWatchPermission = z
  .object({
    id: z.literal("workspace.watch"),
    scope: z
      .object({ globs: globList, maxWatchers: positiveInteger.max(1_000).optional() })
      .strict(),
    reason,
  })
  .strict();
const networkPermission = z
  .object({
    id: z.literal("network.http"),
    scope: z
      .object({
        origins: originList,
        methods: z
          .array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]))
          .min(1)
          .max(6),
        maxBytes: positiveInteger.optional(),
      })
      .strict(),
    reason,
  })
  .strict();
const processPermission = z
  .object({
    id: z.literal("process.run"),
    scope: z
      .object({
        tools: z.array(logicalId).min(1).max(32),
        maxDurationMs: positiveInteger.max(24 * 60 * 60 * 1_000).optional(),
      })
      .strict(),
    reason,
  })
  .strict();
const terminalPermission = z
  .object({
    id: z.literal("terminal.create"),
    scope: z
      .object({
        visible: z.literal(true),
        profiles: z.array(logicalId).min(1).max(32).optional(),
      })
      .strict(),
    reason,
  })
  .strict();
const debugPermission = z
  .object({
    id: z.literal("debug.adapter"),
    scope: z
      .object({
        adapters: z.array(logicalId).min(1).max(32),
        targetTypes: z.array(logicalId).min(1).max(32),
      })
      .strict(),
    reason,
  })
  .strict();
const secretUsePermission = z
  .object({
    id: z.literal("secret.use"),
    scope: z
      .object({
        names: z.array(logicalId).min(1).max(32),
        origins: originList,
      })
      .strict(),
    reason,
  })
  .strict();
const secretReadPermission = z
  .object({
    id: z.literal("secret.read"),
    scope: z.object({ names: z.array(logicalId).min(1).max(32) }).strict(),
    reason,
  })
  .strict();
const clipboardPermission = z
  .object({
    id: z.enum(["clipboard.read", "clipboard.write"]),
    scope: z
      .object({
        formats: z.array(shortText).min(1).max(32),
        maxBytes: positiveInteger.optional(),
        userGesture: z.literal(true),
      })
      .strict(),
    reason,
  })
  .strict();
const externalOpenPermission = z
  .object({
    id: z.literal("external.open"),
    scope: z
      .object({
        origins: originList,
        schemes: z.array(z.enum(["https", "mailto"])).min(1).max(2),
        userGesture: z.literal(true),
      })
      .strict(),
    reason,
  })
  .strict();
const webviewPermission = z
  .object({
    id: z.literal("webview.create"),
    scope: z
      .object({
        viewTypes: z.array(logicalId).min(1).max(32),
        scripts: z.boolean(),
        resourceRoots: z.array(safePackagePath("webview resource root")).max(32),
      })
      .strict(),
    reason,
  })
  .strict();
const extensionConnectPermission = z
  .object({
    id: z.literal("extension.connect"),
    scope: z
      .object({
        extensions: z.array(extensionId).min(1).max(32),
        protocols: z.array(shortText).min(1).max(32),
      })
      .strict(),
    reason,
  })
  .strict();
const digest = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/)
  .transform(value => value.toLowerCase() as `sha256:${string}`);
const nativeAdapterPermission = z
  .object({
    id: z.literal("native.adapter"),
    scope: z
      .object({
        adapters: z.array(logicalId).min(1).max(16),
        digests: z.array(digest).min(1).max(16),
      })
      .strict(),
    reason,
  })
  .strict();

const permission = z.discriminatedUnion("id", [
  workspaceReadPermission,
  workspaceWritePermission,
  workspaceWatchPermission,
  networkPermission,
  processPermission,
  terminalPermission,
  debugPermission,
  secretUsePermission,
  secretReadPermission,
  clipboardPermission,
  externalOpenPermission,
  webviewPermission,
  extensionConnectPermission,
  nativeAdapterPermission,
]);

const runtime = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("declarative") }).strict(),
  z
    .object({
      kind: z.literal("wasm-component"),
      entry: safePackagePath("Wasm entry"),
      world: shortText,
    })
    .strict(),
  z
    .object({ kind: z.literal("vscode-web"), entry: safePackagePath("web entry") })
    .strict(),
  z
    .object({ kind: z.literal("vscode-node"), entry: safePackagePath("Node entry") })
    .strict(),
]);

const languageContribution = z
  .object({
    id: logicalId,
    aliases: z.array(shortText).max(32).optional(),
    extensions: z
      .array(z.string().min(2).max(32).regex(/^\.[A-Za-z0-9._+-]+$/))
      .max(64)
      .optional(),
    configuration: safePackagePath("language configuration").optional(),
  })
  .strict();
const grammarContribution = z
  .object({
    language: logicalId,
    scopeName: logicalId,
    path: safePackagePath("grammar path"),
  })
  .strict();
const themeContribution = z
  .object({
    id: logicalId,
    label: shortText,
    uiTheme: z.enum(["vs", "vs-dark", "hc-black", "hc-light"]),
    path: safePackagePath("theme path"),
  })
  .strict();
const commandContribution = z
  .object({ command: logicalId, title: shortText, category: shortText.optional() })
  .strict();
const configurationProperty = z
  .object({
    type: z.enum(["boolean", "number", "string"]),
    default: z.union([z.boolean(), z.number().finite(), z.string().max(4_096)]).optional(),
    description: description.optional(),
    enum: z
      .array(z.union([z.boolean(), z.number().finite(), z.string().max(4_096)]))
      .max(128)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const values = [value.default, ...(value.enum ?? [])].filter(item => item !== undefined);
    if (values.some(item => typeof item !== value.type)) {
      context.addIssue({ code: "custom", message: "default and enum must match type" });
    }
  });
const configurationContribution = z
  .object({
    id: logicalId,
    title: shortText,
    properties: z.record(logicalId, configurationProperty),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.properties).length > 512) {
      context.addIssue({ code: "custom", message: "too many configuration properties" });
    }
  });
const contributions = z
  .object({
    languages: z.array(languageContribution).max(256).optional(),
    grammars: z.array(grammarContribution).max(256).optional(),
    themes: z.array(themeContribution).max(64).optional(),
    commands: z.array(commandContribution).max(512).optional(),
    configuration: z.array(configurationContribution).max(64).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const count = Object.values(value).reduce(
      (total, items) => total + (items?.length ?? 0),
      0,
    );
    if (count === 0) {
      context.addIssue({ code: "custom", message: "at least one contribution is required" });
    }
  });

const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: packagePart,
    publisher: packagePart,
    version: semanticVersion,
    displayName: shortText,
    description,
    engines: z
      .object({
        logos: logosEngineRange,
      })
      .strict(),
    logos: z
      .object({
        runtime,
        permissions: z.array(permission).max(64).optional(),
        contributes: contributions.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.logos.permissions?.map(item => item.id) ?? [];
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "permission ids must be unique" });
    }
    const hasContributions = value.logos.contributes !== undefined;
    if (value.logos.runtime.kind === "declarative" && !hasContributions) {
      context.addIssue({
        code: "custom",
        message: "declarative extensions must contribute at least one resource",
      });
    }
  });

const registryPackageSchema = z
  .object({
    id: extensionId,
    version: semanticVersion,
    archive: safePackagePath("registry archive").refine(value => value.endsWith(".zip"), {
      message: "registry archives must be ZIP files",
    }),
    digest,
  })
  .strict();
const registrySchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.iso.datetime({ offset: true }).optional(),
    extensions: z.array(registryPackageSchema).max(1_000),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.extensions.map(item => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "registry extension ids must be unique" });
    }
  });

function parseBoundedJson(body: string, label: string, maxBytes: number): unknown {
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }

  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > JSON_MAX_NODES || depth > JSON_MAX_DEPTH) {
      throw new Error(`${label} exceeds structural limits.`);
    }
    if (typeof candidate === "string") {
      if (Buffer.byteLength(candidate, "utf8") > JSON_MAX_STRING_BYTES) {
        throw new Error(`${label} contains an oversized string.`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > JSON_MAX_ARRAY_ITEMS) {
        throw new Error(`${label} contains an oversized array.`);
      }
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (candidate && typeof candidate === "object") {
      const entries = Object.entries(candidate);
      if (entries.length > JSON_MAX_OBJECT_FIELDS) {
        throw new Error(`${label} contains an oversized object.`);
      }
      for (const [key, item] of entries) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new Error(`${label} contains a forbidden object key.`);
        }
        visit(key, depth + 1);
        visit(item, depth + 1);
      }
    }
  };
  visit(value, 0);
  return value;
}

function describeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map(issue => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
}

export function parseExtensionManifest(value: unknown): LogosExtensionManifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid extension manifest: ${describeZodError(result.error)}`);
  }
  return result.data as LogosExtensionManifest;
}

export function parseExtensionManifestJson(body: string): LogosExtensionManifest {
  return parseExtensionManifest(
    parseBoundedJson(body, "Extension manifest", MANIFEST_MAX_BYTES),
  );
}

export function extensionManifestId(manifest: LogosExtensionManifest): string {
  return `${manifest.publisher}.${manifest.name}`;
}

export function parseExtensionRegistry(value: unknown): ExtensionRegistryIndex {
  const result = registrySchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid extension registry: ${describeZodError(result.error)}`);
  }
  return result.data as ExtensionRegistryIndex;
}

export function parseExtensionRegistryJson(body: string): ExtensionRegistryIndex {
  return parseExtensionRegistry(
    parseBoundedJson(body, "Extension registry", REGISTRY_MAX_BYTES),
  );
}
