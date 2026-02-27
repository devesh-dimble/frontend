# Viewer page / iframe – where it can fail

## 1. **Initial route: `currentPath` can be wrong on first paint**

- `currentPath` is set to `signal(this.router.url)` in the constructor.
- When the app first loads (e.g. you open `http://localhost:4200/viewer`), the router may not have run its initial navigation yet, so `router.url` can still be `''`.
- Result: the dashboard (main content) can show briefly, or the viewer layout can be wrong on first load.
- **Fix:** Set `currentPath` again in `ngOnInit()` from `this.router.url` so after the first tick the path is correct.

## 2. **`<router-outlet>` is outside `.app-container`**

- In `app.html`, the structure is: `</div>` (closes app-container) → modals → `<router-outlet />`.
- So when you’re on `/viewer`, the Viewer component is rendered **outside** the main container, as a sibling of the modals.
- The Viewer uses `position: fixed; inset: 0`, so it overlays the whole page. That can work, but if the outlet were **inside** the container (e.g. under the header), you’d get a stable “header + viewer” layout and the outlet would always be in the same place.
- **Fix (optional):** Move `<router-outlet />` inside `.app-container`, e.g. right after the `@if (!currentPath().startsWith('/viewer')) { ... }` block, so the outlet is always inside the container and the viewer sits below the header.

## 3. **Iframe still “blocked” (no entry)**

- Angular’s `index.html` has **Cross-Origin-Embedder-Policy: require-corp**, so the document inside the iframe (Vite at 5173) must send **Cross-Origin-Resource-Policy: cross-origin** (or equivalent).
- **Check:**
  - Vite dev server is running (`npm run dev` in `your-ifc-viewer`).
  - `your-ifc-viewer/vite.config.ts` has the `server.headers` and `configureServer` middleware that set CORP and `frame-ancestors`.
  - Do a **hard refresh** (Ctrl+Shift+R) or clear cache for both 4200 and 5173 so the browser doesn’t use an old cached response (e.g. 304) that might not include those headers.
- If it still blocks, in DevTools → Network, select the request to `http://localhost:5173/` and confirm the response headers include `Cross-Origin-Resource-Policy: cross-origin`.

## 4. **Load Demo does nothing**

- “Load Demo” sends a **postMessage** `{ type: 'LOAD_IFC', url }` to the iframe.
- If the iframe hasn’t finished loading the Vite app, or the Vite app hasn’t run its `window.addEventListener('message', ...)` yet, the message is lost.
- **Fix:** Click “Load Demo” only after the viewer is visible inside the iframe (and, if possible, disable the button or show “Loading viewer…” until the iframe has fired `load`).

## 5. **Wrong or missing `viewerBaseUrl`**

- The Viewer component uses `environment.viewerBaseUrl` (default `http://localhost:5173`). For production you use `environment.prod.ts` and must set the real viewer URL there.
- If you’re in dev and the Vite app runs on another port, update `viewerBaseUrl` in `environment.ts` to match.

## 6. **Path to `environment` in Viewer**

- Viewer imports `environment` from `../../../environments/environment` (from `app/pages/viewer/viewer.ts` → `src/environments/environment`). That path is correct; no change needed unless you move files.

---

**Quick checklist**

- [ ] Vite viewer running at `http://localhost:5173`
- [ ] Angular running at `http://localhost:4200`
- [ ] Open `http://localhost:4200/viewer` (or click “Viewer” in the header)
- [ ] Hard refresh / clear cache if the iframe was blocked before
- [ ] Wait for the iframe to show the viewer, then click “Load Demo”
