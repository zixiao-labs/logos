import { describe, expect, it } from "@lightning-js/lightning";
import { isSensitiveEnvName } from "./acp-env";

describe("ACP environment", () => {
  it("recognizes secret, private-key, and access-key names", () => {
    for (const name of [
      "OPENAI_API_KEY",
      "SSH_PRIVATE_KEY",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "CLIENT_SECRET",
      "database_password",
      "SERVICE_CREDENTIALS",
    ]) {
      expect(isSensitiveEnvName(name)).toBe(true);
    }
  });

  it("does not classify unrelated key-like names as secrets", () => {
    for (const name of [
      "LOG_LEVEL",
      "PUBLIC_KEY",
      "KEYBOARD_LAYOUT",
      "TOKENIZER_PATH",
    ]) {
      expect(isSensitiveEnvName(name)).toBe(false);
    }
  });
});
