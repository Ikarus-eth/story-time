/* ============================================================
   Story Time — Cloudflare Worker proxy.  REVISION 5.

   NEW IN REVISION 5:

   [R10] SSE buffer is flushed after the read loop. The known open
         bug: if the final event did not end with a blank line,
         message_stop was never seen and a perfectly good story was
         reported as "Stream ended early (no message_stop)".
   [R11] /image now generates with OpenAI gpt-image-2 when
         OPENAI_API_KEY is set, and falls back to pollinations.ai
         automatically on ANY failure (missing key, org not yet
         verified, 429, moderation block, timeout). If the OpenAI
         side is not working yet, illustrations behave exactly as
         they do today. Nothing to roll back.
   [R12] CHARACTER_LOOK can now live here as a Worker secret and is
         appended to the image prompt server-side, so no physical
         description of a real child ever sits in the public repo.
         Optional — leave it unset and nothing is appended.

   Changes from revision 4 (each marked [Rn] below
   and explained in the review):

   [R1] The whole background task is wrapped in try/finally, so the
        response body is ALWAYS closed. Previously an unexpected throw
        (e.g. upstream.body being null-ish) left the heartbeat interval
        running forever and the browser's fetch() never settled.
   [R2] Stream-level errors from Anthropic (event: error, e.g.
        overloaded_error / rate_limit) are now detected instead of
        silently discarded. This was the main way a FAILED request
        could produce a log line that looked like a clean completion.
   [R3] stop_reason is captured. "max_tokens" now returns an explicit
        error instead of a truncated story that fails JSON.parse in
        the browser with a confusing message.
   [R4] Streams that end without message_stop are reported as
        incomplete rather than returned as partial text.
   [R5] Cache-Control: no-store, no-transform — stops Cloudflare's
        edge from gzip-buffering the whitespace heartbeats, which
        would defeat the whole point of them.
   [R6] The abort timeout now covers the entire generation (headers
        AND body), not just the headers. Raised to 240s. The old 100s
        timer was cleared the instant response headers arrived, so it
        bounded ~2 seconds of work and then did nothing — which also
        meant the body read had no bound at all.
   [R7] SSE parsing rewritten to skip JSON.parse on events we don't
        care about (ping, message_start, content_block_start/stop).
        Cuts Worker CPU time roughly in half. Matters on the Workers
        FREE plan, where the ceiling is 10ms of CPU per request and a
        long chapter can approach it.
   [R8] Log lines now distinguish success from failure explicitly.
   [R9] /image no longer caches non-2xx responses for 24 hours.

   Deploy: Workers & Pages -> story-time-proxy -> Edit code ->
   replace everything -> Deploy.
   Secrets (Settings -> Variables):
     ANTHROPIC_API_KEY   required
     OPENAI_API_KEY      required for gpt-image-2 illustrations
     POLLINATIONS_KEY    required (fallback illustrations)
     CHARACTER_LOOK      optional, see [R12]
   ============================================================ */

const ALLOWED_ORIGIN = "https://ikarus-eth.github.io";

/* ---- illustration settings. Change these, redeploy, done. ----
   Cost per image at 1536x1024, from OpenAI's pricing table:
     low $0.005   medium $0.041   high $0.165
   Start on medium. Try low for a story and compare — for flat
   picture-book art it is often indistinguishable and 8x cheaper. */
const IMAGE_MODEL       = "gpt-image-2";
const IMAGE_QUALITY     = "medium";       // "low" | "medium" | "high"
const IMAGE_SIZE        = "1536x1024";    // landscape; app displays it at 832x520
const IMAGE_FORMAT      = "webp";         // smaller than png = less Worker CPU
const IMAGE_COMPRESSION = 80;
const IMAGE_TIMEOUT_MS  = 90000;          // leaves room to fall back to pollinations

// Optional extra check — leave blank to skip.
const APP_SECRET = "";

// Total wall-clock bound on one Anthropic generation, headers + body. [R6]
const GENERATION_TIMEOUT_MS = 240000;

// How often to write a keep-alive byte to the browser.
const HEARTBEAT_MS = 10000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const referer = request.headers.get("Referer") || "";
    const originOk = origin === ALLOWED_ORIGIN || referer.indexOf(ALLOWED_ORIGIN) === 0;

    if (url.pathname === "/image") {
      return handleImage(url, env, originOk, ctx);
    }
    return handleMessages(request, env, origin, originOk, ctx);
  },
};

async function handleMessages(request, env, origin, originOk, ctx) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": originOk ? (origin || ALLOWED_ORIGIN) : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-App-Secret",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
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
  if (APP_SECRET && request.headers.get("X-App-Secret") !== APP_SECRET) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return jsonError(corsHeaders, 500, "Worker misconfigured: ANTHROPIC_API_KEY not set");
  }

  let bodyJson;
  try {
    bodyJson = await request.json();
  } catch (e) {
    return new Response("Bad request body", { status: 400, headers: corsHeaders });
  }
  bodyJson.stream = true;

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const started = Date.now();

  const bg = (async () => {
    let heartbeat = setInterval(() => {
      writer.write(encoder.encode(" ")).catch(() => {});
    }, HEARTBEAT_MS);
    let finished = false;

    const finish = async (payload) => {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      try { await writer.write(encoder.encode(JSON.stringify(payload))); } catch (e) {}
      try { await writer.close(); } catch (e) {}
    };

    // [R6] one controller for the whole generation, cleared only at the end.
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), GENERATION_TIMEOUT_MS);

    // [R1] nothing below can escape without finish() running.
    try {
      let upstream;
      try {
        upstream = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(bodyJson),
          signal: ac.signal,
        });
      } catch (e) {
        const aborted = ac.signal.aborted;
        console.error("[Worker] FAIL reach-anthropic", aborted ? "(timeout)" : "", e && e.message);
        await finish({ error: { message: aborted
          ? "Timed out waiting for Anthropic (over " + Math.round(GENERATION_TIMEOUT_MS / 1000) + "s)"
          : "Could not reach Anthropic API" } });
        return;
      }

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        console.error("[Worker] FAIL http", upstream.status, errText.slice(0, 400));
        let parsed;
        try { parsed = JSON.parse(errText); } catch (e) {
          parsed = { error: { message: "Anthropic API error " + upstream.status + (errText ? ": " + errText.slice(0, 200) : "") } };
        }
        if (!parsed || !parsed.error) parsed = { error: { message: "Anthropic API error " + upstream.status } };
        await finish(parsed);
        return;
      }

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let text = "";
      let chunkCount = 0, byteCount = 0, eventCount = 0;
      let stopReason = null;
      let sawStop = false;
      let streamError = null;

      // [R10] one block parser, used both inside the read loop and once more
      // on whatever is left in the buffer when the loop ends.
      const processBlock = (block) => {
        // [R7] cheap pre-filter: only three event types need parsing.
        const isDelta = block.indexOf("content_block_delta") >= 0;
        const isMsgDelta = !isDelta && block.indexOf("message_delta") >= 0;
        const isErr = !isDelta && !isMsgDelta && block.indexOf('"error"') >= 0;
        if (block.indexOf("message_stop") >= 0) sawStop = true;
        if (!isDelta && !isMsgDelta && !isErr) return;

        const di = block.indexOf("data:");
        if (di < 0) return;
        const dataStr = block.slice(di + 5).trim();
        if (!dataStr) return;

        let evt;
        try { evt = JSON.parse(dataStr); } catch (e) { return; }
        eventCount++;

        if (evt.type === "content_block_delta") {
          if (evt.delta && evt.delta.type === "text_delta") text += evt.delta.text || "";
        } else if (evt.type === "message_delta") {
          if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;   // [R3]
        } else if (evt.type === "error") {                                              // [R2]
          streamError = (evt.error && (evt.error.message || evt.error.type)) || "stream error";
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunkCount++;
          byteCount += value.byteLength;
          buf += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            processBlock(block);
          }
        }

        // [R10] THE FIX. Anthropic does not guarantee that the last event is
        // followed by a blank line. Without this, message_stop sitting in the
        // tail of the buffer was never seen and a complete, correct story was
        // reported to the browser as "Stream ended early (no message_stop)".
        buf += decoder.decode();            // flush any trailing multi-byte char
        if (buf.trim()) processBlock(buf);
        buf = "";
      } catch (e) {
        const aborted = ac.signal.aborted;
        console.error("[Worker] FAIL stream-read", aborted ? "(timeout)" : "",
          chunkCount, "chunks", byteCount, "bytes", text.length, "chars:", e && e.message);
        await finish({ error: { message: aborted
          ? "Generation exceeded " + Math.round(GENERATION_TIMEOUT_MS / 1000) + "s"
          : "Stream read failed: " + ((e && e.message) || String(e)) } });
        return;
      }

      const ms = Date.now() - started;

      if (streamError) {                                                                     // [R2]
        console.error("[Worker] FAIL stream-error", ms + "ms", text.length, "chars:", streamError);
        await finish({ error: { message: "Anthropic stream error: " + streamError } });
        return;
      }
      if (stopReason && stopReason !== "end_turn" && stopReason !== "stop_sequence") {       // [R3]
        console.error("[Worker] FAIL stop_reason", stopReason, ms + "ms", text.length, "chars");
        await finish({ error: { message: "Response was cut off (stop_reason: " + stopReason + ")" } });
        return;
      }
      if (!sawStop) {                                                                        // [R4]
        console.error("[Worker] FAIL no-message_stop", ms + "ms", chunkCount, "chunks", text.length, "chars");
        await finish({ error: { message: "Stream ended early (no message_stop)" } });
        return;
      }
      if (!text) {
        console.error("[Worker] FAIL empty-text", ms + "ms", chunkCount, "chunks", eventCount, "events");
        await finish({ error: { message: "Anthropic returned no text" } });
        return;
      }

      console.log("[Worker] OK", ms + "ms", chunkCount, "chunks", byteCount, "bytes",
        eventCount, "events", text.length, "chars stop=" + stopReason);                      // [R8]
      await finish({ content: [{ type: "text", text }], stop_reason: stopReason });
    } catch (e) {
      console.error("[Worker] FAIL unexpected:", (e && e.stack) || String(e));
      await finish({ error: { message: "Worker error: " + ((e && e.message) || String(e)) } });
    } finally {
      clearTimeout(timeoutId);
      clearInterval(heartbeat);
      if (!finished) {
        // Belt and braces: never leave the browser hanging on an open body.
        try { await writer.close(); } catch (e) {}
      }
    }
  })();

  if (ctx && ctx.waitUntil) ctx.waitUntil(bg);

  return new Response(readable, {
    status: 200,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
      "cache-control": "no-store, no-transform",   // [R5]
    },
  });
}

function jsonError(corsHeaders, status, message) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/* ---------------------------------------------------------------
   /image — gpt-image-2 first, pollinations second.  [R11]

   The route's contract is unchanged: GET with ?prompt&width&height&seed,
   responds with raw image bytes. The app sets it as an <img src> and
   knows nothing about which service drew the picture.
   --------------------------------------------------------------- */
async function handleImage(url, env, originOk, ctx) {
  const headers = { "Access-Control-Allow-Origin": originOk ? "*" : "null", "Vary": "Origin" };

  if (!originOk) return new Response("Forbidden origin", { status: 403, headers });

  const prompt = url.searchParams.get("prompt") || "";
  if (!prompt) return new Response("Missing prompt", { status: 400, headers });

  // The app's image URL is deterministic (prompt + seed), so re-reading a
  // chapter should never be billed twice. Note: the Cache API is a no-op on
  // *.workers.dev and only starts working if this Worker is ever put behind
  // a custom domain. The Cache-Control header below is what actually saves
  // money today, by caching on Juna's iPad for 24h.
  const cache = (typeof caches !== "undefined" && caches.default) ? caches.default : null;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) {
      console.log("[Worker] IMG cache-hit");
      return hit;
    }
  }

  let res = null;
  if (env.OPENAI_API_KEY) res = await openaiImage(prompt, env, headers);
  if (!res) res = await pollinationsImage(url, env, headers);

  if (cache && res.ok && ctx && ctx.waitUntil) {
    try { ctx.waitUntil(cache.put(cacheKey, res.clone())); } catch (e) {}
  }
  return res;
}

// Returns a Response on success, or null so the caller falls back.
async function openaiImage(prompt, env, headers) {
  // [R12] optional, and deliberately server-side only.
  const look = (env.CHARACTER_LOOK || "").trim();
  const full = look ? prompt + " " + look : prompt;

  const ac = new AbortController();
  const timeoutId = setTimeout(() => ac.abort(), IMAGE_TIMEOUT_MS);
  const started = Date.now();

  try {
    const r = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer " + env.OPENAI_API_KEY,
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: full.slice(0, 4000),
        size: IMAGE_SIZE,
        quality: IMAGE_QUALITY,
        output_format: IMAGE_FORMAT,
        output_compression: IMAGE_COMPRESSION,
        moderation: "auto",     // keep the stricter default; this is a kids' app
        n: 1,
      }),
      signal: ac.signal,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      // 403 here almost always means the org is not ID-verified yet.
      console.error("[Worker] IMG FAIL openai", r.status, errText.slice(0, 300));
      return null;
    }

    const j = await r.json();
    const b64 = j && j.data && j.data[0] && j.data[0].b64_json;
    if (!b64) {
      console.error("[Worker] IMG FAIL openai no-b64");
      return null;
    }

    const bytes = b64ToBytes(b64);
    console.log("[Worker] IMG OK openai", (Date.now() - started) + "ms",
      IMAGE_QUALITY, bytes.length, "bytes");

    const out = new Headers(headers);
    out.set("Content-Type", "image/" + IMAGE_FORMAT);
    out.set("Cache-Control", "public, max-age=86400");
    return new Response(bytes, { status: 200, headers: out });
  } catch (e) {
    console.error("[Worker] IMG FAIL openai",
      ac.signal.aborted ? "(timeout " + Math.round(IMAGE_TIMEOUT_MS / 1000) + "s)" : "",
      (e && e.message) || String(e));
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function pollinationsImage(url, env, headers) {
  const key = env.POLLINATIONS_KEY;
  if (!key) {
    console.error("[Worker] IMG FAIL no-pollinations-key");
    return new Response("Worker misconfigured: POLLINATIONS_KEY not set", { status: 500, headers });
  }

  const prompt = url.searchParams.get("prompt") || "";
  const width = url.searchParams.get("width") || "832";
  const height = url.searchParams.get("height") || "520";
  const seed = url.searchParams.get("seed") || "1";

  const target = "https://image.pollinations.ai/prompt/" + encodeURIComponent(prompt)
    + "?width=" + encodeURIComponent(width)
    + "&height=" + encodeURIComponent(height)
    + "&seed=" + encodeURIComponent(seed)
    + "&nologo=true&model=gptimage-large&key=" + encodeURIComponent(key);

  let upstream;
  try {
    upstream = await fetch(target);
  } catch (e) {
    console.error("[Worker] IMG FAIL pollinations unreachable");
    return new Response("Could not reach pollinations", { status: 502, headers });
  }

  console.log("[Worker] IMG", upstream.ok ? "OK" : "FAIL", "pollinations", upstream.status);

  const outHeaders = new Headers(headers);
  outHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
  // [R9] only cache real images; a cached error would break that chapter's
  // illustration for 24 hours, because the URL is deterministic (prompt+seed).
  outHeaders.set("Cache-Control", upstream.ok ? "public, max-age=86400" : "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}

// Plain loop, not Uint8Array.from(..., mapFn): the loop is several times
// faster and this runs inside the free plan's 10ms CPU budget.
function b64ToBytes(b64) {
  const bin = atob(b64);
  const n = bin.length;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = bin.charCodeAt(i);
  return out;
}
