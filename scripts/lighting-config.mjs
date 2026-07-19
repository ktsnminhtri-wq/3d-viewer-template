import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_LIGHTING = Object.freeze({
  environment: "warm",
  rotation: 0,
  exposure: 1.3,
  shadowIntensity: 0.8,
  shadowSoftness: 0.95,
});

export const ENVIRONMENT_PRESETS = Object.freeze({
  neutral: { image: "neutral", toneMapping: "neutral" },
  studio: {
    image: "https://modelviewer.dev/shared-assets/environments/moon_1k.hdr",
    toneMapping: "neutral",
  },
  soft: { image: "neutral", toneMapping: "agx" },
  outdoor: {
    image: "https://modelviewer.dev/shared-assets/environments/whipple_creek_regional_park_1k_HDR.jpg",
    toneMapping: "neutral",
  },
  warm: { image: "./assets/spruit-sunrise-1k-hdr.jpg", toneMapping: "neutral" },
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function normalizeLightingConfig(value = {}) {
  const environment = Object.hasOwn(ENVIRONMENT_PRESETS, value.environment)
    ? value.environment
    : DEFAULT_LIGHTING.environment;
  return {
    environment,
    rotation: round(clamp(finiteNumber(value.rotation, DEFAULT_LIGHTING.rotation), 0, 360), 0),
    exposure: round(clamp(finiteNumber(value.exposure, DEFAULT_LIGHTING.exposure), 0.6, 2), 2),
    shadowIntensity: round(clamp(finiteNumber(value.shadowIntensity, DEFAULT_LIGHTING.shadowIntensity), 0, 1), 2),
    shadowSoftness: round(clamp(finiteNumber(value.shadowSoftness, DEFAULT_LIGHTING.shadowSoftness), 0, 2), 2),
  };
}

export async function readLightingConfig(root, { create = false } = {}) {
  const configPath = path.join(root, "lighting-config.json");
  let config = DEFAULT_LIGHTING;
  try {
    config = normalizeLightingConfig(JSON.parse(await readFile(configPath, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Invalid lighting-config.json: ${error.message}`);
    if (!create) throw error;
  }
  if (create) await writeLightingConfig(root, config);
  return config;
}

export async function writeLightingConfig(root, value) {
  const config = normalizeLightingConfig(value);
  await writeFile(
    path.join(root, "lighting-config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
    "utf8",
  );
  return config;
}

function setHTMLAttribute(tag, name, value) {
  const escaped = String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  const attribute = `${name}="${escaped}"`;
  const pattern = new RegExp(`\\s+${name}=(?:"[^"]*"|'[^']*')`, "i");
  return pattern.test(tag)
    ? tag.replace(pattern, `\n        ${attribute}`)
    : tag.replace(/>$/, `\n        ${attribute}\n      >`);
}

export async function bakeLightingIntoViewer(root, value) {
  const config = normalizeLightingConfig(value);
  const preset = ENVIRONMENT_PRESETS[config.environment];
  const indexPath = path.join(root, "index.html");
  const source = await readFile(indexPath, "utf8");
  const match = source.match(/<model-viewer\b[\s\S]*?>/i);
  if (!match) throw new Error("index.html does not contain a <model-viewer> element.");

  let tag = match[0];
  tag = setHTMLAttribute(tag, "data-lighting-preset", config.environment);
  tag = setHTMLAttribute(tag, "environment-image", preset.image);
  tag = setHTMLAttribute(tag, "tone-mapping", preset.toneMapping);
  tag = setHTMLAttribute(tag, "exposure", config.exposure);
  tag = setHTMLAttribute(tag, "shadow-intensity", config.shadowIntensity);
  tag = setHTMLAttribute(tag, "shadow-softness", config.shadowSoftness);
  tag = setHTMLAttribute(tag, "orientation", `0deg ${config.rotation}deg 0deg`);
  tag = setHTMLAttribute(tag, "camera-orbit", `${config.rotation}deg 75deg auto`);

  const output = source.replace(match[0], tag);
  if (output !== source) await writeFile(indexPath, output, "utf8");
  return config;
}
