# Frontend — BCF + IFC Viewer

Angular app for **BCF (BIM Collaboration Format)** topics, comments, and viewpoints, with an embedded **IFC 3D viewer** (Vite + Three.js). Supports linking IFC elements to BCF topics, capturing viewer snapshots as BCF viewpoint images, and filtering topics by selected object.

## Prerequisites

- **Node.js** 18.x or 20.x (LTS recommended)
- **npm** (comes with Node)

Check versions:

```bash
node -v   # v18.x or v20.x
npm -v
```

## Repository structure

```
frontend/
├── frontend/           # Angular app (BCF UI, auth, topic list, iframe host)
├── your-ifc-viewer/   # Vite app (IFC 3D viewer, runs in iframe)
├── docs/              # Documentation
└── README.md
```

The Angular app embeds the IFC viewer in an iframe. Both must be running for full functionality.

## Quick start

### 1. Clone the repository

```bash
git clone https://github.com/devesh-dimble/frontend.git
cd frontend
```

### 2. Install and run the IFC viewer (Vite)

In a terminal:

```bash
cd your-ifc-viewer
npm install
npm run dev
```

The viewer will be available at **http://localhost:5173**. Leave this terminal running.

### 3. Install and run the Angular app

In a **second** terminal, from the repo root:

```bash
cd frontend
npm install
npm run start
```

Or:

```bash
cd frontend
npm install
ng serve
```

The Angular app will be available at **http://localhost:4200**. Open this URL in your browser.

---

**Summary:** Run both apps in two terminals. Use **http://localhost:4200** (Angular); it will load the viewer from **http://localhost:5173** inside an iframe.

## Configuration

### Angular environment

API and viewer URLs are in `frontend/src/environments/environment.ts`:

| Variable        | Default                      | Description                    |
|----------------|-----------------------------|--------------------------------|
| `bcfApiUrl`    | `http://91.99.113.101/bcf/3.0` | BCF 3.0 API base URL           |
| `authApiUrl`   | `http://91.99.113.101`      | Auth endpoint base             |
| `ifcViewerUrl` | `http://localhost:5173`     | IFC viewer URL (iframe source) |

For production, set `ifcViewerUrl` to your deployed viewer URL and use `frontend/src/environments/environment.prod.ts` as needed.

### IFC viewer

- **Demo button:** Loads the sample IFC from `your-ifc-viewer/public/2026-02-10_teilmodell_Vahrendorfer_Sensoren.ifc`. If that file is missing, use **Load IFC** to pick a local `.ifc` file instead.
- **Load IFC:** Opens a file picker; works without any path configuration.
- When embedded in Angular, the viewer can also load a model via the app (e.g. from `frontend/public` or assets) using the configured model URL.

## Scripts reference

### Angular (`frontend/`)

| Command         | Description              |
|----------------|--------------------------|
| `npm run start` | Start dev server (port 4200) |
| `ng serve`     | Same as above            |
| `npm run build` | Production build         |

### IFC viewer (`your-ifc-viewer/`)

| Command        | Description                |
|----------------|----------------------------|
| `npm run dev`  | Start Vite dev server (port 5173) |
| `npm run build`| Production build          |
| `npm run preview` | Preview production build |

## Troubleshooting

- **Viewer area is blank or “buttons don’t work”**  
  Ensure the IFC viewer is running at **http://localhost:5173**. The Angular app loads it in an iframe; if the viewer server is not running, the iframe will fail.

- **Demo button in viewer does nothing or errors**  
  The Demo button loads `/2026-02-10_teilmodell_Vahrendorfer_Sensoren.ifc` from the Vite server. That file must exist under `your-ifc-viewer/public/`. If it’s missing, use **Load IFC** and select an `.ifc` file from your machine.

- **BCF / login not working**  
  Check that `bcfApiUrl` and `authApiUrl` in `frontend/src/environments/environment.ts` point to your BCF and auth backends and are reachable from your network.

- **CORS or iframe errors**  
  The Vite dev server is configured to allow embedding from `http://localhost:4200`. If you use another origin for the Angular app, update the `Content-Security-Policy` / `frame-ancestors` in `your-ifc-viewer/vite.config.ts`.

- **`patch-package` or postinstall errors (Angular)**  
  Run `npm install` again from the `frontend/` directory. The project uses `patch-package` for postinstall; ensure dependencies are fully installed.

## Tech stack

- **Angular** 21 — BCF UI, auth, routing
- **Vite** 6 + **Three.js** + **@thatopen/components** — IFC viewer
- **web-ifc** — IFC parsing

## License

Private
