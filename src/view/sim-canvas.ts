import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldNet, FoldScene, FoldSolver, SimMaterial } from "../sim/index.js";
import { kineticDamp, removeRigidBodyMotion } from "../sim/index.js";
import { type BaryTri, DEFAULT_MAX_SUBDIV, foldDepths, subdivBary, TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import { type Circuit, type ComponentKind, EMPTY_CIRCUIT } from "../model/circuit.js";
import { resolveCircuit } from "../model/circuit-geometry.js";

/**
 * Three.js viewport for the forward fold — renders the FoldNet as lit triangle faces plus
 * mountain/valley/boundary/cut lines, driving the CPU `FoldSolver` (the unit-tested reference).
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
 * Anti-overlap (uniform-pyramid presets): the mesh is split into a lateral-shell layer and a
 * molecule layer sharing one position buffer. Molecules carry a deeper polygonOffset, so when
 * they tuck coincident with the lateral faces mid-fold the laterals deterministically win the
 * depth test (no z-fight flicker). AT FULL FOLD the molecule layer and crease overlays hide
 * entirely and the N apex tips snap to one point — only the clean N-triangle shell remains.
 * Below full fold the whole mesh and all crease/cut lines are visible — the flat pattern must
 * show the molecules, not a 4-petal pinwheel. Camera near/far tightened to model scale for
 * depth precision.
 */
const COLOR_FACE = 0xec008b;
const COLOR_MOUNTAIN = 0xff3b30;
const COLOR_VALLEY = 0x1f6feb;
const COLOR_BOUNDARY = 0x888888;
const COLOR_CUT = 0x000000;
// 3D-printed mode: rigid plastic tiles, the fabric backing behind them, and the fabric-hinge lines.
const COLOR_TILE = 0xdfe3e8;
const COLOR_CLOTH = 0x5a5048;
const COLOR_HINGE = 0xb08d57;
/** Printed tile thickness as a fraction of the model's bbox diagonal (visual; physics is ratio-based). */
const TILE_THICK_FRAC = 0.018;
// `TILE_INSET_FRAC` (tile shrink toward centroid) is shared with the STL export via `tile-subdiv.ts`.
/** Copper-trace overlay line (drawn on top so routing reads against the tiles). */
const COPPER_LINE = new THREE.LineBasicMaterial({ color: 0xc87533, depthTest: false, transparent: true });

const STEPS_PER_FRAME = 40;
const GUIDED_STEPS_PER_FRAME = 80;
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
  private cpu: FoldSolver | null = null;
  /** Uniform-pyramid preset (7N mesh topology): eligible for shell display at full fold. */
  private shellCapable = false;
  /** Currently drawing only the N lateral shell faces (true only at full fold). */
  private shellDisplayed = false;
  private faceMat: THREE.MeshStandardMaterial | null = null;
  /** Molecule layer (pyramid presets only): depth-biased behind the lateral shell. */
  private molMesh: THREE.Mesh | null = null;
  private molGeo: THREE.BufferGeometry | null = null;
  private creaseLines: THREE.LineSegments[] = [];
  private geo: THREE.BufferGeometry | null = null;
  private posAttr: THREE.BufferAttribute | null = null;
  // 3D-printed thick-tile layer (rebuilt each frame from the live folded positions).
  private material: SimMaterial = "vinyl";
  private net: FoldNet | null = null; // kept so a detail change can rebuild the tiles without a full reload
  private thickGeo: THREE.BufferGeometry | null = null;
  private thickPos: Float32Array | null = null;
  private thickAttr: THREE.BufferAttribute | null = null;
  private thickMesh: THREE.Mesh | null = null;
  private tileFaces: number[] | null = null;
  private tileBary: BaryTri[][] | null = null; // per face: its sub-tiles (fold-adaptive) in barycentric coords
  private tileDetail = DEFAULT_MAX_SUBDIV; // max adaptive subdivision; shared with the STL export
  private tileT = 0; // one-sided extrude thickness (model units)
  private tileSign: Float32Array | null = null; // per-face ±1: extrude side, made consistent across mixed winding
  // Legal hinge bridges: little printed straps tying adjacent tiles across each interior (2-face)
  // edge — i.e. the M/V/F hinges. Cuts are split into 1-face boundary edges, so they get NO bridge
  // and stay open (bridging a cut would lock the kirigami mechanism).
  private bridgeList: [number, number, number, number][] | null = null; // [face1, face2, edgeV0, edgeV1]
  private bridgePos: Float32Array | null = null;
  private bridgeGeo: THREE.BufferGeometry | null = null;
  private bridgeAttr: THREE.BufferAttribute | null = null;
  private bridgeMesh: THREE.Mesh | null = null;
  // Circuit overlay: SMD parts + traces placed on the tiles, riding the fold (see model/circuit*).
  private readonly circuitGroup = new THREE.Group();
  private circuit: Circuit = EMPTY_CIRCUIT;
  private circuitMode = false;
  private circuitTool: ComponentKind | null = null;
  private circuitId = 0;
  private pickMesh: THREE.Mesh | null = null; // invisible folded faces; raycast target for placement
  private pickPos: Float32Array | null = null;
  private downPt: { x: number; y: number } | null = null;
  private circuitListener: ((c: Circuit) => void) | null = null;
  private foldPercent = 0;
  // Open at the flat full sheet (0): the kirigamized body is first shown as the complete
  // paper with every cut line visible, then the user drives the fold slider up to the target.
  private targetFold = 0;
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
    this.scene.add(this.circuitGroup);

    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", (e) => { this.downPt = { x: e.clientX, y: e.clientY }; });
    dom.addEventListener("pointerup", (e) => this.onPointerUp(e));

    this.loop = this.loop.bind(this);
  }

  /** Load a fold scene: build render meshes, pick the solver backend, reset fold. */
  setScene(scene: FoldScene): void {
    this.disposeGeo();
    this.fold = scene;
    const { net, model } = scene;
    this.net = net;
    this.thickMesh = null; // disposeGeo()/group.clear() dropped the old tile mesh
    this.bridgeMesh = null;
    this.material = scene.material ?? "vinyl";

    this.guided = anyDriven(model.driven);
    this.foldPercent = 0;
    this.frozen = false;
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
    this.prevPos = model.position.slice();

    this.posAttr = new THREE.BufferAttribute(model.position, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);

    // Printed mode renders thick tiles, never the thin pyramid shell swap.
    this.shellCapable = isUniformPyramidShell(net) && this.material !== "printed";
    this.shellDisplayed = false;
    // Pyramid presets split into lateral shell + molecule layers (shared position buffer) so the
    // molecules can carry a deeper depth bias; other meshes draw as one layer.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", this.posAttr);
    geo.setIndex(this.shellCapable ? lateralFaceIndices(net) : net.faces.flat());
    geo.computeVertexNormals();
    this.geo = geo;

    // Vinyl: the flat sheet itself. Printed: this flat mesh becomes the fabric BACKING that shows
    // through the hinge gaps, with the thick rigid tiles drawn on top (buildPrintedTiles below).
    this.faceMat = new THREE.MeshStandardMaterial({
      color: this.material === "printed" ? COLOR_CLOTH : COLOR_FACE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: this.material === "printed" ? 0.95 : 0.75,
      polygonOffset: true,
      polygonOffsetFactor: this.material === "printed" ? 4 : 1,
      polygonOffsetUnits: this.material === "printed" ? 4 : 1,
    });
    this.group.add(new THREE.Mesh(geo, this.faceMat));

    this.molMesh = null;
    this.molGeo = null;
    if (this.shellCapable) {
      // Molecules tuck flush against the lateral faces near full fold; the deeper polygon offset
      // pushes them behind in the depth buffer so the coincident surfaces never z-fight.
      const molGeo = new THREE.BufferGeometry();
      molGeo.setAttribute("position", this.posAttr);
      molGeo.setIndex(moleculeFaceIndices(net));
      molGeo.computeVertexNormals();
      this.molGeo = molGeo;
      const molMat = new THREE.MeshStandardMaterial({
        color: COLOR_FACE,
        side: THREE.DoubleSide,
        flatShading: true,
        metalness: 0.0,
        roughness: 0.75,
        polygonOffset: true,
        polygonOffsetFactor: 3,
        polygonOffsetUnits: 3,
      });
      this.molMesh = new THREE.Mesh(molGeo, molMat);
      this.group.add(this.molMesh);
    }

    // Crease/cut lines coloured by assignment (facets hidden); all share the live position
    // buffer. Shell presets hide them only at full fold (syncShellDisplay), where the molecule
    // creases and duplicate apex tips converge and z-fight as visual clutter.
    const byKind = creaseIndices(net);
    // Printed: M/V/B fold lines are the fabric hinges (one cloth colour); cuts stay black.
    const colors: Record<string, number> =
      this.material === "printed"
        ? { M: COLOR_HINGE, V: COLOR_HINGE, B: COLOR_HINGE, C: COLOR_CUT }
        : { M: COLOR_MOUNTAIN, V: COLOR_VALLEY, B: COLOR_BOUNDARY, C: COLOR_CUT };
    const widths: Record<string, number> = { M: 1, V: 1, B: 1, C: 2 };
    this.creaseLines = [];
    for (const kind of ["B", "M", "V", "C"]) {
      const idx = byKind[kind];
      if (!idx || idx.length === 0) continue;
      const lg = new THREE.BufferGeometry();
      lg.setAttribute("position", this.posAttr);
      lg.setIndex(idx);
      const line = new THREE.LineSegments(
        lg,
        new THREE.LineBasicMaterial({ color: colors[kind], linewidth: widths[kind] }),
      );
      this.creaseLines.push(line);
      this.group.add(line);
    }

    // Printed: thick rigid tiles drawn on top of the fabric backing, rebuilt each frame.
    if (this.material === "printed") this.buildPrintedTiles(net);

    // Circuit overlay: invisible folded-faces pick mesh for placement, and a fresh (empty) circuit.
    this.buildPickMesh(net);
    this.circuit = EMPTY_CIRCUIT;
    this.circuitId = 0;
    this.circuitListener?.(this.circuit);
    this.updateCircuitOverlay();

    // CPU reference solver for all modes (guided AKDE presets are verified on this path).
    this.cpu = scene.solver;
    // Self-collision so folded layers don't pass through each other. Driven (guided) nodes are
    // fixed and skipped, so prescribed shapes are unaffected; free folds get layer-vs-layer contact.
    this.cpu.enableCollision();

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
    return this.cpu ? "cpu" : "none";
  }

  /**
   * Fast-forward a guided fold to the current slider target. The modal now opens flat (target 0),
   * so this is a no-op on open (the early return below) and only does work once the user scrubs the
   * fold slider to a non-zero target — without the burst the mesh would ease in over many frames.
   */
  warmToTarget(): void {
    if (!this.fold || !this.guided || !this.cpu || this.targetFold < FOLD_REACHED_EPS) return;
    this.cpu.solve(16000, this.targetFold);
    this.foldPercent = this.targetFold;
    this.syncShellDisplay();
    this.flushGeometry();
    this.prevPos = this.fold.model.position.slice();
  }

  setFoldPercent(p: number): void {
    this.targetFold = Math.min(1, Math.max(0, p));
    this.frozen = false; // scrubbing wakes a frozen fold
    this.settledFrames = 0;
    this.framesAtTarget = 0;
    this.prevKE = Infinity;
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
      if (this.cpu) {
        this.cpu.foldPercent = this.foldPercent;
        for (let i = 0; i < GUIDED_STEPS_PER_FRAME; i++) {
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
    this.syncShellDisplay();
    if (this.posAttr) this.posAttr.needsUpdate = true;
    this.geo?.computeVertexNormals();
    if (this.molMesh?.visible) this.molGeo?.computeVertexNormals();
    if (this.material === "printed") this.updatePrintedTiles();
    this.syncPickMesh();
    if (this.circuit.components.length > 0) this.updateCircuitOverlay();
  }

  /**
   * Build the 3D-printed thick-tile layer: one solid prism per face, inset from its fold edges so
   * the bare-fabric hinge gap shows. The vertex buffer is non-indexed and rebuilt every frame from
   * the live folded positions (`updatePrintedTiles`) since the extrusion follows each face normal.
   */
  private buildPrintedTiles(net: FoldNet): void {
    if (!this.fold) return;
    const pos = this.fold.model.position;
    // Visual thickness/gap from the model size (physics closure is ratio-based, set elsewhere).
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      minX = Math.min(minX, pos[i]); maxX = Math.max(maxX, pos[i]);
      minY = Math.min(minY, pos[i + 1]); maxY = Math.max(maxY, pos[i + 1]);
      minZ = Math.min(minZ, pos[i + 2]); maxZ = Math.max(maxZ, pos[i + 2]);
    }
    const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    // One-sided: the full tile thickness extrudes to ONE side of the hinge plane (the +normal face);
    // the cloth surface mesh stays at the plane as the backing. (Was centered ±thick/2.)
    this.tileT = diag * TILE_THICK_FRAC;

    // A detail change rebuilds just this layer — drop the previous tile + bridge meshes first.
    if (this.thickMesh) {
      this.group.remove(this.thickMesh);
      this.thickGeo?.dispose();
      (this.thickMesh.material as THREE.Material).dispose();
      this.thickMesh = null;
    }
    if (this.bridgeMesh) {
      this.group.remove(this.bridgeMesh);
      this.bridgeGeo?.dispose();
      (this.bridgeMesh.material as THREE.Material).dispose();
      this.bridgeMesh = null;
    }

    this.tileFaces = net.faces.flat();
    const nTris = this.tileFaces.length / 3;
    // Kirigamized meshes can have mixed face winding (some faces' raw normals point the opposite
    // way), which would extrude their tiles to the wrong side → tiles on both faces, cloth in the
    // middle. Pin every tile to ONE side: compute a per-face sign vs the mesh's mean (flat) normal,
    // so flipped faces extrude with the majority. Computed once from the flat rest pose.
    this.tileSign = new Float32Array(nTris);
    {
      const r = this.fold.model.rest;
      const ff = this.tileFaces;
      const nrm: number[][] = [];
      let mx = 0, my = 0, mz = 0;
      for (let f = 0; f < ff.length; f += 3) {
        const a = ff[f] * 3, b = ff[f + 1] * 3, c = ff[f + 2] * 3;
        const nx = (r[b + 1] - r[a + 1]) * (r[c + 2] - r[a + 2]) - (r[b + 2] - r[a + 2]) * (r[c + 1] - r[a + 1]);
        const ny = (r[b + 2] - r[a + 2]) * (r[c] - r[a]) - (r[b] - r[a]) * (r[c + 2] - r[a + 2]);
        const nz = (r[b] - r[a]) * (r[c + 1] - r[a + 1]) - (r[b + 1] - r[a + 1]) * (r[c] - r[a]);
        nrm.push([nx, ny, nz]); mx += nx; my += ny; mz += nz;
      }
      for (let i = 0; i < nrm.length; i++) {
        const [nx, ny, nz] = nrm[i];
        this.tileSign[i] = nx * mx + ny * my + nz * mz >= 0 ? 1 : -1;
      }
    }
    // Fold-adaptive subdivision: faces touching harder folds split into more sub-tiles (shared with
    // the STL export via tile-subdiv). Each triangle's sub-tiles are coplanar — purely visual res.
    const depth = this.printedFaceDepths(net);
    this.tileBary = depth.map((d) => subdivBary(d));
    const totalSub = this.tileBary.reduce((n, b) => n + b.length, 0);

    this.thickPos = new Float32Array(totalSub * 21 * 3); // 7 tris (top + 3 side quads) × 3 verts each
    this.thickGeo = new THREE.BufferGeometry();
    this.thickAttr = new THREE.BufferAttribute(this.thickPos, 3);
    this.thickAttr.setUsage(THREE.DynamicDrawUsage);
    this.thickGeo.setAttribute("position", this.thickAttr);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_TILE,
      side: THREE.DoubleSide,
      flatShading: true,
      metalness: 0.0,
      roughness: 0.6,
    });
    this.thickMesh = new THREE.Mesh(this.thickGeo, mat);
    this.group.add(this.thickMesh);
    this.buildBridges(net);
    this.updatePrintedTiles();
  }

  /**
   * Set up the legal-bridge layer: a little strap across each interior hinge edge. A bridge is
   * placed only on an edge that is BOTH shared by two faces AND assigned M/V/F (a real fold or
   * facet hinge). Cut ("C") and boundary ("B") edges get NO bridge — bridging a cut would lock the
   * kirigami mechanism. (Topology alone is insufficient: a cut can still read as a 2-face edge here,
   * so we gate on the assignment too.)
   */
  private buildBridges(net: FoldNet): void {
    const assign = new Map<string, string>();
    for (const e of net.edges) {
      const k = e.a < e.b ? `${e.a}_${e.b}` : `${e.b}_${e.a}`;
      assign.set(k, e.assignment);
    }
    const edgeFaces = new Map<string, number[]>();
    for (let fi = 0; fi < net.faces.length; fi++) {
      const f = net.faces[fi];
      const pairs: [number, number][] = [[f[0], f[1]], [f[1], f[2]], [f[2], f[0]]];
      for (const [u, v] of pairs) {
        const key = u < v ? `${u}_${v}` : `${v}_${u}`;
        const list = edgeFaces.get(key);
        if (list) list.push(fi);
        else edgeFaces.set(key, [fi]);
      }
    }
    const bridges: [number, number, number, number][] = [];
    for (const [key, fs] of edgeFaces) {
      if (fs.length !== 2) continue; // boundary / split cut → keep open, no bridge
      const a = assign.get(key);
      if (a !== "M" && a !== "V" && a !== "F") continue; // only legal hinges (never C / B)
      const u = key.indexOf("_");
      bridges.push([fs[0], fs[1], Number(key.slice(0, u)), Number(key.slice(u + 1))]);
    }
    this.bridgeList = bridges;
    this.bridgePos = new Float32Array(bridges.length * 18); // 2 tris × 3 verts × 3
    this.bridgeGeo = new THREE.BufferGeometry();
    this.bridgeAttr = new THREE.BufferAttribute(this.bridgePos, 3);
    this.bridgeAttr.setUsage(THREE.DynamicDrawUsage);
    this.bridgeGeo.setAttribute("position", this.bridgeAttr);
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_TILE, side: THREE.DoubleSide, flatShading: true, metalness: 0.0, roughness: 0.6,
    });
    this.bridgeMesh = new THREE.Mesh(this.bridgeGeo, mat);
    this.group.add(this.bridgeMesh);
  }

  /** Refill the bridge straps from the live folded positions (rebuilt each frame like the tiles). */
  private updateBridges(): void {
    const list = this.bridgeList, out = this.bridgePos, faces = this.tileFaces;
    if (!list || !out || !faces || !this.fold || !this.tileSign) return;
    const p = this.fold.model.position;
    const t = this.tileT;
    const W = 0.16; // half-width of each strap along its edge (fraction of edge length)
    const frame = (fi: number): { gx: number; gy: number; gz: number; nx: number; ny: number; nz: number } => {
      const f = fi * 3;
      const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      const gx = (ax + bx + cx) / 3, gy = (ay + by + cy) / 3, gz = (az + bz + cz) / 3;
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nx, ny, nz) || 1;
      const s = this.tileSign![fi];
      return { gx, gy, gz, nx: (nx / nl) * s, ny: (ny / nl) * s, nz: (nz / nl) * s };
    };
    // Inset toward the face centroid like a tile, then lift to the tile top (+t): the strap meets
    // the two tiles at their top surfaces, spanning the bare-hinge gap between them.
    const insetTop = (x: number, y: number, z: number, fr: ReturnType<typeof frame>): [number, number, number] => {
      const ix = x + (fr.gx - x) * TILE_INSET_FRAC, iy = y + (fr.gy - y) * TILE_INSET_FRAC, iz = z + (fr.gz - z) * TILE_INSET_FRAC;
      return [ix + fr.nx * t, iy + fr.ny * t, iz + fr.nz * t];
    };
    let o = 0;
    const push = (v: [number, number, number]): void => { out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2]; };
    for (const [f1, f2, v0, v1] of list) {
      const a0 = v0 * 3, b0 = v1 * 3;
      const ax = p[a0], ay = p[a0 + 1], az = p[a0 + 2];
      const dx = p[b0] - ax, dy = p[b0 + 1] - ay, dz = p[b0 + 2] - az;
      const at = (s: number): [number, number, number] => [ax + dx * s, ay + dy * s, az + dz * s];
      const lo = at(0.5 - W), hi = at(0.5 + W);
      const fr1 = frame(f1), fr2 = frame(f2);
      const c1 = insetTop(lo[0], lo[1], lo[2], fr1), c2 = insetTop(hi[0], hi[1], hi[2], fr1);
      const c3 = insetTop(hi[0], hi[1], hi[2], fr2), c4 = insetTop(lo[0], lo[1], lo[2], fr2);
      push(c1); push(c2); push(c3);
      push(c1); push(c3); push(c4);
    }
    this.bridgeAttr!.needsUpdate = true;
    this.bridgeGeo!.computeVertexNormals();
  }

  /** Per-face subdivision depth from the design fold angles, matching the STL export's metric. */
  private printedFaceDepths(net: FoldNet): number[] {
    const c = this.fold!.model.creases;
    const score = new Array<number>(net.faces.length).fill(0);
    for (let i = 0; i < c.count; i++) {
      const m = Math.abs(c.targetTheta[i]);
      const f1 = c.face1[i], f2 = c.face2[i];
      if (f1 >= 0 && f1 < score.length) score[f1] = Math.max(score[f1], m);
      if (f2 >= 0 && f2 < score.length) score[f2] = Math.max(score[f2], m);
    }
    return foldDepths(score, this.tileDetail);
  }

  /** Set the fold-adaptive detail cap (shared with the export) and rebuild the printed tiles. */
  setTileDetail(cap: number): void {
    const v = Math.max(0, Math.floor(cap));
    if (v === this.tileDetail) return;
    this.tileDetail = v;
    if (this.material === "printed" && this.net) this.buildPrintedTiles(this.net);
  }

  /** Refill the printed-tile vertex buffer from the current folded positions (one prism per sub-tile). */
  private updatePrintedTiles(): void {
    const faces = this.tileFaces;
    const bary = this.tileBary;
    const out = this.thickPos;
    if (!faces || !bary || !out || !this.fold) return;
    const p = this.fold.model.position;
    const t = this.tileT;
    let o = 0;
    const push = (v: [number, number, number]): void => {
      out[o++] = v[0]; out[o++] = v[1]; out[o++] = v[2];
    };
    for (let f = 0, fi = 0; f < faces.length; f += 3, fi++) {
      const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      // face normal (shared by all sub-tiles — a triangle face is planar), pinned to the one-sided face
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nx, ny, nz) || 1;
      const sgn = this.tileSign ? this.tileSign[fi] : 1;
      nx = (nx / nl) * sgn; ny = (ny / nl) * sgn; nz = (nz / nl) * sgn;
      // Each sub-tile's corner = barycentric blend of the live face corners.
      const at = (w: [number, number, number]): [number, number, number] => [
        w[0] * ax + w[1] * bx + w[2] * cx,
        w[0] * ay + w[1] * by + w[2] * cy,
        w[0] * az + w[1] * bz + w[2] * cz,
      ];
      for (const tri of bary[fi]) {
        const v0 = at(tri[0]), v1 = at(tri[1]), v2 = at(tri[2]);
        const gx = (v0[0] + v1[0] + v2[0]) / 3, gy = (v0[1] + v1[1] + v2[1]) / 3, gz = (v0[2] + v1[2] + v2[2]) / 3;
        // shrink each corner toward the sub-tile centroid (exposes the bare-cloth hinge strip), then
        // offset along the normal → top plate at +t, wall bases at the hinge plane (s=0), one-sided.
        const corner = (v: [number, number, number], s: number): [number, number, number] => {
          const ix = v[0] + (gx - v[0]) * TILE_INSET_FRAC;
          const iy = v[1] + (gy - v[1]) * TILE_INSET_FRAC;
          const iz = v[2] + (gz - v[2]) * TILE_INSET_FRAC;
          return [ix + nx * s, iy + ny * s, iz + nz * s];
        };
        const t0 = corner(v0, t), t1 = corner(v1, t), t2 = corner(v2, t);
        const b0 = corner(v0, 0), b1 = corner(v1, 0), b2 = corner(v2, 0);
        // top plate + 3 side quads. NO bottom plate: it sat coincident on the cloth plane and z-fought
        // the fabric backing; the cloth mesh is the backing, so the open bottom is hidden behind it.
        push(t0); push(t1); push(t2);
        const tops = [t0, t1, t2], bots = [b0, b1, b2];
        for (let e = 0; e < 3; e++) {
          const j = (e + 1) % 3;
          push(bots[e]); push(bots[j]); push(tops[j]);
          push(bots[e]); push(tops[j]); push(tops[e]);
        }
      }
    }
    this.thickAttr!.needsUpdate = true;
    this.thickGeo!.computeVertexNormals();
    this.updateBridges();
  }

  // --- Circuit overlay ------------------------------------------------------

  /** Enter/exit circuit-placement mode (clicks on tiles drop the selected part). */
  setCircuitMode(on: boolean): void {
    this.circuitMode = on;
  }

  /** Which SMD part the next click places (null = none). */
  setCircuitTool(kind: ComponentKind | null): void {
    this.circuitTool = kind;
  }

  /** Notified whenever the circuit changes (controller mirrors it into the store for export). */
  onCircuitChange(cb: (c: Circuit) => void): void {
    this.circuitListener = cb;
  }

  getCircuit(): Circuit {
    return this.circuit;
  }

  getNet(): FoldNet | null {
    return this.net;
  }

  clearCircuit(): void {
    this.circuit = { components: [], traces: [] };
    this.circuitId = 0;
    this.circuitListener?.(this.circuit);
    this.updateCircuitOverlay();
  }

  /** Invisible indexed mesh of the folded faces — raycast target that maps a hit straight to a face. */
  private buildPickMesh(net: FoldNet): void {
    this.pickPos = new Float32Array(net.vertices.length * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pickPos, 3));
    geo.setIndex(net.faces.flat());
    this.pickMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
    this.pickMesh.frustumCulled = false;
    this.group.add(this.pickMesh);
    this.syncPickMesh();
  }

  private syncPickMesh(): void {
    if (!this.pickPos || !this.pickMesh || !this.fold) return;
    this.pickPos.set(this.fold.model.position.subarray(0, this.pickPos.length));
    (this.pickMesh.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  private onPointerUp(e: PointerEvent): void {
    const down = this.downPt;
    this.downPt = null;
    if (!down || !this.circuitMode || !this.circuitTool || !this.pickMesh || !this.net || !this.fold) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag (orbit), not a click
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.pickMesh, false)[0];
    if (!hit || hit.faceIndex == null) return;
    this.placeComponent(hit.faceIndex, hit.point);
  }

  /** Drop the selected part at a hit, snapped to the face by barycentric coords; chain a trace. */
  private placeComponent(face: number, point: THREE.Vector3): void {
    const p = this.fold!.model.position;
    const f = this.net!.faces[face];
    const bary = baryAt(point, p, f);
    const id = `c${++this.circuitId}`;
    const prev = this.circuit.components[this.circuit.components.length - 1];
    const components = [...this.circuit.components, { id, kind: this.circuitTool!, face, bary, rot: 0 }];
    const traces = [...this.circuit.traces];
    if (prev) traces.push({ id: `t${this.circuitId}`, from: { comp: prev.id, pad: 1 }, to: { comp: id, pad: 0 } });
    this.circuit = { components, traces };
    this.circuitListener?.(this.circuit);
    this.updateCircuitOverlay();
  }

  /** Rebuild the circuit overlay (part boxes + trace lines) at the current fold. */
  private updateCircuitOverlay(): void {
    this.circuitGroup.clear();
    if (!this.net || !this.fold || this.circuit.components.length === 0) return;
    const pos = this.fold.model.position;
    const geo = resolveCircuit(this.circuit, this.net, (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    const bodyH = 0.03 * geo.scale;
    for (const c of geo.components) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(c.len, c.wid, bodyH),
        new THREE.MeshStandardMaterial({ color: c.color, metalness: 0.1, roughness: 0.6 }),
      );
      const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...c.x), new THREE.Vector3(...c.y), new THREE.Vector3(...c.n),
      );
      m.setPosition(c.center[0] + c.n[0] * bodyH / 2, c.center[1] + c.n[1] * bodyH / 2, c.center[2] + c.n[2] * bodyH / 2);
      box.applyMatrix4(m);
      this.circuitGroup.add(box);
    }
    for (const t of geo.traces) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(
        t.path.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      );
      this.circuitGroup.add(new THREE.Line(lineGeo, COPPER_LINE));
    }
  }

  /**
   * Swap between the full-mesh and shell display for uniform-pyramid presets. Below full fold
   * the whole mesh (molecule layer included) and all crease lines are drawn; at full fold the
   * molecule layer and crease lines hide and the duplicate apex tips snap to one point, leaving
   * only the clean N-triangle lateral shell.
   */
  private syncShellDisplay(): void {
    if (!this.shellCapable || !this.fold) return;
    const wantShell = this.foldPercent >= 1 - FOLD_REACHED_EPS;
    if (wantShell !== this.shellDisplayed) {
      this.shellDisplayed = wantShell;
      if (this.molMesh) this.molMesh.visible = !wantShell;
      if (this.faceMat) {
        this.faceMat.side = wantShell ? THREE.FrontSide : THREE.DoubleSide;
        this.faceMat.needsUpdate = true;
      }
      for (const line of this.creaseLines) line.visible = !wantShell;
    }
    if (wantShell) snapTipsToMean(this.fold.model.position, this.fold.net.tips);
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
    this.molGeo?.dispose();
    this.molGeo = null;
    this.molMesh = null;
    this.posAttr = null;
    this.thickGeo?.dispose();
    this.thickGeo = null;
    this.thickPos = null;
    this.thickAttr = null;
    this.thickMesh = null;
    this.bridgeGeo?.dispose();
    this.bridgeGeo = null;
    this.bridgePos = null;
    this.bridgeAttr = null;
    this.bridgeMesh = null;
    this.bridgeList = null;
    this.tileFaces = null;
    this.tileBary = null;
    this.circuitGroup.clear();
    this.pickMesh = null;
    this.pickPos = null;
    this.cpu = null;
    this.faceMat = null;
    this.creaseLines = [];
    this.shellCapable = false;
    this.shellDisplayed = false;
  }
}

/** Barycentric coords of a world point within a folded face (node-index triple into `position`). */
function baryAt(point: THREE.Vector3, position: Float32Array, f: [number, number, number]): [number, number, number] {
  const a = new THREE.Vector3(position[3 * f[0]], position[3 * f[0] + 1], position[3 * f[0] + 2]);
  const b = new THREE.Vector3(position[3 * f[1]], position[3 * f[1] + 1], position[3 * f[1] + 2]);
  const c = new THREE.Vector3(position[3 * f[2]], position[3 * f[2] + 1], position[3 * f[2] + 2]);
  const v0 = b.clone().sub(a), v1 = c.clone().sub(a), v2 = point.clone().sub(a);
  const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1), d20 = v2.dot(v0), d21 = v2.dot(v1);
  const den = d00 * d11 - d01 * d01 || 1e-12;
  const v = (d11 * d20 - d01 * d21) / den;
  const w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}

/** AKDE uniform pyramid: N lateral tris + 6N molecule tris = 7N faces. */
function isUniformPyramidShell(net: FoldNet): boolean {
  const N = net.meta.N;
  return N > 0 && net.faces.length === 7 * N;
}

/** The N lateral shell triangles (faces[7k] of each molecule group). */
function lateralFaceIndices(net: FoldNet): number[] {
  const out: number[] = [];
  for (let k = 0; k < net.meta.N; k++) out.push(...net.faces[7 * k]);
  return out;
}

/** The 6N molecule triangles (everything but the laterals). */
function moleculeFaceIndices(net: FoldNet): number[] {
  const out: number[] = [];
  for (let f = 0; f < net.faces.length; f++) {
    if (f % 7 !== 0) out.push(...net.faces[f]);
  }
  return out;
}

function creaseIndices(net: FoldNet): Record<string, number[]> {
  const byKind: Record<string, number[]> = { M: [], V: [], B: [], C: [] };
  for (const e of net.edges) {
    if (e.assignment === "F") continue;
    byKind[e.assignment]?.push(e.a, e.b);
  }
  return byKind;
}

function snapTipsToMean(pos: Float32Array, tips: number[]): void {
  if (tips.length === 0) return;
  let x = 0, y = 0, z = 0;
  for (const i of tips) {
    x += pos[3 * i];
    y += pos[3 * i + 1];
    z += pos[3 * i + 2];
  }
  const n = tips.length;
  x /= n;
  y /= n;
  z /= n;
  for (const i of tips) {
    pos[3 * i] = x;
    pos[3 * i + 1] = y;
    pos[3 * i + 2] = z;
  }
}

function anyDriven(driven: Uint8Array): boolean {
  for (let i = 0; i < driven.length; i++) if (driven[i]) return true;
  return false;
}
