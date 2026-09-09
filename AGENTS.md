# Project workflow rules

- Treat every lighting adjustment as preview-only.
- Lighting requests may edit viewer files and run `npm run preview`, but must never commit, push, or deploy.
- Only after the user explicitly says `APPROVED` may lighting changes be committed and deployed.
- Keep `model.glb`, its materials, and its textures unchanged for lighting-only requests.
- Treat any path passed to `npm run publish -- <source.glb>` as immutable input: never modify, rename, overwrite, or delete it.
- Preview must only serve the validated artifact in `dist/current`; it must not optimize or select another source model.
- GitHub deployment is an optional adapter that consumes `dist/current` and must remain separate from the publisher core.
