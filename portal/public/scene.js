// Fig. 1: the cluster as a launch complex, drawn with three.js.
// The octagonal deck is the k3d node, every tenant app is a tower on its own pad
// (square = static site, round = Node API), ground systems sit at the rim.
// A launching app rises out of the deck as its five launch steps complete.

import * as THREE from "./vendor/three.module.min.js";

const C = {
  deck: 0xdde2f7, deckTop: 0xeceefa, pad: 0xc6ccef, ink: 0x1d2bb8, paper: 0xffffff,
  orange: 0xc8f53a, go: 0x0f9d6b, hold: 0xe8a20c, scrub: 0xe8344e, idle: 0x8a90c8,
};
const STATUS_COLOR = { go: C.go, hold: C.hold, scrub: C.scrub, launch: C.orange, idle: C.idle };

export function statusOf(item) {
  if (item.steps) return item.status === "failed" ? "scrub" : item.status === "done" ? "go" : "launch";
  if (item.health === "Healthy") return "go";
  if (item.health === "Progressing") return "hold";
  if (item.health === "Degraded" || item.health === "Missing") return "scrub";
  return "idle";
}

function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }

export function createScene(canvas, labelsEl, { onPick = () => {}, reducedMotion = false } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch {
    return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.localClippingEnabled = true;
  // towers rise out of the deck: everything below deck level is cut away
  const deckClip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.17)];

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 200);
  const view = { azimuth: Math.PI * 0.27, elevation: 0.58, radius: 40, velocity: 0, zoom: 1 };

  // ---------------------------------------------------------------- light
  scene.add(new THREE.HemisphereLight(0xf4f6ff, 0xa9b0dc, 1.35));
  const sun = new THREE.DirectionalLight(0xffffff, 1.9);
  sun.position.set(9, 16, 5);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -13, right: 13, top: 13, bottom: -13, near: 1, far: 50 });
  sun.shadow.bias = -0.0008;
  scene.add(sun);

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0.02, ...extra });
  const inkLine = new THREE.LineBasicMaterial({ color: C.ink });
  const towerLine = new THREE.LineBasicMaterial({ color: C.ink, clippingPlanes: deckClip });
  const cmat = (color) => mat(color, { clippingPlanes: deckClip });

  // ---------------------------------------------------------------- the deck (k3d node)
  const deck = new THREE.Group();
  scene.add(deck);
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(9.2, 9.7, 0.9, 8), mat(C.deck));
  slab.rotation.y = Math.PI / 8;
  slab.position.y = -0.45;
  slab.receiveShadow = true;
  slab.castShadow = true;
  deck.add(slab);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(8.7, 8.7, 0.08, 8), mat(C.deckTop));
  top.rotation.y = Math.PI / 8;
  top.position.y = 0.04;
  top.receiveShadow = true;
  deck.add(top);
  const slabEdges = new THREE.LineSegments(new THREE.EdgesGeometry(slab.geometry), inkLine);
  slabEdges.rotation.copy(slab.rotation);
  slabEdges.position.copy(slab.position);
  deck.add(slabEdges);

  // hazard stripes around the rim
  const stripeGeo = new THREE.BoxGeometry(0.62, 0.05, 0.34);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    const r = 8.25 / Math.cos(((a + Math.PI / 8) % (Math.PI / 4)) - Math.PI / 8); // follow the octagon
    const s = new THREE.Mesh(stripeGeo, mat(i % 2 ? C.ink : C.orange));
    s.position.set(Math.cos(a) * r * 0.985, 0.1, Math.sin(a) * r * 0.985);
    s.rotation.y = -a + Math.PI / 2;
    s.receiveShadow = true;
    deck.add(s);
  }
  // painted grid on the deck
  const grid = new THREE.GridHelper(14, 14, C.ink, C.ink);
  grid.material.transparent = true;
  grid.material.opacity = 0.09;
  grid.position.y = 0.085;
  deck.add(grid);

  // ---------------------------------------------------------------- towers
  const towers = new Map(); // name -> record
  const pickables = [];

  function makeTower(name, kind, platform = false) {
    const g = new THREE.Group();
    const rec = { name, g, kind, platform, height: 1, target: 1, rise: 1, status: "idle", dying: false };
    if (platform) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.7, 0.8), mat(0x24308f));
      body.position.y = 0.35;
      body.castShadow = true;
      g.add(body);
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 8), new THREE.MeshBasicMaterial({ color: C.go }));
      lamp.position.set(0.42, 0.8, 0);
      g.add(lamp);
      Object.assign(rec, { body, lamp, height: 0.7 });
      return rec;
    }
    const h = 2.4 + (hash(name) % 4) * 0.55;
    rec.height = h;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.16, 2.3), mat(C.pad));
    pad.position.y = 0.08;
    pad.receiveShadow = true;
    g.add(pad);
    for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.04, 0.08), mat(C.orange));
      mark.position.set(x * 0.98, 0.18, z * 1.1);
      g.add(mark);
    }
    const lift = new THREE.Group(); // everything that rises out of the deck
    g.add(lift);
    const geo = kind === "node-api" ? new THREE.CylinderGeometry(0.62, 0.62, h, 24) : new THREE.BoxGeometry(1.15, h, 1.15);
    const body = new THREE.Mesh(geo, cmat(C.paper));
    body.position.y = h / 2 + 0.16;
    body.castShadow = true;
    body.receiveShadow = true;
    body.userData.name = name;
    lift.add(body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), towerLine);
    edges.position.copy(body.position);
    lift.add(edges);
    // band near the top, in the status colour
    const bandGeo = kind === "node-api" ? new THREE.CylinderGeometry(0.635, 0.635, 0.22, 24) : new THREE.BoxGeometry(1.17, 0.22, 1.17);
    const band = new THREE.Mesh(bandGeo, cmat(C.go));
    band.position.y = h - 0.15 + 0.16;
    lift.add(band);
    // launch gantry: two posts with cross bars
    const gantry = new THREE.Group();
    for (const z of [-0.45, 0.45]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, h + 0.5, 0.09), mat(C.ink));
      post.position.set(-0.95, (h + 0.5) / 2 + 0.16, z);
      post.castShadow = true;
      gantry.add(post);
    }
    for (let y = 0.6; y < h + 0.4; y += 0.55) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.96), mat(C.ink));
      bar.position.set(-0.95, y, 0);
      gantry.add(bar);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.05), mat(C.ink));
      arm.position.set(-0.72, y, 0);
      if (Math.round(y / 0.55) % 2) gantry.add(arm);
    }
    gantry.traverse((o) => { if (o.material) o.material.clippingPlanes = deckClip; });
    lift.add(gantry);
    // beacon + halo
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), new THREE.MeshBasicMaterial({ color: C.go, clippingPlanes: deckClip }));
    beacon.position.y = h + 0.42;
    lift.add(beacon);
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.42, 32), new THREE.MeshBasicMaterial({ color: C.go, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false, clippingPlanes: deckClip }));
    halo.position.y = h + 0.42;
    lift.add(halo);
    // launch beam
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.95, 14, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: C.orange, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
    beam.position.y = 7;
    g.add(beam);
    Object.assign(rec, { body, band, beacon, halo, beam, lift });
    pickables.push(body);
    return rec;
  }

  function setStatus(rec, status) {
    rec.status = status;
    const col = STATUS_COLOR[status];
    if (rec.platform) { rec.lamp.material.color.setHex(col); return; }
    rec.beacon.material.color.setHex(col);
    rec.halo.material.color.setHex(col);
    rec.band.material.color.setHex(col);
  }

  function slots(n) {
    // tenant pads on a ring (and an inner ring when crowded)
    const out = [];
    const outer = Math.min(n, 7);
    for (let i = 0; i < outer; i++) {
      const a = (i / outer) * Math.PI * 2 + Math.PI / 4;
      out.push([Math.cos(a) * (n === 1 ? 0 : 4.6), Math.sin(a) * (n === 1 ? 0 : 4.6)]);
    }
    for (let i = 0; i < n - outer; i++) {
      const a = (i / Math.max(n - outer, 1)) * Math.PI * 2;
      out.push([Math.cos(a) * 1.7, Math.sin(a) * 1.7]);
    }
    return out;
  }

  // ---------------------------------------------------------------- labels
  const labels = new Map();
  function label(name) {
    if (!labels.has(name)) {
      const el = document.createElement("span");
      el.className = "tag3d";
      el.innerHTML = `<i></i>${name.replace(/[&<>"']/g, "")}`;
      labelsEl.appendChild(el);
      labels.set(name, el);
    }
    return labels.get(name);
  }

  // ---------------------------------------------------------------- data in
  function update(apps = [], jobs = [], platform = []) {
    const running = jobs.filter((j) => j.status === "running" || (j.status === "failed" && !apps.some((a) => a.name === j.name)));
    const tenants = [
      ...apps.filter((a) => !running.some((j) => j.name === a.name)).map((a) => ({ name: a.name, kind: a.template, status: statusOf(a), progress: 1 })),
      ...running.map((j) => ({ name: j.name, kind: j.template, status: statusOf(j), progress: j.steps.filter((s) => s.state === "done").length / j.steps.length })),
    ].sort((a, b) => a.name.localeCompare(b.name));

    const wanted = new Set(tenants.map((t) => t.name));
    const pos = slots(tenants.length);
    tenants.forEach((t, i) => {
      let rec = towers.get(t.name);
      if (!rec) {
        rec = makeTower(t.name, t.kind);
        rec.rise = t.progress < 1 ? 0 : 0.0001; // new towers grow out of the deck
        towers.set(t.name, rec);
        scene.add(rec.g);
      }
      rec.dying = false;
      rec.goal = new THREE.Vector3(pos[i][0], 0, pos[i][1]);
      if (!rec.placed) { rec.g.position.copy(rec.goal); rec.placed = true; }
      rec.target = t.status === "launch" ? 0.08 + 0.92 * t.progress : 1;
      setStatus(rec, t.status);
    });

    const ground = platform.map((p) => ({ name: p.name, status: statusOf(p) }));
    ground.forEach((p, i) => {
      const key = `sys:${p.name}`;
      let rec = towers.get(key);
      if (!rec) {
        rec = makeTower(p.name, "sys", true);
        towers.set(key, rec);
        scene.add(rec.g);
        const a = (i / ground.length) * Math.PI * 2 + Math.PI / 8 + 0.2;
        rec.g.position.set(Math.cos(a) * 7.15, 0.08, Math.sin(a) * 7.15);
        rec.g.rotation.y = -a;
        rec.placed = true;
      }
      wanted.add(key);
      setStatus(rec, p.status);
    });

    for (const [key, rec] of towers) {
      if (!wanted.has(key)) { rec.dying = true; rec.target = 0; }
    }
  }

  // ---------------------------------------------------------------- camera + interaction
  function layout() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    const aspect = w / h;
    const size = (aspect < 1 ? 12 / aspect : 8.9) / view.zoom; // the deck fills the frame
    camera.left = -size * aspect; camera.right = size * aspect;
    camera.top = size; camera.bottom = -size;
    camera.updateProjectionMatrix();
  }
  function placeCamera() {
    const { azimuth: az, elevation: el, radius: r } = view;
    camera.position.set(Math.cos(az) * Math.cos(el) * r, Math.sin(el) * r, Math.sin(az) * Math.cos(el) * r);
    camera.lookAt(0, 0.6, 0);
  }

  let drag = null, idleSince = performance.now();
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hover = null;

  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects(pickables, false)[0];
    return hit?.object.userData.name || null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, moved: 0, last: e.clientX, t: performance.now() };
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add("is-dragging");
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - drag.last;
      drag.moved += Math.abs(dx);
      view.azimuth += dx * 0.008;
      view.velocity = dx * 0.008;
      drag.last = e.clientX;
      idleSince = performance.now();
      return;
    }
    const name = pick(e);
    if (name !== hover) {
      if (hover) labels.get(hover)?.classList.remove("is-hot");
      hover = name;
      if (hover) labels.get(hover)?.classList.add("is-hot");
      canvas.style.cursor = hover ? "pointer" : "";
    }
  });
  canvas.addEventListener("pointerup", (e) => {
    canvas.classList.remove("is-dragging");
    if (drag && drag.moved < 5) { const name = pick(e); if (name) onPick(name); }
    drag = null;
  });
  canvas.addEventListener("pointerleave", () => { if (hover) labels.get(hover)?.classList.remove("is-hot"); hover = null; });

  // ---------------------------------------------------------------- loop
  let visible = true, raf = 0, last = performance.now();
  const tmp = new THREE.Vector3();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden) { last = now; return; }
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    if (!drag) {
      view.azimuth += view.velocity;
      view.velocity *= 0.92;
      if (!reducedMotion && now - idleSince > 2500) view.azimuth += dt * 0.07;
    }
    placeCamera();

    const t = now / 1000;
    for (const [key, rec] of towers) {
      rec.rise += (rec.target - rec.rise) * Math.min(1, dt * (rec.dying ? 3 : 2.2));
      if (rec.goal) rec.g.position.lerp(rec.goal, Math.min(1, dt * 3));
      if (rec.platform) {
        rec.g.scale.y = Math.max(rec.rise, 0.001);
        if (rec.status !== "go") rec.lamp.visible = Math.floor(t * 2) % 2 === 0;
      } else {
        rec.lift.position.y = -(1 - rec.rise) * (rec.height + 0.6);
        const launching = rec.status === "launch";
        rec.beam.material.opacity += ((launching ? 0.32 + Math.sin(t * 8) * 0.06 : 0) - rec.beam.material.opacity) * Math.min(1, dt * 4);
        const pulse = reducedMotion ? 1 : 1 + Math.sin(t * (rec.status === "go" ? 2 : 7)) * 0.25;
        rec.halo.scale.setScalar(pulse);
        rec.halo.lookAt(camera.position);
        rec.halo.material.opacity = rec.status === "go" ? 0.35 : 0.75;
      }
      if (rec.dying && rec.rise < 0.02) {
        scene.remove(rec.g);
        rec.g.traverse((o) => { o.geometry?.dispose(); });
        const i = pickables.indexOf(rec.body);
        if (i >= 0) pickables.splice(i, 1);
        towers.delete(key);
        labels.get(rec.name)?.remove();
        labels.delete(rec.name);
      }
    }

    renderer.render(scene, camera);

    // labels follow the beacons
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const [key, rec] of towers) {
      if (rec.platform) continue;
      const el = label(rec.name);
      tmp.set(0, rec.height + 0.75 + rec.lift.position.y, 0).add(rec.g.position).project(camera);
      el.style.left = `${((tmp.x + 1) / 2) * w}px`;
      el.style.top = `${((1 - tmp.y) / 2) * h - 12}px`;
      el.className = `tag3d ${rec.status}${hover === rec.name ? " is-hot" : ""}`;
      el.style.opacity = rec.rise < 0.05 ? "0" : "1";
    }
  }

  const ro = new ResizeObserver(layout);
  ro.observe(canvas);
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; });
  io.observe(canvas);
  layout();
  raf = requestAnimationFrame(frame);

  return {
    update,
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); renderer.dispose(); },
  };
}
