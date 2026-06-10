/** Agent-D scratch diagnostics — DELETE BEFORE FINISHING. */
import { describe, it } from "vitest";
import { condition } from "../../../src/pipeline/conditioning.js";
import { angleDefects } from "../../../src/pipeline/curvature.js";
import { buildTopology, edgeKey } from "../../../src/pipeline/mesh.js";
import { planCuts } from "../../../src/pipeline/plan-cuts.js";
import { cutAlongEdges } from "../../../src/pipeline/unfold.js";
import type { TriMesh } from "../../../src/pipeline/types.js";
import { makeSaddleRoof, makeEnneper } from "./fixtures/targets.js";

/** Tiny face-connectivity labeling over shared undirected edge keys. */
function labelComponents(mesh: TriMesh): { count: number; label: number[] } {
  const edgeFaces = new Map<string, number[]>();
  for (let f = 0; f < mesh.faces.length; f++) {
    const [i, j, k] = mesh.faces[f];
    for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
      const key = edgeKey(a, b);
      (edgeFaces.get(key) ?? edgeFaces.set(key, []).get(key)!).push(f);
    }
  }
  const label = new Array<number>(mesh.faces.length).fill(-1);
  let count = 0;
  for (let seed = 0; seed < mesh.faces.length; seed++) {
    if (label[seed] !== -1) continue;
    const stack = [seed];
    label[seed] = count;
    while (stack.length) {
      const f = stack.pop()!;
      const [i, j, k] = mesh.faces[f];
      for (const [a, b] of [[i, j], [j, k], [k, i]] as [number, number][]) {
        for (const g of edgeFaces.get(edgeKey(a, b))!) {
          if (label[g] === -1) { label[g] = count; stack.push(g); }
        }
      }
    }
    count++;
  }
  return { count, label };
}

function battery(name: string, raw: TriMesh) {
  const { mesh } = condition(raw);
  const topo = buildTopology(mesh);
  const defects = angleDefects(mesh, topo);
  const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy: "dart" });

  console.log(`\n=== ${name} ===`);
  console.log(`V=${mesh.vertices.length} F=${mesh.faces.length} E=${topo.edges.length}`);
  console.log(`boundaryVertices: [${[...topo.boundaryVertices].sort((a, b) => a - b).join(",")}]`);
  console.log("defects:", defects.defects.map((d, v) => `${v}:${defects.classes[v][0]}${d.toFixed(3)}`).join(" "));

  // 2. The plan
  const deg = new Map<number, number>();
  let boundaryTouches = new Set<number>();
  console.log("cutEdges:");
  for (const e of plan.cutEdges) {
    const { a, b } = topo.edges[e];
    deg.set(a, (deg.get(a) ?? 0) + 1);
    deg.set(b, (deg.get(b) ?? 0) + 1);
    if (topo.boundaryVertices.has(a)) boundaryTouches.add(a);
    if (topo.boundaryVertices.has(b)) boundaryTouches.add(b);
    console.log(
      `  e${e}: ${a}(${defects.classes[a]}${topo.boundaryVertices.has(a) ? ",BND" : ""}) - ` +
      `${b}(${defects.classes[b]}${topo.boundaryVertices.has(b) ? ",BND" : ""})`,
    );
  }
  console.log("cut-graph degrees:", [...deg.entries()].sort((p, q) => p[0] - q[0]).map(([v, d]) => `${v}:${d}`).join(" "));
  console.log(`distinct boundary vertices touched by cut graph: ${boundaryTouches.size} -> [${[...boundaryTouches].join(",")}]`);

  // 3. Bare cut (no vents)
  const bare = cutAlongEdges(mesh, topo, plan.cutEdges);
  const comps = labelComponents(bare.mesh);
  console.log(`bare cut: V=${bare.mesh.vertices.length} F=${bare.mesh.faces.length} components=${comps.count}`);

  if (comps.count > 1) {
    // 4. smallest component + provenance
    const byComp = new Map<number, number[]>();
    comps.label.forEach((c, f) => (byComp.get(c) ?? byComp.set(c, []).get(c)!).push(f));
    const sorted = [...byComp.entries()].sort((p, q) => p[1].length - q[1].length);
    for (const [c, fs] of sorted) {
      const srcVerts = new Set<number>();
      for (const f of fs) for (const x of bare.mesh.faces[f]) srcVerts.add(bare.origVertex[x]);
      console.log(
        `  component ${c}: ${fs.length} faces ${JSON.stringify(fs.slice(0, 24))}` +
        ` srcVerts=[${[...srcVerts].sort((a, b) => a - b).join(",")}]`,
      );
    }
    // Per-source-vertex wedge copies for the cut-graph vertices (to see splits)
    const copiesOf = new Map<number, number[]>();
    bare.origVertex.forEach((src, vc) => (copiesOf.get(src) ?? copiesOf.set(src, []).get(src)!).push(vc));
    for (const v of [...deg.keys()].sort((a, b) => a - b)) {
      const copies = copiesOf.get(v) ?? [];
      const compOf = copies.map((vc) => {
        const cs = new Set<number>();
        bare.mesh.faces.forEach((f, fi) => { if (f.includes(vc)) cs.add(comps.label[fi]); });
        return `${vc}->{${[...cs].join(",")}}`;
      });
      console.log(`  src v${v} (deg ${deg.get(v)}${topo.boundaryVertices.has(v) ? ",BND" : ""}): copies ${compOf.join(" ")}`);
    }
  } else {
    // 5. vent trial replication
    console.log("bare cut is ONE component — testing vent at v6, angle 0.135");
    try {
      const vented = cutAlongEdges(mesh, topo, plan.cutEdges, new Map([[6, 0.135]]));
      const vc = labelComponents(vented.mesh);
      console.log(`vented(6, 0.135): F=${vented.mesh.faces.length} components=${vc.count}`);
    } catch (err) {
      console.log(`vented(6, 0.135) THREW: ${(err as Error).message}`);
    }
    // 5b. FULL vent map (what seamedUnfold actually passes)
    const ventAngles = new Map<number, number>();
    for (let v = 0; v < mesh.vertices.length; v++) {
      if (plan.perVertexAction[v] === "slit" && defects.defects[v] < 0) ventAngles.set(v, -defects.defects[v]);
    }
    console.log(`full vent map: ${[...ventAngles.entries()].map(([v, a]) => `${v}:${a.toFixed(3)}`).join(" ")}`);
    try {
      const vented = cutAlongEdges(mesh, topo, plan.cutEdges, ventAngles);
      const vc = labelComponents(vented.mesh);
      console.log(`vented(ALL): F=${vented.mesh.faces.length} components=${vc.count}`);
    } catch (err) {
      console.log(`vented(ALL) THREW: ${(err as Error).message}`);
    }
  }
}

describe("agent-d diagnostics", () => {
  it("saddle roof", () => battery("saddleRoof", makeSaddleRoof()));
  it("enneper", () => battery("enneper", makeEnneper()));

  it("kirigamize repro", async () => {
    const { kirigamize } = await import("../../../src/pipeline/kirigamize.js");
    for (const [name, mesh] of [["saddleRoof", makeSaddleRoof()], ["enneper", makeEnneper()]] as const) {
      try {
        const r = kirigamize(mesh, { verify: false });
        console.log(`${name}: kirigamize OK, reliefEdges=[${r.unfold.reliefEdges.join(",")}], vents=${r.unfold.vents.length}`);
      } catch (err) {
        console.log(`${name}: kirigamize THREW: ${(err as Error).message}`);
      }
    }
  }, 120_000);

  it("HEAD seamedUnfold repro (pre-fix code from git, dbg traces intercepted)", async () => {
    const head = await import("/tmp/unfold-head.ts");
    for (const [name, raw] of [["saddleRoof", makeSaddleRoof()], ["enneper", makeEnneper()]] as const) {
      const { mesh } = condition(raw);
      const topo = buildTopology(mesh);
      const defects = angleDefects(mesh, topo);
      const plan = planCuts(mesh, topo, defects, { lambda: 0, strategy: "dart" });
      const dbg: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => { dbg.push(args.join(" ")); };
      let outcome = "OK";
      try {
        head.seamedUnfold(mesh, topo, plan, defects);
      } catch (err) {
        outcome = `THREW: ${(err as Error).message}`;
      } finally {
        console.error = orig;
      }
      console.log(`\n### HEAD ${name}: ${outcome} (dbg lines: ${dbg.length})`);
      // last "pass" line and the LAST pre-vent line (the call that threw)
      const passLines = dbg.filter((l) => l.includes("pass "));
      console.log("pass lines:", passLines.slice(-3).join(" | "));
      const preVent = dbg.filter((l) => l.includes("pre-vent"));
      console.log("LAST pre-vent line:", preVent[preVent.length - 1]);
      console.log("last 8 dbg lines:");
      for (const l of dbg.slice(-8)) console.log("   ", l);
      // Extract the cutSet of the last (throwing) cutAlongEdges call and
      // measure its bare-cut component count with our own labeler.
      const m = preVent[preVent.length - 1]?.match(/cutSet=\[([0-9,]*)\]/);
      if (m) {
        const cutEdges = m[1] === "" ? [] : m[1].split(",").map(Number);
        const bare = cutAlongEdges(mesh, topo, cutEdges);
        const comps = labelComponents(bare.mesh);
        console.log(`bare-cut components of LAST cutSet [${cutEdges.join(",")}]: ${comps.count}`);
        if (comps.count > 1) {
          const byComp = new Map<number, number[]>();
          comps.label.forEach((c, f) => (byComp.get(c) ?? byComp.set(c, []).get(c)!).push(f));
          for (const [c, fs] of [...byComp.entries()].sort((p, q) => p[1].length - q[1].length)) {
            const srcVerts = new Set<number>();
            for (const f of fs) for (const x of bare.mesh.faces[f]) srcVerts.add(bare.origVertex[x]);
            console.log(`  comp ${c}: ${fs.length} faces, srcVerts=[${[...srcVerts].sort((a, b) => a - b).join(",")}]`);
          }
          // boundary contacts + degrees of the failing cut graph
          const deg = new Map<number, number>();
          const bnd = new Set<number>();
          for (const e of cutEdges) {
            const { a, b } = topo.edges[e];
            deg.set(a, (deg.get(a) ?? 0) + 1);
            deg.set(b, (deg.get(b) ?? 0) + 1);
            if (topo.boundaryVertices.has(a)) bnd.add(a);
            if (topo.boundaryVertices.has(b)) bnd.add(b);
          }
          console.log(`  cut graph: degrees ${[...deg.entries()].sort((p, q) => p[0] - q[0]).map(([v, d]) => `${v}:${d}`).join(" ")}`);
          console.log(`  boundary vertices touched: [${[...bnd].sort((a, b) => a - b).join(",")}]`);
        }
      }
    }
  }, 240_000);
});
