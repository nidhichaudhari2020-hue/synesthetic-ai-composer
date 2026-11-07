import * as THREE from "three";
export function createUniverse(canvas, getSpectrum) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: true,
      powerPreference: "low-power",
    });
  } catch {
    const fallback = document.createElement("p");
    fallback.className = "webgl-notice";
    fallback.textContent =
      "WebGL is unavailable in this browser. You can still compose, play and export music.";
    canvas.after(fallback);
    return { setShape() {}, setPaused() {}, dispose() {} };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
  const scene = new THREE.Scene(),
    camera = new THREE.PerspectiveCamera(44, 1, 0.1, 100);
  camera.position.z = 7.3;
  const N = 10000,
    positions = new Float32Array(N * 3),
    colors = new Float32Array(N * 3),
    sizes = new Float32Array(N),
    phases = new Float32Array(N),
    orb = new Float32Array(N * 3),
    galaxy = new Float32Array(N * 3),
    brain = new Float32Array(N * 3);
  let seed = 31;
  function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  for (let i = 0; i < N; i++) {
    const p = i * 3;
    let phi = rand() * Math.PI * 2,
      cost = rand() * 2 - 1,
      sint = Math.sqrt(1 - cost * cost),
      r = 1.35 * (0.55 + 0.45 * Math.cbrt(rand()));
    orb[p] = r * sint * Math.cos(phi);
    orb[p + 1] = r * cost;
    orb[p + 2] = r * sint * Math.sin(phi);
    let arm = i % 4,
      rad = Math.pow(rand(), 0.7) * 2.35,
      angle = (arm * Math.PI) / 2 + rad * 1.8 + (rand() - 0.5) * 0.6;
    galaxy[p] = Math.cos(angle) * rad;
    galaxy[p + 1] = (rand() - 0.5) * 0.25 + Math.sin(angle) * rad * 0.25;
    galaxy[p + 2] = Math.sin(angle) * rad * 0.75;
    let side = i % 2 ? 1 : -1,
      u = rand() * Math.PI * 2,
      v = Math.acos(rand() * 2 - 1),
      wrinkle =
        1 + 0.07 * Math.sin(u * 10 + Math.cos(v * 12) * 2) * Math.sin(v * 10);
    brain[p] =
      side * (0.31 + 0.65 * Math.abs(Math.sin(v) * Math.cos(u))) * wrinkle;
    brain[p + 1] = 1.1 * Math.cos(v) * wrinkle + 0.1;
    brain[p + 2] = 0.86 * Math.sin(v) * Math.sin(u) * wrinkle;
    if (rand() < 0.08) {
      brain[p] = side * 0.16 + Math.sin(u) * 0.2;
      brain[p + 1] = -0.95 - rand() * 0.6;
      brain[p + 2] = -0.2 + rand() * 0.3;
    }
    const mint = rand() + 0.45 * orb[p] - 0.24 * orb[p + 1] > 0.45,
      color = new THREE.Color(mint ? "#b9f4d2" : "#b69ce1");
    color.multiplyScalar(0.55 + rand() * 0.7);
    colors[p] = color.r;
    colors[p + 1] = color.g;
    colors[p + 2] = color.b;
    sizes[i] = rand() < 0.018 ? 3.5 : rand() * 1.7 + 0.6;
    phases[i] = rand() * 6.283;
    positions.set(orb.subarray(p, p + 3), p);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: true,
    uniforms: { pixelRatio: { value: Math.min(devicePixelRatio, 1.6) } },
    vertexShader:
      "attribute float size; varying vec3 vColor; uniform float pixelRatio; void main(){vColor=color;vec4 mv=modelViewMatrix*vec4(position,1.0);gl_PointSize=size*pixelRatio*(10.5/-mv.z);gl_Position=projectionMatrix*mv;}",
    fragmentShader:
      "varying vec3 vColor; void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;float a=pow(1.0-d*2.0,1.6);gl_FragColor=vec4(vColor,a*.98);}",
  });
  const points = new THREE.Points(geometry, material);
  // A second, sparse layer scatters soft light around the moving particles.
  const haloGeometry = new THREE.BufferGeometry();
  for (const name of ["position", "color", "size"])
    haloGeometry.setAttribute(name, geometry.getAttribute(name));
  haloGeometry.setDrawRange(0, 1800);
  const haloMaterial = material.clone();
  haloMaterial.vertexShader = material.vertexShader.replace(
    "10.5/-mv.z",
    "92.0/-mv.z",
  );
  haloMaterial.fragmentShader =
    "varying vec3 vColor; void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;gl_FragColor=vec4(vColor,exp(-5.*r*r)*.045);}";
  points.add(new THREE.Points(haloGeometry, haloMaterial));
  points.position.y = 0.25;
  scene.add(points);
  // Sparse stars give depth without competing with the foreground cloud.
  const starsGeo = new THREE.BufferGeometry(),
    sp = new Float32Array(210 * 3);
  for (let i = 0; i < sp.length; i++)
    sp[i] = (rand() - 0.5) * (i % 3 === 2 ? 5 : 12);
  starsGeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(
    starsGeo,
    new THREE.PointsMaterial({
      color: "#819d92",
      size: 0.008,
      transparent: true,
      opacity: 0.3,
    }),
  );
  scene.add(stars);
  let shape = "orb",
    paused = matchMedia("(prefers-reduced-motion: reduce)").matches,
    time = 0,
    last = 0,
    frame = 0,
    mx = 0,
    my = 0;
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    mx = (e.clientX - r.left) / r.width - 0.5;
    my = (e.clientY - r.top) / r.height - 0.5;
  };
  canvas.addEventListener("pointermove", onMove);
  function resize() {
    const { width, height } = canvas.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.position.z = width < 500 ? 7.2 : 7.3;
    camera.updateProjectionMatrix();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  function animate(ms) {
    frame = requestAnimationFrame(animate);
    const dt = Math.min((ms - last) / 1000, 0.05) || 0.016;
    last = ms;
    if (document.hidden || !canvas.offsetWidth) return;
    const a = paused ? { bass: 0, treble: 0 } : getSpectrum();
    if (!paused) time += dt * (1 + 2 * a.treble);
    const target = { orb, galaxy, brain }[shape];
    const breathe = 1 + Math.sin(time * 0.8) * 0.035 + a.bass * 0.2;
    for (let i = 0; i < N; i++) {
      const p = i * 3;
      const wave = paused
        ? 0
        : Math.sin(time * (0.4 + a.treble * 4) + phases[i]) * 0.017;
      for (let j = 0; j < 3; j++)
        positions[p + j] +=
          (target[p + j] * breathe + wave - positions[p + j]) *
          Math.min(1, dt * (2.6 + a.bass * 4 + a.treble * 8));
    }
    geometry.attributes.position.needsUpdate = true;
    points.rotation.y = paused ? 0 : Math.sin(time * 0.09) * 0.36 + mx * 0.14;
    points.rotation.x = paused ? 0 : my * 0.08;
    points.rotation.z =
      shape === "galaxy" ? time * 0.035 : Math.sin(time * 0.08) * 0.08;
    renderer.render(scene, camera);
  }
  frame = requestAnimationFrame(animate);
  return {
    setShape(value) {
      shape = value;
    },
    setPaused(value) {
      paused = value;
    },
    dispose() {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      geometry.dispose();
      material.dispose();
      haloGeometry.dispose();
      haloMaterial.dispose();
      starsGeo.dispose();
      stars.material.dispose();
      renderer.dispose();
    },
  };
}
