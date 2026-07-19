# Project workflow rules

- Treat every lighting adjustment as preview-only.
- Lighting requests may edit viewer files and run `npm run preview`, but must never commit, push, or deploy.
- Only after the user explicitly says `APPROVED` may lighting changes be committed and deployed.
- Keep `model.glb`, its materials, and its textures unchanged for lighting-only requests.
- Treat `model-new.glb` as the only new SketchUp source export; never use `model-original.glb` as an optimization source.
- Preserve `model-new.glb` until optimization and validation succeed, then delete it and keep the generated website file as `model.glb`.
