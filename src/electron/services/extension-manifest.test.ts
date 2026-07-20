import { describe, expect, it } from "@lightning-js/lightning";
import {
  extensionManifestId,
  normalizeSafePackagePath,
  parseExtensionManifest,
  parseExtensionManifestJson,
  parseExtensionRegistry,
} from "./extension-manifest";

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    name: "rust-tools",
    publisher: "example",
    version: "1.2.3",
    displayName: "Rust Tools",
    description: "Declarative Rust language support",
    engines: { logos: "^1.0.0" },
    logos: {
      runtime: { kind: "declarative" },
      contributes: {
        languages: [{ id: "rust", extensions: [".rs"] }],
      },
    },
    ...overrides,
  };
}

describe("extension manifest validation", () => {
  it("parses the versioned declarative contract", () => {
    const parsed = parseExtensionManifest(manifest());

    expect({ id: extensionManifestId(parsed), parsed }).toEqual({
      id: "example.rust-tools",
      parsed: manifest(),
    });
  });

  it("rejects unknown fields, missing contributions, and duplicate capabilities", () => {
    expect(() => parseExtensionManifest({ ...manifest(), main: "index.js" })).toThrow();
    expect(() =>
      parseExtensionManifest(
        manifest({ logos: { runtime: { kind: "declarative" } } }),
      ),
    ).toThrow();
    expect(() =>
      parseExtensionManifest(
        manifest({
          logos: {
            runtime: { kind: "declarative" },
            contributes: { commands: [{ command: "example.run", title: "Run" }] },
            permissions: [
              {
                id: "workspace.read",
                scope: { globs: ["**/*.rs"] },
                reason: "Index Rust files",
              },
              {
                id: "workspace.read",
                scope: { globs: ["Cargo.toml"] },
                reason: "Read Cargo metadata",
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it("rejects unsafe paths, ambiguous network origins, and sensitive reads", () => {
    expect(() => normalizeSafePackagePath("../outside.js", "entry")).toThrow();
    expect(() => normalizeSafePackagePath("C:\\outside.js", "entry")).toThrow();
    expect(() =>
      parseExtensionManifest(
        manifest({
          logos: {
            runtime: { kind: "vscode-node", entry: "../main.js" },
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseExtensionManifest(
        manifest({
          logos: {
            runtime: { kind: "declarative" },
            contributes: { commands: [{ command: "example.fetch", title: "Fetch" }] },
            permissions: [
              {
                id: "network.http",
                scope: {
                  origins: ["https://example.test/api"],
                  methods: ["GET"],
                },
                reason: "Fetch metadata",
              },
            ],
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseExtensionManifest(
        manifest({
          logos: {
            runtime: { kind: "declarative" },
            contributes: { commands: [{ command: "example.read", title: "Read" }] },
            permissions: [
              {
                id: "workspace.read",
                scope: { globs: ["**/*"], sensitive: true },
                reason: "Read everything",
              },
            ],
          },
        }),
      ),
    ).toThrow();
  });

  it("canonicalizes exact HTTPS origins and rejects wildcard hosts", () => {
    const withNetwork = (origin: string) =>
      manifest({
        logos: {
          runtime: { kind: "vscode-web", entry: "main.js" },
          permissions: [
            {
              id: "network.http",
              scope: { origins: [origin], methods: ["GET"] },
              reason: "Fetch public metadata",
            },
          ],
        },
      });

    const parsed = parseExtensionManifest(withNetwork("https://EXAMPLE.test:443/"));
    expect(parsed.logos.permissions?.[0]).toMatchObject({
      scope: { origins: ["https://example.test"] },
    });
    expect(() => parseExtensionManifest(withNetwork("https://*.example.test"))).toThrow();
  });

  it("enforces JSON byte and structural limits before schema parsing", () => {
    expect(() => parseExtensionManifestJson(`{"value":"${"x".repeat(1024 * 1024)}"}`)).toThrow();
    let nested = "null";
    for (let index = 0; index < 40; index += 1) nested = `[${nested}]`;
    expect(() => parseExtensionManifestJson(nested)).toThrow();
    expect(() => parseExtensionManifestJson("{" )).toThrow();
  });
});

describe("extension registry validation", () => {
  const entry = {
    id: "example.rust-tools",
    version: "1.2.3",
    archive: "packages/example.rust-tools-1.2.3.zip",
    digest: `sha256:${"a".repeat(64)}`,
  };

  it("accepts canonical package references", () => {
    expect(parseExtensionRegistry({ schemaVersion: 1, extensions: [entry] })).toEqual({
      schemaVersion: 1,
      extensions: [entry],
    });
  });

  it("rejects duplicate identities, traversal, and unbound digests", () => {
    expect(() =>
      parseExtensionRegistry({ schemaVersion: 1, extensions: [entry, entry] }),
    ).toThrow();
    expect(() =>
      parseExtensionRegistry({
        schemaVersion: 1,
        extensions: [{ ...entry, archive: "../outside.zip" }],
      }),
    ).toThrow();
    expect(() =>
      parseExtensionRegistry({
        schemaVersion: 1,
        extensions: [{ ...entry, digest: "sha256:unsigned" }],
      }),
    ).toThrow();
  });
});
