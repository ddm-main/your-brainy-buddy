// JARVIS 3D globe — the HUD centerpiece. Wireframe sphere + lat/long grid +
// particle halo, slow idle spin with cursor parallax. Adapted from the
// reference agentic-os globe, re-themed cyan and self-hosted (vendor/three).
import * as THREE from "./vendor/three.module.js";

const canvas = document.getElementById("globeCanvas");
if (canvas) initGlobe(canvas);

function initGlobe(canvas) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.z = 3.1;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const CYAN = new THREE.Color(0x35d6ed);
  const globe = new THREE.Group();
  scene.add(globe);

  // solid dark core so back-side lines are occluded
  globe.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.97, 48, 48),
    new THREE.MeshBasicMaterial({ color: 0x060a10 })
  ));

  // wireframe shell
  globe.add(new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 24, 16)),
    new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.22 })
  ));

  // emphasized latitude rings
  for (const lat of [-45, 0, 45]) {
    const r = Math.cos((lat * Math.PI) / 180), y = Math.sin((lat * Math.PI) / 180);
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
    }
    globe.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: lat === 0 ? 0.55 : 0.32 })
    ));
  }

  // surface point sprinkles
  const pts = [];
  for (let i = 0; i < 260; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    pts.push(Math.cos(a) * r * 1.005, u * 1.005, Math.sin(a) * r * 1.005);
  }
  globe.add(new THREE.Points(
    new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)),
    new THREE.PointsMaterial({ color: CYAN, size: 0.018, transparent: true, opacity: 0.8 })
  ));

  // outer halo ring (screen-facing)
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(1.28, 1.30, 96),
    new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.28, side: THREE.DoubleSide })
  );
  scene.add(halo);
  const halo2 = new THREE.Mesh(
    new THREE.RingGeometry(1.38, 1.385, 96),
    new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0.14, side: THREE.DoubleSide })
  );
  scene.add(halo2);

  globe.rotation.x = 0.35;

  // cursor parallax — globe leans gently toward the pointer
  let targetX = 0, targetY = 0;
  window.addEventListener("pointermove", (e) => {
    targetY = (e.clientX / window.innerWidth - 0.5) * 0.5;
    targetX = 0.35 + (e.clientY / window.innerHeight - 0.5) * 0.35;
  });

  function resize() {
    const size = canvas.clientWidth || 420;
    renderer.setSize(size, size, false);
  }
  window.addEventListener("resize", resize);
  resize();

  // voice reactivity — the core physically responds to conversation state
  let voiceMode = "idle";
  window.addEventListener("voice:state", (e) => { voiceMode = e.detail; });

  const SPIN = { idle: 0.0028, listening: 0.0012, thinking: 0.012, speaking: 0.005 };
  const PULSE_HZ = { idle: 700, listening: 260, thinking: 140, speaking: 180 };
  const PULSE_AMP = { idle: 0.10, listening: 0.22, thinking: 0.18, speaking: 0.30 };
  let spin = 0, spinRate = SPIN.idle, haloScale = 1;

  const loop = () => {
    spinRate += ((SPIN[voiceMode] ?? SPIN.idle) - spinRate) * 0.06;
    spin += spinRate;
    globe.rotation.y = spin + targetY;
    globe.rotation.x += (targetX - globe.rotation.x) * 0.05;
    halo.rotation.z += 0.0015;
    halo2.rotation.z -= 0.001;
    const t = performance.now();
    const pulse = 0.22 + (PULSE_AMP[voiceMode] ?? 0.10) * Math.sin(t / (PULSE_HZ[voiceMode] ?? 700));
    halo.material.opacity = Math.max(0.05, pulse);
    // speaking: the outer rings breathe like a waveform
    const targetScale = voiceMode === "speaking" ? 1 + 0.05 * Math.abs(Math.sin(t / 150)) : 1;
    haloScale += (targetScale - haloScale) * 0.2;
    halo.scale.setScalar(haloScale);
    halo2.scale.setScalar(1 + (haloScale - 1) * 0.6);
    renderer.render(scene, camera);
  };
  renderer.setAnimationLoop(loop);

  // don't burn GPU while the tab is hidden
  document.addEventListener("visibilitychange", () => {
    renderer.setAnimationLoop(document.hidden ? null : loop);
  });

  // recolor support when the accent changes from Settings
  window.addEventListener("accent:changed", (e) => {
    const c = new THREE.Color(e.detail);
    globe.traverse((o) => { if (o.material?.color && o.geometry?.type !== 'SphereGeometry') o.material.color = c; });
    halo.material.color = c; halo2.material.color = c;
  });
}
