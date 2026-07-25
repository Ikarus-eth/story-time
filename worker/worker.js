/* ============================================================
   Story Time — Cloudflare Worker proxy.  REVISION 4.

   Changes vs. the version you have live (each marked [Rn] below
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
   Secrets required (Settings -> Variables): ANTHROPIC_API_KEY,
   POLLINATIONS_KEY.
   ============================================================ */

const ALLOWED_ORIGIN = "https://ikarus-eth.github.io";

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
      return handleImage(url, env, originOk);
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

            // [R7] cheap pre-filter: only three event types need parsing.
            const isDelta = block.indexOf("content_block_delta") >= 0;
            const isMsgDelta = !isDelta && block.indexOf("message_delta") >= 0;
            const isErr = !isDelta && !isMsgDelta && block.indexOf('"error"') >= 0;
            if (block.indexOf("message_stop") >= 0) sawStop = true;
            if (!isDelta && !isMsgDelta && !isErr) continue;

            const di = block.indexOf("data:");
            if (di < 0) continue;
            const dataStr = block.slice(di + 5).trim();
            if (!dataStr) continue;

            let evt;
            try { evt = JSON.parse(dataStr); } catch (e) { continue; }
            eventCount++;

            if (evt.type === "content_block_delta") {
              if (evt.delta && evt.delta.type === "text_delta") text += evt.delta.text || "";
            } else if (evt.type === "message_delta") {
              if (evt.delta && evt.delta.stop_reason) stopReason = evt.delta.stop_reason;   // [R3]
            } else if (evt.type === "error") {                                              // [R2]
              streamError = (evt.error && (evt.error.message || evt.error.type)) || "stream error";
            }
          }
        }
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

async function handleImage(url, env, originOk) {
  const headers = { "Access-Control-Allow-Origin": originOk ? "*" : "null", "Vary": "Origin" };

  if (!originOk) return new Response("Forbidden origin", { status: 403, headers });

  const key = env.POLLINATIONS_KEY;
  if (!key) return new Response("Worker misconfigured: POLLINATIONS_KEY not set", { status: 500, headers });

  const prompt = url.searchParams.get("prompt") || "";
  if (!prompt) return new Response("Missing prompt", { status: 400, headers });

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
    return new Response("Could not reach pollinations", { status: 502, headers });
  }

  const outHeaders = new Headers(headers);
  outHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "image/jpeg");
  // [R9] only cache real images; a cached error would break that chapter's
  // illustration for 24 hours, because the URL is deterministic (prompt+seed).
  outHeaders.set("Cache-Control", upstream.ok ? "public, max-age=86400" : "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
