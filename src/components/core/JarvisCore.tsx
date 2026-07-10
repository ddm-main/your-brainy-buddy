import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useVoice } from "@/store/voiceStore";
import { useBrain, currentBrainLabel } from "@/store/brainStore";
import { useUi } from "@/store/uiStore";

const COLORS = {
  idle:       new THREE.Color("#5cc8ff"),
  listening:  new THREE.Color("#35d6ed"),
  processing: new THREE.Color("#ffb547"),
  speaking:   new THREE.Color("#6bffb0"),
  muted:      new THREE.Color("#ff5566"),
  paused:     new THREE.Color("#8899aa"),
};

const pointer = { x: 0, y: 0 };

export default function JarvisCore() {
  const openConversation = useUi((s) => s.openConversation);
  const brain = useBrain();
  const brainLabel = currentBrainLabel(brain.provider, brain.model);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

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
      <Parallax />
      <Starfield />
      <FogHalo />
      <RimGlow />
      <NeuralSphere />
      <IrisCore />
    </>
  );
}

function Parallax() {
  const { camera } = useThree();
  useFrame((_, dt) => {
    const tx = pointer.x * 0.18;
    const ty = -pointer.y * 0.12;
    camera.position.x += (tx - camera.position.x) * Math.min(1, dt * 2);
    camera.position.y += (ty - camera.position.y) * Math.min(1, dt * 2);
    camera.lookAt(0, 0, 0);
  });
  return null;
}

function fibSphere(count: number, radius: number) {
  const pts: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const th = golden * i;
    pts.push(new THREE.Vector3(Math.cos(th) * r, y, Math.sin(th) * r).multiplyScalar(radius));
  }
  return pts;
}

function knnEdges(pts: THREE.Vector3[], k: number): [number, number][] {
  const pairs = new Set<string>();
  const edges: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    const d: { j: number; d: number }[] = [];
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      d.push({ j, d: pts[i].distanceToSquared(pts[j]) });
    }
    d.sort((a, b) => a.d - b.d);
    for (let n = 0; n < k; n++) {
      const j = d[n].j;
      const key = i < j ? `${i}_${j}` : `${j}_${i}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      edges.push([i, j]);
    }
  }
  return edges;
}

/* ---------- Neural sphere: nodes + edges in one shared group ---------- */
function NeuralSphere() {
  const grpRef = useRef<THREE.Group>(null!);

  const built = useMemo(() => {
    const OUTER = 120;
    const INNER = 50;
    const outer = fibSphere(OUTER, 1.25);
    const inner = fibSphere(INNER, 1.02);
    const total = OUTER + INNER;

    // Node buffers
    const nodePos = new Float32Array(total * 3);
    const nodeSeed = new Float32Array(total);
    const nodePhase = new Float32Array(total);
    const nodeShell = new Float32Array(total);
    for (let i = 0; i < OUTER; i++) {
      nodePos[i * 3] = outer[i].x; nodePos[i * 3 + 1] = outer[i].y; nodePos[i * 3 + 2] = outer[i].z;
      nodeSeed[i] = Math.random();
      nodePhase[i] = Math.random() * Math.PI * 2;
      nodeShell[i] = 1.0;
    }
    for (let i = 0; i < INNER; i++) {
      const k = OUTER + i;
      nodePos[k * 3] = inner[i].x; nodePos[k * 3 + 1] = inner[i].y; nodePos[k * 3 + 2] = inner[i].z;
      nodeSeed[k] = Math.random();
      nodePhase[k] = Math.random() * Math.PI * 2;
      nodeShell[k] = 0.5;
    }

    // Edges: outer knn, inner knn, radial pairs
    const eOuter = knnEdges(outer, 3);
    const eInner = knnEdges(inner, 3);
    const segs: [THREE.Vector3, THREE.Vector3][] = [];
    eOuter.forEach(([a, b]) => segs.push([outer[a], outer[b]]));
    eInner.forEach(([a, b]) => segs.push([inner[a], inner[b]]));
    for (let i = 0; i < inner.length; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < outer.length; j++) {
        const d = inner[i].distanceToSquared(outer[j]);
        if (d < bd) { bd = d; best = j; }
      }
      segs.push([inner[i], outer[best]]);
    }
    const n = segs.length;
    const edgePos = new Float32Array(n * 2 * 3);
    const edgeT = new Float32Array(n * 2);
    const edgeSeed = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const [a, b] = segs[i];
      edgePos[i * 6] = a.x; edgePos[i * 6 + 1] = a.y; edgePos[i * 6 + 2] = a.z;
      edgePos[i * 6 + 3] = b.x; edgePos[i * 6 + 4] = b.y; edgePos[i * 6 + 5] = b.z;
      edgeT[i * 2] = 0; edgeT[i * 2 + 1] = 1;
      const s = Math.random();
      edgeSeed[i * 2] = s; edgeSeed[i * 2 + 1] = s;
    }

    return { nodePos, nodeSeed, nodePhase, nodeShell, edgePos, edgeT, edgeSeed };
  }, []);

  const nodeU = useMemo(() => ({
    uTime:  { value: 0 },
    uAmp:   { value: 0 },
    uColor: { value: COLORS.idle.clone() },
    uRate:  { value: 1.0 },
    uFire:  { value: 0.0 },
  }), []);

  const edgeU = useMemo(() => ({
    uTime:  { value: 0 },
    uColor: { value: COLORS.idle.clone() },
    uSpeed: { value: 0.4 },
    uAmp:   { value: 0 },
  }), []);

  useFrame((_, dt) => {
    const v = useVoice.getState();
    const target = COLORS[v.state] ?? COLORS.idle;

    let rot = 0.05, rate = 1.4, fire = 0.2, speed = 0.4;
    if (v.state === "listening")  { rot = 0.07; rate = 2.6; fire = 0.5; speed = 0.8; }
    if (v.state === "processing") { rot = 0.11; rate = 3.4; fire = 0.85; speed = 1.4; }
    if (v.state === "speaking")   { rot = 0.06; rate = 2.2; fire = 0.6 + v.amplitude * 0.4; speed = 0.7 + v.amplitude * 0.6; }
    if (v.state === "muted" || v.state === "paused") { rot = 0.0; rate = 0.6; fire = 0.05; speed = 0.1; }

    if (grpRef.current) {
      grpRef.current.rotation.y += dt * rot;
      grpRef.current.rotation.x = Math.sin(nodeU.uTime.value * 0.15) * 0.12;
    }

    nodeU.uTime.value += dt;
    nodeU.uAmp.value += (v.amplitude - nodeU.uAmp.value) * Math.min(1, dt * 6);
    nodeU.uColor.value.lerp(target, Math.min(1, dt * 3));
    nodeU.uRate.value += (rate - nodeU.uRate.value) * Math.min(1, dt * 2);
    nodeU.uFire.value += (fire - nodeU.uFire.value) * Math.min(1, dt * 2);

    edgeU.uTime.value = nodeU.uTime.value;
    edgeU.uColor.value.copy(nodeU.uColor.value);
    edgeU.uAmp.value = nodeU.uAmp.value;
    edgeU.uSpeed.value += (speed - edgeU.uSpeed.value) * Math.min(1, dt * 2);
  });

  return (
    <group ref={grpRef}>
      {/* Edges */}
      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={built.edgePos.length / 3} array={built.edgePos} itemSize={3} args={[built.edgePos, 3]} />
          <bufferAttribute attach="attributes-aT" count={built.edgeT.length} array={built.edgeT} itemSize={1} args={[built.edgeT, 1]} />
          <bufferAttribute attach="attributes-aSeed" count={built.edgeSeed.length} array={built.edgeSeed} itemSize={1} args={[built.edgeSeed, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={edgeU}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          vertexShader={`
            attribute float aT;
            attribute float aSeed;
            uniform float uTime;
            uniform float uSpeed;
            varying float vT;
            varying float vPulse;
            varying float vDepth;
            void main() {
              vT = aT;
              float head = fract(uTime * uSpeed + aSeed);
              // longer dim tail behind head
              float back = aT - head;
              if (back > 0.5) back -= 1.0;
              if (back < -0.5) back += 1.0;
              float dist = abs(back);
              vPulse = smoothstep(0.18, 0.0, dist) + smoothstep(0.35, 0.05, dist) * 0.35;
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vDepth = -mv.z;
              gl_Position = projectionMatrix * mv;
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            uniform float uAmp;
            varying float vPulse;
            varying float vDepth;
            void main() {
              float depthFade = smoothstep(7.5, 5.0, vDepth);
              float base = 0.20 + uAmp * 0.25;
              float bright = base + vPulse * 1.6;
              vec3 col = mix(uColor, vec3(1.0), min(vPulse, 1.0) * 0.75);
              gl_FragColor = vec4(col, bright * (0.18 + 0.82 * depthFade));
            }
          `}
        />
      </lineSegments>

      {/* Nodes */}
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={built.nodePos.length / 3} array={built.nodePos} itemSize={3} args={[built.nodePos, 3]} />
          <bufferAttribute attach="attributes-aSeed" count={built.nodeSeed.length} array={built.nodeSeed} itemSize={1} args={[built.nodeSeed, 1]} />
          <bufferAttribute attach="attributes-aPhase" count={built.nodePhase.length} array={built.nodePhase} itemSize={1} args={[built.nodePhase, 1]} />
          <bufferAttribute attach="attributes-aShell" count={built.nodeShell.length} array={built.nodeShell} itemSize={1} args={[built.nodeShell, 1]} />
        </bufferGeometry>
        <shaderMaterial
          uniforms={nodeU}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          vertexShader={`
            attribute float aSeed;
            attribute float aPhase;
            attribute float aShell;
            uniform float uTime;
            uniform float uAmp;
            uniform float uRate;
            uniform float uFire;
            varying float vBright;
            varying float vDepth;
            void main() {
              float t = uTime * uRate + aPhase;
              float base = 0.55 + 0.45 * (0.5 + 0.5 * sin(t));
              float spark = smoothstep(0.86, 1.0, sin(t * 0.7 + aSeed * 6.28));
              vBright = base + spark * uFire * 1.8 + uAmp * 0.4;
              vec4 mv = modelViewMatrix * vec4(position, 1.0);
              vDepth = -mv.z;
              float sz = aShell > 0.75 ? 4.2 : 2.6;
              gl_PointSize = (sz + vBright * 4.5) * (2.8 / -mv.z);
              gl_Position = projectionMatrix * mv;
            }
          `}
          fragmentShader={`
            uniform vec3 uColor;
            varying float vBright;
            varying float vDepth;
            void main() {
              vec2 c = gl_PointCoord - 0.5;
              float d = length(c);
              if (d > 0.5) discard;
              float soft = smoothstep(0.5, 0.0, d);
              float depthFade = smoothstep(7.5, 5.0, vDepth);
              vec3 col = mix(uColor, vec3(1.0), min(vBright * 0.45, 0.75));
              float a = soft * min(vBright, 1.4) * (0.22 + 0.78 * depthFade);
              gl_FragColor = vec4(col, a);
            }
          `}
        />
      </points>
    </group>
  );
}

/* ---------- Iris core: three shared-breath layers + flat equator ring ---------- */
function IrisCore() {
  const hazeRef = useRef<THREE.Mesh>(null!);
  const shellRef = useRef<THREE.Mesh>(null!);
  const hotRef = useRef<THREE.Mesh>(null!);
  const ringRef = useRef<THREE.Mesh>(null!);
  const ringMat = useRef<THREE.MeshBasicMaterial>(null!);

  const shared = useMemo(() => ({
    uTime:  { value: 0 },
    uAmp:   { value: 0 },
    uColor: { value: COLORS.idle.clone() },
  }), []);

  useFrame((_, dt) => {
    const v = useVoice.getState();
    shared.uTime.value += dt;
    shared.uAmp.value += (v.amplitude - shared.uAmp.value) * Math.min(1, dt * 6);
    shared.uColor.value.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
    // shared breath — all layers scale together, keeping ratios fixed
    const breathHz = v.state === "listening" ? 0.4 : v.state === "processing" ? 0.55 : 0.25;
    const breath = 1.0 + Math.sin(shared.uTime.value * breathHz * 2.0 * Math.PI) * 0.03 + v.amplitude * 0.06;
    if (hazeRef.current)  hazeRef.current.scale.setScalar(breath);
    if (shellRef.current) shellRef.current.scale.setScalar(breath);
    if (hotRef.current)   hotRef.current.scale.setScalar(breath);
    if (ringRef.current) {
      const spd = v.state === "processing" ? 1.6 : v.state === "listening" ? 1.0 : 0.5;
      ringRef.current.rotation.z += dt * spd;
      ringRef.current.scale.setScalar(breath);
    }
    if (ringMat.current) ringMat.current.color.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
  });

  const fresVert = `varying vec3 vN; varying vec3 vV;
    void main() { vec4 mv=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`;

  return (
    <group>
      {/* Outer haze */}
      <mesh ref={hazeRef}>
        <sphereGeometry args={[0.40, 32, 32]} />
        <shaderMaterial
          uniforms={shared}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          vertexShader={fresVert}
          fragmentShader={`uniform vec3 uColor; uniform float uTime; uniform float uAmp; varying vec3 vN; varying vec3 vV;
            void main() { float f=pow(1.0-max(dot(vN,vV),0.0),2.0); float p=0.85+0.15*sin(uTime*1.6);
              vec3 c=mix(vec3(1.0),uColor,f); gl_FragColor=vec4(c,(0.20+f*0.45)*p*(0.85+uAmp*0.5)); }`}
        />
      </mesh>
      {/* Color fresnel shell */}
      <mesh ref={shellRef}>
        <sphereGeometry args={[0.26, 32, 32]} />
        <shaderMaterial
          uniforms={shared}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          vertexShader={fresVert}
          fragmentShader={`uniform vec3 uColor; uniform float uAmp; varying vec3 vN; varying vec3 vV;
            void main() { float f=pow(1.0-max(dot(vN,vV),0.0),2.0); vec3 c=mix(vec3(1.0),uColor,f);
              gl_FragColor=vec4(c,(0.35+f*0.65)*(0.85+uAmp*0.5)); }`}
        />
      </mesh>
      {/* Hot white core */}
      <mesh ref={hotRef}>
        <sphereGeometry args={[0.10, 24, 24]} />
        <shaderMaterial
          uniforms={shared}
          transparent depthWrite={false} blending={THREE.AdditiveBlending}
          vertexShader={fresVert}
          fragmentShader={`varying vec3 vN; varying vec3 vV;
            void main() { float f=pow(1.0-max(dot(vN,vV),0.0),1.5); gl_FragColor=vec4(vec3(1.0), 0.95-f*0.4); }`}
        />
      </mesh>
      {/* Flat equator ring — spin Z only */}
      <mesh ref={ringRef}>
        <torusGeometry args={[0.44, 0.005, 8, 128]} />
        <meshBasicMaterial ref={ringMat} color={COLORS.idle} transparent opacity={0.85} depthWrite={false} blending={THREE.AdditiveBlending} />
      </mesh>
    </group>
  );
}

/* ---------- Soft rim glow behind sphere ---------- */
function RimGlow() {
  const ref = useRef<THREE.Mesh>(null!);
  const uniforms = useMemo(() => ({
    uTime: { value: 0 }, uColor: { value: COLORS.idle.clone() }, uAmp: { value: 0 },
  }), []);
  useFrame((_, dt) => {
    const v = useVoice.getState();
    uniforms.uTime.value += dt;
    uniforms.uAmp.value += (v.amplitude - uniforms.uAmp.value) * Math.min(1, dt * 6);
    uniforms.uColor.value.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
  });
  return (
    <mesh ref={ref} position={[0, 0, -0.6]}>
      <planeGeometry args={[4.6, 4.6]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
        fragmentShader={`uniform vec3 uColor; uniform float uTime; uniform float uAmp; varying vec2 vUv;
          void main() {
            vec2 p = vUv - 0.5;
            float r = length(p) * 2.0;
            float ring = smoothstep(0.62, 0.42, r) * smoothstep(0.30, 0.44, r);
            float halo = smoothstep(1.0, 0.30, r) * 0.25;
            float pulse = 0.85 + 0.15 * sin(uTime * 1.2);
            float a = (ring * 0.75 + halo) * pulse * (0.9 + uAmp * 0.4);
            gl_FragColor = vec4(uColor, a);
          }`}
      />
    </mesh>
  );
}

/* ---------- Far volumetric fog halo ---------- */
function FogHalo() {
  const uniforms = useMemo(() => ({
    uColor: { value: COLORS.idle.clone() },
  }), []);
  useFrame((_, dt) => {
    const v = useVoice.getState();
    uniforms.uColor.value.lerp(COLORS[v.state] ?? COLORS.idle, Math.min(1, dt * 3));
  });
  return (
    <mesh position={[0, 0, -3]}>
      <planeGeometry args={[10, 10]} />
      <shaderMaterial
        uniforms={uniforms}
        transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`varying vec2 vUv; void main() { vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`}
        fragmentShader={`uniform vec3 uColor; varying vec2 vUv;
          void main() {
            vec2 p = vUv - 0.5;
            float r = length(p) * 2.0;
            float a = smoothstep(1.0, 0.0, r) * 0.10;
            gl_FragColor = vec4(uColor, a);
          }`}
      />
    </mesh>
  );
}

/* ---------- Deep starfield ---------- */
function Starfield() {
  const COUNT = 400;
  const data = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r = 8 + Math.random() * 4;
      pos[i * 3]     = Math.sin(ph) * Math.cos(th) * r;
      pos[i * 3 + 1] = Math.sin(ph) * Math.sin(th) * r;
      pos[i * 3 + 2] = Math.cos(ph) * r - 3;
      seed[i] = Math.random();
    }
    return { pos, seed };
  }, []);
  const uniforms = useMemo(() => ({ uTime: { value: 0 } }), []);
  useFrame((_, dt) => { uniforms.uTime.value += dt; });
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={data.pos} itemSize={3} args={[data.pos, 3]} />
        <bufferAttribute attach="attributes-aSeed" count={COUNT} array={data.seed} itemSize={1} args={[data.seed, 1]} />
      </bufferGeometry>
      <shaderMaterial
        uniforms={uniforms}
        transparent depthWrite={false} blending={THREE.AdditiveBlending}
        vertexShader={`attribute float aSeed; uniform float uTime; varying float vT;
          void main() { vT = 0.4 + 0.6 * (0.5 + 0.5 * sin(uTime * 0.6 + aSeed * 20.0));
            vec4 mv = modelViewMatrix * vec4(position,1.0);
            gl_PointSize = (0.8 + aSeed * 1.4) * (2.8 / -mv.z);
            gl_Position = projectionMatrix * mv; }`}
        fragmentShader={`varying float vT;
          void main() { vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard;
            float s=smoothstep(0.5,0.0,d); gl_FragColor=vec4(vec3(0.7,0.85,1.0), s*vT*0.35); }`}
      />
    </points>
  );
}
