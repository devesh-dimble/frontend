# Embedding the standalone Vite IFC viewer (iframe)

The Angular app can show the IFC viewer in an iframe by pointing at your standalone Vite IFC viewer app.

## 1. Headers for embedding

The Angular app sends **Cross-Origin-Embedder-Policy (COEP): require-corp**. With that, any cross-origin resource (including the document in an iframe) must opt in to being loaded. The Vite viewer must therefore send **Cross-Origin-Resource-Policy (CORP)** so the browser allows it to be embedded.

In the **ifc-viewer** repo, configure the dev server (and production server) to send these response headers.

**In `vite.config.ts`** add a `server` section:

```ts
// vite.config.ts
export default defineConfig({
  // ...existing config
  server: {
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // Optional: restrict who can embed this app
      'Content-Security-Policy': "frame-ancestors 'self' http://localhost:4200",
    },
  },
});
```

- **Cross-Origin-Resource-Policy: cross-origin** — Required so the Angular page with COEP can embed the viewer.
- **Content-Security-Policy: frame-ancestors** — Optional; limits which origins can frame the viewer. For production, add your Angular app’s origin (e.g. `https://your-angular-app.com`).

If you use a custom server (e.g. Express) for production, set the same headers on the response that serves the viewer HTML.

After changing `vite.config.ts`, restart the Vite dev server (`npm run dev`).

## 2. Run the Vite IFC viewer

- Clone or use your [ifc-viewer](https://github.com/devesh-dimble/ifc-viewer) repo.
- Install and run:
  ```bash
  npm install
  npm run dev
  ```
- By default it runs at **http://localhost:5173**.

## 3. Angular config

- **Development:** In `src/environments/environment.ts`:
  - `useIframeViewer: true`
  - `viewerBaseUrl: 'http://localhost:5173'`
- **Production:** In `src/environments/environment.prod.ts`:
  - Set `viewerBaseUrl` to your deployed viewer URL (e.g. `https://your-ifc-viewer.example.com`).

## 4. Optional: load a model via URL (query param)

When the user clicks **Load Demo** in Angular, the iframe is opened with a `model` query param pointing at the demo IFC URL. For that to work, the Vite viewer must read the param and load the model.

Add this **after** your world/renderer/loader setup in the Vite app’s `main.ts` (or equivalent):

```ts
// Optional: load model from ?model= URL (e.g. when embedded in Angular)
const params = new URLSearchParams(window.location.search);
const modelUrl = params.get('model');
if (modelUrl) {
  try {
    const response = await fetch(modelUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.arrayBuffer();
    const buffer = new Uint8Array(data);
    const model = await fragmentIfcLoader.load(buffer);
    (model as { name?: string }).name = 'loaded';
    world.scene.three.add(model);
  } catch (e) {
    console.error('Failed to load model from URL:', modelUrl, e);
  }
}
```

**CORS:** If the model URL is on another origin (e.g. Angular at `localhost:4200`), that server must allow the viewer origin (e.g. `http://localhost:5173`) in CORS for the IFC asset. For Angular dev server you can proxy the viewer or add CORS headers for `/assets/` if needed.

## 5. Switching back to the in-app viewer

In `environment.ts` set `useIframeViewer: false`. The panel will use the embedded Three.js / web-ifc-three viewer again.
