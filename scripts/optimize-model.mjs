import { writeFile } from "node:fs/promises";
import { NodeIO, PropertyType, Verbosity } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  dedup,
  join,
  prune,
  textureCompress,
} from "@gltf-transform/functions";
import sharp from "sharp";

const INPUT = "./model-original.glb";
const OUTPUT = "./model-optimized.glb";
const REPORT = "./optimization-transform-report.json";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
io.setLogger({
  debug: console.debug,
  info: console.info,
  warn: console.warn,
  error: console.error,
  getVerbosity: () => Verbosity.WARN,
  setVerbosity: () => {},
});

function countPrimitiveTriangles(primitive) {
  const count = primitive.getIndices()?.getCount()
    ?? primitive.getAttribute("POSITION")?.getCount()
    ?? 0;
  const mode = primitive.getMode();

  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function collectStats(document) {
  const root = document.getRoot();
  const meshes = root.listMeshes();
  const primitives = meshes.flatMap((mesh) => mesh.listPrimitives());
  let sceneTriangles = 0;

  function visitNode(node) {
    const mesh = node.getMesh();
    if (mesh) {
      sceneTriangles += mesh
        .listPrimitives()
        .reduce(
          (total, primitive) => total + countPrimitiveTriangles(primitive),
          0,
        );
    }
    for (const child of node.listChildren()) visitNode(child);
  }

  for (const scene of root.listScenes()) {
    for (const child of scene.listChildren()) visitNode(child);
  }

  return {
    scenes: root.listScenes().length,
    nodes: root.listNodes().length,
    meshes: meshes.length,
    primitives: primitives.length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    accessors: root.listAccessors().length,
    storedTriangles: primitives.reduce(
      (total, primitive) => total + countPrimitiveTriangles(primitive),
      0,
    ),
    sceneTriangles,
    textureBytes: root.listTextures().reduce(
      (total, texture) => total + (texture.getImage()?.byteLength ?? 0),
      0,
    ),
  };
}

console.info(`Reading ${INPUT}...`);
const document = await io.read(INPUT);
const before = collectStats(document);
console.info("Before transforms:", before);

// Names are intentionally ignored here. Materials that render identically should
// share one Material object even if the source exporter assigned unique labels.
await document.transform(
  dedup({
    keepUniqueNames: false,
    propertyTypes: [PropertyType.MATERIAL],
  }),
);
console.info("After material deduplication:", collectStats(document));

// Join only primitives within their existing meshes. This preserves scene nodes,
// transforms, object names, hierarchy, instancing, and the exact polygon count.
await document.transform(
  join({
    keepMeshes: true,
    keepNamed: false,
    cleanup: false,
  }),
  prune({
    keepAttributes: true,
    keepExtras: false,
    keepLeaves: false,
    keepSolidTextures: true,
  }),
  dedup({
    keepUniqueNames: false,
    propertyTypes: [
      PropertyType.ACCESSOR,
      PropertyType.MESH,
      PropertyType.TEXTURE,
      PropertyType.MATERIAL,
    ],
  }),
);
console.info("After primitive joining and cleanup:", collectStats(document));

// WebP is supported by the current <model-viewer> integration and preserves alpha.
// Only the two named leather textures are resized; all other texture dimensions
// remain unchanged. All textures are re-encoded at approximately 82% quality.
await document.transform(
  textureCompress({
    encoder: sharp,
    targetFormat: "webp",
    quality: 82,
    effort: 6,
    resize: [2048, 2048],
    pattern: /coudy-brown-leather/i,
  }),
  textureCompress({
    encoder: sharp,
    targetFormat: "webp",
    quality: 82,
    effort: 6,
    formats: /^image\/(jpeg|png)$/,
    pattern: /^(?!.*coudy-brown-leather).*$/i,
  }),
  dedup({
    keepUniqueNames: false,
    propertyTypes: [PropertyType.TEXTURE, PropertyType.MATERIAL],
  }),
  prune({
    keepAttributes: true,
    keepExtras: false,
    keepLeaves: false,
    keepSolidTextures: true,
  }),
);

const after = collectStats(document);
if (after.sceneTriangles !== before.sceneTriangles) {
  throw new Error(
    `Rendered scene triangle count changed from ${before.sceneTriangles} to ${after.sceneTriangles}. Refusing output.`,
  );
}

console.info("After texture compression:", after);
console.info(`Writing ${OUTPUT}...`);
await io.write(OUTPUT, document);
await writeFile(
  REPORT,
  `${JSON.stringify({ before, after }, null, 2)}\n`,
  "utf8",
);
console.info("Optimization transform completed successfully.");
