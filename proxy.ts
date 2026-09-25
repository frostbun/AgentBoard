import { NextResponse, type NextRequest } from "next/server";
import { boardToken, tokenSource } from "@/lib/auth";

const COOKIE = "agentboard_token";
const BANNER_KEY = "__agentboard_banner__";

/** Printed once per process, on the first request, using the host that request used. */
function logBanner(request: NextRequest, token: string | null): void {
  const store = globalThis as typeof globalThis & { [BANNER_KEY]?: boolean };
  if (store[BANNER_KEY]) return;
  store[BANNER_KEY] = true;

  const host = request.headers.get("host") ?? "127.0.0.1:4317";
  const suffix = token ? `/?token=${token}` : "";
  const source = tokenSource();
  const lines = [`AgentBoard: http://${host}${suffix}`];
  if (source === "generated" && token) {
    lines.push(`  token: ${token}`);
    lines.push("  Set AGENTBOARD_TOKEN to pin one, or AGENTBOARD_OPEN=1 to drop the check.");
  } else if (source === "env") {
    lines.push("  token: from AGENTBOARD_TOKEN");
  } else {
    lines.push("  WARNING: AGENTBOARD_OPEN=1 — anyone who can reach this port controls your agents.");
  }
  console.log(`\n${lines.join("\n")}\n`);
}

/** Default HOST is 0.0.0.0, so LAN access is gated by a shared token. */
export default function proxy(request: NextRequest): NextResponse {
  const token = boardToken();
  logBanner(request, token);
  if (!token) return NextResponse.next();

  const url = request.nextUrl;
  if (url.searchParams.get("token") === token) {
    const clean = new URL(url);
    clean.searchParams.delete("token");
    const response = NextResponse.redirect(clean);
    response.cookies.set(COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return response;
  }

  if (request.cookies.get(COOKIE)?.value === token) return NextResponse.next();

  return new NextResponse(TOKEN_PAGE, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

const TOKEN_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentBoard</title><style>
body{background:#08090b;color:#c3cad3;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100dvh;margin:0}
form{width:min(22rem,90vw);display:grid;gap:.75rem}
input,button{font:inherit;padding:.7rem;border-radius:.6rem;border:1px solid #24292f;background:#0e1013;color:inherit}
button{background:#5b8cff;border-color:#5b8cff;color:#08090b;font-weight:600}
</style></head><body><form method="GET">
<h1 style="font-size:1.1rem;margin:0">AgentBoard token</h1>
<p style="margin:0;color:#7d8794;font-size:.85rem">Printed in the server log at startup, or set AGENTBOARD_TOKEN.</p>
<input name="token" type="password" placeholder="token" autofocus>
<button type="submit">Unlock</button>
</form></body></html>`;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
