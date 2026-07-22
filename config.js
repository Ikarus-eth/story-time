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
  WORKER_URL: "",

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
  POLLINATIONS_KEY: "",

};
