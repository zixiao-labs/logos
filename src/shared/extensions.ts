import type {
  ExtensionPermissionRequest,
  ExtensionRuntimeKind,
} from "@logos-editor/extension-api";

export type ExtensionCompatibility =
  | "safe-compatible"
  | "requires-authorization"
  | "api-unsupported"
  | "blocked";

export interface ExtensionPermissionSummary {
  id: ExtensionPermissionRequest["id"];
  reason: string;
}

export interface RegistryExtensionInfo {
  id: string;
  name: string;
  publisher: string;
  displayName: string;
  description: string;
  version: string;
  engine: string;
  runtime: ExtensionRuntimeKind;
  digest: string;
  permissions: ExtensionPermissionSummary[];
  compatibility: ExtensionCompatibility;
  installed: boolean;
  installedVersion?: string;
  installable: boolean;
}

export type ExtensionRegistryStatus = "ready" | "missing" | "invalid";

export interface ExtensionRegistrySnapshot {
  status: ExtensionRegistryStatus;
  source: "local-development";
  extensions: RegistryExtensionInfo[];
  message?: string;
}
