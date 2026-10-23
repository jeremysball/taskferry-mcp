// Reads the errno `code` off an unknown thrown value. The three call sites that
// needed this each wrote their own cast; this is the one copy.
export function errorCode(value: unknown): string | undefined {
  return typeof value === 'object' && value !== null && 'code' in value
    ? (value as { code?: string }).code
    : undefined;
}
