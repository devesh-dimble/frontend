import { Injectable, signal } from '@angular/core';
import * as THREE from 'three';
import * as OBC from '@thatopen/components';

export interface IfcProperty {
  name: string;
  value: string | number | boolean;
}

export interface IfcPropertyGroup {
  name: string;
  properties: IfcProperty[];
}

export interface SelectedElement {
  expressId: number;
  type: string;
  name: string;
  guid: string;
  propertyGroups: IfcPropertyGroup[];
}

interface IfcPropertyValue {
  value?: unknown;
}

type IfcPropertiesMap = Record<string, IfcPropertyValue | string | unknown>;

@Injectable({
  providedIn: 'root'
})
export class IfcViewerService {
  private components: OBC.Components | null = null;
  private world: OBC.World | null = null;
  private ifcLoader: OBC.IfcLoader | null = null;
  private fragmentsManager: OBC.FragmentsManager | null = null;
  private container: HTMLElement | null = null;
  private loadedModels: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private mouse = new THREE.Vector2();
  private currentProperties: Record<number, IfcPropertiesMap> = {};
  
  public isLoading = signal(false);
  public loadedModel = signal<THREE.Object3D | null>(null);
  public selectedElement = signal<SelectedElement | null>(null);
  public modelElements = signal<{ expressId: number; name: string; type: string }[]>([]);
  public loadingProgress = signal(0);

  /**
   * Initialize the IFC Viewer following the That Open Engine tutorial
   * @see https://docs.thatopen.com/Tutorials/Components/Core/IfcLoader
   */
  async initialize(container: HTMLElement): Promise<void> {
    console.log('Initializing IFC Viewer (That Open Engine)...');
    this.container = container;
    
    try {
      // 1. Create components instance
      this.components = new OBC.Components();
      console.log('Components created');

      // 2. Create world with scene, camera, renderer
      const worlds = this.components.get(OBC.Worlds);
      this.world = worlds.create<
        OBC.SimpleScene,
        OBC.OrthoPerspectiveCamera,
        OBC.SimpleRenderer
      >();

      // 3. Setup scene
      const simpleScene = new OBC.SimpleScene(this.components);
      this.world.scene = simpleScene;
      
      // Call setup if available (for proper scene initialization)
      if ('setup' in simpleScene && typeof simpleScene.setup === 'function') {
        simpleScene.setup();
      }
      
      // Set custom background color
      const scene = this.world.scene.three as THREE.Scene;
      scene.background = new THREE.Color(0x2d4a5e);
      
      // 4. Setup renderer
      this.world.renderer = new OBC.SimpleRenderer(this.components, container);
      
      // 5. Setup OrthoPerspectiveCamera (recommended by tutorial)
      const camera = new OBC.OrthoPerspectiveCamera(this.components);
      this.world.camera = camera;
      if (camera.controls) {
        await camera.controls.setLookAt(50, 50, 50, 0, 0, 0);
      }
      
      console.log('World created with SimpleScene, OrthoPerspectiveCamera, SimpleRenderer');

      // 6. Initialize components
      this.components.init();
      console.log('Components initialized');

      // 7. Add grid
      const grids = this.components.get(OBC.Grids);
      grids.create(this.world);
      console.log('Grid created');

      // 8. Setup FragmentsManager with worker
      this.fragmentsManager = this.components.get(OBC.FragmentsManager);
      const workerUrl = 'https://thatopen.github.io/engine_fragment/resources/worker.mjs';
      this.fragmentsManager.init(workerUrl);
      console.log('FragmentsManager initialized with worker');

      // 9. Setup camera update on rest (for LOD)
      const cameraControls = this.world.camera.controls;
      if (cameraControls) {
        cameraControls.addEventListener('rest', () => {
          this.fragmentsManager?.core.update(true);
        });
      }

      // 10. Handle when fragments are loaded
      this.fragmentsManager.list.onItemSet.add(({ value: model }) => {
        console.log('Fragment model loaded, adding to scene');
        // Use camera for LOD updates - cast to proper type
        const threeCamera = this.world!.camera.three as THREE.PerspectiveCamera | THREE.OrthographicCamera;
        model.useCamera(threeCamera);
        // Add to scene
        this.world!.scene.three.add(model.object);
        // Update fragments
        this.fragmentsManager?.core.update(true);
        
        // Store reference and fit camera
        this.loadedModels.push(model.object);
        this.loadedModel.set(model.object);
        this.fitCameraToModel(model.object);
        
        console.log('Model added to scene successfully');
      });

      // 11. Setup IFC Loader with WASM configuration
      this.ifcLoader = this.components.get(OBC.IfcLoader);
      
      // Configure IFC loader following tutorial
      await this.ifcLoader.setup({
        autoSetWasm: false,
        wasm: {
          path: 'https://unpkg.com/web-ifc@0.0.72/',
          absolute: true
        }
      });
      console.log('IFC Loader setup complete with WASM from unpkg CDN');

      // 12. Log IFC classes being converted (for debugging)
      this.ifcLoader.onIfcImporterInitialized.add((importer) => {
        console.log('IFC Importer initialized. Converting classes:', importer.classes);
      });

      // 13. Setup click handling for selection
      container.addEventListener('click', (event) => this.handleClick(event, container));
      
      console.log('IFC Viewer initialization complete!');
    } catch (error) {
      console.error('Failed to initialize IFC Viewer:', error);
      throw error;
    }
  }

  private handleClick(event: MouseEvent, container: HTMLElement): void {
    if (!this.world || this.loadedModels.length === 0) return;

    const rect = container.getBoundingClientRect();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    const camera = this.world.camera.three;
    this.raycaster.setFromCamera(this.mouse, camera);

    const intersects = this.raycaster.intersectObjects(this.loadedModels, true);
    
    if (intersects.length > 0) {
      const hit = intersects[0];
      const mesh = hit.object as THREE.Mesh;
      
      // Try to get express ID from the geometry or mesh
      if (mesh.geometry && hit.faceIndex != null) {
        const expressIdAttr = mesh.geometry.getAttribute('expressID');
        if (expressIdAttr) {
          const expressId = expressIdAttr.getX(hit.faceIndex * 3);
          this.loadElementProperties(expressId);
        }
      }
    } else {
      this.selectedElement.set(null);
    }
  }

  /**
   * Load an IFC file from a URL path (e.g., local asset)
   */
  async loadIfcFromPath(path: string): Promise<void> {
    console.log('Loading IFC from path:', path);
    
    if (!this.ifcLoader) {
      throw new Error('IFC Loader not initialized');
    }

    this.isLoading.set(true);
    this.loadingProgress.set(0);

    try {
      // Fetch the file
      const response = await fetch(path);
      if (!response.ok) {
        throw new Error(`Failed to fetch IFC file: ${response.statusText}`);
      }
      
      const data = await response.arrayBuffer();
      const buffer = new Uint8Array(data);
      console.log('IFC file fetched, size:', buffer.length, 'bytes');

      // Extract model name from path
      const modelName = path.split('/').pop()?.replace(/\.ifc$/i, '') || 'model';
      
      // Load the IFC file with progress callback
      await this.ifcLoader.load(buffer, false, modelName, {
        processData: {
          progressCallback: (progress: number) => {
            this.loadingProgress.set(Math.round(progress * 100));
            console.log('Loading progress:', Math.round(progress * 100) + '%');
          }
        }
      });

      console.log('IFC file loaded successfully!');
      
    } catch (error) {
      console.error('Error loading IFC file:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
      this.loadingProgress.set(100);
    }
  }

  /**
   * Load an IFC file from a File object (drag & drop or file input)
   */
  async loadIfcFile(file: File): Promise<void> {
    console.log('Starting IFC file load:', file.name, 'Size:', file.size);
    
    if (!this.ifcLoader) {
      throw new Error('IFC Loader not initialized');
    }

    this.isLoading.set(true);
    this.loadingProgress.set(0);

    try {
      const buffer = await file.arrayBuffer();
      const data = new Uint8Array(buffer);
      console.log('Buffer loaded, size:', data.length, 'bytes');
      
      const modelName = file.name.replace(/\.ifc$/i, '');
      
      // Load with progress callback
      await this.ifcLoader.load(data, false, modelName, {
        processData: {
          progressCallback: (progress: number) => {
            this.loadingProgress.set(Math.round(progress * 100));
            console.log('Loading progress:', Math.round(progress * 100) + '%');
          }
        }
      });

      console.log('IFC file loaded successfully!');
      
    } catch (error) {
      console.error('Error loading IFC file:', error);
      throw error;
    } finally {
      this.isLoading.set(false);
      this.loadingProgress.set(100);
    }
  }

  private fitCameraToModel(model: THREE.Object3D): void {
    if (!this.world?.camera.controls) return;

    const box = new THREE.Box3().setFromObject(model);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    
    this.world.camera.controls.setLookAt(
      center.x + maxDim * 1.5,
      center.y + maxDim * 1.5,
      center.z + maxDim * 1.5,
      center.x,
      center.y,
      center.z
    );
  }

  private loadElementProperties(expressId: number): void {
    const elementProps = this.currentProperties[expressId];
    if (!elementProps) {
      this.selectedElement.set(null);
      return;
    }

    const propertyGroups: IfcPropertyGroup[] = [];

    // Identification group
    const identificationProps: IfcProperty[] = [];
    
    const nameVal = elementProps['Name'] as IfcPropertyValue | undefined;
    if (nameVal?.value) {
      identificationProps.push({ name: 'Name', value: String(nameVal.value) });
    }
    
    const guidVal = elementProps['GlobalId'] as IfcPropertyValue | undefined;
    if (guidVal?.value) {
      identificationProps.push({ name: 'GUID', value: String(guidVal.value) });
    }
    
    const typeVal = elementProps['type'];
    if (typeof typeVal === 'string') {
      identificationProps.push({ name: 'Type', value: typeVal });
    }
    
    const objectTypeVal = elementProps['ObjectType'] as IfcPropertyValue | undefined;
    if (objectTypeVal?.value) {
      identificationProps.push({ name: 'Object Type', value: String(objectTypeVal.value) });
    }
    
    if (identificationProps.length > 0) {
      propertyGroups.push({ name: 'Identification', properties: identificationProps });
    }

    // Location group
    if (elementProps['ObjectPlacement']) {
      propertyGroups.push({ 
        name: 'Location', 
        properties: [{ name: 'Has Placement', value: 'Yes' }] 
      });
    }

    // Collect other properties
    const otherProps: IfcProperty[] = [];
    const skipKeys = ['Name', 'GlobalId', 'type', 'ObjectType', 'ObjectPlacement', 'expressID'];
    
    for (const [key, value] of Object.entries(elementProps)) {
      if (skipKeys.includes(key)) continue;
      if (value && typeof value === 'object' && 'value' in value) {
        const propVal = value as IfcPropertyValue;
        otherProps.push({ name: key, value: String(propVal.value) });
      }
    }
    
    if (otherProps.length > 0) {
      propertyGroups.push({ name: 'Properties', properties: otherProps });
    }

    const name = nameVal?.value ? String(nameVal.value) : `Element ${expressId}`;
    const guid = guidVal?.value ? String(guidVal.value) : '';
    const type = typeof typeVal === 'string' ? typeVal : 'Unknown';

    this.selectedElement.set({
      expressId,
      type,
      name,
      guid,
      propertyGroups
    });
  }

  selectElementById(expressId: number): void {
    this.loadElementProperties(expressId);
  }

  clearSelection(): void {
    this.selectedElement.set(null);
  }

  dispose(): void {
    if (this.components) {
      this.components.dispose();
    }
    this.loadedModels = [];
    this.currentProperties = {};
  }
}
