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
import { pliesOf, RUBBER_TYPES, RUBBER_COLORS, HANDLE_STYLE } from './catalog.js';

/* ============ 尺寸常量 ============ */
const HEAD_W = 150;            // 拍面最大宽度
const HEAD_TOP = 89;           // 拍面顶端 y
const HEAD_BOTTOM = -87;       // 轮廓底端 y（拍舌，被手柄盖住）
const HEAD_CY = 1;             // 拍面几何中心 y（用于胶皮外扩）
/**
 * 柄根 y。这个值决定「有效拍面高度」= HEAD_TOP - HANDLE_Y0。
 * 真拍 Viscaria 板面 157mm，所以取 -68；之前是 -52，只有 141mm —— 拍面短了
 * 16mm，宽高比接近 1:1，这才是它看着像个圆盘的直接原因。
 */
const HANDLE_Y0 = -68;
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
/**
 * 柄型参数。wTop / wMid / wTail 是**成品总宽**（mm），不是轮廓半宽 ——
 * 构建时会自动扣掉倒角量，这样标称值就等于量出来的值，便于核对真拍规格。
 * 真拍 FL 柄参考：根 30 / 腰 26 / 尾 34。
 */
export const HANDLE_SPECS = {
  // 蝴蝶 Viscaria FL 官方柄规格：100 × 25 × 34（长 × 厚 × 最宽）
  FL: { cn: '收腰 FL', len: 103, depth: 23.5, wTop: 30, wMid: 26, wTail: 34, pen: false },
  ST: { cn: '直柄 ST', len: 103, depth: 23.5, wTop: 30, wMid: 29, wTail: 29, pen: false },
  CO: { cn: '锥形 CO', len: 103, depth: 23.5, wTop: 31, wMid: 26, wTail: 24, pen: false },
  AN: { cn: '解剖 AN', len: 103, depth: 23.5, wTop: 30, wMid: 27, wTail: 32, pen: false },
  CS: { cn: '中直 CS', len: 84,  depth: 17.5, wTop: 32, wMid: 28, wTail: 24, pen: true },
  JS: { cn: '日直 JS', len: 96,  depth: 20.5, wTop: 29, wMid: 23, wTail: 20, pen: true },
};

/* ============ 平面轮廓 ============ */

/**
 * 拍面轮廓控制点（半侧，从顶点到底端）。每点的 x 就是该高度的半宽，
 * 所以宽度是可直接核对的目标值，不是硬凑贝塞尔凑出来的。
 *
 * 两个关键修正（对齐真拍）：
 *   1. 最宽处 153mm 落在 y≈16（偏上），往下收得更快 → 蛋形，不是左右对称的椭圆
 *   2. 底端收到 48mm 的圆弧收口，而不是收成一个尖点 —— 真拍拍喉本来就是一块
 *      被手柄盖住的宽圆弧，两侧会从手柄旁边露出来
 */
const BLADE_PROFILE = [
  [0, 89], [45, 79], [62, 66], [69, 48], [73, 26],
  [75, 2], [73.5, -20], [68, -40], [60, -56], [47, -68],
  [31, -79], [0, -87],
];

function bladeShape() {
  const pts = BLADE_PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
  for (let i = BLADE_PROFILE.length - 2; i >= 1; i--) {
    pts.push(new THREE.Vector2(-BLADE_PROFILE[i][0], BLADE_PROFILE[i][1]));
  }
  pts.push(new THREE.Vector2(BLADE_PROFILE[0][0], BLADE_PROFILE[0][1]));
  const s = new THREE.Shape();
  s.moveTo(pts[0].x, pts[0].y);
  s.splineThru(pts.slice(1));
  return s;
}

/** 拍柄轮廓（横板四型 + 直板两型） */
function handleShape(kind) {
  const k = HANDLE_SPECS[kind] || HANDLE_SPECS.FL;
  // 倒角会把轮廓向外撑出约一个 bevelSize，先扣掉，成品宽度才等于标称值
  const hw = mm => Math.max(5, mm / 2 - HANDLE_BEVEL);
  const top = hw(k.wTop), midN = hw(k.wMid), tail = hw(k.wTail);

  const s = new THREE.Shape();
  const y0 = HANDLE_Y0;
  const y1 = y0 - k.len;
  const midY = y0 - k.len * 0.55;
  // 直板柄身几乎等宽，横板才有明显的收腰
  const shoulder = k.pen ? 0.86 : 0.62;
  const tailEase = k.pen ? 0.99 : 0.94;

  s.moveTo(top, y0);
  s.bezierCurveTo(top * shoulder, y0 - k.len * 0.19, midN, y0 - k.len * 0.34, midN, midY);
  s.bezierCurveTo(midN, y1 + k.len * 0.29, tail * tailEase, y1 + k.len * 0.1, tail, y1);
  s.lineTo(-tail, y1);
  s.bezierCurveTo(-tail * tailEase, y1 + k.len * 0.1, -midN, y1 + k.len * 0.29, -midN, midY);
  s.bezierCurveTo(-midN, y0 - k.len * 0.34, -top * shoulder, y0 - k.len * 0.19, -top, y0);
  s.closePath();
  return s;
}

/* ============ 多边形工具 ============ */

let _bladePoly = null;
/** 拍面多边形（缓存），用于胶皮裁剪、颗粒落点判定、护边路径 */
export function bladePolygon() {
  // 轮廓由 24 段样条组成，每段取 6 点已足够平滑；点太多只会拖慢颗粒的落点判定
  if (!_bladePoly) _bladePoly = bladeShape().getPoints(6);
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

let _grainTex = null;
/**
 * 面胶的细微粗糙度扰动。
 * 没有它，整块面胶就是一张光滑渐变，灯光一打就像塑料壳；
 * 真实面胶在灯下有细密的质感起伏。（粗糙度贴图必须走线性空间，不能标 sRGB）
 */
function rubberGrain() {
  if (_grainTex) return _grainTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 186 + Math.random() * 69;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / 9, 1 / 9);   // UV 用的是轮廓坐标(mm)，约每 9mm 循环一次
  _grainTex = t;
  return t;
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
    roughnessMap: rubberGrain(),
    metalness: 0,
    clearcoat: rubber.tacky ? 1.0 : 0.65,
    clearcoatRoughness: rubber.tacky ? 0.05 : 0.1,
    sheen: 0.1,
    sheenRoughness: 0.6,
  });
}

/**
 * 手柄饰条布局。x 是相对局部半宽的横向偏移（-1 左缘 ~ 1 右缘），
 * w 是饰条半宽占比，k 决定取柄色里的哪一个：grain 深色 / stripe 对比色。
 * 偏移与宽度都按局部柄宽取比例，所以饰条会跟着手柄的收腰走，换柄型也不会跑出去。
 */
const HANDLE_LAYOUTS = {
  center: [{ x: 0.00, w: 0.17, k: 'stripe' }],
  twin:   [{ x: -0.60, w: 0.13, k: 'stripe' }, { x: 0.60, w: 0.13, k: 'stripe' }],
  edge:   [{ x: -0.86, w: 0.11, k: 'grain' }, { x: 0.86, w: 0.11, k: 'grain' }],
  trio:   [{ x: -0.72, w: 0.10, k: 'grain' }, { x: 0.30, w: 0.16, k: 'stripe' }],
  line:   [{ x: 0.00, w: 0.06, k: 'grain' }],
};

/** 扫描线求轮廓在高度 y 处的半宽 */
function halfWidthAt(poly, y) {
  let w = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a.y > y) !== (b.y > y)) {
      const t = (y - a.y) / (b.y - a.y);
      w = Math.max(w, Math.abs(a.x + (b.x - a.x) * t));
    }
  }
  return w;
}

/** 单条纵向饰条的多边形：沿柄长逐层采样，裁进手柄轮廓内 */
function bandShape(kind, spec, xf, wf) {
  const outline = handleShape(kind).getPoints(36);
  const yTop = HANDLE_Y0 - spec.len * 0.05;
  const yBot = HANDLE_Y0 - spec.len * 0.95;
  const margin = HANDLE_BEVEL + 0.5;   // 让开倒角，保证饰条落在平面上而不是翻到侧棱
  const left = [], right = [];
  const steps = 36;

  for (let i = 0; i <= steps; i++) {
    const y = yTop + (yBot - yTop) * (i / steps);
    const W = halfWidthAt(outline, y) - margin;
    if (W <= 1.5) continue;
    const cx = xf * W;
    const hw = Math.max(0.4, wf * W);
    const a = Math.max(cx - hw, -W);
    const b = Math.min(cx + hw, W);
    if (b - a < 0.5) continue;
    left.push(new THREE.Vector2(a, y));
    right.push(new THREE.Vector2(b, y));
  }
  if (left.length < 3) return null;

  const s = new THREE.Shape();
  s.setFromPoints(left.concat(right.reverse()));
  s.closePath();
  return s;
}

function spongeMaterial(rubber, colorKey) {
  const c = new THREE.Color(rubber.sponge);
  if (colorKey === 'black') c.multiplyScalar(0.78);   // 黑面胶配的海绵通常更深
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.97, metalness: 0 });
}

/* ============ 装配 ============ */

/**
 * 底板：逐层挤出后沿 Z 叠放。
 *
 * 板边不是直上直下的 —— 真拍出厂前要砂磨，所以边缘是微凸的圆弧：越靠外的层
 * 轮廓收得越多，砂磨量约 0.016 × 半宽的平方分布。少了这一步，侧面看起来就是
 * 一块挤出的塑料型材，而不是木头。
 */
const EDGE_ROUND = 0.016;

function buildBlade(blade, reg) {
  const g = new THREE.Group();
  const plies = pliesOf(blade);
  const T = blade.thickness;
  const basePoly = bladePolygon();
  let z = -T / 2;

  plies.forEach((p, i) => {
    const zMid = z + p.t / 2;
    const k = 1 - EDGE_ROUND * Math.pow(Math.abs(zMid) / (T / 2 || 1), 2);
    const poly = k > 0.9995 ? basePoly : scalePoly(basePoly, k, 0, HEAD_CY);

    const geo = new THREE.ExtrudeGeometry(shapeFromPoly(poly), {
      depth: p.t, bevelEnabled: false,
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

  // 纵向饰条：按该型号的布局铺 1~3 条，比柄身厚 0.9mm，两面各凸出一点。
  // 颜色直接取该底板自己的柄色，不再统一「提亮」—— 之前那样会把所有深色手柄
  // 的饰条都归一成同一个奶油色，等于把手柄之间的差异抹掉了。
  const style = HANDLE_STYLE[blade.id] || { layout: 'center', lens: 'round' };
  const layout = HANDLE_LAYOUTS[style.layout] || HANDLE_LAYOUTS.center;
  layout.forEach(b => {
    const shape = bandShape(kind, spec, b.x, b.w);
    if (!shape) return;
    const hex = b.k === 'grain' ? blade.handle.grain : blade.handle.stripe;
    g.add(mk(shape, D + 0.9, 0.3, woodMaterial(hex, 0.52, false)));
  });

  if (style.lens !== 'none') {
    // 标牌：圆柱穿透柄身，两面各露出一个；oval 压扁成竖椭圆
    const lensGeo = new THREE.CylinderGeometry(lensR, lensR, D + 1.2, 32);
    lensGeo.rotateX(Math.PI / 2);
    lensGeo.translate(0, lensY, 0);
    if (style.lens === 'oval') lensGeo.scale(0.72, 1, 1);
    reg.track(lensGeo);
    // 标牌：金属度不能拉满。暗环境里纯金属只会反射到暗部，圆牌会变成一个黑洞，
    // 真拍上的标牌是带涂层的浅色金属，偏漫反射。
    const lensMat = new THREE.MeshStandardMaterial({
      color: '#e2e6ea', metalness: 0.45, roughness: 0.3,
    });
    reg.track(lensMat);
    const lens = new THREE.Mesh(lensGeo, lensMat);
    lens.castShadow = true;
    g.add(lens);

    // 内圈，做出内凹质感
    const ringGeo = new THREE.TorusGeometry(lensR * 0.66, lensR * 0.11, 10, 28);
    if (style.lens === 'oval') ringGeo.scale(0.72, 1, 1);
    reg.track(ringGeo);
    const ringMat = new THREE.MeshStandardMaterial({ color: '#7d838c', metalness: 0.9, roughness: 0.3 });
    reg.track(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.position.set(0, lensY, D / 2 + 0.5);
    g.add(ring);
    const ring2 = ring.clone();
    ring2.position.z = -(D / 2 + 0.5);
    g.add(ring2);
  }

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
  layer: { pos: [133, 64, 27],     target: [73, 55, 0] },
  iso:   { pos: [352, 250, 386],   target: [0, 14, 0] },
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
