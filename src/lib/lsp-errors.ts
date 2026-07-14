const LSP_REQUEST_CANCELLED = -32800;

export function isLspRequestCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === LSP_REQUEST_CANCELLED
  );
}
