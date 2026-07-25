/* ============================================================
   Story Time — configuration.
   This is the ONLY file you should ever need to edit by hand.
   Changing it never requires rebuilding app.js — just edit,
   save, and git push.
   ============================================================ */
window.APP_CONFIG = {

  // Paste the URL your Cloudflare Worker gives you after deploying it,
  // with /v1/messages on the end. Example:
  // "https://story-time-proxy.YOUR-SUBDOMAIN.workers.dev/v1/messages"
  WORKER_URL: "https://story-time-proxy.gvmdc2tpsb.workers.dev/v1/messages",

  // Optional. If you set APP_SECRET below to some random string, put the
  // exact same string here (must match the Worker's APP_SECRET exactly).
  // Leave both blank if you don't want this extra layer.
  APP_SECRET: "",

  // Which Claude model to use for stories. claude-sonnet-5 is the current
  // recommended default (cheaper than the older claude-sonnet-4-6).
  MODEL: "claude-sonnet-5",

  // Optional. A pollinations.ai PUBLISHABLE key (starts with "pk_") from
  // enter.pollinations.ai switches illustrations to their gptimage-large
  // model (real GPT-Image quality, costs Pollen credits there).
  // Leave blank to keep using the free, unlimited "flux" model.
  // Superseded by IMAGE_URL below if that's set - kept as a fallback.
  POLLINATIONS_KEY: "",

  // Optional, recommended once you've added the /image route to your
  // Worker (see README). Your Worker's URL with /image on the end, e.g.
  // "https://story-time-proxy.YOUR-SUBDOMAIN.workers.dev/image"
  // Routes images through your Worker using an unlimited SECRET
  // pollinations key instead of the rate-limited publishable one above.
  IMAGE_URL: "https://story-time-proxy.gvmdc2tpsb.workers.dev/image",

  // Optional. A short physical description of the reader, in your own
  // words, e.g. "curly dark brown hair in two braids, green eyes, freckles".
  // Appended to every image prompt so her look stays consistent chapter to
  // chapter. Leave blank - this is never guessed or invented automatically.
  CHARACTER_LOOK: "",

};
