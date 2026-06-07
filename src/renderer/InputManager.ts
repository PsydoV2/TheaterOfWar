import * as THREE from "three";
import type { HexRenderer } from "./HexRenderer";

export type HoverCallback = (hexId: string | null) => void;
export type ClickCallback = (hexId: string) => void;

export class InputManager {
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse     = new THREE.Vector2();
  private currentHex: string | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly hexRenderer: HexRenderer,
    private readonly onHover: HoverCallback,
    private readonly onClick: ClickCallback,
  ) {
    canvas.addEventListener("mousemove", this.onMouseMove.bind(this));
    canvas.addEventListener("click",     this.onMouseClick.bind(this));
    canvas.addEventListener("mouseleave", () => {
      if (this.currentHex !== null) {
        this.currentHex = null;
        this.canvas.style.cursor = "default";
        this.onHover(null);
      }
    });
  }

  private updateMouse(e: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouse.set(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
  }

  private castToHex(): string | null {
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hits = this.raycaster.intersectObjects(
      this.hexRenderer.getInteractiveMeshes()
    );
    if (hits.length === 0) return null;
    return this.hexRenderer.hexIdForMesh(hits[0]!.object as THREE.Mesh) ?? null;
  }

  private onMouseMove(e: MouseEvent): void {
    this.updateMouse(e);
    const hexId = this.castToHex();
    if (hexId === this.currentHex) return;
    this.currentHex = hexId;
    this.canvas.style.cursor = hexId ? "pointer" : "default";
    this.onHover(hexId);
  }

  private onMouseClick(e: MouseEvent): void {
    this.updateMouse(e);
    const hexId = this.castToHex();
    if (hexId) this.onClick(hexId);
  }
}
