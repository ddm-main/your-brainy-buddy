import { Canvas, useFrame, useLoader } from "@react-three/fiber";
import { OrbitControls, Stars, Line, Sphere } from "@react-three/drei";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { useVoice } from "@/store/voiceStore";

export default function EarthCore() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Canvas
        camera={{ position: [0, 0, 5.4], fov: 45 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 2]}
      >
        <ambientLight intensity={0.25} />
        <pointLight position={[6, 4, 6]} intensity={1.4} color="#7fe9ff" />
        <pointLight position={[-6, -3, -4]} intensity={0.6} color="#1e4d7a" />
        <Suspense fallback={null}>
          <Stars radius={60} depth={30} count={2500} factor={2.5} fade speed={0.4} />
          <Scene />
        </Suspense>
        <OrbitControls
          enablePan={false}
          enableZoom={false}
          autoRotate
          autoRotateSpeed={0.6}
          minPolarAngle={Math.PI / 3}
          maxPolarAngle={Math.PI / 1.6}
        />
      </Canvas>
    </div>
  );
}

function Scene() {
  const group = useRef<THREE.Group>(null!);
  const voiceState = useVoice((s) => s.state);
  const amp = useVoice((s) => s.amplitude);

  useFrame((_, dt) => {
    if (!group.current) return;
    const speed = voiceState === "listening" ? 1 + amp * 2 : voiceState === "processing" ? 1.6 : 0.35;
    group.current.rotation.y += dt * 0.08 * speed;
  });

  return (
    <group ref={group}>
      <WireframeEarth />
      <AtmosphereFresnel />
      <ArcReactorCage />
      <OrbitRing radius={2.35} color="#35d6ed" tilt={0.15} speed={0.25} ticks={24} />
      <OrbitRing radius={2.7} color="#ffb84d" tilt={-0.35} speed={-0.18} ticks={18} />
      <OrbitRing radius={3.05} color="#7fe9ff" tilt={0.55} speed={0.12} ticks={12} />
      <Hotspots />
      <ParticleField />
    </group>
  );
}

function WireframeEarth() {
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({
      color: new THREE.Color("#35d6ed"),
      wireframe: true,
      transparent: true,
      opacity: 0.55,
    }),
    []
  );

  const solidMat = useMemo(
    () => new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColorA: { value: new THREE.Color("#0a1929") },
        uColorB: { value: new THREE.Color("#35d6ed") },
      },
      transparent: true,
      side: THREE.FrontSide,
      vertexShader: `
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        varying vec3 vNormal;
        varying vec2 vUv;
        void main() {
          float lat = sin(vUv.y * 40.0);
          float lon = sin(vUv.x * 60.0);
          float grid = smoothstep(0.85, 1.0, max(abs(lat), abs(lon)));
          float scan = sin((vUv.y + uTime * 0.15) * 30.0) * 0.5 + 0.5;
          float rim = 1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0);
          vec3 col = mix(uColorA, uColorB, grid * 0.9);
          col += uColorB * scan * 0.08;
          col += uColorB * pow(rim, 2.0) * 0.4;
          gl_FragColor = vec4(col, 0.85);
        }
      `,
    }),
    []
  );
  const solidRef = useRef<THREE.ShaderMaterial>(solidMat);
  useFrame((_, dt) => { if (solidRef.current) solidRef.current.uniforms.uTime.value += dt; });

  return (
    <>
      <mesh>
        <sphereGeometry args={[1.5, 48, 32]} />
        <primitive object={solidMat} ref={solidRef} attach="material" />
      </mesh>
      <mesh scale={1.005}>
        <sphereGeometry args={[1.5, 24, 16]} />
        <primitive object={mat} attach="material" />
      </mesh>
    </>
  );
}

function AtmosphereFresnel() {
  const matRef = useRef<THREE.ShaderMaterial>(null!);
  const amp = useVoice((s) => s.amplitude);
  const state = useVoice((s) => s.state);
  useFrame((_, dt) => {
    if (!matRef.current) return;
    matRef.current.uniforms.uTime.value += dt;
    matRef.current.uniforms.uIntensity.value = state === "listening" ? 1.3 + amp * 1.5 : state === "speaking" ? 1.6 : 1.0;
  });

  const mat = useMemo(
    () => new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 1.0 },
        uColor: { value: new THREE.Color("#35d6ed") },
      },
      transparent: true,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uColor;
        varying vec3 vNormal;
        void main() {
          float rim = pow(1.0 - abs(dot(vNormal, vec3(0.0, 0.0, 1.0))), 3.0);
          float pulse = 0.9 + 0.1 * sin(uTime * 1.5);
          gl_FragColor = vec4(uColor * rim * uIntensity * pulse, rim * 0.6);
        }
      `,
    }),
    []
  );

  return (
    <mesh scale={1.18}>
      <sphereGeometry args={[1.5, 48, 32]} />
      <primitive object={mat} ref={matRef} attach="material" />
    </mesh>
  );
}

function ArcReactorCage() {
  const arcs = 6;
  return (
    <group>
      {Array.from({ length: arcs }).map((_, i) => {
        const angle = (i / arcs) * Math.PI * 2;
        const points: [number, number, number][] = [];
        const r = 2.05;
        for (let s = -0.9; s <= 0.9; s += 0.05) {
          const y = s;
          const rr = r * Math.sqrt(1 - y * y * 0.6);
          points.push([Math.cos(angle) * rr, y, Math.sin(angle) * rr]);
        }
        return (
          <Line
            key={i}
            points={points}
            color="#35d6ed"
            lineWidth={0.6}
            transparent
            opacity={0.4}
          />
        );
      })}
      <RotatingArmature />
    </group>
  );
}

function RotatingArmature() {
  const ref = useRef<THREE.Group>(null!);
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.z += dt * 0.3; });
  const points: [number, number, number][] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
    points.push([Math.cos(a) * 1.95, Math.sin(a) * 1.95, 0]);
  }
  return (
    <group ref={ref}>
      <Line points={points} color="#7fe9ff" lineWidth={0.8} transparent opacity={0.5} />
      {[0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((a, i) => (
        <mesh key={i} position={[Math.cos(a) * 1.95, Math.sin(a) * 1.95, 0]}>
          <sphereGeometry args={[0.04, 8, 8]} />
          <meshBasicMaterial color="#7fe9ff" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function OrbitRing({ radius, color, tilt, speed, ticks }:
  { radius: number; color: string; tilt: number; speed: number; ticks: number }) {
  const ref = useRef<THREE.Group>(null!);
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * speed; });
  const points: [number, number, number][] = [];
  for (let a = 0; a <= Math.PI * 2 + 0.01; a += 0.05) {
    points.push([Math.cos(a) * radius, 0, Math.sin(a) * radius]);
  }
  return (
    <group ref={ref} rotation={[tilt, 0, tilt * 0.5]}>
      <Line points={points} color={color} lineWidth={0.6} transparent opacity={0.35} />
      {Array.from({ length: ticks }).map((_, i) => {
        const a = (i / ticks) * Math.PI * 2;
        return (
          <mesh key={i} position={[Math.cos(a) * radius, 0, Math.sin(a) * radius]}>
            <boxGeometry args={[0.05, 0.05, 0.05]} />
            <meshBasicMaterial color={color} toneMapped={false} />
          </mesh>
        );
      })}
    </group>
  );
}

function Hotspots() {
  const hotspots = [
    { lat: 20, lon: 78, color: "#35d6ed" },
    { lat: 40, lon: -74, color: "#ffb84d" },
    { lat: -33, lon: 151, color: "#7fe9ff" },
  ];
  return (
    <group>
      {hotspots.map((h, i) => {
        const phi = (90 - h.lat) * (Math.PI / 180);
        const theta = (h.lon + 180) * (Math.PI / 180);
        const r = 1.5;
        const x = -r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.cos(phi);
        const z = r * Math.sin(phi) * Math.sin(theta);
        return <Beacon key={i} pos={[x, y, z]} color={h.color} />;
      })}
    </group>
  );
}

function Beacon({ pos, color }: { pos: [number, number, number]; color: string }) {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    const s = 1 + Math.sin(clock.elapsedTime * 3 + pos[0]) * 0.3;
    ref.current.scale.setScalar(s);
  });
  const dir = new THREE.Vector3(...pos).normalize();
  const tip = new THREE.Vector3(...pos).addScaledVector(dir, 0.4);
  return (
    <group>
      <mesh ref={ref} position={pos}>
        <sphereGeometry args={[0.04, 8, 8]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
      <Line points={[pos, tip.toArray() as [number, number, number]]} color={color} lineWidth={0.8} transparent opacity={0.7} />
    </group>
  );
}

function ParticleField() {
  const ref = useRef<THREE.Points>(null!);
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const count = 600;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 3.5 + Math.random() * 2;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(p) * Math.cos(t);
      pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      pos[i * 3 + 2] = r * Math.cos(p);
    }
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    return g;
  }, []);
  useFrame((_, dt) => { if (ref.current) ref.current.rotation.y += dt * 0.02; });
  return (
    <points ref={ref} geometry={geom}>
      <pointsMaterial size={0.02} color="#7fe9ff" transparent opacity={0.7} sizeAttenuation blending={THREE.AdditiveBlending} />
    </points>
  );
}
