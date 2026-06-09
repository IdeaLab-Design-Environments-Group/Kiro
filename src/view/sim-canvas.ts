import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldScene } from "../sim/index.js";
import type { FoldSolver } from "../sim/solver.js";
import { GpuFoldSolver } from "../sim/gpu/gpu-solver.js";
import { dampVelocity, kineticDamp, removeRigidBodyMotion } from "../sim/stabilize.js";

/**
 * Three.js viewport for the forward fold — ported from AKDE's `sim-canvas.ts`.
 * It renders the FoldNet as lit triangle faces plus mountain/valley/boundary/cut
 * lines, and drives the **GPU** bar-and-hinge solver (`GpuFoldSolver`,
 * GPUComputationRenderer — Gershenfeld's GPGPU method), falling back to the CPU
 * `FoldSolver` when WebGL float support is unavailable.
 *
 * Two fold modes:
 *  - **guided** (the scene has kinematically driven boundary nodes, e.g. AKDE's
 *    pyramid): behaves exactly like AKDE — GPU/CPU with per-frame easing — which
 *    is what makes the pyramid fold crisp and stable.
 *  - **free** (a generic FOLD/FKLD crease pattern with no goal mesh): explicit
 *    Euler rings on a free mesh, so we run CPU only with quasi-static per-step
 *    easing, velocity damping, rigid-body-motion removal, and a freeze once
 *    folded — the anti-jitter that an unguided fold needs.
 */
const COLOR_FACE = 0xec008b;
const COLOR_MOUNTAIN = 0xff3b30;
const COLOR_VALLEY = 0x1f6feb;
const COLOR_BOUNDARY = 0x888888;
const COLOR_CUT = 0x000000;

const STEPS_PER_FRAME = 40;
/** Guided mode: per-frame easing of the applied fold toward the slider target (AKDE behaviour). */
const FOLD_EASE = 0.05;
/** Free mode: gentler per-step easing + damping + rigid-removal + freeze (see header). */
const FREE_PER_STEP_EASE = 0.014;
const FREE_VELOCITY_DAMP = 0.9;
const FREE_FOLD_REACHED_EPS = 1e-3;
const FREE_RELAX_FRAMES = 72;
/** Guided mode: kinetic-damped relax frames after full fold before freezing the pose. */
const GUIDED_RELAX_FRAMES = 90;

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
  /** Free mode only: freeze stepping once folded + relaxed so the pose is dead still. */
  private frozen = false;
  private relaxFrames = 0;
  /** Guided mode: kinetic-damping (quenched dynamics) energy tracker; zeroes velocity at KE peaks. */
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
    this.relaxFrames = 0;
    this.prevKE = Infinity;

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

    // Guided pyramid → GPU preferred (AKDE). Free fold → CPU only (needs the anti-jitter passes).
    this.gpu = this.guided ? GpuFoldSolver.create(model, this.renderer) : null;
    this.cpu = this.gpu ? null : scene.solver;

    const reach = Math.max(net.meta.s, net.meta.H, 1) * 2.4;
    this.camera.position.set(reach, -reach, reach * 0.85);
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
    this.relaxFrames = 0;
    this.prevKE = Infinity; // restart kinetic damping for the new target
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
    if (!this.fold) return;
    if (this.guided) this.advanceGuided();
    else this.advanceFree();
  }

  /** AKDE behaviour: ease the applied fold per frame, step the solver under kinetic damping. */
  private advanceGuided(): void {
    if (this.frozen) return; // pose folded + drained: hold it dead still, orbit only
    this.foldPercent += (this.targetFold - this.foldPercent) * FOLD_EASE;
    // Snap the last sliver so the driven boundary becomes truly static (no creep re-energizing).
    if (Math.abs(this.targetFold - this.foldPercent) < FREE_FOLD_REACHED_EPS) {
      this.foldPercent = this.targetFold;
    }
    const fp = this.foldPercent;
    if (this.gpu) {
      this.gpu.foldPercent = fp;
      this.gpu.step(STEPS_PER_FRAME);
      this.gpu.readInto(this.fold!.model);
    } else if (this.cpu) {
      this.cpu.foldPercent = fp;
      const model = this.fold!.model;
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        this.cpu.step();
        this.prevKE = kineticDamp(model, this.prevKE); // Otter quench (shared with the solver)
      }
    }
    this.flushGeometry();

    // Once fully folded, give kinetic damping a few frames to drain the interior, then freeze:
    // the frustrated molecules have no exact static equilibrium, so the only dead-still result is
    // to stop stepping and hold the relaxed pose (same strategy as the free path).
    if (this.foldPercent === this.targetFold) {
      if (++this.relaxFrames >= GUIDED_RELAX_FRAMES) {
        this.fold!.model.velocity.fill(0); // final quench so the held pose has zero motion
        this.flushGeometry();
        this.frozen = true;
      }
    } else {
      this.relaxFrames = 0;
    }
  }

  /** Free mesh: quasi-static per-step easing + velocity damping + rigid-removal, then freeze. */
  private advanceFree(): void {
    if (this.frozen || !this.cpu) return; // frozen: hold the pose, orbit only
    const m = this.fold!.model;
    for (let i = 0; i < STEPS_PER_FRAME; i++) {
      this.foldPercent += (this.targetFold - this.foldPercent) * FREE_PER_STEP_EASE;
      this.cpu.foldPercent = this.foldPercent;
      this.cpu.step();
      dampVelocity(m, FREE_VELOCITY_DAMP); // viscous bleed, then remove the rigid component
      removeRigidBodyMotion(m);
    }
    this.flushGeometry();
    if (Math.abs(this.targetFold - this.foldPercent) < FREE_FOLD_REACHED_EPS) {
      if (++this.relaxFrames >= FREE_RELAX_FRAMES) this.frozen = true;
    } else {
      this.relaxFrames = 0;
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
