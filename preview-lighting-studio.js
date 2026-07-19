const DEFAULTS = Object.freeze({
  environment: "warm",
  rotation: 0,
  exposure: 1.3,
  shadowIntensity: 0.8,
  shadowSoftness: 0.95,
});

const ENVIRONMENTS = Object.freeze({
  neutral: "neutral",
  studio: "https://modelviewer.dev/shared-assets/environments/moon_1k.hdr",
  soft: "neutral",
  outdoor: "https://modelviewer.dev/shared-assets/environments/whipple_creek_regional_park_1k_HDR.jpg",
  warm: "./assets/spruit-sunrise-1k-hdr.jpg",
});

const modelViewer = document.querySelector("#modelViewer");
if (!modelViewer || document.querySelector("#lightingStudio")) {
  throw new Error("Preview Lighting Studio could not find the viewer.");
}

const studio = document.createElement("aside");
studio.id = "lightingStudio";
studio.className = "lighting-studio";
studio.setAttribute("aria-label", "Preview Lighting Studio");
studio.innerHTML = `
  <div class="lighting-studio__header">
    <strong>Lighting Studio</strong>
    <span class="lighting-studio__badge">Local preview</span>
  </div>
  <label class="lighting-studio__field">
    <span class="lighting-studio__label"><span>Environment</span></span>
    <select data-lighting="environment">
      <option value="neutral">Neutral</option>
      <option value="studio">Studio</option>
      <option value="soft">Soft</option>
      <option value="outdoor">Outdoor</option>
      <option value="warm">Warm</option>
    </select>
  </label>
  <label class="lighting-studio__field">
    <span class="lighting-studio__label"><span>Exposure</span><output data-output="exposure"></output></span>
    <input data-lighting="exposure" type="range" min="0.6" max="2" step="0.01" />
  </label>
  <label class="lighting-studio__field">
    <span class="lighting-studio__label"><span>Shadow intensity</span><output data-output="shadowIntensity"></output></span>
    <input data-lighting="shadowIntensity" type="range" min="0" max="1" step="0.01" />
  </label>
  <label class="lighting-studio__field">
    <span class="lighting-studio__label"><span>Shadow softness</span><output data-output="shadowSoftness"></output></span>
    <input data-lighting="shadowSoftness" type="range" min="0" max="2" step="0.01" />
  </label>
  <div class="lighting-studio__actions">
    <button type="button" data-action="reset">Reset</button>
    <button type="button" class="lighting-studio__save" data-action="save">Save Lighting</button>
  </div>
  <p class="lighting-studio__status" data-status aria-live="polite"></p>
`;
document.body.append(studio);

const controls = Object.fromEntries(
  [...studio.querySelectorAll("[data-lighting]")].map((element) => [element.dataset.lighting, element]),
);
const outputs = Object.fromEntries(
  [...studio.querySelectorAll("[data-output]")].map((element) => [element.dataset.output, element]),
);
const status = studio.querySelector("[data-status]");
let config = { ...DEFAULTS };
let appliedRotation = 0;

function displayValues() {
  outputs.exposure.textContent = Number(config.exposure).toFixed(2);
  outputs.shadowIntensity.textContent = Number(config.shadowIntensity).toFixed(2);
  outputs.shadowSoftness.textContent = Number(config.shadowSoftness).toFixed(2);
}

function syncControls() {
  for (const [key, control] of Object.entries(controls)) control.value = config[key];
  displayValues();
}

function rotateEnvironment(newRotation) {
  const delta = (newRotation - appliedRotation) * Math.PI / 180;
  const orbit = modelViewer.getCameraOrbit?.();
  modelViewer.orientation = `0deg ${newRotation}deg 0deg`;
  if (orbit && Number.isFinite(orbit.theta) && Number.isFinite(orbit.phi)) {
    modelViewer.cameraOrbit = `${orbit.theta + delta}rad ${orbit.phi}rad ${orbit.radius}m`;
  }
  appliedRotation = newRotation;
}

function applyLighting(nextConfig, { preserveView = true } = {}) {
  config = { ...config, ...nextConfig };
  modelViewer.environmentImage = ENVIRONMENTS[config.environment];
  modelViewer.toneMapping = config.environment === "soft" ? "agx" : "neutral";
  modelViewer.exposure = Number(config.exposure);
  modelViewer.shadowIntensity = Number(config.shadowIntensity);
  modelViewer.shadowSoftness = Number(config.shadowSoftness);
  if (preserveView) rotateEnvironment(Number(config.rotation));
  else {
    modelViewer.orientation = `0deg ${config.rotation}deg 0deg`;
    appliedRotation = Number(config.rotation);
  }
  displayValues();
}

for (const [key, control] of Object.entries(controls)) {
  control.addEventListener("input", () => {
    const value = key === "environment" ? control.value : Number(control.value);
    applyLighting({ [key]: value });
    status.textContent = "Unsaved changes";
    status.dataset.state = "";
  });
}

studio.querySelector('[data-action="reset"]').addEventListener("click", () => {
  applyLighting(DEFAULTS);
  syncControls();
  status.textContent = "Defaults restored — save to keep them";
  status.dataset.state = "";
});

studio.querySelector('[data-action="save"]').addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  status.textContent = "Saving…";
  status.dataset.state = "";
  try {
    const response = await fetch("./__preview_lighting", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!response.ok) throw new Error(await response.text());
    config = await response.json();
    syncControls();
    status.textContent = "Saved to lighting-config.json";
    status.dataset.state = "success";
  } catch (error) {
    status.textContent = `Save failed: ${error.message}`;
    status.dataset.state = "error";
  } finally {
    button.disabled = false;
  }
});

try {
  const response = await fetch("./lighting-config.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  config = { ...DEFAULTS, ...await response.json() };
  appliedRotation = Number(config.rotation);
  syncControls();
  await customElements.whenDefined("model-viewer");
  applyLighting(config, { preserveView: false });
} catch (error) {
  syncControls();
  status.textContent = `Using defaults: ${error.message}`;
  status.dataset.state = "error";
}
