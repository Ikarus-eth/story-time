# ⚠️ This source is STALE — do not run `npm run build` from it

`app-source.jsx` in this folder is **older than the deployed `../app.js`**.
Building from it would silently downgrade the live app.

Confirmed differences (checked 2026-07-25 against the deployed bundle):

| | `src/app-source.jsx` | deployed `app.js` |
|---|---|---|
| `max_tokens` | `1000` | `10000` |
| `APP_CONFIG.IMAGE_URL` (Worker `/image` route) | absent | present |
| `APP_CONFIG.CHARACTER_LOOK` | absent | present |
| retry attempts in `askJson` | 2 | 4 |

The `max_tokens` one matters most: at 1000 tokens every story is cut off
mid-JSON, which produces exactly the "Oops! The story got lost on the way."
failure this repo has been chasing.

`../worker/worker.js` is stale too — it predates both the streaming rewrite
and the `/image` route. The live Worker is edited in the Cloudflare dashboard;
the current deployed version is the one now committed there.

**Before building from source again**, the missing changes need to be ported
forward from the bundle into `app-source.jsx`, and this file deleted.
Until then, `../app.js` is the source of truth.
