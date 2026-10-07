import { hosted } from "./api";

export { hosted };

// Accept only known private paths. Reject protocol-relative URLs, backslashes,
// control characters and encoded separators before handing a path to the router.
export function privateReturnPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x1f\x7f]/.test(value) ||
    /%2f|%5c/i.test(value)
  )
    return "/dashboard";
  const path = value.split(/[?#]/, 1)[0];
  return /^\/(dashboard|import|changes|accounts(?:\/[^/]+)?|admin\/invitations)\/?$/.test(
    path,
  )
    ? value
    : "/dashboard";
}

export function isPrivatePath(pathname: string) {
  return /^\/(dashboard|import|changes|accounts(?:\/|$)|admin(?:\/|$))/.test(
    pathname,
  );
}
