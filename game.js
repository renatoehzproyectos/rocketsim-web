// RocketSim-Web demo
// Física de balón y auto EXACTA (RocketSim/WASM). Render simple: caja = hitbox real de
// Octane, piso de referencia, balón del radio real.
//
// Cámara y controles inspirados en ArcAr-Android (game_engine.cpp RebuildCamera() +
// InputMapper.java). El loop de cada frame está escrito para asignar la MÍNIMA memoria nueva
// posible (todo se reutiliza en buffers fijos).
//
// FIX 2026-09-27: 1 snapshot por frame + fallback automático a get*StateInto.
// - Si el WASM tiene getBallStateInto/getCarStateInto → zero alloc (ideal).
// - Si no → usa getBallState/getCarState (compatible con WASM viejo).
// Antes: getState 2-4x/frame → GC spikes ~32ms. Ahora 1x/frame (+ Into cuando haya).

import RocketSimModule from './dist/rocketsim.js';
import { pollGamepad } from './gamepad.js?v=5';

const TICK_RATE = 120;
const TICK_TIME = 1 / TICK_RATE;
const UU_TO_M = 1 / 50; // solo cosmético, para que la escena de three.js tenga una escala cómoda

// ---------- conversión de coordenadas RocketSim (Z-arriba) -> three.js (Y-arriba) ----------
// Nota: todas estas funciones escriben en un objeto/array que se les pasa (out), en vez de
// crear uno nuevo, para no generar basura en el loop de cada frame.
function rsToThreeInto(x, y, z, out) {
  out.x = x * UU_TO_M; out.y = z * UU_TO_M; out.z = -y * UU_TO_M;
  return out;
}
function rsDirToThreeInto(x, y, z, out) {
  out.x = x; out.y = z; out.z = -y;
  return out;
}

const _tmpMat = new THREE.Matrix4();
const _tmpX = new THREE.Vector3();
const _tmpY = new THREE.Vector3();
const _tmpZ = new THREE.Vector3();
const _dirTmp = { x: 0, y: 0, z: 0 };
// rot9: Float32Array(9) = [forward(3), right(3), up(3)] en espacio RocketSim.
// BoxGeometry: eje local X = largo (hb.x, "adelante" del auto), Y = ancho (hb.y, "derecha"),
// Z = alto (hb.z, "arriba"). Los ejes de la base van en ESE orden -- (forward, right, up) tal
// cual, sin negar nada: RocketSim cumple forward × right = up, y la transformación de
// coordenadas usada aquí tiene determinante +1 (es una rotación propia, no un espejo), así
// que preserva el producto cruz.
function rsRotToThreeQuat(rot9, outQuat) {
  rsDirToThreeInto(rot9[0], rot9[1], rot9[2], _dirTmp);
  _tmpX.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  rsDirToThreeInto(rot9[3], rot9[4], rot9[5], _dirTmp);
  _tmpY.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  rsDirToThreeInto(rot9[6], rot9[7], rot9[8], _dirTmp);
  _tmpZ.set(_dirTmp.x, _dirTmp.y, _dirTmp.z);
  _tmpMat.makeBasis(_tmpX, _tmpY, _tmpZ);
  outQuat.setFromRotationMatrix(_tmpMat);
  return outQuat;
}

// ---------- cámara de persecución (portada de ArcAr GameEngine::RebuildCamera) ----------
// Todo en unidades RocketSim (UU), igual que el original en C++. Sin asignaciones: todos los
// vectores intermedios son arrays fijos reutilizados.
const cam = { ballCam: true, pos: [0, -3000, 200], target: [0, 0, 100] };
const _fwd = [0, 0, 0], _toBall = [0, 0, 0], _look = [0, 0, 0];
const _desiredPos = [0, 0, 0], _desiredTgt = [0, 0, 0];

function rebuildCamera(carPos, carFwd, carVel, ballPos, onGround) {
  const flen = Math.hypot(carFwd[0], carFwd[1], carFwd[2]);
  if (flen > 1e-4) { _fwd[0] = carFwd[0] / flen; _fwd[1] = carFwd[1] / flen; _fwd[2] = carFwd[2] / flen; }
  else { _fwd[0] = 0; _fwd[1] = 1; _fwd[2] = 0; }

  const speed = Math.hypot(carVel[0], carVel[1], carVel[2]);
  const speed01 = Math.min(speed / 2300, 1);

  const camDist = 280 + speed01 * 60;
  const camHeight = 110 + (onGround ? 0 : 25);
  const lookAhead = 60 + speed01 * 80;

  if (cam.ballCam) {
    _toBall[0] = ballPos[0] - carPos[0]; _toBall[1] = ballPos[1] - carPos[1]; _toBall[2] = ballPos[2] - carPos[2];
    const tlen = Math.hypot(_toBall[0], _toBall[1], _toBall[2]);
    let dx, dy, dz;
    if (tlen > 50) { dx = _toBall[0] / tlen; dy = _toBall[1] / tlen; dz = _toBall[2] / tlen; }
    else { dx = _fwd[0]; dy = _fwd[1]; dz = _fwd[2]; }
    const dist = Math.min(Math.max(tlen * 0.35, 220), 500);
    _desiredPos[0] = carPos[0] - dx * dist;
    _desiredPos[1] = carPos[1] - dy * dist;
    _desiredPos[2] = carPos[2] + camHeight + Math.min(tlen * 0.04, 60);
    _desiredTgt[0] = carPos[0] * 0.3 + ballPos[0] * 0.7;
    _desiredTgt[1] = carPos[1] * 0.3 + ballPos[1] * 0.7;
    _desiredTgt[2] = carPos[2] * 0.3 + ballPos[2] * 0.7 + 25;
  } else {
    _look[0] = _fwd[0]; _look[1] = _fwd[1]; _look[2] = _fwd[2];
    const vlen = Math.hypot(carVel[0], carVel[1], carVel[2]);
    if (vlen > 50) {
      _look[0] = _fwd[0] * 0.6 + (carVel[0] / vlen) * 0.4;
      _look[1] = _fwd[1] * 0.6 + (carVel[1] / vlen) * 0.4;
      _look[2] = _fwd[2] * 0.6 + (carVel[2] / vlen) * 0.4;
      const ll = Math.hypot(_look[0], _look[1], _look[2]);
      if (ll > 1e-4) { _look[0] /= ll; _look[1] /= ll; _look[2] /= ll; }
    }
    _desiredPos[0] = carPos[0] - _look[0] * camDist;
    _desiredPos[1] = carPos[1] - _look[1] * camDist;
    _desiredPos[2] = carPos[2] + camHeight;
    _desiredTgt[0] = carPos[0] + _look[0] * lookAhead;
    _desiredTgt[1] = carPos[1] + _look[1] * lookAhead;
    _desiredTgt[2] = carPos[2] + 20;
  }

  const follow = 0.15;
  for (let i = 0; i < 3; i++) {
    cam.pos[i] += (_desiredPos[i] - cam.pos[i]) * follow;
    cam.target[i] += (_desiredTgt[i] - cam.target[i]) * follow;
  }
}

async function main() {
  let Module;
  try {
    Module = await RocketSimModule();
  } catch (err) {
    document.getElementById('stats').textContent = 'Error cargando el módulo WASM: ' + err;
    console.error(err);
    return;
  }

  Module.init();
  Module.createArena();
  const carId = Module.addCar(0);
  Module.setCarState(carId, 0, -2560, 100, 0, 0, 0);

  const hb = Module.getOctaneHitboxSize(); // {x: largo, y: ancho, z: alto}, en UU

  const canvas = document.getElementById('c');
  // MEMORY: no antialias, pixelRatio=1, no PBR tone mapping, minimal lights
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: 'low-power',
    alpha: false,
    stencil: false,
    depth: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1); // fixed 1: biggest GPU memory saver on mobile
  renderer.outputEncoding = THREE.sRGBEncoding;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0e14);

  // Hemisphere + soft directional so MeshStandardMaterial (Fennec body/wheels) is not pitch-black
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(8, 18, 6);
  scene.add(dirLight);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 500);

  // ---------- cancha (medidas reales del mapa estándar competitivo de Rocket League) ----------
  // Todo esto es SOLO visual -- la física sigue usando los planos simples de RLConst que ya
  // tenía (ver patch en Arena.cpp); esto no cambia ninguna colisión, solo cómo se ve la cancha.
  const FIELD_HALF_X = 4096, FIELD_HALF_Y = 5120, CEILING_Z = 2048;
  // Longitud del plano de la esquina (1629.174uu a 45°) -> el recorte a lo largo de cada eje
  // es esa longitud * cos(45°).
  const CORNER_CUT = 1629.174 * Math.SQRT1_2; // ≈ 1152uu

  function fieldPoint(x, y) {
    // (x,y) en espacio RocketSim (X=ancho, Y=largo) -> three.js (X, 0, -Y), a escala UU_TO_M.
    return new THREE.Vector2(x * UU_TO_M, -y * UU_TO_M);
  }
  // Rectángulo con las 4 esquinas recortadas a 45°, en el orden en que three.js espera un Shape.
  const fieldShapePts = [
    fieldPoint(FIELD_HALF_X - CORNER_CUT, FIELD_HALF_Y),
    fieldPoint(-(FIELD_HALF_X - CORNER_CUT), FIELD_HALF_Y),
    fieldPoint(-FIELD_HALF_X, FIELD_HALF_Y - CORNER_CUT),
    fieldPoint(-FIELD_HALF_X, -(FIELD_HALF_Y - CORNER_CUT)),
    fieldPoint(-(FIELD_HALF_X - CORNER_CUT), -FIELD_HALF_Y),
    fieldPoint(FIELD_HALF_X - CORNER_CUT, -FIELD_HALF_Y),
    fieldPoint(FIELD_HALF_X, -(FIELD_HALF_Y - CORNER_CUT)),
    fieldPoint(FIELD_HALF_X, FIELD_HALF_Y - CORNER_CUT),
  ];
  const fieldShape = new THREE.Shape(fieldShapePts);
  const floor = new THREE.Mesh(
    new THREE.ShapeGeometry(fieldShape),
    new THREE.MeshBasicMaterial({ color: 0x14361f, side: THREE.DoubleSide })
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Líneas de la cancha (borde + línea central), dibujadas encima del piso.
  const fieldOutline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      fieldShapePts.map(p => new THREE.Vector3(p.x, 0.01, p.y))
    ),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  scene.add(fieldOutline);
  const centerLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-FIELD_HALF_X * UU_TO_M, 0.01, 0),
      new THREE.Vector3(FIELD_HALF_X * UU_TO_M, 0.01, 0),
    ]),
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })
  );
  scene.add(centerLine);

  // Paredes laterales y traseras (solo el segmento recto; sin las curvas de esquina/rampa,
  // que aquí no importan porque no son parte de la colisión real usada).
  const wallMat = new THREE.MeshBasicMaterial({
    color: 0x335577, transparent: true, opacity: 0.15, side: THREE.DoubleSide,
  });
  const sideWallGeo = new THREE.PlaneGeometry(7936 * UU_TO_M, CEILING_Z * UU_TO_M);
  const wallXPos = new THREE.Mesh(sideWallGeo, wallMat);
  wallXPos.position.set(FIELD_HALF_X * UU_TO_M, CEILING_Z * UU_TO_M / 2, 0);
  wallXPos.rotation.y = Math.PI / 2;
  scene.add(wallXPos);
  const wallXNeg = wallXPos.clone();
  wallXNeg.position.x = -FIELD_HALF_X * UU_TO_M;
  scene.add(wallXNeg);

  const backWallGeo = new THREE.PlaneGeometry(5888 * UU_TO_M, CEILING_Z * UU_TO_M);
  const wallYPos = new THREE.Mesh(backWallGeo, wallMat);
  wallYPos.position.set(0, CEILING_Z * UU_TO_M / 2, -FIELD_HALF_Y * UU_TO_M);
  scene.add(wallYPos);
  const wallYNeg = wallYPos.clone();
  wallYNeg.position.z = FIELD_HALF_Y * UU_TO_M;
  scene.add(wallYNeg);

  // Arcos: marco simple (postes + travesaño) con las medidas reales, en cada línea de gol.
  const GOAL_HALF_WIDTH = 892.755, GOAL_HEIGHT = 642.775, GOAL_DEPTH = 880;
  const goalMat = new THREE.LineBasicMaterial({ color: 0xffcc33 });
  function buildGoal(goalY) {
    const sign = Math.sign(goalY) || 1;
    const gy = -goalY * UU_TO_M; // conversión Y(RS) -> Z(three), con signo invertido
    const x0 = -GOAL_HALF_WIDTH * UU_TO_M, x1 = GOAL_HALF_WIDTH * UU_TO_M;
    const h = GOAL_HEIGHT * UU_TO_M, d = GOAL_DEPTH * UU_TO_M * sign;
    const pts = [
      [x0, 0, gy], [x0, h, gy], [x1, h, gy], [x1, 0, gy], [x1, h, gy],
      [x1, h, gy + d], [x0, h, gy + d], [x0, h, gy], [x0, h, gy + d], [x0, 0, gy + d],
      [x0, 0, gy], [x1, 0, gy], [x1, 0, gy + d], [x0, 0, gy + d],
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(...p)));
    scene.add(new THREE.Line(geo, goalMat));
  }
  buildGoal(FIELD_HALF_Y);
  buildGoal(-FIELD_HALF_Y);

  // Boost pads: grandes (dorado, 100%) y chicos (blanco, 12%) con las coordenadas dadas.
  // Los 34 chicos no vinieron todos con coordenadas exactas; se dibujan los de la línea
  // central (Y=0) que sí se dieron -- el resto de carriles quedaría por agregar si hace falta.
  // Shared materials + low-segment cylinders (memory)
  const padMatBig = new THREE.MeshBasicMaterial({ color: 0xffcc33 });
  const padMatSmall = new THREE.MeshBasicMaterial({ color: 0xdddddd });
  function addPad(x, y, big) {
    const r = (big ? 65 : 35) * UU_TO_M;
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, 0.05, 8),
      big ? padMatBig : padMatSmall
    );
    pad.position.set(x * UU_TO_M, 0.03, -y * UU_TO_M);
    scene.add(pad);
  }
  const bigPadCoords = [
    [3072, 4096], [3072, -4096], [-3072, 4096], [-3072, -4096],
    [3584, 0], [-3584, 0],
  ];
  bigPadCoords.forEach(([x, y]) => addPad(x, y, true));
  const smallPadCoordsCenterLine = [
    [256, 0], [-256, 0], [1024, 0], [-1024, 0], [1792, 0], [-1792, 0],
  ];
  smallPadCoordsCenterLine.forEach(([x, y]) => addPad(x, y, false));

  const ballState0 = Module.getBallState();
  // Low-poly ball (MeshBasic = no lighting uniforms)
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(ballState0.radius * UU_TO_M, 12, 8),
    new THREE.MeshBasicMaterial({ color: 0xe8a020 })
  );
  scene.add(ball);

  // Fennec visual. Local axes: X = forward, Y = right, Z = up.
  const carMesh = new THREE.Group();
  scene.add(carMesh);
  const wheelRig = [];
  let wheelSpin = 0;
  {
    const L = hb.x * UU_TO_M, W = hb.y * UU_TO_M, H = hb.z * UU_TO_M;
    const textureLoader = new THREE.TextureLoader();
    const bodyMap = textureLoader.load('assets/Chassis_Grain_D.png');
    const bodyNormal = textureLoader.load('assets/Chassis_Grain_N.png');
    const wheelMap = textureLoader.load('assets/Alpha_D.png');
    const wheelNormal = textureLoader.load('assets/Alpha_N.png');
    bodyMap.encoding = THREE.sRGBEncoding;
    wheelMap.encoding = THREE.sRGBEncoding;
    bodyMap.flipY = bodyNormal.flipY = wheelMap.flipY = wheelNormal.flipY = false;

    const gltf = await new Promise((resolve, reject) => {
      new THREE.GLTFLoader().load('assets/fennec.glb', resolve, undefined, reject);
    }).catch(err => { console.error('Fennec no cargó:', err); return null; });
    const source = gltf ? gltf.scene : new THREE.Group();
    const body = gltf ? source.getObjectByName('Fennec') : null;
    const wheelOrder = ['FR', 'FL', 'BR', 'BL'];
    const wheels = wheelOrder.map(code => {
      let match = null;
      source.traverse(child => {
        if (!match && child.name.startsWith('Alpha') && child.name.includes(code)) match = child;
      });
      return match;
    });

    if (body) {
      source.traverse(child => {
        if (!child.isMesh) return;
        const name = Array.isArray(child.material)
          ? child.material.map(material => material.name).join(' ')
          : child.material?.name || '';
        if (/Window/i.test(name)) {
          child.material = new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.2, metalness: 0.15 });
        } else if (/Headlight/i.test(name)) {
          child.material = new THREE.MeshStandardMaterial({ color: 0xe8f5ff, emissive: 0x8ac8ff, emissiveIntensity: 0.7 });
        } else if (/Alpha|Dieci/i.test(name)) {
          child.material = new THREE.MeshStandardMaterial({ map: wheelMap, normalMap: wheelNormal, color: 0x30343a, roughness: 0.7, metalness: 0.35 });
        } else {
          child.material = new THREE.MeshStandardMaterial({ map: bodyMap, normalMap: bodyNormal, color: 0x2f74d0, roughness: 0.55, metalness: 0.15 });
        }
      });
      const box = new THREE.Box3().setFromObject(source);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = (L * 0.98) / size.x;
      source.scale.setScalar(scale);
      source.rotation.x = Math.PI / 2;
      source.position.set(-center.x * scale, center.z * scale, -box.min.y * scale - H * 0.48);
      carMesh.add(source);

      wheels.forEach((wheel, index) => {
        if (!wheel) return;
        wheelRig.push({
          wheel,
          baseY: wheel.position.y,
          baseQuaternion: wheel.quaternion.clone(),
          front: index < 2,
          right: index === 0 || index === 2,
          modelScale: scale,
        });
      });
    }
  }

  // ---------- Hit sparks (car↔ball / car↔wall) — bright Additive + bloom-like flash like RL ----------
  const BALL_RADIUS_UU = ballState0.radius || 91.25;
  const CAR_HIT_RADIUS_UU = Math.max(hb.x, hb.y) * 0.55; // approx outer radius of hitbox
  const SPARK_POOL = 8;
  const sparkTex = new THREE.TextureLoader().load('assets/fading-sparkler.webp');
  sparkTex.encoding = THREE.sRGBEncoding;
  const sparkMat = new THREE.SpriteMaterial({
    map: sparkTex,
    color: 0xffee88,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
  });
  const sparks = [];
  for (let i = 0; i < SPARK_POOL; i++) {
    const s = new THREE.Sprite(sparkMat.clone());
    s.visible = false;
    s.scale.set(0.01, 0.01, 1);
    scene.add(s);
    sparks.push({
      sprite: s,
      life: 0,
      maxLife: 0.28,
      baseScale: 1.8,
      rotSpeed: 0,
    });
  }
  // Extra flash light for bloom-ish overexposure (short lived)
  const sparkLight = new THREE.PointLight(0xffcc66, 0, 12, 2);
  scene.add(sparkLight);
  let sparkLightLife = 0;

  // Hit detection state (UU space)
  let prevBallVel = { x: 0, y: 0, z: 0 };
  let prevCarVel = { x: 0, y: 0, z: 0 };
  let hitCooldown = 0; // seconds

  function spawnSpark(x, y, z, intensity = 1) {
    // Find free or oldest spark
    let best = sparks[0];
    for (const sp of sparks) {
      if (sp.life <= 0) { best = sp; break; }
      if (sp.life < best.life) best = sp;
    }
    const sp = best;
    rsToThreeInto(x, y, z, bp3); // reuse bp3 temp
    sp.sprite.position.set(bp3.x, bp3.y, bp3.z);
    sp.life = sp.maxLife;
    sp.baseScale = 1.4 + intensity * 1.6;
    sp.rotSpeed = (Math.random() - 0.5) * 8;
    sp.sprite.material.opacity = 1;
    sp.sprite.material.color.setHex(intensity > 0.7 ? 0xfff0a0 : 0xffcc66);
    sp.sprite.visible = true;
    sp.sprite.scale.set(sp.baseScale * 0.3, sp.baseScale * 0.3, 1);
    // Flash light
    sparkLight.position.copy(sp.sprite.position);
    sparkLight.intensity = 4 + intensity * 6;
    sparkLightLife = 0.18;
  }

  function updateSparks(dt) {
    hitCooldown = Math.max(0, hitCooldown - dt);
    sparkLightLife = Math.max(0, sparkLightLife - dt);
    if (sparkLightLife <= 0) sparkLight.intensity = 0;
    else sparkLight.intensity *= Math.max(0, 1 - dt * 9);

    for (const sp of sparks) {
      if (sp.life <= 0) {
        if (sp.sprite.visible) sp.sprite.visible = false;
        continue;
      }
      sp.life -= dt;
      const t = 1 - Math.max(sp.life, 0) / sp.maxLife; // 0→1
      // Fast bright flash then fade (RL style)
      const fade = t < 0.15 ? 1 : Math.pow(1 - (t - 0.15) / 0.85, 1.8);
      sp.sprite.material.opacity = fade;
      const sc = sp.baseScale * (0.35 + t * 1.1);
      sp.sprite.scale.set(sc, sc, 1);
      sp.sprite.material.rotation += sp.rotSpeed * dt;
      if (sp.life <= 0) sp.sprite.visible = false;
    }
  }

  function checkHits() {
    if (hitCooldown > 0) return;
    const bx = currState.ballPos.x, by = currState.ballPos.y, bz = currState.ballPos.z;
    const cx = currState.carPos.x, cy = currState.carPos.y, cz = currState.carPos.z;
    const dx = bx - cx, dy = by - cy, dz = bz - cz;
    const dist = Math.hypot(dx, dy, dz);
    const contactDist = BALL_RADIUS_UU + CAR_HIT_RADIUS_UU;

    // --- car ↔ ball ---
    // Sudden change in relative velocity while close = impact
    const rvx = currState.ballVel.x - currState.carVel.x;
    const rvy = currState.ballVel.y - currState.carVel.y;
    const rvz = currState.ballVel.z - currState.carVel.z;
    const relSpeed = Math.hypot(rvx, rvy, rvz);
    const prevRvx = prevBallVel.x - prevCarVel.x;
    const prevRvy = prevBallVel.y - prevCarVel.y;
    const prevRvz = prevBallVel.z - prevCarVel.z;
    const prevRel = Math.hypot(prevRvx, prevRvy, prevRvz);
    const velDelta = Math.abs(relSpeed - prevRel);

    if (dist < contactDist + 25 && (velDelta > 350 || (relSpeed > 600 && dist < contactDist + 8))) {
      // Contact point roughly between car and ball, biased toward surface
      const t = BALL_RADIUS_UU / (dist || 1);
      const hx = bx - dx * t * 0.55;
      const hy = by - dy * t * 0.55;
      const hz = bz - dz * t * 0.55;
      const intensity = Math.min(1.4, 0.4 + relSpeed / 2500 + velDelta / 1800);
      spawnSpark(hx, hy, hz, intensity);
      // Extra secondary burst for strong hits (RL multi-spark feel)
      if (intensity > 0.85) {
        spawnSpark(hx + (Math.random() - 0.5) * 18, hy + (Math.random() - 0.5) * 18, hz + (Math.random() - 0.5) * 12, intensity * 0.7);
      }
      hitCooldown = 0.09;
    }

    // --- car ↔ wall (side / back) ---
    const wallMargin = 90;
    const speedInto = Math.hypot(currState.carVel.x, currState.carVel.y);
    if (speedInto > 900) {
      let wallHit = false;
      let wx = cx, wy = cy, wz = cz;
      if (Math.abs(cx) > FIELD_HALF_X - wallMargin) {
        wallHit = true;
        wx = Math.sign(cx) * (FIELD_HALF_X - 20);
      } else if (Math.abs(cy) > FIELD_HALF_Y - wallMargin) {
        wallHit = true;
        wy = Math.sign(cy) * (FIELD_HALF_Y - 20);
      }
      // Detect impact by velocity component reversing or high speed near wall
      if (wallHit) {
        const intoX = Math.abs(cx) > FIELD_HALF_X - wallMargin && Math.sign(currState.carVel.x) === Math.sign(cx);
        const intoY = Math.abs(cy) > FIELD_HALF_Y - wallMargin && Math.sign(currState.carVel.y) === Math.sign(cy);
        const prevInto = (Math.abs(prevCarVel.x) > 400 && Math.sign(prevCarVel.x) === Math.sign(cx)) ||
                         (Math.abs(prevCarVel.y) > 400 && Math.sign(prevCarVel.y) === Math.sign(cy));
        if ((intoX || intoY) || (prevInto && speedInto > 1200)) {
          const intensity = Math.min(1.3, speedInto / 2800);
          spawnSpark(wx, wy, wz + 40, intensity);
          hitCooldown = 0.12;
        }
      }
    }

    prevBallVel.x = currState.ballVel.x; prevBallVel.y = currState.ballVel.y; prevBallVel.z = currState.ballVel.z;
    prevCarVel.x = currState.carVel.x; prevCarVel.y = currState.carVel.y; prevCarVel.z = currState.carVel.z;
  }

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------- controles (teclado + mobile UI) ----------
  const keys = new Set();
  window.addEventListener('keydown', e => {
    keys.add(e.code);
    if (e.code === 'KeyR') Module.resetBall();
    if (e.code === 'KeyC') cam.ballCam = !cam.ballCam;
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  // Objeto de controles reutilizado (no se crea uno nuevo cada frame).
  const ctl = { throttle: 0, steer: 0, pitch: 0, yaw: 0, roll: 0, jump: false, boost: false, handbrake: false };

  // ---- Mobile touch state (shared with keyboard; mobile overrides when active) ----
  const mobile = {
    // joystick: -1..1
    joyX: 0,   // steer
    joyY: 0,   // throttle (up = accel)
    // discrete buttons
    accel: false,
    decel: false,
    jump: false,
    boost: false,
    handbrake: false,
    airRollL: false,
    airRollR: false,
    // tracking
    joyActive: false,
    joyPointerId: null,
  };

  // Detect / force mobile UI
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) ||
    window.matchMedia('(pointer: coarse)').matches;
  if (isTouchDevice) document.body.classList.add('show-mobile-ui');

  // ---- Virtual joystick ----
  const joyZone = document.getElementById('joystick-zone');
  const joyBase = document.getElementById('joystick-base');
  const joyKnob = document.getElementById('joystick-knob');
  const JOY_RADIUS = 55; // px max travel of knob center

  function setKnob(dx, dy) {
    const len = Math.hypot(dx, dy);
    let nx = dx, ny = dy;
    if (len > JOY_RADIUS) {
      nx = (dx / len) * JOY_RADIUS;
      ny = (dy / len) * JOY_RADIUS;
    }
    joyKnob.style.transform = `translate(${nx}px, ${ny}px)`;
    // Normalize to -1..1
    mobile.joyX = nx / JOY_RADIUS;
    mobile.joyY = -ny / JOY_RADIUS; // up = positive throttle
  }

  function resetKnob() {
    joyKnob.style.transform = 'translate(0px, 0px)';
    joyKnob.classList.remove('active');
    mobile.joyX = 0;
    mobile.joyY = 0;
    mobile.joyActive = false;
    mobile.joyPointerId = null;
  }

  function joyStart(e) {
    e.preventDefault();
    e.stopPropagation();
    const t = e.changedTouches ? e.changedTouches[0] : e;
    mobile.joyPointerId = t.identifier !== undefined ? t.identifier : 'mouse';
    mobile.joyActive = true;
    joyKnob.classList.add('active');
    const rect = joyBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    setKnob(t.clientX - cx, t.clientY - cy);
  }

  function joyMove(e) {
    if (!mobile.joyActive) return;
    e.preventDefault();
    const touches = e.changedTouches || [e];
    for (const t of touches) {
      const id = t.identifier !== undefined ? t.identifier : 'mouse';
      if (id !== mobile.joyPointerId) continue;
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      setKnob(t.clientX - cx, t.clientY - cy);
    }
  }

  function joyEnd(e) {
    if (!mobile.joyActive) return;
    const touches = e.changedTouches || [e];
    for (const t of touches) {
      const id = t.identifier !== undefined ? t.identifier : 'mouse';
      if (id === mobile.joyPointerId) {
        resetKnob();
        break;
      }
    }
  }

  if (joyZone) {
    joyZone.addEventListener('touchstart', joyStart, { passive: false });
    joyZone.addEventListener('touchmove', joyMove, { passive: false });
    joyZone.addEventListener('touchend', joyEnd, { passive: false });
    joyZone.addEventListener('touchcancel', joyEnd, { passive: false });
    // mouse support for desktop testing
    joyZone.addEventListener('mousedown', joyStart);
    window.addEventListener('mousemove', joyMove);
    window.addEventListener('mouseup', joyEnd);
  }

  // ---- Action & throttle buttons (pointer events so multi-touch works) ----
  function bindButton(el, onDown, onUp) {
    if (!el) return;
    const down = (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('pressed');
      onDown();
    };
    const up = (e) => {
      e.preventDefault();
      el.classList.remove('pressed');
      onUp();
    };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }

  bindButton(document.getElementById('btn-jump'),
    () => { mobile.jump = true; },
    () => { mobile.jump = false; });
  bindButton(document.getElementById('btn-boost'),
    () => { mobile.boost = true; },
    () => { mobile.boost = false; });
  bindButton(document.getElementById('btn-powerslide'),
    () => { mobile.handbrake = true; },
    () => { mobile.handbrake = false; });
  bindButton(document.getElementById('btn-airroll-l'),
    () => { mobile.airRollL = true; },
    () => { mobile.airRollL = false; });
  bindButton(document.getElementById('btn-airroll-r'),
    () => { mobile.airRollR = true; },
    () => { mobile.airRollR = false; });
  bindButton(document.getElementById('btn-accel'),
    () => { mobile.accel = true; },
    () => { mobile.accel = false; });
  bindButton(document.getElementById('btn-decel'),
    () => { mobile.decel = true; },
    () => { mobile.decel = false; });

  // Prevent the canvas from stealing touches that should go to controls
  const canvasEl = document.getElementById('c');
  if (canvasEl) {
    canvasEl.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  }

  function readControls() {
    // Keyboard base
    let throttle = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    let steer = -((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0));
    let roll = (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0);
    let jump = keys.has('Space');
    let boost = keys.has('ShiftLeft') || keys.has('ShiftRight');
    let handbrake = keys.has('ControlLeft') || keys.has('ControlRight');

    // Mobile overrides / additions (combine with keyboard so both work)
    if (mobile.joyActive) {
      // Deadzone
      const dead = 0.12;
      const jx = Math.abs(mobile.joyX) < dead ? 0 : mobile.joyX;
      const jy = Math.abs(mobile.joyY) < dead ? 0 : mobile.joyY;
      steer = -jx;          // same sign convention as keyboard
      throttle = jy;
    }
    // Discrete accel/decel can reinforce or replace stick Y
    if (mobile.accel) throttle = Math.max(throttle, 1);
    if (mobile.decel) throttle = Math.min(throttle, -1);

    if (mobile.airRollL) roll = Math.min(roll, -1);
    if (mobile.airRollR) roll = Math.max(roll, 1);

    jump = jump || mobile.jump;
    boost = boost || mobile.boost;
    handbrake = handbrake || mobile.handbrake;

    let pitch = -throttle;
    let yaw = steer;

    // Mando (PS4 / gamepad estándar)
    const gp = pollGamepad();
    if (gp.connected) {
      if (gp.throttle !== 0) throttle = gp.throttle;
      if (gp.steer !== 0) { steer = gp.steer; yaw = gp.yaw; }
      if (gp.pitch !== 0) pitch = gp.pitch;
      if (gp.roll !== 0) roll = gp.roll;
      jump = jump || gp.jump;
      boost = boost || gp.boost;
      handbrake = handbrake || gp.handbrake;
      if (gp.resetPressed) Module.resetBall();
      if (gp.camPressed) cam.ballCam = !cam.ballCam;
    }

    ctl.throttle = throttle;
    ctl.steer = steer;
    ctl.roll = roll;
    ctl.pitch = pitch;
    ctl.yaw = yaw;
    ctl.jump = jump;
    ctl.boost = boost;
    ctl.handbrake = handbrake;
  }

  // ---------- estado físico (dos "casillas" fijas prev/curr) ----------
  // FIX GC: 1 snapshot/frame.
  // Prefer get*StatePtr + HEAPF32 (zero-alloc). If HEAPF32 missing or Ptr fails → legacy.
  function makeStateSlot() {
    return {
      ballPos: { x: 0, y: 0, z: 0 }, ballVel: { x: 0, y: 0, z: 0 }, ballRot: new Float32Array(9),
      carPos: { x: 0, y: 0, z: 0 }, carVel: { x: 0, y: 0, z: 0 }, carRot: new Float32Array(9),
      boost: 0, isOnGround: false, isSupersonic: false,
    };
  }
  function readVectorInto(embindVec, out) {
    for (let i = 0; i < 9; i++) out[i] = embindVec.get(i);
    embindVec.delete();
  }

  // Detect Ptr API + usable heap view.
  // Recent Emscripten keeps HEAPF32 private unless EXPORTED_RUNTIME_METHODS includes it.
  function getHeapF32() {
    if (Module.HEAPF32) return Module.HEAPF32;
    if (Module.HEAP8) return new Float32Array(Module.HEAP8.buffer);
    if (Module.HEAPU8) return new Float32Array(Module.HEAPU8.buffer);
    if (Module.wasmMemory) return new Float32Array(Module.wasmMemory.buffer);
    // Last resort: dig into wasm exports
    try {
      const mem = Module.asm?.memory || Module.wasmExports?.memory
        || Module.instance?.exports?.memory;
      if (mem && mem.buffer) return new Float32Array(mem.buffer);
    } catch (_) {}
    return null;
  }
  let _heapF32 = getHeapF32();
  // Re-resolve once more after a tick in case memory views are filled late
  if (!_heapF32 && typeof Module.getBallStatePtr === 'function') {
    try { Module.getBallStatePtr(); _heapF32 = getHeapF32(); } catch (_) {}
  }
  const hasPtr = typeof Module.getBallStatePtr === 'function'
              && typeof Module.getCarStatePtr === 'function'
              && _heapF32 != null;
  console.log('[RocketSim] HEAPF32 available:', !!_heapF32, 'hasPtr:', hasPtr);

  let _ballView = null, _carView = null, _heapBuf = null, _ballPtr = 0, _carPtr = 0;
  function viewAt(ptr, isBall) {
    // Refresh heap view if memory grew (ALLOW_MEMORY_GROWTH)
    const h = _heapF32 || getHeapF32();
    if (!h) throw new Error('no HEAPF32');
    const buf = h.buffer;
    if (buf !== _heapBuf) {
      _heapBuf = buf; _heapF32 = new Float32Array(buf);
      _ballView = null; _carView = null; _ballPtr = 0; _carPtr = 0;
    }
    if (isBall) {
      if (!_ballView || _ballPtr !== ptr) { _ballView = new Float32Array(buf, ptr, 18); _ballPtr = ptr; }
      return _ballView;
    }
    if (!_carView || _carPtr !== ptr) { _carView = new Float32Array(buf, ptr, 18); _carPtr = ptr; }
    return _carView;
  }

  function snapshotIntoLegacy(slot) {
    const bs = Module.getBallState();
    const cs = Module.getCarState(carId);
    slot.ballPos.x = bs.pos.x; slot.ballPos.y = bs.pos.y; slot.ballPos.z = bs.pos.z;
    if (bs.vel) {
      slot.ballVel.x = bs.vel.x; slot.ballVel.y = bs.vel.y; slot.ballVel.z = bs.vel.z;
    } else {
      slot.ballVel.x = slot.ballVel.y = slot.ballVel.z = 0;
    }
    readVectorInto(bs.rot, slot.ballRot);
    slot.carPos.x = cs.pos.x; slot.carPos.y = cs.pos.y; slot.carPos.z = cs.pos.z;
    slot.carVel.x = cs.vel.x; slot.carVel.y = cs.vel.y; slot.carVel.z = cs.vel.z;
    readVectorInto(cs.rot, slot.carRot);
    slot.boost = cs.boost;
    slot.isOnGround = cs.isOnGround;
    slot.isSupersonic = cs.isSupersonic;
  }

  function snapshotInto(slot) {
    if (hasPtr) {
      try {
        const bp = Module.getBallStatePtr();
        const cp = Module.getCarStatePtr(carId);
        if (bp && cp) {
          const b = viewAt(bp, true), c = viewAt(cp, false);
          slot.ballPos.x = b[0]; slot.ballPos.y = b[1]; slot.ballPos.z = b[2];
          slot.ballVel.x = b[3]; slot.ballVel.y = b[4]; slot.ballVel.z = b[5];
          for (let i = 0; i < 9; i++) slot.ballRot[i] = b[6 + i];
          slot.carPos.x = c[0]; slot.carPos.y = c[1]; slot.carPos.z = c[2];
          slot.carVel.x = c[3]; slot.carVel.y = c[4]; slot.carVel.z = c[5];
          for (let i = 0; i < 9; i++) slot.carRot[i] = c[6 + i];
          slot.boost = c[15];
          slot.isOnGround = c[16] !== 0;
          slot.isSupersonic = c[17] !== 0;
          return;
        }
      } catch (e) {
        console.warn('get*StatePtr failed, falling back to legacy:', e);
      }
    }
    snapshotIntoLegacy(slot);
  }

  const slotA = makeStateSlot();
  const slotB = makeStateSlot();
  snapshotInto(slotA);
  snapshotInto(slotB);
  let prevState = slotA, currState = slotB, useA = true;
  console.log('[RocketSim] state API:', hasPtr ? 'get*StatePtr (zero-alloc)' : 'legacy get*State');

  const ballQuatPrev = new THREE.Quaternion();
  const ballQuatCurr = new THREE.Quaternion();
  const carQuatPrev = new THREE.Quaternion();
  const carQuatCurr = new THREE.Quaternion();
  const ballPosUU = { x: 0, y: 0, z: 0 };
  const carPosUU = { x: 0, y: 0, z: 0 };
  const bp3 = { x: 0, y: 0, z: 0 };
  const cp3 = { x: 0, y: 0, z: 0 };
  const camPos3 = { x: 0, y: 0, z: 0 };
  const camTgt3 = { x: 0, y: 0, z: 0 };
  const carFwdBuf = [0, 0, 0];
  const carVelBuf = [0, 0, 0];
  const ballPosBuf = [0, 0, 0];
  const carPosBuf = [0, 0, 0];

  function lerpInto(a, b, t, out) {
    out.x = a.x + (b.x - a.x) * t;
    out.y = a.y + (b.y - a.y) * t;
    out.z = a.z + (b.z - a.z) * t;
  }

  // ---------- diagnóstico continuo, sin asignar memoria por frame ----------
  // Buffer circular de números planos (Float64Array): frame, tiempo, dt, step, ticks, acc.
  // El texto (que sí implica crear strings) solo se arma UNA vez, al tocar "Copiar".
  const LOG_CAPACITY = 600; // ~30s a 60fps
  const FIELDS = 14; // frame, t, dt, step, ticks, acc, speed, rawX,Y,Z, renderX,Y,Z, flipped
  const logBuf = new Float64Array(LOG_CAPACITY * FIELDS);
  let logCount = 0;
  const startTime = performance.now();

  const copyBtn = document.getElementById('copyLogBtn');
  copyBtn.addEventListener('click', () => {
    const n = Math.min(logCount, LOG_CAPACITY);
    const startIdx = logCount > LOG_CAPACITY ? logCount % LOG_CAPACITY : 0;
    const lines = new Array(n + 1);
    lines[0] = 'frame\ttiempo(s)\tdt(ms)\tstep(ms)\tticks\tacc_restante(ms)\tspeed(uu/s)\t' +
      'rawX\trawY\trawZ\trenderX\trenderY\trenderZ\tflip';
    for (let i = 0; i < n; i++) {
      const idx = ((startIdx + i) % LOG_CAPACITY) * FIELDS;
      lines[i + 1] =
        `${logBuf[idx]}\t${logBuf[idx + 1].toFixed(2)}\t${logBuf[idx + 2].toFixed(1)}\t` +
        `${logBuf[idx + 3].toFixed(2)}\t${logBuf[idx + 4]}\t${logBuf[idx + 5].toFixed(1)}\t` +
        `${logBuf[idx + 6].toFixed(1)}\t${logBuf[idx + 7].toFixed(2)}\t${logBuf[idx + 8].toFixed(2)}\t${logBuf[idx + 9].toFixed(2)}\t` +
        `${logBuf[idx + 10].toFixed(2)}\t${logBuf[idx + 11].toFixed(2)}\t${logBuf[idx + 12].toFixed(2)}\t${logBuf[idx + 13]}`;
    }
    const text = lines.join('\n');
    const done = () => { copyBtn.textContent = `Copiado (${n} líneas) ✓`; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  });
  function fallbackCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    done();
  }

  let acc = 0;
  let last = performance.now();
  const statsEl = document.getElementById('stats');
  let hudCounter = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 0.25);
    acc += dt;

    readControls();
    Module.setCarControls(
      carId, ctl.throttle, ctl.steer, ctl.pitch, ctl.yaw, ctl.roll, ctl.jump, ctl.boost, ctl.handbrake
    );

    const dtMs = dt * 1000;
    const stepStart = performance.now();
    let ticks = 0;
    // FIX GC: solo hacemos Module.step() dentro del while. snapshotInto() se llama
    // UNA sola vez por frame (después del while). Antes se llamaba getBallState +
    // getCarState en CADA tick (2-4 veces/frame) → embind creaba objetos JS nuevos
    // constantemente → presión de GC → spikes de dt ~32ms. Con 1 snapshot/frame la
    // basura baja ~3-4x y los tirones casi desaparecen.
    // Trade-off: cuando hay catch-up de varios ticks, prevState queda a más de 1 tick
    // de distancia de currState. La interpolación con alpha (fracción de UN tick) no
    // es perfecta en esos frames raros, pero es mucho mejor que tener GC spikes
    // visibles. La mayoría de frames siguen teniendo ticks=1 o 2 y se ven fluidos.
    while (acc >= TICK_TIME && ticks < 8) {
      Module.step(1);
      acc -= TICK_TIME;
      ticks++;
    }
    if (ticks > 0) {
      const nextSlot = useA ? slotA : slotB;
      snapshotInto(nextSlot);
      prevState = currState;
      currState = nextSlot;
      useA = !useA;
    }
    const stepMs = performance.now() - stepStart;
    const alpha = Math.min(Math.max(acc / TICK_TIME, 0), 1);

    // Posición/rotación RENDERIZADAS = interpolación entre el último tick y el anterior.
    lerpInto(prevState.ballPos, currState.ballPos, alpha, ballPosUU);
    lerpInto(prevState.carPos, currState.carPos, alpha, carPosUU);
    rsRotToThreeQuat(prevState.ballRot, ballQuatPrev);
    rsRotToThreeQuat(currState.ballRot, ballQuatCurr);
    rsRotToThreeQuat(prevState.carRot, carQuatPrev);
    rsRotToThreeQuat(currState.carRot, carQuatCurr);
    // Un quaternion `q` y su opuesto `-q` representan exactamente la misma rotación, pero
    // setFromRotationMatrix puede "elegir" signos distintos para dos matrices casi iguales
    // (es una ambigüedad matemática conocida, pasa cerca de ciertos ángulos). Si eso ocurre
    // entre prevQuat y currQuat, el slerp interpola por el camino LARGO en vez del corto,
    // y se ve como un tirón/spin brusco en la orientación -- independiente del dispositivo o
    // del timing de frames, por eso aparecía igual en PC y celular. Forzamos que currQuat
    // quede siempre en el mismo "hemisferio" que prevQuat antes de mezclar.
    let flipped = 0;
    if (ballQuatPrev.dot(ballQuatCurr) < 0) {
      ballQuatCurr.set(-ballQuatCurr.x, -ballQuatCurr.y, -ballQuatCurr.z, -ballQuatCurr.w);
      flipped |= 1;
    }
    if (carQuatPrev.dot(carQuatCurr) < 0) {
      carQuatCurr.set(-carQuatCurr.x, -carQuatCurr.y, -carQuatCurr.z, -carQuatCurr.w);
      flipped |= 2;
    }

    // Log: solo escribe números en un Float64Array ya reservado, cero asignación. Va AQUÍ
    // (no antes) porque necesita carPosUU, que recién se calculó arriba -- comparar "raw"
    // (posición cruda del último tick de física) contra "render" (la ya interpolada, lo que
    // realmente se dibuja) es lo que permite distinguir un glitch de física real de uno que
    // solo vive en la interpolación/render.
    {
      const idx = (logCount % LOG_CAPACITY) * FIELDS;
      const speed = Math.hypot(currState.carVel.x, currState.carVel.y, currState.carVel.z);
      logBuf[idx] = logCount + 1;
      logBuf[idx + 1] = (now - startTime) / 1000;
      logBuf[idx + 2] = dtMs;
      logBuf[idx + 3] = stepMs;
      logBuf[idx + 4] = ticks;
      logBuf[idx + 5] = acc * 1000;
      logBuf[idx + 6] = speed;
      logBuf[idx + 7] = currState.carPos.x;
      logBuf[idx + 8] = currState.carPos.y;
      logBuf[idx + 9] = currState.carPos.z;
      logBuf[idx + 10] = carPosUU.x;
      logBuf[idx + 11] = carPosUU.y;
      logBuf[idx + 12] = carPosUU.z;
      logBuf[idx + 13] = flipped;
      logCount++;
    }

    rsToThreeInto(ballPosUU.x, ballPosUU.y, ballPosUU.z, bp3);
    ball.position.set(bp3.x, bp3.y, bp3.z);
    ball.quaternion.copy(ballQuatPrev).slerp(ballQuatCurr, alpha);

    rsToThreeInto(carPosUU.x, carPosUU.y, carPosUU.z, cp3);
    carMesh.position.set(cp3.x, cp3.y, cp3.z);
    carMesh.quaternion.copy(carQuatPrev).slerp(carQuatCurr, alpha);

    // Hit sparks (car-ball / car-wall)
    if (ticks > 0) checkHits();
    updateSparks(dt);

    // Giro independiente, dirección del eje delantero y recorrido visual de suspensión.
    const forwardSpeedUU = currState.carVel.x * currState.carRot[0]
      + currState.carVel.y * currState.carRot[1]
      + currState.carVel.z * currState.carRot[2];
    wheelSpin -= forwardSpeedUU * UU_TO_M * dt / 0.32;
    const speedFactor = Math.min(Math.abs(forwardSpeedUU) / 1400, 1);
    const groundTravel = currState.isOnGround ? 0.015 : -0.085;
    for (const rig of wheelRig) {
      const pitchTravel = (rig.front ? -1 : 1) * ctl.throttle * 0.018;
      const rollTravel = (rig.right ? -1 : 1) * ctl.steer * speedFactor * 0.014;
      const travel = groundTravel + pitchTravel + rollTravel;
      const targetY = rig.baseY + travel / rig.modelScale;
      rig.wheel.position.y += (targetY - rig.wheel.position.y) * Math.min(dt * 14, 1);
      rig.wheel.quaternion.copy(rig.baseQuaternion);
      if (rig.front) rig.wheel.rotateY(-ctl.steer * 0.48);
      // Spin around local X (axle) so the wheel rolls forward instead of yaw-spinning.
      // After the GLB's baked matrices + source.rotation.x = π/2, local Z was acting as yaw.
      rig.wheel.rotateX(wheelSpin);
    }

    // Cámara: cálculo en espacio RocketSim (UU), convertido a three.js solo al final.
    carFwdBuf[0] = currState.carRot[0]; carFwdBuf[1] = currState.carRot[1]; carFwdBuf[2] = currState.carRot[2];
    carVelBuf[0] = currState.carVel.x; carVelBuf[1] = currState.carVel.y; carVelBuf[2] = currState.carVel.z;
    ballPosBuf[0] = ballPosUU.x; ballPosBuf[1] = ballPosUU.y; ballPosBuf[2] = ballPosUU.z;
    carPosBuf[0] = carPosUU.x; carPosBuf[1] = carPosUU.y; carPosBuf[2] = carPosUU.z;
    rebuildCamera(carPosBuf, carFwdBuf, carVelBuf, ballPosBuf, currState.isOnGround);
    rsToThreeInto(cam.pos[0], cam.pos[1], cam.pos[2], camPos3);
    rsToThreeInto(cam.target[0], cam.target[1], cam.target[2], camTgt3);
    camera.position.set(camPos3.x, camPos3.y, camPos3.z);
    camera.lookAt(camTgt3.x, camTgt3.y, camTgt3.z);

    // El HUD de texto solo se actualiza ~10 veces/seg (no cada frame) para no forzar al
    // navegador a tocar el DOM 60 veces por segundo sin necesidad.
    hudCounter++;
    if (hudCounter >= 15) {
      hudCounter = 0;
      const apiMode = hasPtr ? 'ptr' : 'legacy';
      statsEl.textContent =
        `boost: ${currState.boost.toFixed(0)}  onGround: ${currState.isOnGround}  ` +
        `supersonic: ${currState.isSupersonic}  cam: ${cam.ballCam ? 'ball' : 'chase'} | ` +
        `api:${apiMode} | frames: ${Math.min(logCount, LOG_CAPACITY)}/${logCount}`;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(frame);
}

main();
