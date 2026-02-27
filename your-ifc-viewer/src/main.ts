// IFC Viewer
import * as THREE from "three";
import * as WEBIFC from "web-ifc";
import * as BUI from "@thatopen/ui";
import * as OBC from "@thatopen/components";
import type * as FRAGS from "@thatopen/fragments";
import Stats from "stats.js";

const container = document.getElementById("container")!;

const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);
const world = worlds.create<OBC.SimpleScene, OBC.SimpleCamera, OBC.SimpleRenderer>();

world.scene = new OBC.SimpleScene(components);
world.renderer = new OBC.SimpleRenderer(components, container);
world.camera = new OBC.SimpleCamera(components);

components.init();
world.camera.controls.setLookAt(12, 6, 8, 0, 0, -10);
world.scene.setup();
world.scene.three.background = new THREE.Color(0x2d4a5e);

const grids = components.get(OBC.Grids);
grids.create(world);

// IFC loader
const fragments = components.get(OBC.FragmentsManager);
const fragmentIfcLoader = components.get(OBC.IfcLoader);
await fragmentIfcLoader.setup();

const excludedCats = [
  WEBIFC.IFCTENDONANCHOR,
  WEBIFC.IFCREINFORCINGBAR,
  WEBIFC.IFCREINFORCINGELEMENT,
];
for (const cat of excludedCats) {
  fragmentIfcLoader.settings.excludedCategories.add(cat);
}
fragmentIfcLoader.settings.webIfc.COORDINATE_TO_ORIGIN = true;

/** Load IFC from a URL (fetch + load). Used by ?model= and by Angular postMessage LOAD_IFC. */
async function loadIfcFromUrl(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.arrayBuffer();
  const buffer = new Uint8Array(data);
  const model = await fragmentIfcLoader.load(buffer);
  (model as { name?: string }).name = "loaded";
  world.scene.three.add(model);
}

// Optional: load model from ?model= URL (e.g. when embedded in Angular)
const params = new URLSearchParams(window.location.search);
const modelUrl = params.get("model");
if (modelUrl) {
  try {
    await loadIfcFromUrl(modelUrl);
  } catch (e) {
    console.error("Failed to load model from URL:", modelUrl, e);
  }
}

// Listen for LOAD_IFC and DESELECT from Angular (postMessage) when embedded
window.addEventListener("message", async (event: MessageEvent) => {
  const msg = event.data;
  if (msg?.type === "LOAD_IFC" && typeof msg.url === "string") {
    try {
      await loadIfcFromUrl(msg.url);
    } catch (e) {
      console.error("Failed to load IFC from postMessage:", msg.url, e);
    }
    return;
  }
  if (msg?.type === "DESELECT") {
    clearSelectionAndHighlight();
  }
  if (msg?.type === "HIGHLIGHT_LINKED") {
    const globalIds = Array.isArray(msg.globalIds) ? (msg.globalIds as string[]) : [];
    const colorHex = typeof msg.color === "number" ? msg.color : 0xbcf124;
    applyLinkedHighlight(globalIds, colorHex);
    return;
  }
  if (msg?.type === "CLEAR_LINKED_HIGHLIGHT") {
    clearLinkedHighlight();
  }
  if (msg?.type === "CAPTURE_SCREENSHOT") {
    const runCapture = () => {
      try {
        const canvas = (world.renderer as unknown as { three: { domElement: HTMLCanvasElement } }).three.domElement;
        const dataUrl = canvas.toDataURL("image/png");
        const base64 = dataUrl.split(",")[1] ?? "";
        if (window.parent !== window) {
          window.parent.postMessage({ type: "IFC_SCREENSHOT", base64 }, "*");
        }
      } catch (e) {
        console.error("Failed to capture screenshot:", e);
        if (window.parent !== window) {
          window.parent.postMessage({ type: "IFC_SCREENSHOT", base64: null, error: "capture failed" }, "*");
        }
      }
    };
    const renderer = world.renderer as unknown as { onAfterUpdate: { add: (cb: () => void) => void; remove?: (cb: () => void) => void } };
    const onCapture = () => {
      if (renderer.onAfterUpdate.remove) renderer.onAfterUpdate.remove(onCapture);
      runCapture();
    };
    renderer.onAfterUpdate.add(onCapture);
  }
});

// ─── Selection: raycaster, click, properties, postMessage ─────────────────
const raycasters = components.get(OBC.Raycasters);
const raycaster = raycasters.get(world);
const classifier = components.get(OBC.Classifier);

let currentSelection: {
  model: FRAGS.FragmentsGroup;
  fragmentIdMap: FRAGS.FragmentIdMap;
  expressId: number;
  globalId: string;
  mesh: THREE.InstancedMesh;
  instanceId: number;
  originalColor: { r: number; g: number; b: number };
} | null = null;

const HIGHLIGHT_COLOR = new THREE.Color(0xbcf124);

/** Read the current instance color from the mesh (before overwriting with highlight). */
function getInstanceColor(
  mesh: THREE.InstancedMesh,
  instanceId: number
): { r: number; g: number; b: number } | null {
  try {
    if (!mesh?.instanceColor || instanceId < 0 || instanceId >= mesh.count) return null;
    const attr = mesh.instanceColor;
    return { r: attr.getX(instanceId), g: attr.getY(instanceId), b: attr.getZ(instanceId) };
  } catch {
    return null;
  }
}

/** Restore one instance's color on the fragment InstancedMesh to the given original color. */
function setFragmentInstanceColor(
  mesh: THREE.InstancedMesh,
  instanceId: number,
  r: number,
  g: number,
  b: number
): void {
  try {
    if (!mesh?.instanceColor) return;
    const attr = mesh.instanceColor;
    if (instanceId >= 0 && instanceId < mesh.count) {
      attr.setXYZ(instanceId, r, g, b);
      attr.needsUpdate = true;
    }
  } catch (_) {}
}

function clearSelectionAndHighlight(): void {
  if (currentSelection) {
    try {
      classifier.resetColor(currentSelection.fragmentIdMap);
    } catch (_) {}
    const { r, g, b } = currentSelection.originalColor;
    setFragmentInstanceColor(currentSelection.mesh, currentSelection.instanceId, r, g, b);
    (world.renderer as unknown as { needsUpdate?: boolean }).needsUpdate = true;
    currentSelection = null;
  }
}

function getGlobalIdFromModel(model: FRAGS.FragmentsGroup, expressId: number): string {
  for (const [guid, id] of model.globalToExpressIDs.entries()) {
    if (id === expressId) return guid;
  }
  return "";
}

// ─── Linked highlight (BCF topic → model) ─────────────────────────────────
type LinkedHighlightEntry = {
  model: FRAGS.FragmentsGroup;
  fragment: { id: string; group?: FRAGS.FragmentsGroup; getItemID: (i: number) => number | null };
  expressId: number;
  instanceId: number;
  mesh: THREE.InstancedMesh;
  originalColor: { r: number; g: number; b: number };
};
let linkedHighlightEntries: LinkedHighlightEntry[] = [];

/** Resolve a single globalId to model, fragment, expressId, instanceId and mesh. */
function resolveGlobalIdToInstance(globalId: string): LinkedHighlightEntry | null {
  if (!globalId || !fragments.groups?.size) return null;
  const groups = Array.from(fragments.groups.values());
  for (const model of groups) {
    let expressId: number | null = null;
    for (const [guid, id] of model.globalToExpressIDs.entries()) {
      if (guid === globalId) {
        expressId = id;
        break;
      }
    }
    if (expressId == null) continue;
    let found: LinkedHighlightEntry | null = null;
    (model as unknown as THREE.Object3D).traverse((obj: unknown) => {
      if (found) return;
      const mesh = obj as THREE.InstancedMesh & { fragment?: { getItemID: (i: number) => number | null; id: string; group?: FRAGS.FragmentsGroup } };
      const fragment = mesh.fragment;
      if (!fragment?.group || fragment.group !== model) return;
      if (!mesh.instanceColor || mesh.count === 0) return;
      for (let i = 0; i < mesh.count; i++) {
        if (fragment.getItemID(i) === expressId) {
          const orig = getInstanceColor(mesh, i) ?? { r: 1, g: 1, b: 1 };
          found = { model, fragment, expressId, instanceId: i, mesh, originalColor: orig };
          return;
        }
      }
    });
    if (found) return found;
  }
  return null;
}

/** Resolve multiple globalIds to linked highlight entries. */
function resolveGlobalIdsToInstances(globalIds: string[]): LinkedHighlightEntry[] {
  const result: LinkedHighlightEntry[] = [];
  for (const gid of globalIds) {
    const entry = resolveGlobalIdToInstance(gid);
    if (entry) result.push(entry);
  }
  return result;
}

function clearLinkedHighlight(): void {
  for (const e of linkedHighlightEntries) {
    setFragmentInstanceColor(e.mesh, e.instanceId, e.originalColor.r, e.originalColor.g, e.originalColor.b);
  }
  linkedHighlightEntries = [];
  (world.renderer as unknown as { needsUpdate?: boolean }).needsUpdate = true;
}

async function applyLinkedHighlight(globalIds: string[], colorHex: number): Promise<void> {
  for (const e of linkedHighlightEntries) {
    setFragmentInstanceColor(e.mesh, e.instanceId, e.originalColor.r, e.originalColor.g, e.originalColor.b);
  }
  linkedHighlightEntries = [];
  if (globalIds.length === 0) {
    (world.renderer as unknown as { needsUpdate?: boolean }).needsUpdate = true;
    return;
  }
  const color = new THREE.Color(colorHex);
  const entries = resolveGlobalIdsToInstances(globalIds);
  linkedHighlightEntries = entries;
  for (const e of entries) {
    setFragmentInstanceColor(e.mesh, e.instanceId, color.r, color.g, color.b);
  }
  if (globalIds.length === 1 && entries.length === 1) {
    const e = entries[0];
    try {
      const payload = await buildPropertiesPayloadFromHierarchy(e.model, e.expressId);
      payload.GlobalId = globalIds[0];
      const data = serializePropertiesForPostMessage(payload);
      if (window.parent !== window) {
        window.parent.postMessage({ type: "IFC_PROPERTIES", data }, "*");
      }
    } catch (_) {
      if (window.parent !== window) {
        window.parent.postMessage({ type: "IFC_PROPERTIES", data: {} }, "*");
      }
    }
  }
  (world.renderer as unknown as { needsUpdate?: boolean }).needsUpdate = true;
}

/**
 * Unwrap a web-ifc typed wrapper (e.g. IfcIdentifier {value, type, name})
 * into a plain JS primitive. Works for Name, NominalValue, Labels, etc.
 */
function unwrapIfcValue(val: unknown): string | number | boolean | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "object" && val !== null && "value" in val) {
    const inner = (val as { value: unknown }).value;
    if (typeof inner === "string" || typeof inner === "number" || typeof inner === "boolean") return inner;
    if (inner === null || inner === undefined) return null;
    return String(inner);
  }
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
  return String(val);
}

function serializePropertiesForPostMessage(attrs: Record<string, unknown> | null): Record<string, unknown> {
  if (!attrs || typeof attrs !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "object" && !Array.isArray(value) && value !== null) {
      try {
        out[key] = JSON.parse(JSON.stringify(value));
      } catch {
        out[key] = String(value);
      }
    } else if (typeof value !== "function" && typeof value !== "symbol") {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build IFC_PROPERTIES payload from IFC hierarchy:
 * IfcRelDefinesByProperties → IfcPropertySet (Name) → IfcPropertySingleValue (Name + NominalValue).
 */
async function buildPropertiesPayloadFromHierarchy(
  model: FRAGS.FragmentsGroup,
  expressId: number
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};

  const entityNameResult = await OBC.IfcPropertiesUtils.getEntityName(model, expressId);
  const rawName = entityNameResult?.name ?? entityNameResult?.key;
  payload.Name = (rawName ? unwrapIfcValue(rawName) : null) ?? "Unknown";

  let relationMap: { [relatingID: number]: number[] };
  try {
    relationMap = await OBC.IfcPropertiesUtils.getRelationMap(model, WEBIFC.IFCRELDEFINESBYPROPERTIES);
  } catch {
    return payload;
  }

  const psetIds: number[] = [];
  for (const [relatingIdStr, relatedIds] of Object.entries(relationMap)) {
    const related = relatedIds as number[];
    if (related.includes(expressId)) psetIds.push(Number(relatingIdStr));
  }

  for (const psetId of psetIds) {
    let psetName: string;
    try {
      const psetNameResult = await OBC.IfcPropertiesUtils.getEntityName(model, psetId);
      const rawPsetName = psetNameResult?.name ?? psetNameResult?.key;
      psetName = (rawPsetName ? String(unwrapIfcValue(rawPsetName) ?? "PropertySet") : null) ?? "PropertySet";
    } catch {
      psetName = "PropertySet";
    }

    let propIds: number[] = [];
    try {
      const ids = await OBC.IfcPropertiesUtils.getPsetProps(model, psetId);
      propIds = ids ? [...ids] : [];
    } catch {
      propIds = [];
    }

    if (propIds.length === 0) {
      try {
        const psetAttrs = await model.getProperties(psetId);
        if (psetAttrs && typeof psetAttrs === "object") {
          const hasProp = (psetAttrs as Record<string, unknown>).HasProperties;
          if (Array.isArray(hasProp)) {
            for (const entry of hasProp) {
              if (typeof entry === "number") propIds.push(entry);
              else if (entry && typeof entry === "object" && "value" in entry && typeof (entry as { value: unknown }).value === "number") propIds.push((entry as { value: number }).value);
            }
          }
        }
      } catch { /* ignore */ }
    }

    const psetObj: Record<string, unknown> = {};
    for (const propId of propIds) {
      try {
        const propAttrs = await model.getProperties(propId);
        if (!propAttrs || typeof propAttrs !== "object") continue;
        const propName = unwrapIfcValue((propAttrs as Record<string, unknown>).Name);
        if (propName === null) continue;
        const nominalValue = unwrapIfcValue((propAttrs as Record<string, unknown>).NominalValue);
        if (nominalValue !== null) {
          psetObj[String(propName)] = nominalValue;
        }
      } catch {
        // skip this property
      }
    }
    payload[psetName] = psetObj;
  }

  if (psetIds.length === 0) {
    const raw = await model.getProperties(expressId);
    if (raw && typeof raw === "object") {
      const flat = raw as Record<string, unknown>;
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (k === "Name") continue;
        if (v === null || v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        if (typeof v === "object" && !Array.isArray(v)) {
          try {
            payload[k] = JSON.parse(JSON.stringify(v));
          } catch {
            payload[k] = String(v);
          }
        } else {
          rest[k] = v;
        }
      }
      if (Object.keys(rest).length > 0) payload.Properties = rest;
    }
  }

  return payload;
}

async function onContainerClick(event: MouseEvent): Promise<void> {
  const canvas = container.querySelector("canvas") ?? (container as unknown as HTMLCanvasElement);
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  const position = new THREE.Vector2(x, y);

  const hit = raycaster.castRay([world.scene.three], position);
  if (!hit?.object) {
    clearSelectionAndHighlight();
    if (window.parent !== window) {
      window.parent.postMessage({ type: "IFC_SELECTION", globalId: null, expressId: null }, "*");
    }
    return;
  }

  const mesh = hit.object as unknown as { fragment?: { getItemID: (i: number) => number | null; id: string; group?: FRAGS.FragmentsGroup }; instanceId?: number };
  const fragment = mesh.fragment;
  if (!fragment?.group) return;

  const instanceId = (hit as unknown as { instanceId?: number }).instanceId ?? 0;
  const expressId = fragment.getItemID(instanceId) ?? 0;
  if (expressId === 0) return;

  const model = fragment.group;

  clearSelectionAndHighlight();

  const raw = hit.object as unknown as THREE.InstancedMesh & { mesh?: THREE.InstancedMesh };
  const instancedMesh = raw?.mesh ?? raw;
  const originalColor = getInstanceColor(instancedMesh, instanceId) ?? { r: 1, g: 1, b: 1 };

  const fragmentIdMap: FRAGS.FragmentIdMap = { [fragment.id]: new Set([expressId]) };
  try {
    classifier.setColor(fragmentIdMap, HIGHLIGHT_COLOR, true);
  } catch (_) {}

  currentSelection = {
    model,
    fragmentIdMap,
    expressId,
    globalId: "",
    mesh: instancedMesh,
    instanceId,
    originalColor,
  };

  const globalId = getGlobalIdFromModel(model, expressId);
  currentSelection.globalId = globalId;

  if (window.parent !== window) {
    window.parent.postMessage({ type: "IFC_SELECTION", globalId, expressId }, "*");
  }

  try {
    const payload = await buildPropertiesPayloadFromHierarchy(model, expressId);
    payload.GlobalId = globalId;
    const data = serializePropertiesForPostMessage(payload);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "IFC_PROPERTIES", data }, "*");
    }
  } catch (e) {
    console.error("Failed to get IFC properties:", e);
    if (window.parent !== window) {
      window.parent.postMessage({ type: "IFC_PROPERTIES", data: {} }, "*");
    }
  }
}

container.addEventListener("click", (e) => void onContainerClick(e));

/** Load demo IFC (Vahrendorfer-Stadtweg_4.ifc from public folder) */
async function loadDemo() {
  const response = await fetch("/2026-02-10_teilmodell_Vahrendorfer_Sensoren.ifc"); /***/
  if (!response.ok) throw new Error(`Failed to load: ${response.status}`);
  const data = await response.arrayBuffer();
  const buffer = new Uint8Array(data);
  const model = await fragmentIfcLoader.load(buffer);
  (model as { name?: string }).name = "demo";
  world.scene.three.add(model);
}

/** Open local IFC file */
function openLocalIfc() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".ifc";
  input.style.display = "none";
  input.addEventListener("change", async () => {
    if (!input.files?.length) return;
    const file = input.files[0];
    const buffer = await file.arrayBuffer();
    const model = await fragmentIfcLoader.load(new Uint8Array(buffer));
    (model as { name?: string }).name = file.name;
    world.scene.three.add(model);
  });
  document.body.appendChild(input);
  input.click();
  input.remove();
}

function download(file: File) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function exportFragments() {
  if (!fragments.groups.size) return;
  const group = Array.from(fragments.groups.values())[0];
  const data = fragments.export(group);
  download(new File([new Blob([data as BlobPart])], "model.frag"));
  const properties = group.getLocalProperties();
  if (properties) {
    download(new File([JSON.stringify(properties)], "model.json"));
  }
}

function disposeFragments() {
  fragments.dispose();
}

// UI
BUI.Manager.init();

// Performance stats (FPS / frame time)
const stats = new Stats();
stats.showPanel(0);
document.body.append(stats.dom);
world.renderer.onBeforeUpdate.add(() => stats.begin());
world.renderer.onAfterUpdate.add(() => stats.end());

const panel = BUI.Component.create<BUI.PanelSection>(() => {
  return BUI.html`
    <bim-panel active label="IFC Viewer" class="options-menu">
      <bim-panel-section collapsed label="Controls">
        <bim-panel-section style="padding-top: 12px;">
          <bim-button label="Demo" @click="${loadDemo}"></bim-button>
          <bim-button label="Load IFC" @click="${openLocalIfc}"></bim-button>
          <bim-button label="Export fragments" @click="${exportFragments}"></bim-button>
          <bim-button label="Dispose" @click="${disposeFragments}"></bim-button>
        </bim-panel-section>
      </bim-panel-section>
    </bim-panel>
  `;
});

const toggler = BUI.Component.create<BUI.PanelSection>(() => {
  return BUI.html`
    <bim-button class="phone-menu-toggler" icon="solar:settings-bold"
      @click="${() => panel.classList.toggle("options-menu-visible")}">
    </bim-button>
  `;
});

document.body.append(toggler);
document.body.append(panel);

const app = document.getElementById("app") as BUI.Grid;
app.layouts = {
  main: {
    template: `"container panel"`,
    elements: { container, panel },
    style: `
      grid-template-columns: 1fr 320px;
      grid-template-rows: 100%;
      height: 100vh;
    `,
  },
};
app.layout = "main";
