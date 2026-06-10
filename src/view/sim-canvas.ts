import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldScene, FoldSolver } from "../sim/index.js";
import { kineticDamp, removeRigidBodyMotion } from "../sim/index.js";
import { GpuFoldSolver } from "../sim/gpu/index.js";

/**
 * Three.js viewport for the forward fold — renders the FoldNet as lit triangle faces plus
 * mountain/valley/boundary/cut lines, driving the GPU bar-and-hinge solver (`GpuFoldSolver`,
 * Gershenfeld GPGPU), falling back to the CPU `FoldSolver`.
 *
 * Anti-twitch (model-level): a frustrated kirigami mesh (cut-induced floppy DOF + a driven
 * boundary) has no force-balanced state reachable by plain viscous damping — that only orbits a
 * limit cycle forever (the jitter). So once the fold reaches the target we run the **global Otter
 * quench**: zero ALL velocity each time total kinetic energy stops rising, which descends to a TRUE
 * static rest. On the CPU that's `kineticDamp`; on the GPU it's `gpu.relax()` (a per-frame velocity
 * read-back + a uReset zeroing pass — the GPU twin of the same algorithm, since JS-side damping is a
 * no-op there, velocity living on-device). When the per-frame max node motion stays below a
 * scale-relative threshold the view **freezes** (stops stepping); a hard frame cap freezes regardless.
 * (Rigid-body-motion removal is applied only to FREE folds — it fights a driven/pinned mesh.)
 *
 * Anti-overlap: the camera near/far planes are tightened to the model scale each load, so the depth
 * buffer has enough precision that coincident folded faces don't z-fight (flicker through each other).
 */
const COLOR_FACE = 0xec008b;
const COLOR_MOUNTAIN = 0xff3b30;
const COLOR_VALLEY = 0x1f6feb;
const COLOR_BOUNDARY = 0x888888;
const COLOR_CUT = 0x000000;

const STEPS_PER_FRAME = 40;
/** Guided mode: per-frame easing of the applied fold toward the slider target. */
const FOLD_EASE = 0.05;
/** Free mode: gentler per-step easing toward the target. */
const FREE_PER_STEP_EASE = 0.014;
/** |targetFold − foldPercent| below this counts as "at the target fold". */
const FOLD_REACHED_EPS = 1e-3;
/** Freeze after this many consecutive frames whose max node motion is below the settle threshold. */
const SETTLE_FRAMES = 10;
/** Settle threshold = SETTLE_REL · camera reach (scale-relative so it works at any model size). */
const SETTLE_REL = 4e-4;
/** Hard cap: freeze this many frames after reaching the target even if it never fully settles (~4s). */
const MAX_SETTLE_FRAMES = 240;

export class SimCanvas {
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;
  private readonly group = new THREE.Group();

  private fold: FoldScene | null = null;
  private gpu: GpuFoldSolver | null = null;
  private cpu: FoldSolver | null = null;
  private geo: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  private foldPercent = 0;
  private targetFold = 1;
  private running = false;
  /** True when the scene drives boundary nodes to a goal mesh (AKDE pyramid). */
  private guided = false;
  /** Freeze stepping once folded + settled so the pose is dead still (no twitch). */
  private frozen = false;
  /** Previous frame's node positions, for the position-delta settle test. */
  private prevPos: Float32Array | null = null;
  private settledFrames = 0;
  private framesAtTarget = 0;
  /** Max per-frame node motion (model units) below which the fold counts as still. */
  private settleEps = 1e-3;
  /** Global-quench (Otter) kinetic-energy tracker for the CPU paths (the GPU keeps its own). */
  private prevKE = Infinity;

  constructor(container: HTMLElement) {
    const w = container.clientWidth || 480;
    const h = container.clientHeight || 360;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0xf4f4f6, 1);
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0xf4f4f6);
    this.camera = new THREE.PerspectiveCamera(50, w / h, 0.5, 20000);
    this.camera.position.set(260, -260, 220);
    this.camera.up.set(0, 0, 1); // z-up to match the model's vertical apex axis

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(1, -1, 2);
    this.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
    fillLight.position.set(-1, 1, 0.5);
    this.scene.add(fillLight);
    this.scene.add(this.group);

    this.loop = this.loop.bind(this);
  }

  /** Load a fold scene: build render meshes, pick the solver backend, reset fold. */
  setScene(scene: FoldScene): void {
    this.disposeGeo();
    this.fold = scene;
    const { net, model } = scene;

    this.guided = anyDriven(model.driven);
    this.foldPercent = 0;
    this.frozen = false;
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
    this.prevPos = model.position.slice();

    this.posAttr = new THREE.BufferAttribute(model.position, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.posAttr);
    geo.setIndex(net.faces.flat());
    geo.computeVertexNormals();
    this.geo = geo;

    const faceMat = new THREE.MeshStandardMaterial({
      color: COLOR_FACE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: 0.75,
      // Push faces slightly back in depth so the crease/cut lines (which share the same vertex
      // buffer, hence the same depth) sit cleanly on top instead of z-fighting and overlapping.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    this.group.add(new THREE.Mesh(geo, faceMat));

    // crease/cut lines coloured by assignment (facets hidden); all share the live position buffer
    const byKind: Record<string, number[]> = { M: [], V: [], B: [], C: [] };
    for (const e of net.edges) {
      if (e.assignment === "F") continue;
      byKind[e.assignment]?.push(e.a, e.b);
    }
    const colors: Record<string, number> = {
      M: COLOR_MOUNTAIN,
      V: COLOR_VALLEY,
      B: COLOR_BOUNDARY,
      C: COLOR_CUT,
    };
    const widths: Record<string, number> = { M: 1, V: 1, B: 1, C: 2 };
    for (const kind of ["B", "M", "V", "C"]) {
      const idx = byKind[kind];
      if (!idx || idx.length === 0) continue;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", this.posAttr);
      lg.setIndex(idx);
      this.group.add(
        new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: colors[kind], linewidth: widths[kind] })),
      );
    }

    // Guided pyramid → GPU (Gershenfeld GPGPU); free fold → CPU. Settling is applied at the target
    // (advance): the GPU global quench via gpu.relax(), the CPU via kineticDamp.
    this.gpu = this.guided ? GpuFoldSolver.create(model, this.renderer) : null;
    this.cpu = this.gpu ? null : scene.solver;

    // Frame the model AND tighten the depth range to its scale — a near/far ratio of ~250:1 instead
    // of 40000:1 gives the depth buffer the precision to stop coincident folded faces z-fighting.
    const reach = Math.max(net.meta.s, net.meta.H, 1) * 2.4;
    this.settleEps = reach * SETTLE_REL;
    this.camera.near = Math.max(0.05, reach * 0.04);
    this.camera.far = reach * 10;
    this.camera.position.set(reach, -reach, reach * 0.85);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, net.meta.H * 0.2);
    this.controls.update();
  }

  /** Active solver backend, for status display. */
  backend(): "gpu" | "cpu" | "none" {
    return this.gpu ? "gpu" : this.cpu ? "cpu" : "none";
  }

  setFoldPercent(p: number): void {
    this.targetFold = Math.min(1, Math.max(0, p));
    this.frozen = false; // scrubbing wakes a frozen fold
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
    this.gpu?.resetSettle();
    this.prevPos = this.fold?.model.position.slice() ?? null; // restart the settle test from here
  }

  getFoldPercent(): number {
    return this.targetFold;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  stop(): void {
    this.running = false;
  }

  dispose(): void {
    this.stop();
    this.disposeGeo();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private advance(): void {
    if (!this.fold || this.frozen) return; // frozen: hold the pose, orbit only
    const m = this.fold.model;

    // The quench only runs ONCE THE SHAPE IS REACHED. During the ramp the driven boundary keeps
    // injecting energy, so quenching then would repeatedly halt the lagging interior and leave a
    // worse pose; under bare ζ the ramp stays smooth, and the quench settles it afterward.
    if (this.guided) {
      this.foldPercent += (this.targetFold - this.foldPercent) * FOLD_EASE;
      if (Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS) this.foldPercent = this.targetFold;
      const atTarget = this.foldPercent === this.targetFold;
      if (this.gpu) {
        this.gpu.foldPercent = this.foldPercent;
        this.gpu.step(STEPS_PER_FRAME);
        this.gpu.readInto(m);
        if (atTarget) this.gpu.relax(); // GPU global quench → still rest
      } else if (this.cpu) {
        this.cpu.foldPercent = this.foldPercent;
        for (let i = 0; i < STEPS_PER_FRAME; i++) {
          this.cpu.step();
          if (atTarget) this.prevKE = kineticDamp(m, this.prevKE);
        }
      }
    } else if (this.cpu) {
      // Free (Neil's normal origami) fold: ease crease targets per step; rigid-removal kills the
      // drift of an un-pinned mesh; the global quench settles it once at target.
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        this.foldPercent += (this.targetFold - this.foldPercent) * FREE_PER_STEP_EASE;
        this.cpu.foldPercent = this.foldPercent;
        this.cpu.step();
        if (this.foldPercent === this.targetFold) this.prevKE = kineticDamp(m, this.prevKE);
        removeRigidBodyMotion(m);
      }
      if (Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS) this.foldPercent = this.targetFold;
    }

    this.flushGeometry();
    this.maybeFreeze();
  }

  /**
   * Freeze once the fold has reached the target AND the mesh has stopped moving (max per-frame node
   * displacement below `settleEps` for `SETTLE_FRAMES` frames), or after a hard frame cap. Freezing
   * stops all stepping, so the held pose is perfectly still. With the per-node quick-min quench the
   * mesh actually reaches rest, so this fires quickly instead of bottoming out at the cap.
   */
  private maybeFreeze(): void {
    const pos = this.fold!.model.position;
    let moved = Infinity;
    if (this.prevPos && this.prevPos.length === pos.length) {
      moved = 0;
      for (let i = 0; i < pos.length; i++) {
        const d = Math.abs(pos[i] - this.prevPos[i]);
        if (d > moved) moved = d;
      }
      this.prevPos.set(pos);
    } else {
      this.prevPos = pos.slice();
    }

    const atTarget = Math.abs(this.targetFold - this.foldPercent) < FOLD_REACHED_EPS;
    if (!atTarget) {
      this.framesAtTarget = 0;
      this.settledFrames = 0;
      return;
    }
    this.framesAtTarget++;
    if (moved < this.settleEps) this.settledFrames++;
    else this.settledFrames = 0;

    if (this.settledFrames >= SETTLE_FRAMES || this.framesAtTarget >= MAX_SETTLE_FRAMES) {
      this.fold!.model.velocity.fill(0); // hold the pose dead still (CPU; GPU just stops stepping)
      this.frozen = true;
    }
  }

  private flushGeometry(): void {
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geo?.computeVertexNormals();
  }

  private loop(): void {
    if (!this.running) return;
    this.advance();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    requestAnimationFrame(this.loop);
  }

  private disposeGeo(): void {
    this.group.clear();
    this.geo?.dispose();
    this.geo = null;
    this.posAttr = null;
    this.gpu = null;
    this.cpu = null;
  }
}

function anyDriven(driven: Uint8Array): boolean {
  for (let i = 0; i < driven.length; i++) if (driven[i]) return true;
  return false;
}
