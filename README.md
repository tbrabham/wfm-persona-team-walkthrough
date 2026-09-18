# How the WFM forecast persona team works

A static, interactive walkthrough of the WFM forecast persona team (The Desk,
Michael, Stu, Sara, Casey). Type any question and it runs the Desk's actual
routing rules and model-tier logic client-side, then animates the resulting
conversation and hand-offs.

**This is a decision-logic simulation, not a live system.** It does not call
the Finance Cube, Glean, or Trino — it shows who would get called, in what
order, on what model tier, and why, based on the same rules encoded in the
real persona files (`.claude/agents/desk.md` etc). No API keys, no secrets,
no backend — safe to host publicly.

## Run it locally

Any static file server works, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Publish on GitHub Pages

1. Create a new repo (or a folder in an existing one) and add these three files: `index.html`, `styles.css`, `app.js`.
2. Push to GitHub.
3. In the repo: **Settings → Pages → Source → Deploy from a branch**, pick `main` (or your default branch) and `/ (root)`.
4. Wait a minute, then the page is live at `https://<org-or-user>.github.io/<repo>/`.

## Editing the routing logic

All of the actual decision logic lives in `app.js`, in the `RULES` object and
the `routeQuestion` / `modelFor` functions. If the real Desk's rules change
(new keyword, new escalation trigger, new specialist), update it there —
`index.html` and `styles.css` shouldn't need to change.
