# Extension developer contract and temporary registry

Logos currently implements the package and declarative-contribution slice of
the extension architecture. It deliberately does not start third-party Wasm,
Web, or Node code yet.

## Developer types

The npm workspace package [`@logos-editor/extension-api`](../../packages/extension-api/README.md)
contains the versioned TypeScript contract for:

- `LogosExtensionManifest`
- runtime and permission declarations
- declarative contribution types
- `ExtensionRegistryIndex` and content-digest references

Use `satisfies LogosExtensionManifest` when authoring `extension.json`. The
types document what a package may request; the host remains authoritative and
can reject a structurally valid package under product, workspace, runtime, or
user policy.

## Local registry

During development, Logos reads the sibling repository
`/Users/logos/WebstormProjects/extensions`. An absolute
`LOGOS_EXTENSION_REGISTRY` environment variable can override that location in
an unpackaged build. Packaged builds never read this local registry.

The registry has this layout:

```text
extensions/
├── registry.json
└── packages/
    └── example.rust-tools-1.0.0.zip
```

`registry.json` binds an extension identity and version to a package digest:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-20T00:00:00Z",
  "extensions": [
    {
      "id": "example.rust-tools",
      "version": "1.0.0",
      "archive": "packages/example.rust-tools-1.0.0.zip",
      "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

Each ZIP contains `extension.json` at its root. Resource paths in the manifest
are POSIX-style package-relative paths:

```json
{
  "schemaVersion": 1,
  "name": "rust-tools",
  "publisher": "example",
  "version": "1.0.0",
  "displayName": "Rust Tools",
  "description": "Declarative Rust language metadata",
  "engines": { "logos": "^1.0.0" },
  "logos": {
    "runtime": { "kind": "declarative" },
    "contributes": {
      "languages": [{ "id": "rust", "extensions": [".rs"] }]
    }
  }
}
```

## Current enforcement

The host performs the following steps before an install pointer is created:

1. Parse a size/depth/field-bounded registry and manifest with unknown fields
   rejected.
2. Resolve the archive below the registry root and copy it into private
   staging, preventing later registry changes from affecting verification.
3. Verify the complete ZIP against its SHA-256 binding.
4. Reject absolute/traversing paths, links, devices, duplicates,
   case-conflicts, oversized entries, excessive nesting, and unsafe compression
   ratios.
5. Match the manifest publisher, name, and version to the registry entry and
   confirm every declared package resource exists.
6. Extract into a private staging directory without install scripts, then move
   it to a read-only content-addressed directory.
7. Atomically write a small installed-version pointer only after all checks
   succeed.

Only permission-free `declarative` packages are installable in this phase.
Packages requesting capabilities are reported as `Needs permission`; executable
runtime declarations are reported as `Blocked`; incompatible engine ranges are
reported as `API unsupported`. None of these states silently fall back to a
less isolated runtime.

Local packages are unsigned development inputs. Publisher signing, revocation,
permission grants, contribution activation, and the per-extension Wasm/Web/Node
runners remain subsequent phases of the sandbox architecture.
