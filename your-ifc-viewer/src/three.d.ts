/**
 * Minimal type declarations for three.js (v0.175+).
 *
 * three@0.175 ships without .d.ts files and the @types/three package's
 * exports map is incompatible with moduleResolution:"bundler".
 * This file declares only the subset used by the viewer.
 */
declare module "three" {
  export class Color {
    constructor(color?: number | string);
    r: number;
    g: number;
    b: number;
    set(color: number | string): this;
  }

  export class Vector2 {
    constructor(x?: number, y?: number);
    x: number;
    y: number;
  }

  export class Object3D {
    traverse(callback: (object: Object3D) => void): void;
    add(...objects: Object3D[]): this;
    parent: Object3D | null;
    children: Object3D[];
    name: string;
  }

  export class Mesh extends Object3D {}

  export class InstancedMesh extends Mesh {
    count: number;
    instanceColor: {
      getX(index: number): number;
      getY(index: number): number;
      getZ(index: number): number;
      setXYZ(index: number, r: number, g: number, b: number): void;
      needsUpdate: boolean;
    } | null;
  }
}
