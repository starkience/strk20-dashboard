import { useEffect, useRef } from "react";
import * as THREE from "three";
import { CSS3DRenderer, CSS3DObject } from "three/examples/jsm/renderers/CSS3DRenderer.js";
import type { Receipt } from "../lib/receipt-feed.js";
import { formatTimestamp, shortHash } from "./receipt-format.js";

// ── Layout constants — tweak to taste. Sizes are in CSS3D "pixels" since
// CSS3DRenderer maps 1 three.js unit ≈ 1 CSS pixel when camera is set up
// with a PerspectiveCamera at world-distance == viewport height / (2 tan(fov/2)).
const ROWS = 4;
const COLS = 6;
const CARD_W = 240;
const CARD_H = 120;
const COL_GAP = 24;
const ROW_GAP = 28;

const PRINT_DURATION_MS = 700;
const DROP_DURATION_MS = 450;
const SHIFT_DURATION_MS = 520;
const CASCADE_DELAY_MS = 80; // small stagger so the wave reads top→bottom

// Easing helpers
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

interface SlotTarget {
  x: number;
  y: number;
  z: number;
  rotX: number;
  opacity: number;
}

interface ReceiptObject {
  receipt: Receipt;
  obj: CSS3DObject;
  el: HTMLDivElement;
  // current animated values
  cur: SlotTarget;
  // target (where it should end up this frame)
  tgt: SlotTarget;
  // tween state: animates cur→tgt over `dur` from `startMs`
  startMs: number;
  fromTgt: SlotTarget;
  dur: number;
  ease: (t: number) => number;
  // when arrived: row & column it lives in; -1/-1 means in-flight / leaving
  row: number;
  col: number;
}

function cloneTgt(s: SlotTarget): SlotTarget {
  return { x: s.x, y: s.y, z: s.z, rotX: s.rotX, opacity: s.opacity };
}

function slotPosition(row: number, col: number): SlotTarget {
  // Centre the grid horizontally; rows stack downward from a top baseline.
  const totalW = COLS * CARD_W + (COLS - 1) * COL_GAP;
  const totalH = ROWS * CARD_H + (ROWS - 1) * ROW_GAP;
  const x = -totalW / 2 + CARD_W / 2 + col * (CARD_W + COL_GAP);
  const y = totalH / 2 - CARD_H / 2 - row * (CARD_H + ROW_GAP);
  return { x, y, z: 0, rotX: 0, opacity: 1 };
}

function spawnPosition(): SlotTarget {
  // Above row 0, column 0 — where the "printer" feeds receipts from.
  const base = slotPosition(0, 0);
  return { ...base, y: base.y + CARD_H + 80, z: 60, rotX: -Math.PI / 2, opacity: 0 };
}

function buildReceiptEl(r: Receipt): HTMLDivElement {
  const el = document.createElement("div");
  el.className = "strk20-receipt";
  el.style.width = `${CARD_W}px`;
  el.style.height = `${CARD_H}px`;
  const sign = r.kind === "Deposit" ? "→" : "←";
  const amt = r.amount;
  const usd = r.amountUsd != null ? `$${r.amountUsd.toFixed(2)}` : "—";
  const peer = r.peer?.label ?? r.peer?.addressShort ?? (r.kind === "Deposit" ? "[private]" : "—");
  el.innerHTML = `
    <div class="receipt-head">
      <span class="kind kind-${r.kind.toLowerCase()}">${sign} ${r.kind}</span>
      <span class="ts">${formatTimestamp(r.timestampIso)}</span>
    </div>
    <div class="receipt-amt">
      <span class="num">${amt}</span>
      <span class="sym">${r.tokenSymbol}</span>
    </div>
    <div class="receipt-foot">
      <span class="hash">${shortHash(r.txHash)}</span>
      <span class="peer">${peer}</span>
      <span class="usd">${usd}</span>
    </div>
    <div class="receipt-tear"></div>
  `;
  return el;
}

interface SceneRefs {
  webgl: THREE.WebGLRenderer;
  css: CSS3DRenderer;
  scene3d: THREE.Scene;
  sceneCss: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  particles: THREE.Points;
  cssRoot: HTMLDivElement;
  glRoot: HTMLCanvasElement;
}

function makeScene(container: HTMLDivElement): SceneRefs {
  const w = container.clientWidth;
  const h = container.clientHeight;

  // WebGL backdrop — embers + soft fog.
  const scene3d = new THREE.Scene();
  scene3d.fog = new THREE.FogExp2(0x0c0a18, 0.00045);

  const fov = 45;
  const camera = new THREE.PerspectiveCamera(fov, w / h, 1, 5000);
  // place camera so that 1 unit ≈ 1 CSS px at the slot grid (z=0).
  const camZ = h / (2 * Math.tan((fov * Math.PI) / 360));
  camera.position.set(0, 0, camZ);

  const webgl = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  webgl.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  webgl.setSize(w, h);
  webgl.setClearColor(0x0c0a18, 1);
  webgl.domElement.style.position = "absolute";
  webgl.domElement.style.inset = "0";
  webgl.domElement.style.pointerEvents = "none";
  container.appendChild(webgl.domElement);

  // Embers — orange points drifting up.
  const PARTICLE_COUNT = 320;
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const seeds = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    positions[i * 3 + 0] = (Math.random() - 0.5) * w * 1.6;
    positions[i * 3 + 1] = (Math.random() - 0.5) * h * 1.4;
    positions[i * 3 + 2] = -200 - Math.random() * 600;
    seeds[i] = Math.random();
  }
  const pGeom = new THREE.BufferGeometry();
  pGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pGeom.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
  const pMat = new THREE.PointsMaterial({
    color: 0xff7a1a,
    size: 3.2,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(pGeom, pMat);
  scene3d.add(particles);

  // Subtle violet rim light (visual only — no shading needed since CSS3D is unlit).
  const rim = new THREE.PointLight(0x3a1f8a, 1.2, 1500);
  rim.position.set(-300, 200, 200);
  scene3d.add(rim);

  // CSS3D scene + renderer (overlay, transparent).
  const sceneCss = new THREE.Scene();
  const css = new CSS3DRenderer();
  css.setSize(w, h);
  css.domElement.style.position = "absolute";
  css.domElement.style.inset = "0";
  css.domElement.style.pointerEvents = "none";
  container.appendChild(css.domElement);

  return {
    webgl,
    css,
    scene3d,
    sceneCss,
    camera,
    particles,
    cssRoot: css.domElement as HTMLDivElement,
    glRoot: webgl.domElement,
  };
}

export interface ReceiptSceneHandle {
  /** Print a single new receipt with the full 3D animation + cascade. */
  enqueue: (r: Receipt) => void;
  /** Instantly fill the grid with up to ROWS*COLS receipts (newest first), no animation. */
  placeImmediate: (receipts: Receipt[]) => void;
}

interface Props {
  onMounted?: (h: ReceiptSceneHandle) => void;
}

export function ReceiptScene({ onMounted }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const refs = makeScene(container);
    const { webgl, css, scene3d, sceneCss, camera, particles } = refs;

    // grid[row][col] = ReceiptObject | null
    const grid: (ReceiptObject | null)[][] = Array.from({ length: ROWS }, () =>
      Array<ReceiptObject | null>(COLS).fill(null),
    );
    const inFlight: ReceiptObject[] = []; // currently animating outside the grid (printing or leaving)

    function addReceiptObject(r: Receipt): ReceiptObject {
      const el = buildReceiptEl(r);
      const obj = new CSS3DObject(el);
      const spawn = spawnPosition();
      obj.position.set(spawn.x, spawn.y, spawn.z);
      obj.rotation.x = spawn.rotX;
      el.style.opacity = String(spawn.opacity);
      sceneCss.add(obj);
      const cur = cloneTgt(spawn);
      const target = slotPosition(0, 0);
      return {
        receipt: r,
        obj,
        el,
        cur,
        tgt: target,
        fromTgt: cur,
        startMs: performance.now(),
        dur: PRINT_DURATION_MS,
        ease: easeOutCubic,
        row: -1,
        col: -1,
      };
    }

    function setTween(
      r: ReceiptObject,
      tgt: SlotTarget,
      dur: number,
      ease: (t: number) => number,
      delayMs = 0,
    ) {
      r.fromTgt = cloneTgt(r.cur);
      r.tgt = tgt;
      r.dur = dur;
      r.ease = ease;
      r.startMs = performance.now() + delayMs;
    }

    function tickTween(r: ReceiptObject, now: number) {
      const elapsed = now - r.startMs;
      if (elapsed < 0) return; // delayed
      const t = Math.min(1, elapsed / r.dur);
      const k = r.ease(t);
      r.cur.x = r.fromTgt.x + (r.tgt.x - r.fromTgt.x) * k;
      r.cur.y = r.fromTgt.y + (r.tgt.y - r.fromTgt.y) * k;
      r.cur.z = r.fromTgt.z + (r.tgt.z - r.fromTgt.z) * k;
      r.cur.rotX = r.fromTgt.rotX + (r.tgt.rotX - r.fromTgt.rotX) * k;
      r.cur.opacity =
        r.fromTgt.opacity + (r.tgt.opacity - r.fromTgt.opacity) * k;
      r.obj.position.set(r.cur.x, r.cur.y, r.cur.z);
      r.obj.rotation.x = r.cur.rotX;
      r.el.style.opacity = String(r.cur.opacity);
    }

    function dropFromGrid(r: ReceiptObject) {
      const leaveTgt: SlotTarget = {
        x: r.cur.x + 120,
        y: r.cur.y - 220,
        z: -200,
        rotX: 0,
        opacity: 0,
      };
      r.row = -1;
      r.col = -1;
      setTween(r, leaveTgt, 700, easeOutCubic);
      inFlight.push(r);
      // schedule removal after the leave tween finishes
      window.setTimeout(() => {
        sceneCss.remove(r.obj);
        const i = inFlight.indexOf(r);
        if (i >= 0) inFlight.splice(i, 1);
      }, 750);
    }

    function cascade() {
      // After a new receipt lands in (0,0), shift every row right by one and
      // bubble the rightmost cell of row N down to col 0 of row N+1. Anything
      // pushed off the last row leaves the scene.
      for (let row = 0; row < ROWS; row++) {
        const rowArr = grid[row]!;
        const overflow = rowArr[COLS - 1] ?? null;
        // shift right within the row
        for (let col = COLS - 1; col > 0; col--) {
          const item = rowArr[col - 1] ?? null;
          rowArr[col] = item;
          if (item) {
            item.col = col;
            setTween(item, slotPosition(row, col), SHIFT_DURATION_MS, easeOutCubic, row * CASCADE_DELAY_MS);
          }
        }
        // free col 0; if there's an overflow from this row, push it to the
        // next row's col 0. If we're on the last row, drop it off-scene.
        rowArr[0] = null;
        if (overflow) {
          if (row + 1 < ROWS) {
            const nextRow = grid[row + 1]!;
            overflow.row = row + 1;
            overflow.col = 0;
            nextRow[0] = overflow;
            setTween(
              overflow,
              slotPosition(row + 1, 0),
              SHIFT_DURATION_MS,
              easeOutCubic,
              (row + 1) * CASCADE_DELAY_MS,
            );
          } else {
            dropFromGrid(overflow);
          }
        }
      }
    }

    // Serialize prints — a new poll can surface many txs at once; running
    // them in parallel races on grid[0][0] and orphans receipts mid-print.
    const printQueue: Receipt[] = [];
    let printing = false;

    function runPrint(r: Receipt) {
      printing = true;
      // 1. cascade the grid first so col 0 is free when the new receipt drops in.
      cascade();
      // 2. spawn the new receipt above row 0, animate print → drop into (0,0).
      const ro = addReceiptObject(r);
      const printDone: SlotTarget = {
        x: slotPosition(0, 0).x,
        y: slotPosition(0, 0).y + CARD_H + 40,
        z: 40,
        rotX: 0,
        opacity: 1,
      };
      setTween(ro, printDone, PRINT_DURATION_MS, easeOutCubic);
      window.setTimeout(() => {
        ro.row = 0;
        ro.col = 0;
        grid[0]![0] = ro;
        setTween(ro, slotPosition(0, 0), DROP_DURATION_MS, easeOutBack);
      }, PRINT_DURATION_MS);
      // Release the lock after the drop animation completes (+ tiny breath).
      window.setTimeout(() => {
        printing = false;
        const next = printQueue.shift();
        if (next) runPrint(next);
      }, PRINT_DURATION_MS + DROP_DURATION_MS + 80);
    }

    function enqueue(r: Receipt) {
      if (printing) {
        printQueue.push(r);
        return;
      }
      runPrint(r);
    }

    function placeImmediate(receipts: Receipt[]) {
      // Wipe whatever's there (only meaningful if called twice; we only call
      // it once on mount, but keep it safe).
      for (let r = 0; r < ROWS; r++) {
        const rowArr = grid[r]!;
        for (let c = 0; c < COLS; c++) {
          const existing = rowArr[c];
          if (existing) sceneCss.remove(existing.obj);
          rowArr[c] = null;
        }
      }
      // Newest first → snake left-to-right, top-to-bottom, capped at the grid.
      const cap = ROWS * COLS;
      const slice = receipts.slice(0, cap);
      for (let i = 0; i < slice.length; i++) {
        const row = Math.floor(i / COLS);
        const col = i % COLS;
        const r = slice[i]!;
        const el = buildReceiptEl(r);
        const obj = new CSS3DObject(el);
        const pos = slotPosition(row, col);
        obj.position.set(pos.x, pos.y, pos.z);
        obj.rotation.x = 0;
        el.style.opacity = "1";
        sceneCss.add(obj);
        const ro: ReceiptObject = {
          receipt: r,
          obj,
          el,
          cur: cloneTgt(pos),
          tgt: cloneTgt(pos),
          fromTgt: cloneTgt(pos),
          startMs: performance.now(),
          dur: 1,
          ease: easeOutCubic,
          row,
          col,
        };
        grid[row]![col] = ro;
      }
    }

    // Expose API to React.
    onMounted?.({ enqueue, placeImmediate });

    // Capture a non-null alias so TS keeps the narrowing inside closures.
    const host: HTMLDivElement = container;

    // Resize handling.
    function onResize() {
      const w = host.clientWidth;
      const h = host.clientHeight;
      camera.aspect = w / h;
      const camZ = h / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.z = camZ;
      camera.updateProjectionMatrix();
      webgl.setSize(w, h);
      css.setSize(w, h);
    }
    const resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(host);

    // Animation loop.
    let raf = 0;
    const startMs = performance.now();
    function frame() {
      const now = performance.now();

      // Drift the embers upward and gently sideways.
      const pos = particles.geometry.getAttribute("position") as THREE.BufferAttribute;
      const seeds = particles.geometry.getAttribute("seed") as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      const seedArr = seeds.array as Float32Array;
      const elapsed = (now - startMs) / 1000;
      const screenH = host.clientHeight;
      const screenW = host.clientWidth;
      for (let i = 0; i < seedArr.length; i++) {
        const yi = i * 3 + 1;
        const xi = i * 3;
        const seed = seedArr[i] ?? 0;
        arr[yi] = (arr[yi] ?? 0) + 0.4 + seed * 0.5;
        arr[xi] = (arr[xi] ?? 0) + Math.sin(elapsed * 0.5 + seed * 6) * 0.1;
        if ((arr[yi] ?? 0) > screenH) {
          arr[yi] = -screenH / 2 - Math.random() * 100;
          arr[xi] = (Math.random() - 0.5) * screenW * 1.6;
        }
      }
      pos.needsUpdate = true;

      // Tick all known receipts.
      for (let r = 0; r < ROWS; r++) {
        const rowArr = grid[r]!;
        for (let c = 0; c < COLS; c++) {
          const item = rowArr[c];
          if (item) tickTween(item, now);
        }
      }
      for (const item of inFlight) tickTween(item, now);

      webgl.render(scene3d, camera);
      css.render(sceneCss, camera);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      resizeObs.disconnect();
      webgl.dispose();
      particles.geometry.dispose();
      (particles.material as THREE.Material).dispose();
      host.removeChild(webgl.domElement);
      host.removeChild(css.domElement);
    };
    // onMounted is intentionally not a dep — we only want to wire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={containerRef} data-strk20-scene />;
}
