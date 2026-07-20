/** Manifest schema understood by Logos 1.x. */
export type ExtensionManifestSchemaVersion = 1;

/** Registry index schema understood by Logos 1.x. */
export type ExtensionRegistrySchemaVersion = 1;

export type ExtensionRuntimeKind =
  | "declarative"
  | "wasm-component"
  | "vscode-web"
  | "vscode-node";

export interface DeclarativeRuntime {
  readonly kind: "declarative";
}

export interface WasmComponentRuntime {
  readonly kind: "wasm-component";
  readonly entry: string;
  readonly world: string;
}

export interface VsCodeWebRuntime {
  readonly kind: "vscode-web";
  readonly entry: string;
}

export interface VsCodeNodeRuntime {
  readonly kind: "vscode-node";
  readonly entry: string;
}

export type ExtensionRuntime =
  | DeclarativeRuntime
  | WasmComponentRuntime
  | VsCodeWebRuntime
  | VsCodeNodeRuntime;

export type WorkspaceOperation = "create" | "modify" | "delete";
export type NetworkMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface WorkspaceReadPermission {
  readonly id: "workspace.read";
  readonly scope: {
    readonly globs: readonly string[];
    readonly maxBytes?: number;
    readonly includeHidden?: boolean;
    /** Ordinary extensions cannot request sensitive files through this flag. */
    readonly sensitive?: false;
  };
  readonly reason: string;
}

export interface WorkspaceWritePermission {
  readonly id: "workspace.write";
  readonly scope: {
    readonly globs: readonly string[];
    readonly operations: readonly WorkspaceOperation[];
  };
  readonly reason: string;
}

export interface WorkspaceWatchPermission {
  readonly id: "workspace.watch";
  readonly scope: {
    readonly globs: readonly string[];
    readonly maxWatchers?: number;
  };
  readonly reason: string;
}

export interface NetworkHttpPermission {
  readonly id: "network.http";
  readonly scope: {
    readonly origins: readonly string[];
    readonly methods: readonly NetworkMethod[];
    readonly maxBytes?: number;
  };
  readonly reason: string;
}

export interface ProcessRunPermission {
  readonly id: "process.run";
  readonly scope: {
    /** Tool identities are resolved and pinned by the installer; they are not paths. */
    readonly tools: readonly string[];
    readonly maxDurationMs?: number;
  };
  readonly reason: string;
}

export interface TerminalCreatePermission {
  readonly id: "terminal.create";
  readonly scope: {
    readonly visible: true;
    readonly profiles?: readonly string[];
  };
  readonly reason: string;
}

export interface DebugAdapterPermission {
  readonly id: "debug.adapter";
  readonly scope: {
    readonly adapters: readonly string[];
    readonly targetTypes: readonly string[];
  };
  readonly reason: string;
}

export interface SecretUsePermission {
  readonly id: "secret.use";
  readonly scope: {
    readonly names: readonly string[];
    readonly origins: readonly string[];
  };
  readonly reason: string;
}

export interface SecretReadPermission {
  readonly id: "secret.read";
  readonly scope: { readonly names: readonly string[] };
  readonly reason: string;
}

export interface ClipboardPermission {
  readonly id: "clipboard.read" | "clipboard.write";
  readonly scope: {
    readonly formats: readonly string[];
    readonly maxBytes?: number;
    readonly userGesture: true;
  };
  readonly reason: string;
}

export interface ExternalOpenPermission {
  readonly id: "external.open";
  readonly scope: {
    readonly origins: readonly string[];
    readonly schemes: readonly ("https" | "mailto")[];
    readonly userGesture: true;
  };
  readonly reason: string;
}

export interface WebviewCreatePermission {
  readonly id: "webview.create";
  readonly scope: {
    readonly viewTypes: readonly string[];
    readonly scripts: boolean;
    readonly resourceRoots: readonly string[];
  };
  readonly reason: string;
}

export interface ExtensionConnectPermission {
  readonly id: "extension.connect";
  readonly scope: {
    readonly extensions: readonly string[];
    readonly protocols: readonly string[];
  };
  readonly reason: string;
}

export interface NativeAdapterPermission {
  readonly id: "native.adapter";
  readonly scope: {
    readonly adapters: readonly string[];
    readonly digests: readonly `sha256:${string}`[];
  };
  readonly reason: string;
}

export type ExtensionPermissionRequest =
  | WorkspaceReadPermission
  | WorkspaceWritePermission
  | WorkspaceWatchPermission
  | NetworkHttpPermission
  | ProcessRunPermission
  | TerminalCreatePermission
  | DebugAdapterPermission
  | SecretUsePermission
  | SecretReadPermission
  | ClipboardPermission
  | ExternalOpenPermission
  | WebviewCreatePermission
  | ExtensionConnectPermission
  | NativeAdapterPermission;

export interface LanguageContribution {
  readonly id: string;
  readonly aliases?: readonly string[];
  readonly extensions?: readonly string[];
  readonly configuration?: string;
}

export interface GrammarContribution {
  readonly language: string;
  readonly scopeName: string;
  readonly path: string;
}

export interface ThemeContribution {
  readonly id: string;
  readonly label: string;
  readonly uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light";
  readonly path: string;
}

export interface CommandContribution {
  readonly command: string;
  readonly title: string;
  readonly category?: string;
}

export interface ConfigurationPropertyContribution {
  readonly type: "boolean" | "number" | "string";
  readonly default?: boolean | number | string;
  readonly description?: string;
  readonly enum?: readonly (boolean | number | string)[];
}

export interface ConfigurationContribution {
  readonly id: string;
  readonly title: string;
  readonly properties: Readonly<Record<string, ConfigurationPropertyContribution>>;
}

export interface DeclarativeContributions {
  readonly languages?: readonly LanguageContribution[];
  readonly grammars?: readonly GrammarContribution[];
  readonly themes?: readonly ThemeContribution[];
  readonly commands?: readonly CommandContribution[];
  readonly configuration?: readonly ConfigurationContribution[];
}

export interface LogosExtensionManifest {
  readonly schemaVersion: ExtensionManifestSchemaVersion;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly displayName: string;
  readonly description: string;
  readonly engines: { readonly logos: string };
  readonly logos: {
    readonly runtime: ExtensionRuntime;
    readonly permissions?: readonly ExtensionPermissionRequest[];
    readonly contributes?: DeclarativeContributions;
  };
}

export interface ExtensionRegistryPackage {
  /** Must equal `${manifest.publisher}.${manifest.name}`. */
  readonly id: string;
  readonly version: string;
  /** POSIX-style relative path to a ZIP below the registry root. */
  readonly archive: string;
  readonly digest: `sha256:${string}`;
}

export interface ExtensionRegistryIndex {
  readonly schemaVersion: ExtensionRegistrySchemaVersion;
  readonly generatedAt?: string;
  readonly extensions: readonly ExtensionRegistryPackage[];
}
