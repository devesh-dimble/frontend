# IFC Viewer

A web-based IFC (Industry Foundation Classes) viewer built with [That Open Company](https://thatopen.com) components, [web-ifc](https://github.com/ThatOpen/web-ifc), and Three.js.

## Features

- **Load IFC models** from a demo file or from your local machine
- **3D view** with grid, orbit controls, and transparent background
- **Export** loaded models as fragment files (`.frag`) and properties (`.json`)
- **Dispose** all loaded fragments to free memory
- **Performance stats** (FPS) overlay

## Tech Stack

- [Vite](https://vitejs.dev/) – build tool and dev server
- [@thatopen/components](https://www.npmjs.com/package/@thatopen/components) – 3D world, scene, camera, IFC loader, fragments
- [@thatopen/ui](https://www.npmjs.com/package/@thatopen/ui) – BIM-oriented UI (panels, buttons, layout)
- [web-ifc](https://github.com/ThatOpen/web-ifc) – IFC parsing (used by the loader)
- [Three.js](https://threejs.org/) – 3D rendering (via That Open components)
- [stats.js](https://github.com/mrdoob/stats.js) – FPS / frame time display

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- npm (or pnpm / yarn)

## Installation

```bash
npm install
```

## Scripts

| Command      | Description                    |
|-------------|--------------------------------|
| `npm run dev`    | Start dev server (e.g. http://localhost:5173) |
| `npm run build`  | TypeScript compile + Vite production build   |
| `npm run preview`| Serve the production build locally          |

## Usage

1. Run `npm run dev` and open the URL in your browser.
2. **Demo** – Loads the bundled sample IFC (`public/2026-02-10_teilmodell_Vahrendorfer_Sensoren.ifc`).
3. **Load IFC** – Opens a file picker; choose a `.ifc` file to load it into the viewer.
4. **Export fragments** – Exports the first loaded model as `model.frag` and `model.json` (if properties exist).
5. **Dispose** – Clears all loaded fragments and frees resources.
6. Use the settings icon to show/hide the control panel.

## Project Structure

```
your-ifc-viewer/
├── public/
│   └── 2026-02-10_teilmodell_Vahrendorfer_Sensoren.ifc   # Demo IFC model
├── src/
│   ├── main.ts                       # App entry: world, loader, UI, handlers
│   └── style.css                    # Global styles
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## License

Private / unlicensed unless you add one.
