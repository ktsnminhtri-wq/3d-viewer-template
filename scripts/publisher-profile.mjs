export const VIEWER_SAFE_PROFILE = Object.freeze({
  name: "viewer-safe",
  maxTextureSize: 2048,
  colorTextureQuality: 82,
  webpEffort: 100,
  preserveRenderedTriangles: true,
  allowedAddedRequiredExtensions: Object.freeze([
    "EXT_texture_webp",
    "KHR_mesh_primitive_restart",
  ]),
});

