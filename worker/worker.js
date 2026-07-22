/* ============================================================
   Story Time — Cloudflare Worker proxy.

   This is the only place your real Anthropic API key lives. The
   deployed website never sees it; it calls this Worker instead,
   and this Worker calls Anthropic on the website's behalf.

   Deploy this file's contents as-is in the Cloudflare dashboard
   (Workers & Pages → Create → paste this in → Deploy). See
   README.md for the exact click-by-click steps.

   Two things to set after deploying, both in the Worker's
   Settings tab:
   1. A secret variable named ANTHROPIC_API_KEY (your real key,
      "Encrypt" it) - see README.md.
   2. Edit ALLOWED_ORIGIN below to your actual github.io URL
      before deploying (or after, then re-deploy).
   ============================================================ */

// EDIT THIS to your deployed site's exact origin, no trailing slash.
// Example: "https://johanna.github.io"
const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io";

// Optional extra check. If you set APP_SECRET here to some random
// string, put the exact same string in config.js's APP_SECRET.
// Leave both blank to skip this (the origin check above still applies).
const APP_SECRET = "";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const originOk = origin === ALLOWED_ORIGIN;

    const corsHeaders = {
      "Access-Control-Allow-Origin": originOk ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }
    if (!originOk) {
      return new Response("Forbidden origin", { status: 403, headers: corsHeaders });
    }
    const secret = APP_SECRET;
    if (secret && request.headers.get("X-App-Secret") !== secret) {
      return new Response("Forbidden", { status: 403, headers: corsHeaders });
    }

    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: { message: "Worker misconfigured: ANTHROPIC_API_KEY not set" } }),
        { status: 500, headers: { ...corsHeaders, "content-type": "application/json" } }
      );
    }

    let bodyText;
    try {
      bodyText = await request.text();
    } catch (e) {
      return new Response("Bad request body", { status: 400, headers: corsHeaders });
    }

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: bodyText,
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: { message: "Could not reach Anthropic API" } }),
        { status: 502, headers: { ...corsHeaders, "content-type": "application/json" } }
      );
    }

    const responseBody = await upstream.text();
    return new Response(responseBody, {
      status: upstream.status,
      headers: { ...corsHeaders, "content-type": "application/json" },
    });
  },
};
