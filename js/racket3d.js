/**
 * 球拍 3D 装配与渲染
 *
 * 建模思路：
 *   底板不是一块实心木头，而是按 STRUCT 定义的每一层分别挤出（ExtrudeGeometry）再叠起来，
 *   所以侧面的木层 / 芳碳层是真实几何，外置芳碳与内置芳碳的位置差别可以肉眼分辨。
 *   胶皮 = 海绵层 + 面胶层；正胶 / 生胶 / 长胶额外用 InstancedMesh 铺出真实颗粒。
 *
 * 单位：毫米（1 场景单位 = 1mm）。拍面 150×158，整拍长约 254mm，与真拍一致。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { pliesOf, RUBBER_TYPES, RUBBER_COLORS } from './catalog.js';

/* ============ 尺寸常量 ============ */
const HEAD_W = 150;            // 拍面宽
const HEAD_TOP = 88;           // 拍面顶端 y
const HEAD_BOTTOM = -70;       // 拍喉底端 y
const HEAD_CY = 9;             // 拍面几何中心 y（用于胶皮外扩）
const HANDLE_Y0 = -46;         // 柄根 y
const HANDLE_BEVEL = 1.8;

/** 面胶厚度（mm）—— 同时用于 3D 建模与 ITTF 合法性计算，保证两边口径一致 */
export const TOPSHEET_THICKNESS = 1.5;

const RUBBER_OVERHANG = 1.006; // 胶皮比拍面大一圈
const Y_SHIFT = 39;            // 整拍上移，使包围盒居中

/**
 * 柄型参数。
 * 横板（FL/ST/CO/AN）柄厚约 24.5mm；直板（CS 中式 / JS 日式）明显更短更薄，
 * 且日式直板比中式更窄、更接近方形。
 */
export const HANDLE_SPECS = {
  FL: { cn: '收腰 FL', len: 118, depth: 24.5, top: 30, midN: 15.5, tail: 23.5, pen: false },
  ST: { cn: '直柄 ST', len: 118, depth: 24.5, top: 30, midN: 17.0, tail: 17.0, pen: false },
  CO: { cn: '锥形 CO', len: 118, depth: 24.5, top: 31, midN: 15.5, tail: 14.0, pen: false },
  AN: { cn: '解剖 AN', len: 118, depth: 24.5, top: 30, midN: 18.0, tail: 20.0, pen: false },
  CS: { cn: '中直 CS', len: 82,  depth: 17.5, top: 23.0, midN: 15.0, tail: 12.5, pen: true },
  JS: { cn: '日直 JS', len: 96,  depth: 20.5, top: 20.5, midN: 11.5, tail: 10.0, pen: true },
};

/* ============ 平面轮廓 ============ */

/**
 * 拍面轮廓（150 × 158）
 * 真拍不是椭圆，而是「窄喉 → 中上部最宽 → 圆顶」的蛋形：
 * 喉部约 78mm 宽，最宽处偏上（约 55% 高度），顶部收成圆弧。
 */
function bladeShape() {
  const s = new THREE.Shape();
  s.moveTo(0, HEAD_BOTTOM);
  s.bezierCurveTo(21, -70, 33, -65, 39, -55);
  s.bezierCurveTo(58, -36, 71, -12, 75, 16);
  s.bezierCurveTo(78, 48, 60, 74, 30, 84);
  s.bezierCurveTo(20, 87, 10, 88, 0, HEAD_TOP);
  s.bezierCurveTo(-10, 88, -20, 87, -30, 84);
  s.bezierCurveTo(-60, 74, -78, 48, -75, 16);
  s.bezierCurveTo(-71, -12, -58, -36, -39, -55);
  s.bezierCurveTo(-33, -65, -21, -70, 0, HEAD_BOTTOM);
  return s;
}

/** 拍柄轮廓（横板四型 + 直板两型） */
function handleShape(kind) {
  const k = HANDLE_SPECS[kind] || HANDLE_SPECS.FL;
  const s = new THREE.Shape();
  const y0 = HANDLE_Y0;
  const y1 = y0 - k.len;
  const midY = y0 - k.len * 0.55;
  // 直板柄身几乎等宽，横板才有明显的收腰
  const shoulder = k.pen ? 0.86 : 0.62;
  const tailEase = k.pen ? 0.99 : 0.94;

  s.moveTo(k.top, y0);
  s.bezierCurveTo(k.top * shoulder, y0 - k.len * 0.19, k.midN, y0 - k.len * 0.34, k.midN, midY);
  s.bezierCurveTo(k.midN, y1 + k.len * 0.29, k.tail * tailEase, y1 + k.len * 0.1, k.tail, y1);
  s.lineTo(-k.tail, y1);
  s.bezierCurveTo(-k.tail * tailEase, y1 + k.len * 0.1, -k.midN, y1 + k.len * 0.29, -k.midN, midY);
  s.bezierCurveTo(-k.midN, y0 - k.len * 0.34, -k.top * shoulder, y0 - k.len * 0.19, -k.top, y0);
  s.closePath();
  return s;
}

/* ============ 多边形工具 ============ */

let _bladePoly = null;
/** 拍面多边形（缓存），用于胶皮裁剪、颗粒落点判定、护边路径 */
export function bladePolygon() {
  if (!_bladePoly) _bladePoly = bladeShape().getPoints(26);
  return _bladePoly;
}

function scalePoly(poly, k, cx, cy) {
  return poly.map(p => new THREE.Vector2(cx + (p.x - cx) * k, cy + (p.y - cy) * k));
}

function shapeFromPoly(poly) {
  const s = new THREE.Shape();
  s.setFromPoints(poly);
  s.closePath();
  return s;
}

/** 射线法判断点是否在轮廓内 */
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

/* ============ 木纹贴图 ============ */

let _woodTex = null;
/** 白底 + 灰色纹理，让 material.color 决定实际木色，map 只负责纹理 */
function woodTexture() {
  if (_woodTex) return _woodTex;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 512);
  for (let i = 0; i < 110; i++) {
    const x0 = Math.random() * 256;
    const amp = 3 + Math.random() * 9;
    g.strokeStyle = '#7a6a52';
    g.globalAlpha = 0.05 + Math.random() * 0.2;
    g.lineWidth = 0.5 + Math.random() * 2.6;
    g.beginPath();
    g.moveTo(x0, -20);
    for (let y = -20; y <= 532; y += 26) {
      g.lineTo(x0 + Math.sin(y * 0.021 + i * 1.7) * amp + (Math.random() - 0.5) * 3, y);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  _woodTex = t;
  return t;
}

/* ============ 材质工厂 ============ */

function woodMaterial(color, roughness, textured) {
  const tex = textured ? woodTexture() : null;
  const m = new THREE.MeshStandardMaterial({
    color, roughness, metalness: 0,
    map: tex, bumpMap: tex, bumpScale: 0.4,
  });
  return m;
}

function topsheetMaterial(hex, rubber) {
  // 关键：清漆层要「窄而亮」，不能「宽而糊」。
  // clearcoatRoughness 一大，高光就摊平成一层灰雾，黑色胶皮会整片泛白。
  if (rubber.type === 'anti') {
    return new THREE.MeshPhysicalMaterial({ color: hex, roughness: 0.95, metalness: 0 });
  }
  return new THREE.MeshPhysicalMaterial({
    color: hex,
    roughness: rubber.tacky ? 0.42 : 0.55,
    metalness: 0,
    clearcoat: rubber.tacky ? 1.0 : 0.65,
    clearcoatRoughness: rubber.tacky ? 0.05 : 0.1,
    sheen: 0.1,
    sheenRoughness: 0.6,
  });
}

/** 柄身中央的纵向长圆嵌条（两端半圆收口） */
function inlayShape(len) {
  const w = 4.4;
  const t = HANDLE_Y0 - len * 0.15;
  const b = HANDLE_Y0 - len * 0.83;
  const s = new THREE.Shape();
  s.moveTo(-w, t - w);
  s.lineTo(-w, b + w);
  s.absarc(0, b + w, w, Math.PI, Math.PI * 2, false);
  s.lineTo(w, t - w);
  s.absarc(0, t - w, w, 0, Math.PI, false);
  s.closePath();
  return s;
}

/** 保证嵌条与柄身之间有足够明度差，避免深色叠深色看不出层次 */
function readableInlay(baseHex, stripeHex) {
  const base = new THREE.Color(baseHex);
  const stripe = new THREE.Color(stripeHex);
  const hsl = {};
  base.getHSL(hsl);
  if (hsl.l >= 0.26) return stripeHex;              // 浅柄身配深嵌条，本来就好读
  const light = new THREE.Color('#cbaa78');         // 深柄身改用浅木色嵌条
  stripe.lerp(light, 0.62);
  return '#' + stripe.getHexString();
}

function spongeMaterial(rubber, colorKey) {
  const c = new THREE.Color(rubber.sponge);
  if (colorKey === 'black') c.multiplyScalar(0.78);   // 黑面胶配的海绵通常更深
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.97, metalness: 0 });
}

/* ============ 装配 ============ */

/** 底板：逐层挤出后沿 Z 叠放 */
function buildBlade(blade, reg) {
  const g = new THREE.Group();
  const plies = pliesOf(blade);
  const T = blade.thickness;
  let z = -T / 2;
  plies.forEach((p, i) => {
    const geo = new THREE.ExtrudeGeometry(bladeShape(), {
      depth: p.t, bevelEnabled: false, curveSegments: 44,
    });
    geo.translate(0, 0, z);
    reg.track(geo);
    const outer = i === 0 || i === plies.length - 1;
    const mat = woodMaterial(p.c, p.r, outer);
    if (outer) mat.map.repeat.set(1 / HEAD_W, 1 / (HEAD_TOP - HEAD_BOTTOM));
    reg.track(mat);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    z += p.t;
  });
  return g;
}

/** 拍柄 + 中央嵌条 + 金属标牌 */
function buildHandle(blade, kind, reg) {
  const g = new THREE.Group();
  const spec = HANDLE_SPECS[kind] || HANDLE_SPECS.FL;
  const D = spec.depth;
  const midY = HANDLE_Y0 - spec.len * 0.5;
  const buttY = HANDLE_Y0 - spec.len;
  const lensR = spec.pen ? 5.0 : 6.4;
  const lensY = buttY + spec.len * 0.16;

  const mk = (shape, d, bev, mat) => {
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: d - 2 * bev, bevelEnabled: bev > 0,
      bevelThickness: bev, bevelSize: bev, bevelSegments: bev > 0 ? 4 : 0, curveSegments: 28,
    });
    geo.translate(0, 0, -(d - 2 * bev) / 2);
    reg.track(geo); reg.track(mat);
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  };

  const baseMat = woodMaterial(blade.handle.base, 0.62, true);
  baseMat.map.repeat.set(1 / 64, 1 / 130);
  g.add(mk(handleShape(kind), D, HANDLE_BEVEL, baseMat));

  // 中央嵌条：纵向长圆槽，比柄身厚 0.9mm，两面各凸出一点。
  // 深色柄身配深色嵌条会读成「挖了个洞」，所以柄身偏暗时自动把嵌条反过来提亮。
  const stripeHex = readableInlay(blade.handle.base, blade.handle.stripe);
  const stripeMat = woodMaterial(stripeHex, 0.5, false);
  g.add(mk(inlayShape(spec.len), D + 0.9, 0.35, stripeMat));

  // 金属标牌（圆柱穿透柄身，两面各露出一个圆）
  const lensGeo = new THREE.CylinderGeometry(lensR, lensR, D + 1.2, 32);
  lensGeo.rotateX(Math.PI / 2);
  lensGeo.translate(0, lensY, 0);
  reg.track(lensGeo);
  const lensMat = new THREE.MeshStandardMaterial({
    color: '#c9ced6', metalness: 0.95, roughness: 0.22,
  });
  reg.track(lensMat);
  const lens = new THREE.Mesh(lensGeo, lensMat);
  lens.castShadow = true;
  g.add(lens);

  // 标牌内圈，做出内凹质感
  const ringGeo = new THREE.TorusGeometry(lensR * 0.66, lensR * 0.11, 10, 28);
  reg.track(ringGeo);
  const ringMat = new THREE.MeshStandardMaterial({ color: '#7d838c', metalness: 0.9, roughness: 0.3 });
  reg.track(ringMat);
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.set(0, lensY, D / 2 + 0.5);
  g.add(ring);
  const ring2 = ring.clone();
  ring2.position.z = -(D / 2 + 0.5);
  g.add(ring2);

  return g;
}

/**
 * 单面胶皮：海绵 + 面胶 (+ 颗粒)
 * 局部坐标 z=0 为拍面，向 +z 生长
 */
function buildRubber(rubber, thickness, colorKey, reg) {
  const g = new THREE.Group();
  const poly = scalePoly(bladePolygon(), RUBBER_OVERHANG, 0, HEAD_CY);
  const shape = shapeFromPoly(poly);
  const hex = RUBBER_COLORS[colorKey].hex;

  // 海绵
  const spongeGeo = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: false, curveSegments: 44,
  });
  reg.track(spongeGeo);
  const spongeMat = spongeMaterial(rubber, colorKey);
  reg.track(spongeMat);
  const sponge = new THREE.Mesh(spongeGeo, spongeMat);
  sponge.castShadow = true; sponge.receiveShadow = true;
  g.add(sponge);

  // 面胶
  const topGeo = new THREE.ExtrudeGeometry(shape, {
    depth: TOPSHEET_THICKNESS, bevelEnabled: false, curveSegments: 44,
  });
  topGeo.translate(0, 0, thickness);
  reg.track(topGeo);
  const topMat = topsheetMaterial(hex, rubber);
  reg.track(topMat);
  const top = new THREE.Mesh(topGeo, topMat);
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);

  // 颗粒（正胶 / 生胶 / 长胶）
  const cfg = RUBBER_TYPES[rubber.type].pips;
  if (cfg) {
    const pts = [];
    let row = 0;
    for (let y = HEAD_BOTTOM - 2; y <= HEAD_TOP + 2; y += cfg.gap * 0.866) {
      const off = (row++ % 2) * (cfg.gap / 2);
      for (let x = -HEAD_W / 2 - 2 + off; x <= HEAD_W / 2 + 2; x += cfg.gap) {
        if (pointInPoly(x, y, poly)) pts.push([x, y]);
      }
    }
    const pg = new THREE.CylinderGeometry(cfg.r, cfg.r * 1.05, cfg.h, 9);
    pg.rotateX(Math.PI / 2);
    reg.track(pg);
    const pm = new THREE.MeshPhysicalMaterial({
      color: hex, roughness: 0.55, metalness: 0, sheen: 0.4, clearcoat: 0.2,
    });
    reg.track(pm);
    const inst = new THREE.InstancedMesh(pg, pm, pts.length);
    inst.castShadow = true; inst.receiveShadow = true;
    const dummy = new THREE.Object3D();
    const zTop = thickness + TOPSHEET_THICKNESS + cfg.h / 2 - 0.15;
    pts.forEach(([x, y], i) => {
      dummy.position.set(x, y, zTop);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    g.add(inst);
  }

  return g;
}

/** 护边（可选）：沿轮廓的扁管 */
function buildEdgeTape(reg) {
  const pts = bladePolygon().map(p => new THREE.Vector3(p.x, p.y, 0));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.03);
  const geo = new THREE.TubeGeometry(curve, 320, 1.45, 8, true);
  reg.track(geo);
  const mat = new THREE.MeshPhysicalMaterial({
    color: '#d8dbe0', roughness: 0.45, metalness: 0.15, clearcoat: 0.6,
  });
  reg.track(mat);
  const m = new THREE.Mesh(geo, mat);
  m.scale.z = 2.35;           // 压扁成带状，包住板边
  m.castShadow = true;
  return m;
}

/* ============ 相机预设 ============ */

/**
 * 视角预设。注意球拍组整体上移了 Y_SHIFT，所以世界坐标下拍面中心约在 y = +48。
 * layer 是层剖微距：整拍 13mm 厚，全景视角里只有二十几个像素，
 * 必须凑近了才看得清外置芳碳层到底夹在第几层。
 */
const VIEWS = {
  front: { pos: [0, 34, 480],      target: [0, 0, 0] },
  back:  { pos: [0, 34, -480],     target: [0, 0, 0] },
  side:  { pos: [470, 62, 96],     target: [0, 8, 0] },
  // 目标点取拍面右缘中段的世界坐标：轮廓最宽点 (76, 16) 经组位移 +39 与
  // 1.6° 姿态旋转后约落在 (75.5, 57)
  layer: { pos: [112, 62, 16],     target: [72, 55, 0] },
  iso:   { pos: [300, 215, 330],   target: [0, 0, 0] },
  top:   { pos: [0, 470, 120],     target: [0, 0, 0] },
};

/* ============ 资源回收 ============ */

class Registry {
  constructor() { this.items = []; }
  track(x) { this.items.push(x); return x; }
  clear() {
    this.items.forEach(x => x.dispose && x.dispose());
    this.items = [];
  }
}

/* ============ 主类 ============ */

export class RacketViewer {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.onError = opts.onError || (() => {});
    this.reg = new Registry();
    this.autoRotate = true;
    this._rebuildQueued = null;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = this._bgTexture();
    this.scene.fog = new THREE.Fog(0x0f1013, 900, 2000);

    this.camera = new THREE.PerspectiveCamera(32, 1, 10, 4000);
    this.camera.position.set(...VIEWS.iso.pos);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.07;
    this.controls.enablePan = false;
    this.controls.minDistance = 42;   // 层剖微距要能凑到很近
    this.controls.maxDistance = 1100;
    this.controls.minPolarAngle = 0.18;
    this.controls.maxPolarAngle = Math.PI - 0.18;
    this.controls.target.set(0, 0, 0);

    this._lights();
    this._environment();
    this._floor();

    this.racket = new THREE.Group();
    this.racket.position.y = Y_SHIFT;
    // 固定的轻微姿态，避免正襟危坐的呆板感；转动交给相机，物体本身不转
    this.racket.rotation.set(-0.055, 0, 0.028);
    this.scene.add(this.racket);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();

    this._t0 = performance.now();
    this._loop = this._loop.bind(this);
    this._raf = requestAnimationFrame(this._loop);
  }

  _bgTexture() {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, '#1c1e24');
    grad.addColorStop(0.55, '#121316');
    grad.addColorStop(1, '#0a0a0c');
    g.fillStyle = grad; g.fillRect(0, 0, 4, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }

  _lights() {
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x14161a, 0.28));

    const key = new THREE.DirectionalLight(0xfff2e0, 2.3);
    key.position.set(220, 340, 300);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 100;
    key.shadow.camera.far = 1200;
    const d = 230;
    Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    key.shadow.bias = -0.0012;
    key.shadow.normalBias = 0.6;
    key.shadow.camera.updateProjectionMatrix();
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xbcd2ff, 0.85);
    fill.position.set(-300, 90, 200);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd9a8, 1.5);
    rim.position.set(-120, 160, -320);
    this.scene.add(rim);
  }

  _environment() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
      this.scene.environment = env.texture;
      // 环境反射只用来点亮金属件和橡胶高光，压低一点，
      // 否则黑胶皮会被环境光整体提亮成灰的
      if ('environmentIntensity' in this.scene) this.scene.environmentIntensity = 0.28;
      pmrem.dispose();
    } catch (e) {
      this.onError('环境贴图不可用，已退回纯灯光照明：' + e.message);
    }
  }

  _floor() {
    const geo = new THREE.CircleGeometry(1400, 64);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({
      color: '#101215', roughness: 0.82, metalness: 0.05,
    });
    const floor = new THREE.Mesh(geo, mat);
    floor.position.y = -175;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // 灯光下的柔光斑，避免地面死黑
    const glowGeo = new THREE.CircleGeometry(340, 48);
    glowGeo.rotateX(-Math.PI / 2);
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x2a2f38, transparent: true, opacity: 0.5,
    });
    const glow = new THREE.Mesh(glowGeo, glowMat);
    glow.position.set(60, -174.4, 40);
    this.scene.add(glow);
  }

  /** 应用一套配置并重建球拍 */
  setConfig(cfg) {
    if (this._rebuildQueued) this._rebuildQueued = null;
    this.reg.clear();
    this.racket.clear();

    const { blade, fh, bh, fhThickness, bhThickness, fhColor, bhColor, handle, edgeTape } = cfg;
    const T = blade.thickness;

    this.racket.add(buildBlade(blade, this.reg));
    this.racket.add(buildHandle(blade, handle, this.reg));

    const fhGroup = buildRubber(fh, fhThickness, fhColor, this.reg);
    fhGroup.position.z = T / 2;
    this.racket.add(fhGroup);

    const bhGroup = buildRubber(bh, bhThickness, bhColor, this.reg);
    bhGroup.position.z = -T / 2;
    bhGroup.rotation.y = Math.PI;
    this.racket.add(bhGroup);

    if (edgeTape) this.racket.add(buildEdgeTape(this.reg));
  }

  setView(name) {
    const v = VIEWS[name] || VIEWS.iso;
    this._viewTween = {
      from: this.camera.position.clone(),
      to: new THREE.Vector3(...v.pos),
      fromTarget: this.controls.target.clone(),
      toTarget: new THREE.Vector3(...v.target),
      t: 0,
    };
  }

  setAutoRotate(on) {
    this.autoRotate = !!on;
    this.controls.autoRotateSpeed = 1.15;
  }

  /** 当前视角截图。与渲染同一个任务里取，无需 preserveDrawingBuffer */
  snapshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }

  resize() {
    const parent = this.canvas.parentElement;
    const w = parent.clientWidth || 1;
    const h = parent.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    const dt = Math.min((now - this._t0) / 1000, 0.05);
    this._t0 = now;

    if (this._viewTween) {
      const tw = this._viewTween;
      tw.t = Math.min(1, tw.t + dt * 2.4);
      const e = 1 - Math.pow(1 - tw.t, 3);          // easeOutCubic
      this.camera.position.lerpVectors(tw.from, tw.to, e);
      this.controls.target.lerpVectors(tw.fromTarget, tw.toTarget, e);
      this.camera.lookAt(this.controls.target);
      if (tw.t >= 1) {
        this._viewTween = null;
        // 相机落位后把方位角同步给 OrbitControls，否则下一次拖拽会从旧角度开始跳
        this.controls.update();
        this.controls.saveState?.();
      }
    }

    // 环绕由相机完成，产品本身不动 —— 光照相对产品的角度恒定，视角预设也永远准确
    this.controls.autoRotate = this.autoRotate && !this._viewTween;

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    this.reg.clear();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
