# `@logos-editor/extension-api`

Type definitions for the versioned contract between a Logos extension package,
the temporary registry, and the Logos installer.

```ts
import type { LogosExtensionManifest } from "@logos-editor/extension-api";

export default {
  schemaVersion: 1,
  name: "rust-tools",
  publisher: "example",
  version: "1.0.0",
  displayName: "Rust Tools",
  description: "Declarative Rust language metadata",
  engines: { logos: "^1.0.0" },
  logos: {
    runtime: { kind: "declarative" },
    contributes: {
      languages: [{ id: "rust", extensions: [".rs"] }],
    },
  },
} satisfies LogosExtensionManifest;
```

The manifest is an application for capabilities, not an authorization grant.
Logos computes effective permissions at runtime and may reject a package even
when it satisfies these TypeScript declarations.

The initial host only installs code-free `declarative` packages. Executable
runtime types are included so packages can be scanned and reported accurately;
they remain blocked until their isolated runner and broker are available. The
package intentionally exposes no Node, Electron, filesystem, network, process,
or secret API.
