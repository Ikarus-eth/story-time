# Story Time — standalone deployment

Everything the reading app needs, restructured to run as a real website
instead of a Claude artifact. Three things changed from the artifact
version: where it gets its Claude API access (your own key, via a small
proxy, instead of the artifact's built-in one), where it saves data
(`localStorage` instead of the artifact's `window.storage`), and how it's
built (one plain `app.js` file instead of live JSX). Everything else —
every screen, every prompt, all the SRS/chapter logic — is unchanged.

Three parts to set up, in this order: **the Worker → the website → the
iPad**. About 20–30 minutes total, most of it account creation.

---

## Part 1 — Anthropic API key

1. Go to **console.anthropic.com** → sign in → **API Keys** → **Create Key**.
   Copy it immediately (shown once).
2. Add billing: **Settings → Billing**. Load a small amount — **$5–10 is
   plenty** for this app; a full story chapter costs a few cents.
3. **Turn auto-reload OFF.** This is the important step: with auto-reload
   off, you mechanically cannot spend more than what you loaded, no matter
   what happens to the key later. This is your actual safety net, more
   than anything technical.

Keep this key somewhere safe for a minute — it goes into the Worker next,
nowhere else.

---

## Part 2 — Cloudflare Worker (holds the key, proxies requests)

1. Go to **dash.cloudflare.com** → sign up free → **Workers & Pages** →
   **Create** → **Create Worker**.
2. Give it a name (e.g. `story-time-proxy`) → **Deploy** (deploys a
   placeholder first, that's fine).
3. Click **Edit code**. Delete everything in the editor, paste in the
   full contents of `worker/worker.js` from this package.
4. In that pasted code, change this line near the top to your actual
   GitHub Pages URL (you'll create it in Part 3 — if you already know
   your GitHub username, it's `https://USERNAME.github.io`):
   ```js
   const ALLOWED_ORIGIN = "https://YOUR-GITHUB-USERNAME.github.io";
   ```
5. Click **Save and deploy**.
6. Go to the Worker's **Settings → Variables and Secrets** → **Add** →
   name it exactly `ANTHROPIC_API_KEY`, paste your real key as the value,
   toggle **Encrypt**, save.
7. Copy the Worker's URL from the top of its dashboard page (looks like
   `https://story-time-proxy.YOUR-SUBDOMAIN.workers.dev`). You'll need
   this in Part 3.

That's the only paid-key-holding piece. The website never sees it.

---

## Part 3 — GitHub Pages (the website itself)

1. Go to **github.com** → **New repository** → any name (e.g.
   `story-time`) → **Public** (required for free-plan Pages) → Create.
2. On your computer, open a terminal in a fresh folder and run:
   ```bash
   git clone https://github.com/YOUR-GITHUB-USERNAME/story-time.git
   cd story-time
   ```
3. Copy every file from this package into that folder (keep the folder
   structure: `index.html`, `config.js`, `app.js`, `manifest.json`,
   `icons/`, `worker/`, `src/` — `worker/` and `src/` are just there for
   reference, GitHub Pages will ignore them).
4. Open `config.js` in any text editor and fill in:
   ```js
   WORKER_URL: "https://story-time-proxy.YOUR-SUBDOMAIN.workers.dev/v1/messages",
   ```
   (your Worker URL from Part 2, **with `/v1/messages` added on the end**).
   Leave `APP_SECRET` and `POLLINATIONS_KEY` blank for now — both
   optional, see below.
5. Push it:
   ```bash
   git add .
   git commit -m "Story Time"
   git push
   ```
6. On GitHub: **Settings → Pages** → under "Build and deployment", source
   = **Deploy from a branch** → branch = **main**, folder = **/ (root)**
   → **Save**.
7. Wait 1–2 minutes, then visit `https://YOUR-GITHUB-USERNAME.github.io/story-time/`.
   It should load and be able to generate a story. If you get an error,
   see Troubleshooting below.

---

## Part 4 — iPad home screen

1. Open the site above in **Safari** on the iPad (must be Safari, not
   another browser, for this to work).
2. Tap the **Share** icon → **Add to Home Screen** → **Add**.
3. That's it — the icon on the home screen now opens full-screen, no
   address bar, like a real app.

---

## Optional: better images

The image pipeline (pollinations → real photos → hand-drawn fallback)
already works with no setup, same as before. If you want the higher
GPT-Image-quality tier:

1. Go to **enter.pollinations.ai**, get a **publishable key** (starts
   `pk_`).
2. In `config.js`, set `POLLINATIONS_KEY: "pk_..."`.
3. `git add config.js && git commit -m "add image key" && git push`.
   No rebuild needed — this file isn't part of the bundle.

## Optional: the shared-secret layer

Raises the bar slightly against someone finding your Worker URL directly
(not real protection — the value still sits in your public site's JS —
but cheap to add):

1. In `worker/worker.js`, set `const APP_SECRET = "some-random-string";`
   before deploying (or re-deploy after editing).
2. In `config.js`, set `APP_SECRET: "some-random-string"` — must match
   exactly.
3. Push `config.js`; re-deploy the Worker if you changed it.

---

## Making future changes

- **Editing `config.js`, icons, or `manifest.json`**: edit, commit, push.
  Takes effect immediately, no rebuild.
- **Changing app behavior** (anything in `src/app-source.jsx`): this file
  needs to be rebuilt into `app.js`. Easiest is to come back and ask me —
  paste or describe the change and I'll rebuild `app.js` for you. If you'd
  rather do it yourself: `cd src && npm install && npx esbuild entry.jsx
  --bundle --minify --outfile=../app.js --loader:.jsx=jsx
  --define:process.env.NODE_ENV='"production"'`.

## Troubleshooting

- **Blank page / errors in Safari's console**: Settings → Safari →
  Advanced → Web Inspector (enable), then plug the iPad into a Mac and
  inspect via Safari's Develop menu — or just test the same URL in a
  desktop browser first, easier to debug.
- **"APP_CONFIG.WORKER_URL is not set"**: `config.js` wasn't filled in,
  or didn't get pushed/deployed.
- **CORS / "Forbidden origin" from the Worker**: `ALLOWED_ORIGIN` in
  `worker/worker.js` doesn't exactly match your GitHub Pages URL (check
  for trailing slash, http vs https, www or not).
- **Story generation fails silently**: open the browser's network tab,
  check what the Worker actually returned — usually a billing/key issue
  (no credit loaded, key mistyped) surfaced from Anthropic's own error.
- **Old version keeps showing after a push**: GitHub Pages can take a
  minute or two to redeploy; also try a hard refresh (the browser may be
  caching `app.js`).

## What I could not test from here

I don't have a live GitHub Pages URL or an iPad to verify the full,
real, end-to-end path — the bundle builds cleanly and passes syntax
checks, and every piece (Worker CORS logic, config wiring, localStorage
swap) is the same pattern already confirmed working for the pollinations
and Openverse calls earlier. But the first real deploy is the actual
test. If something doesn't work exactly as described above, tell me what
you're seeing and I'll fix it.
