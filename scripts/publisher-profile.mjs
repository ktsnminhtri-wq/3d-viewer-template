export const VIEWER_SAFE_PROFILE = Object.freeze({
  name: "viewer-safe",
  maxTextureSize: 2048,
  colorTextureQuality: 82,
  webpEffort: 100,
  preserveRenderedTriangles: true,
  // Applied only to LARGE/HIGHLY_FRAGMENTED paths. Production framing uses the
  // validated world bounds from metadata instead of model-viewer's internal
  // EXT_mesh_gpu_instancing bounds.
  runtimeInstancing: true,
  minimumInstanceCount: 2,
  allowedAddedRequiredExtensions: Object.freeze([
    "EXT_texture_webp",
    "EXT_mesh_gpu_instancing",
    "KHR_mesh_primitive_restart",
  ]),
});
