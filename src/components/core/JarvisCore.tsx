import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useVoice } from "@/store/voiceStore";

/* -------------------------------------------------------------------------- */
/* Palette — arc-reactor white/blue                                           */
/* -------------------------------------------------------------------------- */
const CORE = new THREE.Color("#ffffff");
const RIM = new THREE.Color("#8fd8ff");
const DEEP = new THREE.Color("#4aa8e8");

const PARTICLE_COUNT = 5000;
const MAX_R = 2.6;

/* -------------------------------------------------------------------------- */
/* Root                                                                       */
/* -------------------------------------------------------------------------- */
export default function JarvisCore() {
  const [hover, setHover] = useState(false);
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  return (
    <div
      style={{ position: "absolute", inset: 0, cursor: "crosshair" }}
      onPointerMove={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        pointerRef.current.x = ((e.clientX - r.left) / r.width) * 2 - 1;
        pointerRef.current.y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <Canvas
        camera={{ position: [0, 0, 5], fov: 55 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 2]}
      >
        <Suspense fallback={null}>
          <Scene pointerRef={pointerRef} hovering={hover} />
        </Suspense>
      </Canvas>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Scene                                                                      */
/* -------------------------------------------------------------------------- */
function Scene({
  pointerRef,
  hovering,
}: {
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
  hovering: boolean;
}) {
  return (
    <>
      <Bloom hovering={hovering} />
      <Swarm pointerRef={pointerRef} hovering={hovering} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Central bloom sprite                                                       */
/* -------------------------------------------------------------------------- */
function makeBloomTexture() {
  const size = 256;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, "rgba(255,255,255,1)");
  g.addColorStop(0.15, "rgba(220,240,255,0.85)");
  g.addColorStop(0.45, "rgba(140,200,255,0.25)");
  g.addColorStop(1.0, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.needsUpdate = true;
  return t;
}

function Bloom({ hovering }: { hovering: boolean }) {
  const matRef = useRef<THREE.SpriteMaterial>(null!);
  const spriteRef = useRef<THREE.Sprite>(null!);
  const voiceState = useVoice((s) => s.state);
  const amp = useVoice((s) => s.amplitude);
  const tex = useMemo(() => makeBloomTexture(), []);
  const targetRef = useRef(1);

  useFrame((_, dt) => {
    if (!matRef.current || !spriteRef.current) return;
    const base =
      voiceState === "processing" ? 1.5 :
      voiceState === "listening" ? 1.2 + amp * 0.4 :
      voiceState === "speaking" ? 1.1 + amp * 0.6 :
      1.0;
    const target = base * (hovering ? 1.6 : 1.0);
    targetRef.current += (target - targetRef.current) * Math.min(1, dt * 5);
    const s = targetRef.current;
    spriteRef.current.scale.setScalar(1.9 * s);
    matRef.current.opacity = Math.min(1, 0.55 * s);
  });

  return (
    <sprite ref={spriteRef}>
      <spriteMaterial
        ref={matRef}
        map={tex}
        color={0xffffff}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </sprite>
  );
}

/* -------------------------------------------------------------------------- */
/* Swarm — curl-noise flow field with pointer attraction                      */
/* -------------------------------------------------------------------------- */
function Swarm({
  pointerRef,
  hovering,
}: {
  pointerRef: React.MutableRefObject<{ x: number; y: number }>;
  hovering: boolean;
}) {
  const voiceState = useVoice((s) => s.state);
  const amp = useVoice((s) => s.amplitude);
  const geomRef = useRef<THREE.BufferGeometry>(null!);
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  const { camera, size } = useThree();
  const hoverStrengthRef = useRef(0);
  const timeRef = useRef(0);

  const data = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const velocities = new Float32Array(PARTICLE_COUNT * 3);
    const seeds = new Float32Array(PARTICLE_COUNT);
    const hot = new Float32Array(PARTICLE_COUNT);
    const sizes = new Float32Array(PARTICLE_COUNT);

    const spawn = (i: number) => {
      // center-biased radius
      const r = Math.pow(Math.random(), 3) * MAX_R;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta) * 0.9;
      positions[i * 3 + 2] = r * Math.cos(phi) * 0.8;
      velocities[i * 3] = (Math.random() - 0.5) * 0.1;
      velocities[i * 3 + 1] = (Math.random() - 0.5) * 0.1;
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.1;
    };

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      spawn(i);
      seeds[i] = Math.random();
      hot[i] = Math.random() < 0.3 ? 1 : 0;
      sizes[i] = hot[i] > 0.5 ? 7 : 3;
    }
    return { positions, velocities, seeds, hot, sizes };
  }, []);

  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute("aSeed", new THREE.BufferAttribute(data.seeds, 1));
    g.setAttribute("aHot", new THREE.BufferAttribute(data.hot, 1));
    g.setAttribute("aSize", new THREE.BufferAttribute(data.sizes, 1));
    return g;
  }, [data]);

  const mat = useMemo(() => new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixel: { value: (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1 },
      uBrightness: { value: 1.0 },
      uCore: { value: CORE },
      uRim: { value: RIM },
      uDeep: { value: DEEP },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSeed;
      attribute float aHot;
      attribute float aSize;
      uniform float uTime;
      uniform float uPixel;
      varying float vFlick;
      varying float vHot;
      varying float vDepth;
      void main() {
        vFlick = 0.65 + 0.35 * sin(uTime * 3.2 + aSeed * 24.0);
        vHot = aHot;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_PointSize = aSize * vFlick * uPixel * (3.8 / -mv.z);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uCore;
      uniform vec3 uRim;
      uniform vec3 uDeep;
      uniform float uBrightness;
      varying float vFlick;
      varying float vHot;
      varying float vDepth;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float d = length(c);
        if (d > 0.5) discard;
        float soft = smoothstep(0.5, 0.0, d);
        float depthMix = clamp(1.0 - (vDepth - 2.0) / 6.0, 0.0, 1.0);
        vec3 base = mix(uDeep, uRim, depthMix);
        vec3 col = mix(base, uCore, vHot * 0.9);
        gl_FragColor = vec4(col * uBrightness, soft * vFlick);
      }
    `,
  }), []);

  const pointerWorld = useMemo(() => new THREE.Vector3(), []);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    if (!geomRef.current || !matRef.current) return;
    timeRef.current += dt;
    const t = timeRef.current;

    // ease hover strength
    hoverStrengthRef.current += ((hovering ? 1 : 0) - hoverStrengthRef.current) * Math.min(1, dt * 6);
    const hoverK = hoverStrengthRef.current;

    // project pointer to plane z=0
    ndc.set(pointerRef.current.x, pointerRef.current.y);
    raycaster.setFromCamera(ndc, camera);
    // intersect z=0 plane
    const origin = raycaster.ray.origin;
    const dir = raycaster.ray.direction;
    if (Math.abs(dir.z) > 1e-4) {
      const tHit = -origin.z / dir.z;
      pointerWorld.set(origin.x + dir.x * tHit, origin.y + dir.y * tHit, 0);
    }

    // state-driven params
    const flowSpeed =
      voiceState === "processing" ? 1.8 :
      voiceState === "listening" ? 1.0 + amp * 0.6 :
      voiceState === "speaking" ? 1.2 + amp * 0.5 :
      1.0;
    const centerPull =
      voiceState === "processing" ? 1.4 :
      voiceState === "listening" ? 0.7 :
      voiceState === "speaking" ? 0.6 :
      0.55;
    const brightness =
      voiceState === "processing" ? 1.5 :
      voiceState === "listening" ? 1.3 :
      voiceState === "speaking" ? 1.15 + amp * 0.5 :
      1.05;

    matRef.current.uniforms.uTime.value = t;
    const u = matRef.current.uniforms.uBrightness;
    u.value += (brightness - u.value) * Math.min(1, dt * 4);

    const pos = data.positions;
    const vel = data.velocities;
    const seeds = data.seeds;

    const flow = flowSpeed * (1 + hoverK * 0.4);
    const pull = centerPull;
    const hoverPull = hoverK * 1.4;

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const ix = i * 3;
      let x = pos[ix];
      let y = pos[ix + 1];
      let z = pos[ix + 2];
      const s = seeds[i];

      // pseudo-curl noise via layered sinusoids of position + time
      const nx = Math.sin(y * 1.7 + t * 0.9 + s * 6.28) - Math.cos(z * 1.3 - t * 0.7);
      const ny = Math.sin(z * 1.5 - t * 1.1 + s * 3.14) - Math.cos(x * 1.9 + t * 0.6);
      const nz = Math.sin(x * 1.4 + t * 0.8) - Math.cos(y * 1.6 - t * 1.0 + s * 4.7);

      // integrate velocity
      vel[ix] += nx * 0.18 * flow * dt;
      vel[ix + 1] += ny * 0.18 * flow * dt;
      vel[ix + 2] += nz * 0.14 * flow * dt;

      // radial gravity toward center
      const r2 = x * x + y * y + z * z + 1e-4;
      const r = Math.sqrt(r2);
      const gravity = pull * (r > 0.4 ? 1 : 0.2) * dt;
      vel[ix] -= (x / r) * gravity;
      vel[ix + 1] -= (y / r) * gravity;
      vel[ix + 2] -= (z / r) * gravity;

      // pointer attraction
      if (hoverPull > 0.001) {
        const dx = pointerWorld.x - x;
        const dy = pointerWorld.y - y;
        const dz = 0 - z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.2;
        const f = (hoverPull * dt) / dist;
        vel[ix] += dx * f;
        vel[ix + 1] += dy * f;
        vel[ix + 2] += dz * f * 0.4;
      }

      // damping
      const damp = 1 - dt * 1.4;
      vel[ix] *= damp;
      vel[ix + 1] *= damp;
      vel[ix + 2] *= damp;

      x += vel[ix] * dt * 6;
      y += vel[ix + 1] * dt * 6;
      z += vel[ix + 2] * dt * 6;

      // hard bound: respawn if drifting way out
      if (x * x + y * y + z * z > MAX_R * MAX_R * 1.6) {
        const rr = Math.pow(Math.random(), 3) * MAX_R * 0.6;
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        x = rr * Math.sin(ph) * Math.cos(th);
        y = rr * Math.sin(ph) * Math.sin(th) * 0.9;
        z = rr * Math.cos(ph) * 0.8;
        vel[ix] = vel[ix + 1] = vel[ix + 2] = 0;
      }

      pos[ix] = x;
      pos[ix + 1] = y;
      pos[ix + 2] = z;
    }

    (geomRef.current.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  });

  // avoid unused warning
  void size;

  return (
    <points
      geometry={geom}
      ref={(o) => { if (o) geomRef.current = o.geometry as THREE.BufferGeometry; }}
      frustumCulled={false}
    >
      <primitive object={mat} ref={matRef} attach="material" />
    </points>
  );
}
