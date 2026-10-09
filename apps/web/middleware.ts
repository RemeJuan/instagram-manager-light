import { NextRequest, NextResponse } from "next/server";

const enabled = process.env.LOCAL_LAN === "true";
const publicEnabled = process.env.NEXT_PUBLIC_LOCAL_LAN === "true";
const lanIp = process.env.LOCAL_LAN_IP || "";
const allowedHosts = new Set([
  `${lanIp}:3000`,
  "localhost:3000",
  "127.0.0.1:3000",
]);
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

export function middleware(request: NextRequest) {
  if (enabled !== publicEnabled)
    return new NextResponse("Invalid LAN configuration", { status: 500 });
  if (!enabled) return NextResponse.next();

  const host = request.headers.get("host") || "";
  if (!allowedHosts.has(host))
    return new NextResponse("Invalid host", { status: 403 });

  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    !safeMethods.has(request.method)
  ) {
    const origin = request.headers.get("origin");
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      !origin ||
      origin === "null" ||
      origin !== `${request.nextUrl.protocol}//${host}` ||
      fetchSite === "cross-site"
    )
      return new NextResponse("Invalid request origin", { status: 403 });
  }

  return NextResponse.next();
}

export const config = { matcher: "/:path*" };
