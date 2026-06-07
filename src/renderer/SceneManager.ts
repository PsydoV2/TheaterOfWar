import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;

  private frustumSize = 22;

  constructor(canvas: HTMLCanvasElement) {
    // ── Scene ────────────────────────────────────────────────────────────────
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f1923);
    this.scene.fog = new THREE.FogExp2(0x0f1923, 0.010);

    // ── Orthographic camera (isometric angle) ────────────────────────────────
    const aspect = canvas.clientWidth / canvas.clientHeight;
    const f = this.frustumSize;
    this.camera = new THREE.OrthographicCamera(
      (-f * aspect) / 2, (f * aspect) / 2,
       f / 2,            -f / 2,
      0.1, 400
    );
    this.camera.position.set(16, 20, 16);
    this.camera.lookAt(0, 0, 0);

    // ── Renderer ─────────────────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    // ── Lighting ─────────────────────────────────────────────────────────────
    this.scene.add(new THREE.AmbientLight(0xffeedd, 0.55));

    const sun = new THREE.DirectionalLight(0xfff0d0, 1.9);
    sun.position.set(8, 20, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { near: 0.5, far: 120, left: -28, right: 28, top: 28, bottom: -28 });
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0x8899ff, 0.35);
    fill.position.set(-6, 4, -6);
    this.scene.add(fill);

    // ── Controls: pan + zoom only, no rotation ───────────────────────────────
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableRotate = false;
    this.controls.enablePan = true;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.zoomSpeed = 1.2;
    this.controls.screenSpacePanning = true;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.PAN,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    window.addEventListener("resize", this.onResize.bind(this));
  }

  private onResize(): void {
    const c = this.renderer.domElement;
    const aspect = c.clientWidth / c.clientHeight;
    const f = this.frustumSize;
    this.camera.left   = (-f * aspect) / 2;
    this.camera.right  =  (f * aspect) / 2;
    this.camera.top    =   f / 2;
    this.camera.bottom =  -f / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(c.clientWidth, c.clientHeight, false);
  }

  start(tick: (dt: number) => void): void {
    const clock = new THREE.Clock();
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = clock.getDelta();
      this.controls.update();
      tick(dt);
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }
}
