// 3D hero: the simulated network on a dot-matrix India (illustrative geography). PSP → switch → bank arcs carry payment
// particles coloured by each route's D3 score; the localizer's primary node pulses; status-check particles flood the
// switch in proportion to M2's switch checks/s; the Drunix ring flashes on every ledger event. Mapping in sceneLogic.ts.
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { useQs } from "../store";
import { TEXT } from "../text/claims";
import { HeatMap } from "./HeatMap";
import { BANKS, checkParticles, deriveVisual, INDIA, indiaDots, NODES, project, PSPS, SWITCH, type SceneVisual } from "./sceneLogic";

const PER_ROUTE = 9;
const CHECK_POOL = 220;
const NODE_IDS = [SWITCH, ...PSPS, ...BANKS];

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function arc(a: THREE.Vector3, b: THREE.Vector3): THREE.QuadraticBezierCurve3 {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.z += 0.8 + a.distanceTo(b) * 0.28;
  return new THREE.QuadraticBezierCurve3(a, mid, b);
}

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function NetworkScene() {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<Record<string, HTMLDivElement | null>>({});
  const [failed, setFailed] = useState(() => !webglAvailable());
  const tick = useQs((s) => s.ticks[s.ticks.length - 1]);
  const ts = useQs((s) => s.timeseries);
  const ledgerSource = useQs((s) => s.sources.ledger);
  const nLedger = useQs((s) => s.ledgerEvents.length);

  useEffect(() => {
    if (failed || !host.current) return;
    const el = host.current;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x060a14, 1);
    el.prepend(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060a14, 0.012);
    const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;                          // build in (x=lon, y=lat, z=up), lay flat
    scene.add(world);
    const glow = glowTexture();
    const disposables: { dispose(): void }[] = [glow];
    const track = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };

    // India: dark fill, glowing outline, dot matrix
    const outline = INDIA.map(project);
    const shape = new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(x, y)));
    const fill = new THREE.Mesh(track(new THREE.ShapeGeometry(shape)),
      track(new THREE.MeshBasicMaterial({ color: 0x0b1a33, transparent: true, opacity: 0.85 })));
    fill.position.z = -0.05;
    world.add(fill);
    const edge = new THREE.LineLoop(track(new THREE.BufferGeometry().setFromPoints(outline.map(([x, y]) => new THREE.Vector3(x, y, 0)))),
      track(new THREE.LineBasicMaterial({ color: 0x3fd0e0, transparent: true, opacity: 0.9 })));
    world.add(edge);
    const dots = indiaDots();
    const dotGeo = track(new THREE.BufferGeometry());
    dotGeo.setAttribute("position", new THREE.Float32BufferAttribute(dots.flatMap(([x, y]) => [x, y, 0]), 3));
    world.add(new THREE.Points(dotGeo, track(new THREE.PointsMaterial({ color: 0x2b6c8f, size: 0.13, transparent: true, opacity: 0.7 }))));

    // nodes
    const pos: Record<string, THREE.Vector3> = {};
    const nodeMats: Record<string, THREE.MeshBasicMaterial> = {};
    const halos: Record<string, THREE.Sprite> = {};
    const beacons: Record<string, THREE.Mesh> = {};
    for (const id of NODE_IDS) {
      const [x, y] = project(NODES[id].ll);
      pos[id] = new THREE.Vector3(x, y, 0.35);
      const r = id === SWITCH ? 0.6 : 0.36;
      const base = id === SWITCH ? 0xe8fbff : id.startsWith("P") ? 0x8fd8ff : 0xdfe8ff;
      nodeMats[id] = track(new THREE.MeshBasicMaterial({ color: base }));
      const m = new THREE.Mesh(track(new THREE.SphereGeometry(r, 24, 16)), nodeMats[id]);
      m.position.copy(pos[id]);
      world.add(m);
      const halo = new THREE.Sprite(track(new THREE.SpriteMaterial({ map: glow, color: 0x3fd0e0, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })));
      halo.position.copy(pos[id]);
      halo.scale.setScalar(id === SWITCH ? 3.4 : 2.2);
      world.add(halo);
      halos[id] = halo;
      const beacon = new THREE.Mesh(track(new THREE.CylinderGeometry(0.05, 0.05, 6, 8, 1, true)),
        track(new THREE.MeshBasicMaterial({ color: 0xff3a4c, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false })));
      beacon.rotation.x = Math.PI / 2;
      beacon.position.set(pos[id].x, pos[id].y, 3.3);
      world.add(beacon);
      beacons[id] = beacon;
    }

    // arcs: PSP -> switch, switch -> bank
    const curves: Record<string, THREE.QuadraticBezierCurve3> = {};
    const arcMats: Record<string, THREE.LineBasicMaterial> = {};
    for (const id of [...PSPS, ...BANKS]) {
      const c = id.startsWith("P") ? arc(pos[id], pos[SWITCH]) : arc(pos[SWITCH], pos[id]);
      curves[id] = c;
      arcMats[id] = track(new THREE.LineBasicMaterial({ color: 0x3fd0e0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending }));
      world.add(new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(c.getPoints(48))), arcMats[id]));
    }

    // payment particles: PER_ROUTE per route, PSP -> switch -> bank
    const nPay = PSPS.length * BANKS.length * PER_ROUTE;
    const payGeo = track(new THREE.BufferGeometry());
    const payPos = new Float32Array(nPay * 3);
    const payCol = new Float32Array(nPay * 3);
    payGeo.setAttribute("position", new THREE.BufferAttribute(payPos, 3));
    payGeo.setAttribute("color", new THREE.BufferAttribute(payCol, 3));
    const phase = Float32Array.from({ length: nPay }, () => Math.random());
    world.add(new THREE.Points(payGeo, track(new THREE.PointsMaterial({ size: 0.5, map: glow, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false }))));

    // status-check particles: PSP -> switch, count follows switch checks/s
    const chkGeo = track(new THREE.BufferGeometry());
    const chkPos = new Float32Array(CHECK_POOL * 3);
    chkGeo.setAttribute("position", new THREE.BufferAttribute(chkPos, 3));
    const chkPhase = Float32Array.from({ length: CHECK_POOL }, () => Math.random());
    const chkFrom = Array.from({ length: CHECK_POOL }, (_, i) => PSPS[i % PSPS.length]);
    const chkJitter = Float32Array.from({ length: CHECK_POOL * 2 }, () => (Math.random() - 0.5) * 0.9);
    world.add(new THREE.Points(chkGeo, track(new THREE.PointsMaterial({ size: 0.34, map: glow, color: 0xff8a3d, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false }))));

    // Drunix ledger ring above the switch, with four org nodes and a shock-wave on each ledger event
    const ringMat = track(new THREE.MeshBasicMaterial({ color: 0xff8a3d, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending }));
    const ring = new THREE.Mesh(track(new THREE.TorusGeometry(2.2, 0.035, 8, 96)), ringMat);
    ring.position.set(pos[SWITCH].x, pos[SWITCH].y, 2.2);
    world.add(ring);
    const orgs = new THREE.Group();
    orgs.position.copy(ring.position);
    for (let i = 0; i < 4; i++) {
      const o = new THREE.Mesh(track(new THREE.SphereGeometry(0.16, 12, 8)), track(new THREE.MeshBasicMaterial({ color: 0xffb27f })));
      o.position.set(Math.cos((i / 4) * Math.PI * 2) * 2.2, Math.sin((i / 4) * Math.PI * 2) * 2.2, 0);
      orgs.add(o);
    }
    world.add(orgs);
    const waveMat = track(new THREE.MeshBasicMaterial({ color: 0xffb27f, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    const wave = new THREE.Mesh(track(new THREE.RingGeometry(0.95, 1, 96)), waveMat);
    wave.position.copy(ring.position);
    world.add(wave);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.95, 0.55, 0.12);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const resize = () => {
      const w = el.clientWidth, h = el.clientHeight;
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let vis: SceneVisual = deriveVisual(undefined, undefined, 0);
    const read = () => {
      const st = useQs.getState();
      vis = deriveVisual(st.ticks[st.ticks.length - 1], st.timeseries?.switch_checks_per_s, st.ledgerEvents.length);
    };
    read();
    const unsub = useQs.subscribe(read);

    const tmp = new THREE.Vector3();
    const col = new THREE.Color();
    let lastLedger = vis.ledgerEvents;
    let waveT = 1;
    let raf = 0;
    let prev = performance.now();
    const t0 = prev;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - prev) / 1000);
      prev = now;
      const t = (now - t0) / 1000;
      const crit = vis.globalState === "CRITICAL";
      const sway = reduced ? 0 : Math.sin(t * 0.07) * 0.32;
      const shake = crit && !reduced ? 0.06 : 0;
      camera.position.set(Math.sin(sway) * 29 + (Math.random() - 0.5) * shake, 24 + (Math.random() - 0.5) * shake, Math.cos(sway) * 29 + 3.5);
      camera.lookAt(0, 0, 3.5);                               // world +z is south: keep Kanyakumari in frame
      bloom.strength = crit ? 1.25 : 0.95;

      // each arc takes the colour of the worst route that runs over it
      for (const id of [...PSPS, ...BANKS]) {
        const mine = vis.routes.filter((x) => x.psp === id || x.bank === id);
        const w = mine.reduce((a, b) => (b.score > a.score ? b : a), mine[0]);
        arcMats[id].color.setRGB(w.colour[0], w.colour[1], w.colour[2]);
        arcMats[id].opacity = 0.35 + 0.6 * w.score;
      }
      for (const id of NODE_IDS) {
        const hot = vis.hot.has(id);
        const pulse = hot ? 0.5 + 0.5 * Math.sin(t * 6) : 0;
        halos[id].material.color.set(hot ? 0xff3a4c : 0x3fd0e0);
        halos[id].scale.setScalar((id === SWITCH ? 3.4 : 2.2) * (1 + (hot ? 0.9 * pulse + 0.4 : 0)));
        (beacons[id].material as THREE.MeshBasicMaterial).opacity = hot ? 0.35 + 0.45 * pulse : 0;
        nodeMats[id].color.set(hot ? 0xff6a75 : id === SWITCH ? 0xe8fbff : id.startsWith("P") ? 0x8fd8ff : 0xdfe8ff);
      }

      // payment particles
      let k = 0;
      for (const r of vis.routes) {
        for (let i = 0; i < PER_ROUTE; i++, k++) {
          phase[k] = (phase[k] + dt * 0.22 * r.speed) % 1;
          const p = phase[k];
          (p < 0.5 ? curves[r.psp].getPoint(p * 2, tmp) : curves[r.bank].getPoint((p - 0.5) * 2, tmp));
          payPos.set([tmp.x, tmp.y, tmp.z], k * 3);
          payCol.set(r.colour, k * 3);
        }
      }
      payGeo.attributes.position.needsUpdate = true;
      payGeo.attributes.color.needsUpdate = true;

      // status-check particles
      const nChk = checkParticles(vis.checksPerS, CHECK_POOL);
      for (let i = 0; i < nChk; i++) {
        chkPhase[i] = (chkPhase[i] + dt * 0.55) % 1;
        curves[chkFrom[i]].getPoint(chkPhase[i], tmp);
        chkPos.set([tmp.x + chkJitter[2 * i] * (1 - chkPhase[i]), tmp.y + chkJitter[2 * i + 1] * (1 - chkPhase[i]), tmp.z], i * 3);
      }
      chkGeo.setDrawRange(0, nChk);
      chkGeo.attributes.position.needsUpdate = true;
      halos[SWITCH].material.color.set(vis.hot.has(SWITCH) || nChk > 60 ? 0xff8a3d : 0x3fd0e0);

      // ledger ring
      if (vis.ledgerEvents > lastLedger) { waveT = 0; lastLedger = vis.ledgerEvents; }
      waveT = Math.min(1, waveT + dt * 0.9);
      wave.scale.setScalar(1 + waveT * 3.2);
      waveMat.opacity = (1 - waveT) * 0.8;
      ringMat.opacity = 0.45 + (1 - waveT) * 0.5;
      orgs.rotation.z = reduced ? 0 : t * 0.25;
      ring.rotation.z = reduced ? 0 : -t * 0.1;
      col.setRGB(1, 0.54 + (1 - waveT) * 0.3, 0.24 + (1 - waveT) * 0.4);
      ringMat.color.copy(col);

      composer.render();

      // HTML labels follow their nodes
      const w = el.clientWidth, h = el.clientHeight;
      for (const id of NODE_IDS) {
        const lab = labels.current[id];
        if (!lab) continue;
        tmp.copy(pos[id]).applyMatrix4(world.matrixWorld).project(camera);
        lab.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`;
        lab.classList.toggle("hot", vis.hot.has(id));
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
      composer.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [failed]);

  if (failed) return <HeatMap />;
  const checks = ts?.switch_checks_per_s;
  const now = checks && checks.length ? checks[checks.length - 1] : null;
  const state = tick?.global_state ?? "IDLE";
  return (
    <section className="panel hero" aria-label="network view">
      <div className="scene" ref={host}>
        {NODE_IDS.map((id) => (
          <div key={id} className={`node-label ${id === SWITCH ? "switch" : id.startsWith("P") ? "psp" : "bank"}`}
            ref={(d) => { labels.current[id] = d; }}>
            <span>{NODES[id].label}</span>
          </div>
        ))}
        <div className="hud top-left">
          <h3>Network <span className="muted small">illustrative geography · {TEXT.simulationLabel}</span></h3>
          <div className="row">
            <span className={`pill ${state}`}>{state}</span>
            <span className="chip">verdict {tick?.localization.verdict ?? "—"}</span>
            {tick?.localization.primary_segment_id && <span className="chip hot">{tick.localization.primary_segment_id}</span>}
          </div>
        </div>
        <div className="hud bottom-left legend">
          <span><i className="dot calm" />payments, healthy</span>
          <span><i className="dot sick" />payments, degraded route</span>
          <span><i className="dot check" />status checks to the switch</span>
          <span><i className="dot ledger" />Drunix ledger event</span>
        </div>
        <div className="hud top-right stats">
          <div><span className="muted small">switch checks/s</span><b>{now == null ? "—" : Math.round(now)}</b></div>
          <div><span className="muted small">ledger events</span><b>{nLedger}</b><span className={`badge ${ledgerSource}`}>{ledgerSource}</span></div>
        </div>
      </div>
    </section>
  );
}
