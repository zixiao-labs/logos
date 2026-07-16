export const ACP_SECRET_MASK = "********";

const SECRET_ENV_NAME =
  /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i;

export function isSensitiveEnvName(name: string): boolean {
  return SECRET_ENV_NAME.test(name);
}
