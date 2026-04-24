export function getPathSegments(input: Request | URL | string): string[] {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
  return url.pathname.split("/").filter(Boolean);
}
