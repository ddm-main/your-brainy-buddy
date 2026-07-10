import { Canvas, useFrame } from "@react-three/fiber";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { useVoice } from "@/store/voiceStore";
import { useBrain, currentBrainLabel } from "@/store/brainStore";
import { useUi } from "@/store/uiStore";

/* State-driven palette. */
const COLORS = {
  idle:       new THREE.Color("#5cc8ff"),
  listening:  new THREE.Color("#35d6ed"),
  processing: new THREE.Color("#ffb547"),
  speaking:   new THREE.Color("#6bffb0"),
  muted:      new THREE.Color("#ff5566"),
  paused:     new THREE.Color("#8899aa"),
};

/**
 * JARVIS Core — neural network sphere.
 *
 * A single coherent silhouette: nodes fibonacci-distributed on a sphere,
 * connected to their nearest neighbors, gently pulsing. Voice state drives
 * color, rotation speed, and firing rate.
 */
export default function JarvisCore() {
  const openConversation = useUi((s) => s.openConversation);
  const brain = useBrain();
  const brainLabel = currentBrainLabel(brain.provider, brain.model);

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <Canvas
        camera={{ position: [0, 0, 6.2], fov: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        dpr={[1, 2]}
      >
        <Suspense fallback={null}>
          <Scene />
        </Suspense>
      </Canvas>

      <button
        onClick={(e) => { e.stopPropagation(); openConversation(); }}
        style={{
          position: "absolute", bottom: 60, left: "50%", transform: "translateX(-50%)",
          pointerEvents: "auto",
          padding: "5px 14px", border: "1px solid var(--edge-strong)",
          background: "var(--panel-tint)", backdropFilter: "blur(8px)",
          color: "var(--accent-soft)", fontFamily: "var(--font-hud)",
          fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase",
          borderRadius: 2, cursor: "pointer", transition: "all 200ms",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-tint-strong)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "var(--panel-tint)"; }}
      >
        ◈ {brainLabel} · open conversation
      </button>
    </div>
  );
}

function Scene() {
  return (
    <>
      <ambientLight intensity={0.4} />
      <pointLight position={[0, 0, 2]} intensity={1.0} color="#5cc8ff" />
      <HaloParticles />
      <HudRing radius={1.85} thickness={0.008} tickCount={72} tickLen={0.06} spin={0.12} />
      <HudRing radius={2.15} thickness={0.006} tickCount={120} tickLen={0.035} spin={-0.07} />
      <NeuralSphere />
      <CoreGlow />
    </>
  );
}

/* ---------- Neural network sphere ---------- */
function NeuralSphere() {
  const grpRef = useRef<THREE.Group>(null!);
  const NODES = 90;
  const RADIUS = 1.15;
  const K = 3; // nearest neighbors per node

  const { nodePos, nodeSeed, nodePhase, edgePos, edgeSeed } = useMemo(() => {
    // Fibonacci sphere
    const pos = new Float32Array(NODES * 3);
    const seed = new Float32Array(NODES);
    const phase = new Float32Array(NODES);
    const points: THREE.Vector3[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < NODES; i++) {
      const y = 1 - (i / (NODES - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      const x = Math.cos(theta) * r;
      const z = Math.sin(theta) * r;
      const p = new THREE.Vector3(x, y, z).multiplyScalar(RADIUS);
      points.push(p);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      seed[i] = Math.random();
      phase[i] = Math.random() * Math.PI * 2;
    }
    // k-NN edges (dedup by pair key)
    const pairs = new Set<string>();
    const edges: number[] = [];
    for (let i = 0; i < NODES; i++) {
      const dists: { j: number; d: number }[] = [];
      for (let j = 0; j < NODES; j++) {
        if (i === j) continue;
        dists.push({ j, d: points[i].distanceToSquared(points[j]) });
      }
      dists.sort((a, b) => a.d - b.d);
      for (let k = 0; k < K; k++) {
        const j = dists[k].j;
        const key = i < j ? `${i}_${j}` : `${j}_${i}`;
        if (pairs.has(key)) continue;
        pairs.add(key);
        edges.push(i, j);
      }
    }
    const ePos = new Float32Array(edges.length * 3);
    const eSeed = new Float32Array(edges.length);
    for (let e = 0; e < edges.length; e++) {
      const idx = edges[e];
      ePos[e * 3] = pos[idx * 3];
      ePos[e * 3 + 1] = pos[idx * 3 + 1];
      ePos[e * 3 + 2] = pos[idx * 3 + 2];
      eSeed[e] = seed[idx];
    }
    return { nodePos: pos, nodeSeed: seed, nodePhase: phase, edgePos: ePos, edgeSeed: eSeed };
  }, []);

  const nodeUniforms = useMemo(() => ({
    uTime:  { value: 0 },
    uAmp:   { value: 0 },
    uColor: { value: COLORS.idle.clone() },
    uRate:  { value: 1.0 },
    uFire:  { value: 0.0 }, // firing intensity
  }), []);

  const edgeUniforms = useMemo(() => ({
    uTime:  { value: 0 },
    uColor: { value: COLORS.idle.clone() },
    uAmp:   { value: 0 },
  }), []);

  useFrame((_, dt) => {
    const v = useVoice.getState();
    const target = COLORS[v.state] ?? COLORS.idle;

    // Rotation speed by state (calm at idle)
    let rotSpeed = 0.05;
    let rate = 1.4;
    let fire = 0.2;
    if (v.state === "listening")  { rotSpeed = 0.07; rate = 2.6; fire = 0.5; }
    if (v.state === "processing") { rotSpeed = 0.11; rate = 3.4; fire = 0.85; }
    if (v.state === "speaking")   { rotSpeed = 0.06; rate = 2.2; fire = 0.6 + v.amplitude * 0.4; }
    if (v.state === "muted" || v.state === "paused") { rotSpeed = 0.0; rate = 0.6; fire = 0.05; }

    if (grpRef.current) {
      grpRef.current.rotation.y += dt * rotSpeed;
      grpRef.current.rotation.x = Math.sin(nodeUniforms.uTime.value * 0.1) * 0.08;
    }

    nodeUniforms.uTime.value += dt;
    nodeUniforms.uAmp.value += (v.amplitude - nodeUniforms.uAmp.value) * Math.min(1, dt * 6);
    nodeUniforms.uColor.value.lerp(target, Math.min(1, dt * 3));
    nodeUniforms.uRate.value += (rate - nodeUniforms.uRate.value) * Math.min(1, dt * 2);
    nodeUniforms.uFire.value += (fire - nodeUniforms.uFire.value) * Math.min(1, dt * 2);

    edgeUniforms.uTime.value = nodeUniforms.uTime.value;
    edgeUniforms.uColor.value.copy(nodeUniforms.uColor.value);
    edgeUniforms.uAmp.value = nodeUniforms.uAmp.value;
  });

  return (
    <group ref={grpRef}>
      {/* Edges */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={edgePos.length / 3} array={edgePos} itemSize={3} args={[edgePos, 3]} />
          <bufferAttribute attach="attributes-aSeed" count={edgeSeed.length} array={edgeSeed} itemSize={1} args={[edgeSeed, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={edgeUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          vertexShader={`
            attribute float aSeed;
            uniform float uTime;
            varying float vPulse;
            void main() {
              float t = uTime * 0.7 + aSeed * 12.0;
              vPulse = 0.25 + 0.35 * (0.5 + 0.5 * sin(t));
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            uniform float uAmp;
            varying float vPulse;
            void main() {
              float a = vPulse * (0.55 + uAmp * 0.4);
              gl_FragColor = vec4(uColor, a);
            }
          `}
        />
      </lineSegments>

      {/* Nodes */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={NODES} array={nodePos} itemSize={3} args={[nodePos, 3]} />
          <bufferAttribute attach="attributes-aSeed" count={NODES} array={nodeSeed} itemSize={1} args={[nodeSeed, 1]} />
          <bufferAttribute attach="attributes-aPhase" count={NODES} array={nodePhase} itemSize={1} args={[nodePhase, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={nodeUniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          vertexShader={`
            attribute float aSeed;
            attribute float aPhase;
            uniform float uTime;
            uniform float uAmp;
            uniform float uRate;
            uniform float uFire;
            varying float vBright;
            void main() {
              float t = uTime * uRate + aPhase;
              float base = 0.55 + 0.45 * (0.5 + 0.5 * sin(t));
              // firing spark: rare bright bumps for a subset of nodes
              float spark = smoothstep(0.85, 1.0, sin(t * 0.7 + aSeed * 6.28));
              vBright = base + spark * uFire * 1.6 + uAmp * 0.4;

              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              gl_PointSize = (3.0 + vBright * 4.5) * (2.8 / -mv.z);
              gl_Position = projectionMatrix * mv;
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            varying float vBright;
            void main() {
              vec2 c = gl_PointCoord - 0.5;
              float d = length(c);
              if (d > 0.5) discard;
              float soft = smoothstep(0.5, 0.0, d);
              vec3 col = mix(uColor, vec3(1.0), min(vBright * 0.4, 0.7));
              gl_FragColor = vec4(col, soft * min(vBright, 1.4) * 0.95);
            }
          `}
        />
      </points>
    </group>
  );
}

/* ---------- Soft central glow (gives the sphere a "core") ---------- */
function CoreGlow() {
  const meshRef = useRef<THREE.Mesh>(null!);
  const uniforms = useMemo(() => ({
    uTime:  { value: 0 },
    uAmp:   { value: 0 },
    uColor: { value: COLORS.idle.clone() },
  }), []);
  useFrame((_, dt) => {
    const v = useVoice.getState();
    uniforms.uTime.value += dt;
    uniforms.uAmp.value += (v.amplitude - uniforms.uAmp.value) * Math.min(1, dt * 6);
    uniforms.uColor.value.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
    if (meshRef.current) {
      const breathe = 0.9 + Math.sin(uniforms.uTime.value * 1.2) * 0.04;
      meshRef.current.scale.setScalar(breathe + v.amplitude * 0.15);
    }
  });
  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.42, 32, 32]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        vertexShader={`
          varying vec3 vN; varying vec3 vV;
          void main() {
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vN = normalize(normalMatrix * normal);
            vV = normalize(-mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `}
        fragmentShader={`
          uniform vec3 uColor; uniform float uTime; uniform float uAmp;
          varying vec3 vN; varying vec3 vV;
          void main() {
            float f = pow(1.0 - max(dot(vN, vV), 0.0), 2.0);
            float pulse = 0.85 + 0.15 * sin(uTime * 1.6);
            vec3 core = mix(vec3(1.0), uColor, f);
            float alpha = (0.35 + f * 0.6) * pulse * (0.85 + uAmp * 0.5);
            gl_FragColor = vec4(core, alpha);
          }
        `}
      />
    </mesh>
  );
}

/* ---------- HUD ring with tick marks (kept from previous design) ---------- */
function HudRing({
  radius, thickness, tickCount, tickLen, spin,
}: {
  radius: number; thickness: number; tickCount: number; tickLen: number; spin: number;
}) {
  const grpRef = useRef<THREE.Group>(null!);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null!);
  const tickMatRef = useRef<THREE.LineBasicMaterial>(null!);

  const ringGeom = useMemo(() => {
    return new THREE.RingGeometry(radius - thickness, radius + thickness, 128);
  }, [radius, thickness]);

  const tickGeom = useMemo(() => {
    const arr = new Float32Array(tickCount * 2 * 3);
    for (let i = 0; i < tickCount; i++) {
      const a = (i / tickCount) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const long = i % 8 === 0 ? tickLen * 2.2 : tickLen;
      const r1 = radius + thickness + 0.01;
      const r2 = r1 + long;
      arr[i * 6]     = cos * r1;
      arr[i * 6 + 1] = sin * r1;
      arr[i * 6 + 2] = 0;
      arr[i * 6 + 3] = cos * r2;
      arr[i * 6 + 4] = sin * r2;
      arr[i * 6 + 5] = 0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  }, [tickCount, tickLen, radius, thickness]);

  useFrame((_, dt) => {
    const v = useVoice.getState();
    if (grpRef.current) {
      const speed = v.state === "processing" ? 2.2 : v.state === "listening" ? 1.4 : 1.0;
      grpRef.current.rotation.z += dt * spin * speed;
    }
    const target = COLORS[v.state] ?? COLORS.idle;
    if (ringMatRef.current) ringMatRef.current.color.lerp(target, Math.min(1, dt * 3));
    if (tickMatRef.current) tickMatRef.current.color.lerp(target, Math.min(1, dt * 3));
  });

  return (
    <group ref={grpRef}>
      <mesh geometry={ringGeom}>
        <meshBasicMaterial
          ref={ringMatRef}
          color={COLORS.idle}
          transparent
          opacity={0.5}
          side={THREE.DoubleSide}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </mesh>
      <lineSegments geometry={tickGeom}>
        <lineBasicMaterial
          ref={tickMatRef}
          color={COLORS.idle}
          transparent
          opacity={0.55}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </group>
  );
}

/* ---------- Bounded halo particles ---------- */
function HaloParticles() {
  const COUNT = 900;
  const data = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    const R = 1.95;
    const tube = 0.3;
    for (let i = 0; i < COUNT; i++) {
      const u = Math.random() * Math.PI * 2;
      const v = Math.random() * Math.PI * 2;
      const r = tube * (0.7 + Math.random() * 0.3);
      pos[i * 3]     = (R + r * Math.cos(v)) * Math.cos(u);
      pos[i * 3 + 1] = (R + r * Math.cos(v)) * Math.sin(u);
      pos[i * 3 + 2] = r * Math.sin(v) * 0.5;
      seed[i] = Math.random();
    }
    return { pos, seed };
  }, []);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uAmp: { value: 0 }, uColor: { value: COLORS.idle.clone() },
  }), []);
  useFrame((_, dt) => {
    const v = useVoice.getState();
    uniforms.uTime.value += dt;
    uniforms.uAmp.value += (v.amplitude - uniforms.uAmp.value) * Math.min(1, dt * 5);
    uniforms.uColor.value.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
  });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={data.pos} itemSize={3} args={[data.pos, 3]} />
        <bufferAttribute attach="attributes-aSeed" count={COUNT} array={data.seed} itemSize={1} args={[data.seed, 1]} />
      </bufferGeometry>
      <shaderMaterial
        uniforms={uniforms}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        vertexShader={`
          attribute float aSeed;
          uniform float uTime; uniform float uAmp;
          varying float vFlick;
          void main() {
            float t = uTime * 0.4 + aSeed * 20.0;
            vFlick = 0.35 + 0.65 * sin(t * 2.0);
            vec3 p = position;
            p.z += sin(t + aSeed * 6.0) * 0.03;
            p.xy *= 1.0 + uAmp * 0.02;
            vec4 mv = modelViewMatrix * vec4(p, 1.0);
            gl_PointSize = (1.2 + vFlick * 1.8) * (2.8 / -mv.z);
            gl_Position = projectionMatrix * mv;
          }
        `}
        fragmentShader={`
          uniform vec3 uColor;
          varying float vFlick;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float d = length(c);
            if (d > 0.5) discard;
            float soft = smoothstep(0.5, 0.0, d);
            gl_FragColor = vec4(uColor, soft * vFlick * 0.6);
          }
        `}
      />
    </points>
  );
}
