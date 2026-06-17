import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { FoldNet, FoldScene, FoldSolver, SimMaterial } from "../sim/index.js";
import { kineticDamp, removeRigidBodyMotion } from "../sim/index.js";
import { type BaryTri, DEFAULT_MAX_SUBDIV, DETAIL_OFFSET, foldDepths, MAX_TILE_GAP, MIN_TILE_GAP, subdivBary, TILE_INSET_FRAC } from "../model/tile-subdiv.js";
import { type Circuit, type ComponentKind, EMPTY_CIRCUIT } from "../model/circuit.js";
import { type ComponentGeom, locateFlat, resolveCircuit, type TraceGeom, TRACE_W } from "../model/circuit-geometry.js";

/** Active circuit-editor tool, KiCad-style: a cursor (select/move), the wire router, or a part to drop. */
export type CircuitTool = "select" | "route" | ComponentKind;

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
/** Copper SMD pad material (shared; pads are all the same finish). */
const PAD_MAT = new THREE.MeshStandardMaterial({ color: 0xc87533, metalness: 0.6, roughness: 0.35 });
/** Live wire shown while dragging a trace from one pad toward another (drawn on top). */
const ROUTE_PREVIEW_MAT = new THREE.LineBasicMaterial({ color: 0xffa030, depthTest: false, transparent: true });
/** Pad grab radius in screen pixels² — how close the cursor must be to a pad to grab/snap it. */
const PAD_PICK_PX2 = 22 * 22;
/** Component grab radius in screen pixels² — for selecting/moving a part by its body centre. */
const COMP_PICK_PX2 = 30 * 30;
/** Highlight finish for the selected part's pads (KiCad-style selection). */
const SELECT_MAT = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0x7a5c00, emissiveIntensity: 0.5, metalness: 0.4, roughness: 0.4 });
/** Translucent finish for the part attached to the cursor (place/move ghost). */
const GHOST_MAT = new THREE.MeshStandardMaterial({ color: 0xffd23f, transparent: true, opacity: 0.55, depthTest: false, metalness: 0.3, roughness: 0.5 });
/** Snap grid: this many cells across the flat pattern's larger dimension. */
const GRID_CELLS = 28;
const GRID_MAT = new THREE.LineBasicMaterial({ color: 0xcdd2d8, transparent: true, opacity: 0.6 });
/**
 * Copper trace ribbon — a full-width conductor laid FLAT on the fabric, sitting a hair above the cloth
 * but BELOW the tile tops. Plain depth testing then makes the raised gray tiles occlude it wherever a
 * tile is above, so it shows ONLY in the bare-cloth gaps it threads (never on the gray). No
 * polygonOffset — the geometric lift already clears the fabric backing, and offset risked peeking over
 * tile edges.
 */
const TRACE_MAT = new THREE.MeshStandardMaterial({
  color: 0xc87533, metalness: 0.6, roughness: 0.35, side: THREE.DoubleSide,
});

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
  /** Flat 2D camera for the circuit editor: orthographic top-down, no perspective depth. */
  private readonly orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
  private activeCamera!: THREE.Camera; // the camera currently rendered/picked with (persp or ortho)
  private orthoRadius = 1;
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.65);
  private readonly keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  private readonly fillLight = new THREE.DirectionalLight(0xffffff, 0.35);
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
  private tileInset = TILE_INSET_FRAC; // gap: tile shrink toward centroid (the "Gap" slider); shared with export
  private tileT = 0; // one-sided extrude thickness (model units)
  private tileSign: Float32Array | null = null; // per-face ±1: extrude side, made consistent across mixed winding
  // PyKirigami-style SPHERICAL joints (printed mode): little TPU connectors pinning tiles that meet
  // only at a corner POINT — rotating-units pivots (e.g. the rotating-triangles kirigami). Tiles that
  // share a fold EDGE are already tied by the continuous TPU backing; cuts stay OPEN. This is what
  // holds a printed cut-pattern together as proper kirigami (cf. PyKirigami Fig. 2c). Detected by
  // geometric coincidence in the rest pose (the solver net splits shared corners), rebuilt each frame.
  private sphPivots: number[][] | null = null; // each pivot: the net-vertices coincident at one point
  private jointMesh: THREE.InstancedMesh | null = null;
  private jointGeo: THREE.BufferGeometry | null = null;
  private jointMat: THREE.MeshStandardMaterial | null = null;
  // Circuit overlay: SMD parts + traces placed on the tiles, riding the fold (see model/circuit*).
  private readonly circuitGroup = new THREE.Group();
  private circuit: Circuit = EMPTY_CIRCUIT;
  private circuitMode = false;
  private tool: CircuitTool = "select"; // KiCad-style active tool
  private selected: string | null = null; // selected component id (select tool)
  private circuitId = 0;
  // KiCad cursor-attached place/move: the part rides the cursor and a CLICK drops it (no drag).
  private held:
    | { mode: "place"; kind: ComponentKind; rot: number }
    | { mode: "move"; id: string; orig: { face: number; bary: [number, number, number] } }
    | null = null;
  private readonly ghostGroup = new THREE.Group();
  // Snap grid (flat-pattern units), aligned to the model origin; shown only in the circuit editor.
  private gridStep = 1;
  private gridLines: THREE.LineSegments | null = null;
  private pickMesh: THREE.Mesh | null = null; // invisible folded faces; raycast target for placement
  private pickPos: Float32Array | null = null;
  private downPt: { x: number; y: number } | null = null;
  private circuitListener: ((c: Circuit) => void) | null = null;
  // KiCad-style routing: click a pad to start, rubber-band to the cursor, click a pad to finish.
  private readonly routeGroup = new THREE.Group();
  private routeStart: { comp: string; pad: number; world: [number, number, number] } | null = null;
  private padCache: { comp: string; pad: number; world: [number, number, number] }[] = [];
  private compCache: { id: string; world: [number, number, number] }[] = []; // component centres (select/move)
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
    // Flat 2D camera for the circuit editor (orthographic, top-down → no perspective depth).
    this.orthoCamera.up.set(0, 1, 0);
    this.activeCamera = this.camera;

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.zoomToCursor = true; // KiCad-style: wheel zooms toward the cursor
    this.controls.screenSpacePanning = true;

    this.scene.add(this.ambient);
    this.keyLight.position.set(1, -1, 2);
    this.scene.add(this.keyLight);
    this.fillLight.position.set(-1, 1, 0.5);
    this.scene.add(this.fillLight);
    this.scene.add(this.group);
    this.scene.add(this.circuitGroup);
    this.scene.add(this.routeGroup);
    this.scene.add(this.ghostGroup);

    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    dom.addEventListener("pointermove", (e) => this.onPointerMove(e));
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

    // Circuit overlay: invisible folded-faces pick mesh for placement, a snap grid, and a fresh circuit.
    this.buildPickMesh(net);
    this.buildGrid(net);
    this.circuit = EMPTY_CIRCUIT;
    this.circuitId = 0;
    this.held = null;
    this.selected = null;
    this.circuitListener?.(this.circuit);
    this.updateCircuitOverlay();

    // CPU reference solver for all modes (guided AKDE presets are verified on this path).
    this.cpu = scene.solver;
    // Self-collision so folded layers don't pass through each other. Driven (guided) nodes are
    // fixed and skipped, so prescribed shapes are unaffected; free folds get layer-vs-layer contact.
    this.cpu.enableCollision();

    // Frame the camera to the model's ACTUAL bounding box — the union of the flat rest and the
    // folded goal, so nothing crops as the fold slider scrubs — rather than a fixed radius. The
    // importer normalizes every model to a bounding-SPHERE of radius 1, so a high-aspect relief (a
    // tall, narrow 2.5D sign especially) occupies only a thin slice of a fixed sphere and renders as
    // a sliver. Fitting to the box makes any aspect fill the view. Tightening near/far to the box
    // also keeps the ~250:1 depth ratio that stops coincident folded faces z-fighting.
    const mdl = scene.model;
    const anyDrivenNode = ((): boolean => { for (let i = 0; i < mdl.driven.length; i++) if (mdl.driven[i]) return true; return false; })();
    let loX = Infinity, loY = Infinity, loZ = Infinity, hiX = -Infinity, hiY = -Infinity, hiZ = -Infinity;
    const swallow = (a: Float32Array): void => {
      for (let i = 0; i < mdl.numNodes; i++) {
        const x = a[3 * i], y = a[3 * i + 1], z = a[3 * i + 2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        if (x < loX) loX = x; if (x > hiX) hiX = x;
        if (y < loY) loY = y; if (y > hiY) hiY = y;
        if (z < loZ) loZ = z; if (z > hiZ) hiZ = z;
      }
    };
    swallow(mdl.position);
    if (anyDrivenNode) swallow(mdl.goal); // guided: also bound the folded relief it eases into
    const cx = (loX + hiX) / 2, cy = (loY + hiY) / 2, cz = (loZ + hiZ) / 2;
    // Fit the LARGEST box dimension to the frame. (Old code framed the radius-1 bounding sphere —
    // span≈2 — at reach 2.4, i.e. reach ≈ span·1.2; reuse that density so the proven framing is
    // unchanged for square models while narrow signs now fill the view too.)
    const span = Math.max(hiX - loX, hiY - loY, hiZ - loZ, 1e-3);
    const reach = span * 1.2;
    this.settleEps = reach * SETTLE_REL;
    this.camera.near = Math.max(0.02, reach * 0.04);
    this.camera.far = reach * 12;
    this.camera.position.set(cx + reach, cy - reach, cz + reach * 0.85);
    this.camera.updateProjectionMatrix();
    this.controls.target.set(cx, cy, cz);
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
    if (this.activeCamera === this.orthoCamera) this.applyOrthoFrustum();
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
      // Free fold (self-supporting origami/kirigami, e.g. the Miyamoto RES tower): drive crease
      // targets and let the OS-faithful under-damped dynamics settle — exactly as Origami Simulator
      // does. NO kinetic quench here: zeroing velocity at the first equilibrium traps an
      // underconstrained sheet flat before it can buckle UP into shape (the RES tower stalled at
      // h/w≈0.2 with the quench vs ≈0.57 erected without it). Rigid-removal kills the un-pinned
      // mesh's global drift; the per-frame motion-freeze settles it once it stops moving.
      for (let i = 0; i < STEPS_PER_FRAME; i++) {
        this.foldPercent += (this.targetFold - this.foldPercent) * FREE_PER_STEP_EASE;
        this.cpu.foldPercent = this.foldPercent;
        this.cpu.step();
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

    // A detail change rebuilds just this layer — drop the previous tile mesh first.
    if (this.thickMesh) {
      this.group.remove(this.thickMesh);
      this.thickGeo?.dispose();
      (this.thickMesh.material as THREE.Material).dispose();
      this.thickMesh = null;
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
    this.buildJoints(net, diag); // TPU spherical joints pinning corner-meeting tiles (rotating-units pivots)
    this.updatePrintedTiles();
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
    return foldDepths(score, this.tileDetail + DETAIL_OFFSET); // level 0 → 1 subdivision (slider shift)
  }

  /** Set the fold-adaptive detail cap (shared with the export) and rebuild the printed tiles. */
  setTileDetail(cap: number): void {
    const v = Math.max(0, Math.floor(cap));
    if (v === this.tileDetail) return;
    this.tileDetail = v;
    if (this.material === "printed" && this.net) this.buildPrintedTiles(this.net);
  }

  /** Set the inter-tile gap (shrink-toward-centroid fraction, shared with the export) and rebuild. */
  setTileGap(frac: number): void {
    const v = Math.min(MAX_TILE_GAP, Math.max(MIN_TILE_GAP, frac));
    if (v === this.tileInset) return;
    this.tileInset = v;
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
          const ix = v[0] + (gx - v[0]) * this.tileInset;
          const iy = v[1] + (gy - v[1]) * this.tileInset;
          const iz = v[2] + (gz - v[2]) * this.tileInset;
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
    this.updateJoints();
  }

  /**
   * Find the SPHERICAL joints: corner points where ≥2 tiles meet but NO shared (2-face) fold edge
   * runs through them — i.e. rotating-units pivots. The solver net splits shared corners into
   * separate vertices, so we cluster by REST position to recover each physical pivot. Tiles that
   * share a fold edge are already joined by the continuous TPU backing, so those points are skipped;
   * cut ("C") edges carry no joint and stay open. One small TPU sphere per pivot ties the tiles.
   */
  private buildJoints(net: FoldNet, diag: number): void {
    this.disposeJoints();
    if (!this.fold) return;
    const rest = this.fold.model.rest;
    const q = 1e3; // ~1µm·(unit) snap so coincident split corners cluster together
    const keyOf = (v: number): string =>
      `${Math.round(rest[v * 3] * q)}_${Math.round(rest[v * 3 + 1] * q)}_${Math.round(rest[v * 3 + 2] * q)}`;
    // vertex → incident tiles
    const vFaces = new Map<number, Set<number>>();
    net.faces.forEach((f, fi) => f.forEach((v) => (vFaces.get(v) ?? vFaces.set(v, new Set()).get(v)!).add(fi)));
    // positions that sit on a shared (2-face) edge are handled by the continuous backing, not a sphere
    const edgeFaces = new Map<string, number>();
    net.faces.forEach((f) => {
      for (let k = 0; k < f.length; k++) {
        const u = f[k], w = f[(k + 1) % f.length], kk = u < w ? `${u}_${w}` : `${w}_${u}`;
        edgeFaces.set(kk, (edgeFaces.get(kk) ?? 0) + 1);
      }
    });
    const onSharedEdge = new Set<string>();
    for (const [kk, n] of edgeFaces) {
      if (n < 2) continue;
      const u = kk.indexOf("_");
      onSharedEdge.add(keyOf(Number(kk.slice(0, u))));
      onSharedEdge.add(keyOf(Number(kk.slice(u + 1))));
    }
    // cluster vertices by rest position; a pivot = a cluster touched by ≥2 tiles, off any shared edge
    const clusters = new Map<string, number[]>();
    for (let v = 0; v < net.vertices.length; v++) {
      const k = keyOf(v);
      (clusters.get(k) ?? clusters.set(k, []).get(k)!).push(v);
    }
    const pivots: number[][] = [];
    for (const [k, verts] of clusters) {
      if (onSharedEdge.has(k)) continue;
      const tiles = new Set<number>();
      for (const v of verts) for (const fi of vFaces.get(v) ?? []) tiles.add(fi);
      if (tiles.size >= 2) pivots.push(verts);
    }
    this.sphPivots = pivots;
    if (!pivots.length) return;
    const r = Math.max(diag * 0.01, 1e-4);
    this.jointGeo = new THREE.SphereGeometry(r, 12, 8);
    this.jointMat = new THREE.MeshStandardMaterial({ color: COLOR_HINGE, metalness: 0.0, roughness: 0.85 });
    this.jointMesh = new THREE.InstancedMesh(this.jointGeo, this.jointMat, pivots.length);
    this.jointMesh.visible = !this.circuitMode; // joints hide while the circuit editor is open
    this.group.add(this.jointMesh);
    this.updateJoints();
  }

  /** Move each spherical joint to the live centroid of its (split) pivot vertices. */
  private updateJoints(): void {
    if (!this.jointMesh || !this.sphPivots || !this.fold) return;
    const p = this.fold.model.position;
    const m = new THREE.Matrix4();
    this.sphPivots.forEach((verts, i) => {
      let x = 0, y = 0, z = 0;
      for (const v of verts) { x += p[v * 3]; y += p[v * 3 + 1]; z += p[v * 3 + 2]; }
      const n = verts.length;
      m.makeTranslation(x / n, y / n, z / n);
      this.jointMesh!.setMatrixAt(i, m);
    });
    this.jointMesh.instanceMatrix.needsUpdate = true;
  }

  private disposeJoints(): void {
    if (this.jointMesh) this.group.remove(this.jointMesh);
    this.jointGeo?.dispose();
    this.jointMat?.dispose();
    this.jointMesh = null;
    this.jointGeo = null;
    this.jointMat = null;
    this.sphPivots = null;
  }

  // --- Circuit overlay ------------------------------------------------------

  /** Enter/exit the circuit editor (flat 2D + tool interactions + snap grid). */
  setCircuitMode(on: boolean): void {
    this.circuitMode = on;
    if (this.jointMesh) this.jointMesh.visible = !on; // bare TPU while routing traces; joints return after
    if (this.gridLines) this.gridLines.visible = on;
    if (!on) { this.routeStart = null; this.routeGroup.clear(); this.held = null; this.ghostGroup.clear(); this.select(null); }
    this.setCircuitTool("select"); // start on the select cursor; clears any held part + sets the cursor
    this.setCircuit2D(on);
  }

  /** Flat 2D circuit view: orthographic top-down camera + flat even lighting (no perspective, no shading). */
  private setCircuit2D(on: boolean): void {
    this.ambient.intensity = on ? 1.0 : 0.65; // flat even fill vs the 3D shaded key/fill
    this.keyLight.visible = !on;
    this.fillLight.visible = !on;
    this.controls.enableRotate = !on; // 2D: pan + zoom only, locked top-down
    if (on) {
      const b = this.modelBounds();
      this.orthoRadius = Math.max(b.rx, b.ry) * 1.12 || 1;
      this.applyOrthoFrustum();
      this.orthoCamera.position.set(b.cx, b.cy, b.zMax + this.orthoRadius * 4 + 1); // straight above
      this.orthoCamera.near = 0.01;
      this.orthoCamera.far = this.orthoRadius * 12 + (b.zMax - b.zMin) + 100;
      this.orthoCamera.updateProjectionMatrix();
      this.orthoCamera.lookAt(b.cx, b.cy, b.cz);
      this.controls.target.set(b.cx, b.cy, b.cz);
      this.activeCamera = this.orthoCamera;
    } else {
      this.activeCamera = this.camera;
      this.controls.target.set(0, 0, (this.net?.meta.H ?? 0) * 0.2);
    }
    this.controls.object = this.activeCamera;
    this.controls.update();
  }

  /** xy/z extents + centre of the current folded mesh — frames the 2D ortho camera. */
  private modelBounds(): { cx: number; cy: number; cz: number; zMin: number; zMax: number; rx: number; ry: number } {
    const p = this.fold?.model.position;
    if (!p || p.length === 0) return { cx: 0, cy: 0, cz: 0, zMin: 0, zMax: 0, rx: 1, ry: 1 };
    let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity, zl = Infinity, zh = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      xl = Math.min(xl, p[i]); xh = Math.max(xh, p[i]);
      yl = Math.min(yl, p[i + 1]); yh = Math.max(yh, p[i + 1]);
      zl = Math.min(zl, p[i + 2]); zh = Math.max(zh, p[i + 2]);
    }
    return { cx: (xl + xh) / 2, cy: (yl + yh) / 2, cz: (zl + zh) / 2, zMin: zl, zMax: zh, rx: (xh - xl) / 2 || 1, ry: (yh - yl) / 2 || 1 };
  }

  private applyOrthoFrustum(): void {
    const size = new THREE.Vector2();
    this.renderer.getSize(size);
    const aspect = (size.x || 1) / (size.y || 1);
    const r = this.orthoRadius;
    this.orthoCamera.left = -r * aspect; this.orthoCamera.right = r * aspect;
    this.orthoCamera.top = r; this.orthoCamera.bottom = -r;
    this.orthoCamera.updateProjectionMatrix();
  }

  /** Set the active editor tool. A part kind enters cursor-attached PLACE mode; select/route cancel it. */
  setCircuitTool(tool: CircuitTool): void {
    this.tool = tool;
    this.routeStart = null;
    this.routeGroup.clear();
    this.held = isPartKind(tool) ? { mode: "place", kind: tool, rot: 0 } : null; // part rides the cursor
    if (!this.held) this.ghostGroup.clear();
    const style = (this.renderer.domElement as Partial<HTMLElement>).style;
    if (style) style.cursor = this.circuitMode ? (tool === "select" && !this.held ? "default" : "crosshair") : "";
  }

  /** Esc: drop whatever's on the cursor (cancel place/move), else cancel a route, else deselect → Select. */
  escapeTool(): void {
    if (this.held) {
      if (this.held.mode === "move") this.setComponentPos(this.held.id, this.held.orig.face, this.held.orig.bary, true);
      this.setCircuitTool("select");
      return;
    }
    if (this.routeStart) { this.routeStart = null; this.routeGroup.clear(); return; }
    if (this.selected) { this.select(null); return; }
    this.setCircuitTool("select");
  }

  /** Delete the selected part and any traces touching it (KiCad Del). */
  deleteSelected(): void {
    if (!this.selected) return;
    const id = this.selected;
    this.circuit = {
      components: this.circuit.components.filter((c) => c.id !== id),
      traces: this.circuit.traces.filter((t) => t.from.comp !== id && t.to.comp !== id),
    };
    this.select(null);
    this.commitCircuit();
  }

  /** Rotate whatever is active 45° (the held place-ghost, the part being moved, or the selection). */
  rotateSelected(): void {
    if (this.held?.mode === "place") { this.held.rot += Math.PI / 4; return; }
    const id = this.held?.mode === "move" ? this.held.id : this.selected;
    if (!id) return;
    this.circuit = {
      ...this.circuit,
      components: this.circuit.components.map((c) => (c.id === id ? { ...c, rot: c.rot + Math.PI / 4 } : c)),
    };
    this.commitCircuit();
  }

  /** M: pick the selected part up onto the cursor (KiCad click-move-click). */
  moveSelected(): void {
    if (this.held || !this.selected) return;
    const c = this.circuit.components.find((x) => x.id === this.selected);
    if (!c) return;
    this.held = { mode: "move", id: c.id, orig: { face: c.face, bary: c.bary } };
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
    this.select(null);
    this.routeStart = null;
    this.routeGroup.clear();
    this.commitCircuit();
  }

  /** Invisible indexed mesh of the folded faces — raycast target that maps a hit straight to a face. */
  private buildPickMesh(net: FoldNet): void {
    if (!net.vertices?.length || !net.faces?.length) return;
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

  private onPointerDown(e: PointerEvent): void {
    this.downPt = { x: e.clientX, y: e.clientY };
    if (this.circuitMode) this.snapshotGeo(); // pad + component positions for cheap hit-testing this gesture
  }

  /** Move: the held part (place ghost / live move) rides the cursor; routing rubber-bands to the cursor. */
  private onPointerMove(e: PointerEvent): void {
    if (!this.circuitMode) return;
    if (this.held) {
      const at = this.snappedPlacement(e);
      if (this.held.mode === "place") this.showGhost(this.held.kind, this.held.rot, at);
      else if (at) this.setComponentPos(this.held.id, at.face, at.bary);
      return;
    }
    if (this.tool === "route" && this.routeStart) {
      const target = this.nearestPad(e.clientX, e.clientY);
      const to = target && !samePad(target, this.routeStart) ? target.world : this.surfacePoint(e);
      this.routeGroup.clear();
      if (to) {
        const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...this.routeStart.world), new THREE.Vector3(...to)]);
        this.routeGroup.add(new THREE.Line(g, ROUTE_PREVIEW_MAT));
      }
    }
  }

  /** Click: drop the held part (place repeats / move ends), advance a route, or select — by active tool. */
  private onPointerUp(e: PointerEvent): void {
    const down = this.downPt; this.downPt = null;
    if (!down || !this.circuitMode) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return; // a drag (pan/zoom), not a click

    if (this.held) {
      const at = this.snappedPlacement(e);
      if (this.held.mode === "place") {
        if (at) this.placeComponent(at.face, at.bary, this.held.kind, this.held.rot); // drop; ghost continues
      } else { // a move: commit where it now sits, back to the select tool
        if (at) this.setComponentPos(this.held.id, at.face, at.bary);
        this.commitCircuit();
        this.setCircuitTool("select");
      }
      return;
    }
    if (this.tool === "route") {
      const pad = this.nearestPad(e.clientX, e.clientY);
      if (!pad) return;
      if (!this.routeStart) this.routeStart = pad; // first click: start pad
      else if (!samePad(pad, this.routeStart)) { this.addTrace(this.routeStart, pad); this.routeStart = null; this.routeGroup.clear(); }
      return;
    }
    // Select tool: click a part to select it (M then picks it up to move).
    this.select(this.nearestComp(e.clientX, e.clientY)?.id ?? null);
  }

  /** Raycast the folded faces at the pointer → { face, point }, or null. */
  private pickFace(e: PointerEvent): { face: number; point: THREE.Vector3 } | null {
    if (!this.pickMesh) return null;
    const ray = this.rayAt(e);
    const hit = ray.intersectObject(this.pickMesh, false)[0];
    return hit && hit.faceIndex != null ? { face: hit.faceIndex, point: hit.point } : null;
  }

  /** Surface point under the pointer (on the folded mesh), or null when the ray misses. */
  private surfacePoint(e: PointerEvent): [number, number, number] | null {
    const hit = this.pickMesh ? this.rayAt(e).intersectObject(this.pickMesh, false)[0] : null;
    return hit ? [hit.point.x, hit.point.y, hit.point.z] : null;
  }

  private rayAt(e: PointerEvent): THREE.Raycaster {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.activeCamera);
    return ray;
  }

  /** Snapshot pad + component world positions once per gesture so hit-testing on move/up stays cheap. */
  private snapshotGeo(): void {
    if (!this.net || !this.fold || this.circuit.components.length === 0) { this.padCache = []; this.compCache = []; return; }
    const pos = this.fold.model.position;
    const geo = resolveCircuit(this.circuit, this.net, (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    this.padCache = geo.components.flatMap((c) => c.pads.map((world, pad) => ({ comp: c.id, pad, world })));
    this.compCache = geo.components.map((c) => ({ id: c.id, world: c.center }));
  }

  /** The pad nearest the cursor within the grab radius (screen-space), or null. */
  private nearestPad(cx: number, cy: number): { comp: string; pad: number; world: [number, number, number] } | null {
    let best: { comp: string; pad: number; world: [number, number, number] } | null = null;
    let bestD = PAD_PICK_PX2;
    for (const e of this.padCache) {
      const d = this.screenDist2(e.world, cx, cy);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  /** The component centre nearest the cursor (screen-space), or null — for select/move. */
  private nearestComp(cx: number, cy: number): { id: string; world: [number, number, number] } | null {
    let best: { id: string; world: [number, number, number] } | null = null;
    let bestD = COMP_PICK_PX2;
    for (const e of this.compCache) {
      const d = this.screenDist2(e.world, cx, cy);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  private screenDist2(world: [number, number, number], cx: number, cy: number): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(world[0], world[1], world[2]).project(this.activeCamera);
    const sx = (v.x * 0.5 + 0.5) * rect.width + rect.left;
    const sy = (-v.y * 0.5 + 0.5) * rect.height + rect.top;
    return (sx - cx) ** 2 + (sy - cy) ** 2;
  }

  private select(id: string | null): void {
    if (this.selected === id) return;
    this.selected = id;
    this.updateCircuitOverlay();
  }

  private addTrace(from: { comp: string; pad: number }, to: { comp: string; pad: number }): void {
    this.circuit = {
      ...this.circuit,
      traces: [...this.circuit.traces, { id: `t${++this.circuitId}`, from: { ...from }, to: { ...to } }],
    };
    this.commitCircuit();
  }

  /** Drop a new part of `kind`/`rot` at a grid-snapped {face,bary}; the place tool stays active. */
  private placeComponent(face: number, bary: [number, number, number], kind: ComponentKind, rot: number): void {
    const id = `c${++this.circuitId}`;
    this.circuit = { ...this.circuit, components: [...this.circuit.components, { id, kind, face, bary, rot }] };
    this.commitCircuit();
  }

  /** Re-pin a part to {face,bary}. Live moves only redraw; `commit` does the full notify. */
  private setComponentPos(id: string, face: number, bary: [number, number, number], commit = false): void {
    this.circuit = {
      ...this.circuit,
      components: this.circuit.components.map((c) => (c.id === id ? { ...c, face, bary } : c)),
    };
    if (commit) this.commitCircuit();
    else this.updateCircuitOverlay();
  }

  /**
   * Map the pointer to a grid-snapped {face, bary}: raycast the surface, convert to the FLAT pattern,
   * snap to the grid, then re-locate the containing face. Fold-independent (snap happens in flat space).
   */
  private snappedPlacement(e: PointerEvent): { face: number; bary: [number, number, number] } | null {
    const hit = this.pickFace(e);
    if (!hit || !this.net || !this.fold) return null;
    const f = this.net.faces[hit.face];
    const b = baryAt(hit.point, this.fold.model.position, f);
    const v = this.net.vertices;
    const fx = b[0] * v[f[0]].x + b[1] * v[f[1]].x + b[2] * v[f[2]].x;
    const fy = b[0] * v[f[0]].y + b[1] * v[f[1]].y + b[2] * v[f[2]].y;
    const sx = Math.round(fx / this.gridStep) * this.gridStep, sy = Math.round(fy / this.gridStep) * this.gridStep;
    return locateFlat(sx, sy, this.net);
  }

  /** Draw the translucent part attached to the cursor (place mode), or clear it when there's no target. */
  private showGhost(kind: ComponentKind, rot: number, at: { face: number; bary: [number, number, number] } | null): void {
    this.ghostGroup.clear();
    if (!at || !this.net || !this.fold) return;
    const pos = this.fold.model.position;
    const geo = resolveCircuit(
      { components: [{ id: "ghost", kind, face: at.face, bary: at.bary, rot }], traces: [] },
      this.net, (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]],
    );
    const c = geo.components[0];
    if (!c) return;
    const mount = this.tileT || 0.02 * geo.scale, padH = 0.012 * geo.scale;
    const basis = new THREE.Matrix4().makeBasis(new THREE.Vector3(...c.x), new THREE.Vector3(...c.y), new THREE.Vector3(...c.n));
    for (const p of c.pads) {
      const pad = box(c.padLen, c.padWid, padH, GHOST_MAT);
      const m = basis.clone();
      m.setPosition(p[0] + c.n[0] * mount, p[1] + c.n[1] * mount, p[2] + c.n[2] * mount);
      pad.applyMatrix4(m);
      this.ghostGroup.add(pad);
    }
  }

  /** Build the snap grid (lines in the flat xy plane, sized to the pattern) — shown only in circuit mode. */
  private buildGrid(net: FoldNet): void {
    if (!net.vertices?.length) return;
    let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
    for (const v of net.vertices) { xl = Math.min(xl, v.x); xh = Math.max(xh, v.x); yl = Math.min(yl, v.y); yh = Math.max(yh, v.y); }
    this.gridStep = (Math.max(xh - xl, yh - yl) || 1) / GRID_CELLS;
    const pts: number[] = [];
    const x0 = Math.floor(xl / this.gridStep) * this.gridStep, x1 = Math.ceil(xh / this.gridStep) * this.gridStep;
    const y0 = Math.floor(yl / this.gridStep) * this.gridStep, y1 = Math.ceil(yh / this.gridStep) * this.gridStep;
    for (let x = x0; x <= x1 + 1e-6; x += this.gridStep) pts.push(x, y0, 0, x, y1, 0);
    for (let y = y0; y <= y1 + 1e-6; y += this.gridStep) pts.push(x0, y, 0, x1, y, 0);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pts), 3));
    this.gridLines = new THREE.LineSegments(g, GRID_MAT);
    this.gridLines.visible = this.circuitMode;
    this.group.add(this.gridLines);
  }

  /** Persist a circuit edit: notify and redraw the overlay. */
  private commitCircuit(): void {
    this.circuitListener?.(this.circuit);
    this.updateCircuitOverlay();
  }

  /**
   * Rebuild the circuit overlay at the current fold: proper SMD footprints (copper pads + body + a
   * kind-specific marker) mounted on the rigid tile tops, plus FULL-WIDTH copper trace ribbons that
   * thread the bare-cloth gaps between the tiles. The ribbons are depth-tested, so the raised tiles
   * occlude them — they read as conductors running on the fabric in the spaces between the triangles.
   */
  private updateCircuitOverlay(): void {
    this.circuitGroup.clear();
    if (!this.net || !this.fold || this.circuit.components.length === 0) return;
    const pos = this.fold.model.position;
    const geo = resolveCircuit(this.circuit, this.net, (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]]);
    // Footprints mount on the tile's top face (one tile thickness off the cloth) so they're never
    // buried; the traces drop off each pad down into the bare-cloth gaps.
    const mount = this.tileT || 0.02 * geo.scale;
    const padH = 0.012 * geo.scale;
    for (const c of geo.components) this.addComponent(c, mount, padH, c.id === this.selected);
    const halfW = (TRACE_W * geo.scale) / 2;
    // Lay the WHOLE ribbon low (well below the tile tops at +mount): depth-tested, the raised gray
    // tiles then occlude it everywhere a tile sits above, so it only ever shows in the bare-cloth
    // gaps. A uniform low height (not lifted to the pads) keeps it off the gray near the pads too.
    const lift = 0.15 * mount;
    for (const t of geo.traces) {
      const ribbon = buildTraceRibbon(t, halfW, lift, lift);
      if (ribbon) this.circuitGroup.add(new THREE.Mesh(ribbon, TRACE_MAT));
    }
  }

  /** Add one SMD part as JUST its two copper pads (no body/marker), flat on the tile top; gold if selected. */
  private addComponent(c: ComponentGeom, mount: number, padH: number, selected: boolean): void {
    const basis = new THREE.Matrix4().makeBasis(
      new THREE.Vector3(...c.x), new THREE.Vector3(...c.y), new THREE.Vector3(...c.n),
    );
    const mat = selected ? SELECT_MAT : PAD_MAT;
    for (const p of c.pads) {
      const pad = box(c.padLen, c.padWid, selected ? padH * 1.4 : padH, mat);
      const m = basis.clone();
      m.setPosition(p[0] + c.n[0] * mount, p[1] + c.n[1] * mount, p[2] + c.n[2] * mount);
      pad.applyMatrix4(m);
      this.circuitGroup.add(pad);
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
    this.renderer.render(this.scene, this.activeCamera);
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
    this.disposeJoints();
    this.tileFaces = null;
    this.tileBary = null;
    this.circuitGroup.clear();
    this.routeGroup.clear();
    this.ghostGroup.clear();
    this.gridLines = null; // group.clear() removed it from the scene graph
    this.routeStart = null;
    this.held = null;
    this.selected = null;
    this.padCache = [];
    this.compCache = [];
    this.pickMesh = null;
    this.pickPos = null;
    this.cpu = null;
    this.faceMat = null;
    this.creaseLines = [];
    this.shellCapable = false;
    this.shellDisplayed = false;
  }
}

const samePad = (a: { comp: string; pad: number }, b: { comp: string; pad: number }): boolean =>
  a.comp === b.comp && a.pad === b.pad;

const isPartKind = (t: CircuitTool): t is ComponentKind => t !== "select" && t !== "route";

/** An oriented box whose base sits at local z=0 (so `place(...)` stacks it on top of the surface). */
function box(lx: number, ly: number, lz: number, mat: THREE.Material): THREE.Mesh {
  const g = new THREE.BoxGeometry(lx, ly, lz);
  g.translate(0, 0, lz / 2);
  return new THREE.Mesh(g, mat);
}

/**
 * Build a full-width copper ribbon along a routed trace: each path point is offset ±`halfW`
 * perpendicular to the path within the local tangent plane (so the strip lies flat on the surface and
 * rides the fold). Endpoints lift to the pad height (`endLift`); interior points hug the cloth
 * (`midLift`), so the conductor ramps off the tile-top pads down into the gaps it threads.
 */
function buildTraceRibbon(t: TraceGeom, halfW: number, endLift: number, midLift: number): THREE.BufferGeometry | null {
  const pts = t.path, nrm = t.normals, last = pts.length - 1;
  if (last < 1) return null;
  const L: THREE.Vector3[] = [], R: THREE.Vector3[] = [];
  for (let i = 0; i <= last; i++) {
    const p = new THREE.Vector3(pts[i][0], pts[i][1], pts[i][2]);
    const n = new THREE.Vector3(nrm[i][0], nrm[i][1], nrm[i][2]);
    if (n.lengthSq() < 1e-12) n.set(0, 0, 1); else n.normalize();
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(last, i + 1)];
    const tan = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (tan.lengthSq() < 1e-14) tan.set(1, 0, 0);
    const side = new THREE.Vector3().crossVectors(n, tan);
    if (side.lengthSq() < 1e-14) { // tangent ∥ normal: any perpendicular will do
      side.crossVectors(n, new THREE.Vector3(1, 0, 0));
      if (side.lengthSq() < 1e-14) side.crossVectors(n, new THREE.Vector3(0, 1, 0));
    }
    side.normalize().multiplyScalar(halfW);
    const base = p.addScaledVector(n, i === 0 || i === last ? endLift : midLift);
    L.push(base.clone().add(side));
    R.push(base.clone().sub(side));
  }
  const verts: number[] = [];
  const push = (v: THREE.Vector3): void => { verts.push(v.x, v.y, v.z); };
  for (let i = 0; i < last; i++) {
    push(L[i]); push(R[i]); push(R[i + 1]);
    push(L[i]); push(R[i + 1]); push(L[i + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.computeVertexNormals();
  return g;
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
