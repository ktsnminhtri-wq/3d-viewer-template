# Project workflow rules

- Treat every lighting adjustment as preview-only.
- Lighting requests may edit viewer files and run `npm run preview`, but must never commit, push, or deploy.
- Only after the user explicitly says `APPROVED` may lighting changes be committed and deployed.
- Keep `model.glb`, its materials, and its textures unchanged for lighting-only requests.
