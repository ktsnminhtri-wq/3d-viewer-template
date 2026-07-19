import { writeFile } from "node:fs/promises";
import {
  Logger,
  NodeIO,
  PropertyType,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import {
  compressTexture,
  dedup,
  join,
  listTextureSlots,
  prune,
} from "@gltf-transform/functions";
import sharp from "sharp";

const INPUT = process.argv[2] ?? "./model-source-backup.glb";
const OUTPUT = process.argv[3] ?? "./model-optimized.glb";
const REPORT = process.argv[4] ?? "./optimization-transform-report.json";

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
io.setLogger(new Logger(Logger.Verbosity.WARN));

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
      sceneTriangles += mesh.listPrimitives().reduce(
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

function isDataTexture(texture) {
  return listTextureSlots(texture).some((slot) => (
    /normal|occlusion|metallic|roughness|transmission|thickness|specular/i.test(slot)
  ));
}

console.info(`Reading ${INPUT}...`);
const document = await io.read(INPUT);
const before = collectStats(document);
console.info("Before transforms:", before);

// Exporters often create unique names for otherwise identical materials.
await document.transform(
  dedup({
    keepUniqueNames: false,
    propertyTypes: [PropertyType.MATERIAL],
  }),
);

// Join compatible primitives only within their existing mesh. Object names,
// transforms, hierarchy, instancing, and rendered triangle count are preserved.
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

// Avoid generation loss on already-compliant WebP textures. Color textures use
// quality 82; data textures use lossless WebP. Any image over 2048 px is resized.
for (const texture of document.getRoot().listTextures()) {
  const image = texture.getImage();
  if (!image) continue;

  const mimeType = texture.getMimeType();
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) continue;

  const metadata = await sharp(image).metadata();
  const oversized = Math.max(metadata.width ?? 0, metadata.height ?? 0) > 2048;
  const needsWebP = mimeType !== "image/webp";
  if (!oversized && !needsWebP) continue;

  const dataTexture = isDataTexture(texture);
  await compressTexture(texture, {
    encoder: sharp,
    targetFormat: "webp",
    effort: 6,
    ...(oversized ? { resize: [2048, 2048] } : {}),
    ...(dataTexture ? { lossless: true } : { quality: 82 }),
  });
}

// WebP image payloads must be declared through EXT_texture_webp. The
// single-texture helper changes the MIME type but does not add the document
// extension automatically.
if (document.getRoot().listTextures().some((texture) => texture.getMimeType() === "image/webp")) {
  const existingWebPExtension = document
    .getRoot()
    .listExtensionsUsed()
    .find((extension) => extension.extensionName === EXTTextureWebP.EXTENSION_NAME);
  (existingWebPExtension ?? document.createExtension(EXTTextureWebP)).setRequired(true);
}

await document.transform(
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

console.info("After transforms:", after);
console.info(`Writing ${OUTPUT}...`);
await io.write(OUTPUT, document);
await writeFile(
  REPORT,
  `${JSON.stringify({ input: INPUT, output: OUTPUT, before, after }, null, 2)}\n`,
  "utf8",
);
console.info("Optimization completed successfully without geometry simplification.");
