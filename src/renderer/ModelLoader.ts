import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export class ModelLoader {
  private readonly loader = new GLTFLoader();
  private readonly cache = new Map<string, THREE.Object3D>();

  async preload(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.loadOne(path)));
  }

  private loadOne(path: string): Promise<void> {
    return new Promise((resolve) => {
      this.loader.load(
        path,
        (gltf) => {
          const obj = gltf.scene;
          this.normalize(obj);
          obj.traverse((child) => {
            if ((child as THREE.Mesh).isMesh) {
              child.castShadow = true;
              child.receiveShadow = true;
            }
          });
          this.cache.set(path, obj);
          resolve();
        },
        undefined,
        () => {
          // Error: cache a placeholder so the game still runs
          this.cache.set(path, new THREE.Group());
          resolve();
        }
      );
    });
  }

  /**
   * Normalizes a loaded GLB so its max horizontal dimension equals 1 unit
   * and its base sits at Y = 0.
   */
  private normalize(obj: THREE.Object3D): void {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const maxH = Math.max(size.x, size.z);
    if (maxH > 0) obj.scale.multiplyScalar(1 / maxH);

    const box2 = new THREE.Box3().setFromObject(obj);
    const center = box2.getCenter(new THREE.Vector3());
    obj.position.x -= center.x;
    obj.position.z -= center.z;
    obj.position.y -= box2.min.y;
  }

  /**
   * Returns a deep clone of the cached model, scaled by `scaleFactor`.
   * Returns null if the path was never preloaded.
   */
  clone(path: string, scaleFactor = 1): THREE.Object3D | null {
    const proto = this.cache.get(path);
    if (!proto) return null;
    const c = proto.clone(true);
    c.scale.set(scaleFactor, scaleFactor, scaleFactor);
    return c;
  }

  has(path: string): boolean {
    return this.cache.has(path);
  }
}
