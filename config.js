/* ============================================================
   Story Time — configuration.
   This is the ONLY file you should ever need to edit by hand.
   Changing it never requires rebuilding app.js — just edit,
   save, and git push.
   ============================================================ */
window.APP_CONFIG = {

  // Paste the URL your Cloudflare Worker gives you after deploying it,
  // with /v1/messages on the end.
  WORKER_URL: "https://story-time-proxy.gvmdc2tpsb.workers.dev/v1/messages",

  // Optional. If you set APP_SECRET below to some random string, put the
  // exact same string here (must match the Worker's APP_SECRET exactly).
  // Leave both blank if you don't want this extra layer.
  APP_SECRET: "",

  // Which Claude model to use for stories. claude-sonnet-5 is the current
  // recommended default (cheaper than the older claude-sonnet-4-6).
  MODEL: "claude-sonnet-5",

  // Old direct/publishable-key path. Superseded by IMAGE_URL below - leave
  // blank now that images route through the Worker.
  POLLINATIONS_KEY: "",

  // Routes images through your Worker using the unlimited SECRET
  // pollinations key (set as a Worker secret, never here).
  IMAGE_URL: "https://story-time-proxy.gvmdc2tpsb.workers.dev/image",

  // Optional. A short physical description of the reader, in your own
  // words, e.g. "curly dark brown hair in two braids, green eyes, freckles".
  // Appended to every image prompt so her look stays consistent chapter to
  // chapter. Leave blank - this is never guessed or invented automatically.
  CHARACTER_LOOK: "",

};
