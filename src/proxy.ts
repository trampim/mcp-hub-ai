import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const { nextUrl } = req;
  const session = req.auth;
  const isAuthenticated = !!session;

  const pathname = nextUrl.pathname;

  // Always allow: auth API, login page, static assets, OAuth discovery, and proxy endpoint (uses its own Bearer auth)
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/mcp/proxy") ||
    pathname.startsWith("/api/mcp/namespaces") ||
    pathname.startsWith("/api/mcp/auth") ||
    pathname.startsWith("/.well-known") ||
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/icon")
  ) {
    return NextResponse.next();
  }

  // Redirect unauthenticated users to login
  if (!isAuthenticated) {
    const loginUrl = new URL("/login", nextUrl.origin);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Block non-admin from /admin routes
  if (pathname.startsWith("/admin") && !session.user.isAdmin) {
    return NextResponse.redirect(new URL("/chat", nextUrl.origin));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon\\.svg).*)",
  ],
};
