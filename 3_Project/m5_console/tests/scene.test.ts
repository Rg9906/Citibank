import { describe, expect, it } from "vitest";
import { checkParticles, deriveVisual, hotNodes, indiaDots, INDIA, NODES, pointInPolygon, project, scoreColour } from "../src/panels/sceneLogic";
import type { SegmentState } from "../src/contracts";

describe("network scene mapping", () => {
  it("places every node inside the India outline", () => {
    const poly = INDIA.map(project);
    for (const [id, n] of Object.entries(NODES)) expect(pointInPolygon(project(n.ll), poly), id).toBe(true);
    expect(pointInPolygon(project([60, 10]), poly)).toBe(false);
  });

  it("fills the outline with a dot matrix", () => {
    const n = indiaDots().length;
    expect(n).toBeGreaterThan(800);
    expect(n).toBeLessThan(4000);
  });

  it("maps the localizer primary to nodes", () => {
    expect([...hotNodes("bank:*:B1")]).toEqual(["B1"]);
    expect([...hotNodes("psp:P3:*")]).toEqual(["P3"]);
    expect([...hotNodes("route:P1:B3")].sort()).toEqual(["B3", "P1"]);
    expect([...hotNodes("switch:*:*")]).toEqual(["SW"]);
    expect(hotNodes(null).size).toBe(0);
  });

  it("colours calm cyan and sick red, slows sick routes", () => {
    expect(scoreColour(0)[2]).toBeGreaterThan(0.8);
    expect(scoreColour(1)[0]).toBe(1);
    expect(scoreColour(1)[1]).toBeLessThan(0.3);
    const tick = {
      global_state: "WARNING", localization: { verdict: "BANK_SIDE", primary_segment_id: "bank:*:B1" },
      segments: [{ segment_id: "route:P1:B1", d3_score: 0.9 }, { segment_id: "route:P1:B2", d3_score: 0.05 }],
    } as unknown as SegmentState;
    const v = deriveVisual(tick, [1, 2, Number.NaN], 7);
    expect(v.routes).toHaveLength(15);
    const sick = v.routes.find((r) => r.id === "route:P1:B1")!;
    const calm = v.routes.find((r) => r.id === "route:P1:B2")!;
    expect(sick.speed).toBeLessThan(calm.speed);
    expect([...v.hot]).toEqual(["B1"]);
    expect(v.checksPerS).toBe(2);
    expect(v.ledgerEvents).toBe(7);
  });

  it("makes a status storm visibly denser than a governed run", () => {
    expect(checkParticles(null)).toBe(0);
    expect(checkParticles(0)).toBe(0);
    expect(checkParticles(372)).toBeGreaterThan(2 * checkParticles(38));
    expect(checkParticles(1e6)).toBe(220);
  });
});
