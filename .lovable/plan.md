## Goal
Replace the current JARVIS core (overlapping tilted ring plates + fresnel sphere + satellites — reads as "clashing spheres") with a **neural network sphere**: nodes distributed on a sphere surface, connected by faint lines to nearest neighbors, gently pulsing. One coherent AI-brain silhouette, calm breathing at idle, more active when listening/thinking/speaking.

## What changes
Only `src/components/core/JarvisCore.tsx`. No other files touched. Voice states, colors, and the "open conversation" pill stay identical — same store hooks, same button.

## New composition (back → front)
```text
1. Faint bounded halo particles (kept — subtle depth)
2. Two thin concentric HUD rings with tick marks (kept — HUD framing)
3. NEW: Neural sphere
     - ~90 nodes fibonacci-distributed on a sphere (r ≈ 1.1)
     - Lines connecting each node to its 3 nearest neighbors
     - Nodes pulse individually (per-node phase); brighter nodes "fire"
     - Sphere slowly rotates on Y (calm breathing)
     - Voice state → color + pulse rate + firing frequency
4. Soft inner glow orb at center (small, low opacity — gives the sphere a "core")
```

Removed: `ReactorPlate` ×3 (the tilted overlapping rings), `Satellites`, the large fresnel `InnerCore` sphere. Those are what make it feel like "few spheres, current is a mess".

## Motion (calm — slow breathing)
- Idle: sphere rotates ~0.05 rad/s on Y, node pulse period ~4s, ~2 nodes firing/sec.
- Listening: rotation ×1.4, node pulse period ~2s, ~6 nodes firing/sec.
- Processing: rotation ×2.2, firing ~12/sec, color shifts to amber.
- Speaking: pulses sync to `voice.amplitude`, color shifts to green.
- Muted/paused: rotation frozen, dim palette.

## Technical detail
- Node positions: fibonacci sphere (deterministic, evenly spaced — no clumping).
- Edges: precomputed once per mount by k-NN (k=3) → single `LineSegments` with additive blending.
- Nodes: single `Points` with a custom shader; per-vertex `aSeed` + `aPhase` attributes drive independent flicker so it looks alive without rebuilding buffers each frame.
- Firing "spark": shader adds a brief brightness bump when `sin(uTime*rate + aPhase) > threshold`.
- Uniforms: `uTime`, `uAmp`, `uColor`, `uRate`, `uFireThreshold` — updated in one `useFrame` from `useVoice.getState()` (no re-renders, same pattern as today).
- HUD rings + halo particles: reused unchanged so the outer framing is stable.
- All additive blending on transparent black — no z-fighting, no depth writes.

## Verify
After the edit, load `/` and confirm:
- Center is a single recognizable sphere made of connected nodes (not multiple overlapping rings).
- Slow calm rotation at idle, no jitter.
- Tapping the core → state changes → color and pulse rate change visibly.
- "open conversation" pill still works and sits in the same place.
- No console errors, no drop in FPS vs. current.

## Not doing
- Not touching `Home.tsx`, `VoiceBar`, `CommandPalette`, stores, or any panel.
- Not adding new dependencies (three + @react-three/fiber already installed).
- Not changing the color palette / voice-state semantics.
