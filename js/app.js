/**
 * 界面逻辑：状态、打分模型、规则校验、渲染
 */
import { BLADES, RUBBERS, RUBBER_TYPES, RUBBER_COLORS } from './catalog.js';
import { RacketViewer, HANDLE_SPECS, TOPSHEET_THICKNESS } from './racket3d.js';

/* ================= 常量 ================= */

const STRUCT_LABEL = {
  w5: '5 层纯木', w7: '7 层纯木',
  alcOut: '5+2 外置芳碳', alcIn: '5+2 内置芳碳',
  zlcOut: '5+2 外置 ZLC', zlcIn: '5+2 内置 ZLC',
  szlcOut: '5+2 Super ZLC', zlfOut: '5+2 ZL 纤维',
  c3x2: '3+2 碳素', cOut: '5+2 外置碳素', hw7: '7 层硬木',
};

/** 各指标中，底板与胶皮的权重。胶皮主导旋转，底板主导支撑与手感。 */
const WEIGHTS = {
  speed:   { blade: 0.45, rubber: 0.55 },
  spin:    { blade: 0.25, rubber: 0.75 },
  control: { blade: 0.45, rubber: 0.55 },
  hard:    { blade: 0.40, rubber: 0.60 },
};

const METRICS = [
  { key: 'speed',   name: '速度', icon: 'i-zap' },
  { key: 'spin',    name: '旋转', icon: 'i-spin' },
  { key: 'control', name: '控制', icon: 'i-target' },
  { key: 'hard',    name: '硬度', icon: 'i-gauge' },
];

const THICKNESS = [
  { v: 1.7, label: '1.7' },
  { v: 1.9, label: '1.9' },
  { v: 2.1, label: '2.1' },
  { v: 2.2, label: 'MAX' },
];

const PRESETS = [
  { id: 'zjk',  label: '张继科',   blade: 'viscaria',     fh: 'h3-national',   bh: 'tenergy05',    handle: 'FL' },
  { id: 'fzd',  label: '樊振东',   blade: 'fzd-alc',      fh: 'h3-national',   bh: 'dignics09c',   handle: 'FL' },
  { id: 'ml',   label: '马龙',     blade: 'hl5',          fh: 'h3-national',   bh: 'h3-provincial',handle: 'FL' },
  { id: 'wcq',  label: '王楚钦',   blade: 'hl5x',         fh: 'h3-provincial', bh: 'hurricane8',   handle: 'FL' },
  { id: 'boll', label: '波尔',     blade: 'boll-alc',     fh: 'tenergy05',     bh: 'tenergy05',    handle: 'FL' },
  { id: 'har',  label: '张本智和', blade: 'harimoto-alc', fh: 'dignics09c',    bh: 'dignics05',    handle: 'FL' },
  { id: 'mlin', label: '马琳',     blade: 'yeo',          fh: 'h3-provincial', bh: 'markv',        handle: 'CS' },
  { id: 'xx',   label: '许昕',     blade: 'hl5',          fh: 'h3-provincial', bh: 'tenergy05',    handle: 'CS' },
  { id: 'ovt',  label: '奥恰洛夫', blade: 'ovtcharov-tc', fh: 'mxp',           bh: 'elp',          handle: 'ST' },
  { id: 'sys',  label: '孙颖莎',   blade: 'hl5',          fh: 'h3-neo',        bh: 'hurricane8-80',handle: 'FL' },
];

const $ = id => document.getElementById(id);
const byId = (list, id) => list.find(x => x.id === id) || list[0];
const ic = name =>
  `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#${name}"/></svg>`;

/* ================= 状态 ================= */

const state = {
  bladeId: 'viscaria',
  fh: { rubberId: 'tenergy05', color: 'black', thickness: 2.1 },
  bh: { rubberId: 'tenergy05', color: 'red',   thickness: 2.1 },
  handle: 'FL',
  edgeTape: true,
  side: 'fh',
  bladeBrand: 'all',
  rubberBrand: 'all',
  rubberType: 'all',
  bladeQuery: '',
  rubberQuery: '',
  autoRotate: true,
  presetId: null,
};

let viewer = null;

/* ================= 打分模型 ================= */

function metricsOf(blade, fh, bh) {
  const avg = k => (fh[k] + bh[k]) / 2;
  const out = {};
  for (const { key } of METRICS) {
    const w = WEIGHTS[key];
    const b = blade[key] * w.blade;
    const r = avg(key) * w.rubber;
    out[key] = { blade: b, rubber: r, total: b + r };
  }
  return out;
}

/** 打法分类：先看颗粒类型，再看速度/旋转/控制的关系 */
function classify(blade, fh, bh, m) {
  const types = [fh.type, bh.type];
  const has = t => types.includes(t);
  const speed = m.speed.total, spin = m.spin.total, ctrl = m.control.total;

  if (has('lp')) return {
    name: '长胶削球 / 防守',
    desc: '长胶把来球旋转反向送回，配合削球或倒板能制造极不规则的节奏，靠变化和耐心得分。',
  };
  if (has('anti')) return {
    name: '防弧怪球 / 防守反击',
    desc: '防弧胶几乎不吃转，能把对手的强旋转「卸」掉，适合以控制和突然反攻为主的打法。',
  };
  if ((has('sp') || has('mp')) && speed >= 84) return {
    name: '近台快攻（颗粒）',
    desc: '颗粒胶回球快而沉，主打上升期的抢点与节奏压制，不给对手拉弧圈的时间。',
  };
  if (has('sp') || has('mp')) return {
    name: '颗粒控制 / 变化型',
    desc: '以颗粒胶制造旋转差异和落点变化，伺机用另一面发起进攻。',
  };
  if (spin >= 88 && speed >= 88) return {
    name: '两面弧圈 / 相持型',
    desc: '旋转与速度兼备，中远台对拉不落下风，靠质量球压制对手。',
  };
  if (speed >= 87) return {
    name: '快攻结合弧圈',
    desc: '以速度抢先上手，前三板和近台衔接是主要得分手段。',
  };
  if (ctrl >= 88) return {
    name: '全面控制型',
    desc: '失误少、落点准，靠稳定的相持和对手的失误积累优势，很适合进阶练球。',
  };
  return {
    name: '全能均衡型',
    desc: '各项指标都不偏科，适合打法尚未定型或想全面发展的球友。',
  };
}

/** 搭配点评：从底板硬度与胶皮硬度的差值给出建议 */
function adviceOf(blade, fh, bh, m) {
  const rubberHard = (fh.hard + bh.hard) / 2;
  const delta = rubberHard - blade.hard;
  const tacky = fh.tacky || bh.tacky;
  const parts = [];

  if (delta > 16) {
    parts.push('胶皮比底板明显偏硬：吃球深、旋转上限高，但需要主动发力才能打出速度，'
      + '中小力量下容易「打不透」。适合有发力基础的近台弧圈打法。');
  } else if (delta < -16) {
    parts.push('底板比胶皮明显偏硬：借力好、出球干脆，中远台对拉省力，'
      + '但主动进攻时的旋转上限一般，适合快攻与相持为主的打法。');
  } else {
    parts.push('底板与胶皮的硬度基本匹配，形变与回弹的节奏一致，'
      + '上手难度低，是一套很均衡的搭配。');
  }

  if (tacky && blade.hard >= 60) {
    parts.push('粘性胶皮配硬底板，是典型的国手正手思路：小力量靠粘性制造旋转，大力时靠底板底劲出速度。');
  } else if (tacky) {
    parts.push('粘性胶皮配偏软的底板，吃球时间更长，起下旋轻松，是业余球友最友好的组合之一。');
  }

  const { name } = classify(blade, fh, bh, m);
  parts.push(`整体归类为「${name}」。`);
  return parts.join('');
}

/** ITTF 器材合规性检查 */
function legalityOf(blade, fh, bh) {
  const out = [];
  const fhBlack = state.fh.color === 'black';
  const bhBlack = state.bh.color === 'black';

  if (fhBlack && bhBlack) {
    out.push({ level: 'bad', text: '两面同为黑色。ITTF 规定球拍两面必须一面为黑色、另一面为鲜艳色，此配置不能用于正式比赛。' });
  } else if (!fhBlack && !bhBlack) {
    out.push({ level: 'bad', text: '两面都不是黑色。ITTF 规定必须有一面为黑色，此配置不能用于正式比赛。' });
  }

  const total = blade.weight + fh.weight + bh.weight;
  if (total > 190) {
    out.push({ level: 'warn', text: `整拍约 ${total} g，偏重。直板横打或长时间比赛时手腕负担明显。` });
  }

  const dh = Math.abs(fh.hard - bh.hard);
  if (dh > 26) {
    out.push({ level: 'warn', text: `正反手胶皮硬度相差 ${dh} 档，两面手感差异较大，正反手转换时需要额外适应。` });
  }

  if (!out.length) {
    out.push({ level: 'ok', text: '配置符合 ITTF 器材规定，可用于正式比赛。' });
  }
  return out;
}

/* ================= 渲染：列表 ================= */

function bladeMatches(b) {
  if (state.bladeBrand !== 'all' && b.brand !== state.bladeBrand) return false;
  const q = state.bladeQuery.trim().toLowerCase();
  if (!q) return true;
  return (b.name + ' ' + b.cn + ' ' + b.brandCn + ' ' + b.tag).toLowerCase().includes(q);
}

function rubberMatches(r) {
  if (state.rubberBrand !== 'all' && r.brand !== state.rubberBrand) return false;
  if (state.rubberType !== 'all' && r.type !== state.rubberType) return false;
  const q = state.rubberQuery.trim().toLowerCase();
  if (!q) return true;
  return (r.name + ' ' + r.cn + ' ' + r.brandCn).toLowerCase().includes(q);
}

function renderBlades() {
  const list = BLADES.filter(bladeMatches);
  $('bladeCount').textContent = `${list.length} / ${BLADES.length} 款`;

  if (!list.length) {
    $('bladeList').innerHTML = '<div class="empty">没有匹配的底板，换个关键词试试</div>';
    return;
  }

  $('bladeList').innerHTML = list.map(b => {
    const on = b.id === state.bladeId;
    return `<button class="item${on ? ' is-on' : ''}" data-id="${b.id}" role="option" aria-selected="${on}">
      <div class="item__top">
        <span class="item__name">${b.name}</span>
        <span class="item__price">¥${b.price.toLocaleString('zh-CN')}</span>
      </div>
      <div class="item__cn">${b.cn} · ${b.brandCn}</div>
      <div class="item__meta">
        <span class="tag tag--struct">${STRUCT_LABEL[b.struct] || b.struct}</span>
        <span class="tag">${b.thickness} mm</span>
        ${b.tag ? `<span class="tag tag--hl">${b.tag}</span>` : ''}
      </div>
    </button>`;
  }).join('');
}

function renderRubbers() {
  const list = RUBBERS.filter(rubberMatches);
  $('rubberCount').textContent = `${list.length} / ${RUBBERS.length} 款`;

  if (!list.length) {
    $('rubberList').innerHTML = '<div class="empty">没有匹配的胶皮，换个关键词试试</div>';
    return;
  }

  $('rubberList').innerHTML = list.map(r => {
    const onFh = r.id === state.fh.rubberId;
    const onBh = r.id === state.bh.rubberId;
    const on = state.side === 'fh' ? onFh : onBh;
    const mark = onFh && onBh ? '正 · 反' : onFh ? '正手' : onBh ? '反手' : '';
    return `<button class="item${on ? ' is-on' : ''}" data-id="${r.id}" role="option" aria-selected="${on}">
      <div class="item__top">
        <span class="item__name">${r.name}</span>
        <span class="item__price">¥${r.price.toLocaleString('zh-CN')}</span>
      </div>
      <div class="item__cn">${r.cn} · ${r.brandCn}</div>
      <div class="item__meta">
        <span class="tag tag--struct">${RUBBER_TYPES[r.type].cn}</span>
        <span class="tag">${r.hardLabel}</span>
        ${r.tacky ? '<span class="tag tag--hl">粘性</span>' : ''}
        ${mark ? `<span class="tag tag--hl">${mark}</span>` : ''}
      </div>
    </button>`;
  }).join('');
}

/* ================= 渲染：控件 ================= */

function renderBrandChips() {
  const bs = [...new Set(BLADES.map(b => b.brand))];
  $('bladeBrands').innerHTML =
    `<button class="chip${state.bladeBrand === 'all' ? ' is-on' : ''}" data-brand="all">全部</button>` +
    bs.map(b => {
      const cn = BLADES.find(x => x.brand === b).brandCn;
      return `<button class="chip${state.bladeBrand === b ? ' is-on' : ''}" data-brand="${b}">${cn}</button>`;
    }).join('');
}

function renderRubberFilters() {
  $('rubberTypes').innerHTML =
    `<button class="chip${state.rubberType === 'all' ? ' is-on' : ''}" data-type="all">全部</button>` +
    Object.entries(RUBBER_TYPES).map(([k, v]) =>
      `<button class="chip${state.rubberType === k ? ' is-on' : ''}" data-type="${k}">${v.cn}</button>`).join('');

  const bs = [...new Set(RUBBERS.map(r => r.brand))];
  $('rubberBrands').innerHTML =
    `<button class="chip${state.rubberBrand === 'all' ? ' is-on' : ''}" data-rbrand="all">全部品牌</button>` +
    bs.map(b => {
      const cn = RUBBERS.find(x => x.brand === b).brandCn;
      return `<button class="chip${state.rubberBrand === b ? ' is-on' : ''}" data-rbrand="${b}">${cn}</button>`;
    }).join('');
}

function renderSideControls() {
  const side = state.side;
  const cur = state[side];
  const rubber = byId(RUBBERS, cur.rubberId);

  // 该胶皮实际市售的颜色
  const avail = rubber.colors;
  if (!avail.includes(cur.color)) cur.color = avail[0];

  $('colorRow').innerHTML = avail.map(c => {
    const info = RUBBER_COLORS[c];
    return `<button class="swatch${cur.color === c ? ' is-on' : ''}" data-color="${c}"
      style="background:${info.hex}" title="${info.cn}" aria-label="颜色 ${info.cn}"
      aria-pressed="${cur.color === c}"></button>`;
  }).join('');

  $('thicknessRow').innerHTML = THICKNESS.map(t =>
    `<button class="chip${cur.thickness === t.v ? ' is-on' : ''}" data-th="${t.v}">${t.label}</button>`).join('');

  document.querySelectorAll('#sideTabs .seg__btn').forEach(btn => {
    const on = btn.dataset.side === side;
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-selected', String(on));
  });
}

function renderHandleChips() {
  $('handleRow').innerHTML = Object.entries(HANDLE_SPECS).map(([k, v]) =>
    `<button class="chip${state.handle === k ? ' is-on' : ''}" data-handle="${k}">${v.cn}</button>`).join('');
}

function renderPresets() {
  $('presets').innerHTML = PRESETS.map(p =>
    `<button class="preset${state.presetId === p.id ? ' is-on' : ''}" data-preset="${p.id}">
      ${ic('i-star')}${p.label}
    </button>`).join('');
}

/* ================= 渲染：仪表盘 ================= */

function renderHud(blade, fh, bh) {
  const m = metricsOf(blade, fh, bh);

  $('meters').innerHTML = METRICS.map(({ key, name, icon }) => {
    const d = m[key];
    const total = d.total;
    const bw = total > 0 ? (d.blade / total) * 100 : 0;
    const rw = total > 0 ? (d.rubber / total) * 100 : 0;
    return `<div class="meter" data-key="${key}">
      <div class="meter__head">
        <span class="meter__name">${ic(icon)}${name}</span>
        <span class="meter__val">${total.toFixed(0)}</span>
      </div>
      <div class="meter__track">
        <div class="meter__fill" style="width:${total.toFixed(1)}%">
          <span class="meter__seg meter__seg--blade" style="width:${bw.toFixed(1)}%"></span>
          <span class="meter__seg meter__seg--rubber" style="width:${rw.toFixed(1)}%"></span>
        </div>
      </div>
    </div>`;
  }).join('');

  const price = blade.price + fh.price + bh.price;
  const weight = blade.weight + fh.weight + bh.weight;
  const stack = blade.thickness + (state.fh.thickness + TOPSHEET_THICKNESS)
              + (state.bh.thickness + TOPSHEET_THICKNESS);
  const cls = classify(blade, fh, bh, m);

  $('kpis').innerHTML = [
    { icon: 'i-tag',    label: '整套价格', value: '¥' + price.toLocaleString('zh-CN') },
    { icon: 'i-scale',  label: '整拍重量', value: weight, unit: 'g' },
    { icon: 'i-ruler',  label: '拍面总厚', value: stack.toFixed(1), unit: 'mm' },
    { icon: 'i-paddle', label: '打法归类', value: cls.name },
  ].map(k => `<div class="kpi">
      <div class="kpi__label">${ic(k.icon)}${k.label}</div>
      <div class="kpi__value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</div>
    </div>`).join('');

  $('advice').textContent = cls.desc + ' ' + adviceOf(blade, fh, bh, m);

  const warnIcon = { ok: 'i-check-circle', warn: 'i-alert', bad: 'i-alert' };
  $('warns').innerHTML = legalityOf(blade, fh, bh).map(w =>
    `<div class="warn warn--${w.level}">${ic(warnIcon[w.level])}<span>${w.text}</span></div>`).join('');
}

function renderStageTag(blade, fh, bh) {
  $('stageName').textContent = `${blade.brandCn} ${blade.cn}`;
  $('stageMeta').textContent =
    `${blade.name} · 正手 ${fh.cn} / 反手 ${bh.cn} · ${HANDLE_SPECS[state.handle].cn}`;
}

/* ================= 主更新 ================= */

function current() {
  const blade = byId(BLADES, state.bladeId);
  const fh = byId(RUBBERS, state.fh.rubberId);
  const bh = byId(RUBBERS, state.bh.rubberId);
  return { blade, fh, bh };
}

function syncViewer() {
  const { blade, fh, bh } = current();
  try {
    viewer.setConfig({
      blade, fh, bh,
      fhThickness: state.fh.thickness,
      bhThickness: state.bh.thickness,
      fhColor: state.fh.color,
      bhColor: state.bh.color,
      handle: state.handle,
      edgeTape: state.edgeTape,
    });
  } catch (err) {
    console.error(err);
    $('stageErr').hidden = false;
    $('stageErr').textContent = '球拍装配失败：' + err.message;
  }
}

function renderAll() {
  const { blade, fh, bh } = current();
  renderBlades();
  renderRubbers();
  renderSideControls();
  renderHandleChips();
  renderPresets();
  renderStageTag(blade, fh, bh);
  renderHud(blade, fh, bh);
  syncViewer();
}

function renderHudOnly() {
  const { blade, fh, bh } = current();
  renderStageTag(blade, fh, bh);
  renderHud(blade, fh, bh);
}

/* ================= 交互 ================= */

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 1900);
}

function bindEvents() {
  // 底板
  $('bladeList').addEventListener('click', e => {
    const btn = e.target.closest('.item');
    if (!btn) return;
    state.bladeId = btn.dataset.id;
    state.presetId = null;
    renderBlades(); renderPresets(); renderHudOnly(); syncViewer();
  });
  $('bladeBrands').addEventListener('click', e => {
    const btn = e.target.closest('[data-brand]');
    if (!btn) return;
    state.bladeBrand = btn.dataset.brand;
    renderBrandChips(); renderBlades();
  });
  $('bladeSearch').addEventListener('input', e => {
    state.bladeQuery = e.target.value;
    renderBlades();
  });

  // 胶皮
  $('rubberList').addEventListener('click', e => {
    const btn = e.target.closest('.item');
    if (!btn) return;
    state[state.side].rubberId = btn.dataset.id;
    state.presetId = null;
    renderRubbers(); renderPresets(); renderSideControls(); renderHudOnly(); syncViewer();
  });
  $('sideTabs').addEventListener('click', e => {
    const btn = e.target.closest('.seg__btn');
    if (!btn) return;
    state.side = btn.dataset.side;
    renderSideControls(); renderRubbers();
  });
  $('colorRow').addEventListener('click', e => {
    const btn = e.target.closest('[data-color]');
    if (!btn) return;
    state[state.side].color = btn.dataset.color;
    renderSideControls(); renderHudOnly(); syncViewer();
  });
  $('thicknessRow').addEventListener('click', e => {
    const btn = e.target.closest('[data-th]');
    if (!btn) return;
    state[state.side].thickness = parseFloat(btn.dataset.th);
    renderSideControls(); renderHudOnly(); syncViewer();
  });
  $('rubberTypes').addEventListener('click', e => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    state.rubberType = btn.dataset.type;
    renderRubberFilters(); renderRubbers();
  });
  $('rubberBrands').addEventListener('click', e => {
    const btn = e.target.closest('[data-rbrand]');
    if (!btn) return;
    state.rubberBrand = btn.dataset.rbrand;
    renderRubberFilters(); renderRubbers();
  });
  $('rubberSearch').addEventListener('input', e => {
    state.rubberQuery = e.target.value;
    renderRubbers();
  });

  // 柄型 / 护边
  $('handleRow').addEventListener('click', e => {
    const btn = e.target.closest('[data-handle]');
    if (!btn) return;
    state.handle = btn.dataset.handle;
    renderHandleChips(); renderHudOnly(); syncViewer();
  });
  $('edgeTape').addEventListener('change', e => {
    state.edgeTape = e.target.checked;
    syncViewer();
  });

  // 预设
  $('presets').addEventListener('click', e => {
    const btn = e.target.closest('[data-preset]');
    if (!btn) return;
    const p = PRESETS.find(x => x.id === btn.dataset.preset);
    state.bladeId = p.blade;
    state.fh.rubberId = p.fh;
    state.bh.rubberId = p.bh;
    state.handle = p.handle;
    state.presetId = p.id;
    // 职业配置统一为「正手黑 / 反手红」
    state.fh.color = 'black';
    state.bh.color = 'red';
    renderAll();
    toast(`已载入 ${p.label} 的配置`);
  });

  // 视角
  document.querySelectorAll('.vbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.vbtn').forEach(b => b.classList.toggle('is-on', b === btn));
      viewer.setView(btn.dataset.view);
    });
  });

  // 顶栏动作
  $('btnAutoRotate').addEventListener('click', e => {
    state.autoRotate = !state.autoRotate;
    e.currentTarget.setAttribute('aria-pressed', String(state.autoRotate));
    viewer.setAutoRotate(state.autoRotate);
  });
  $('btnReset').addEventListener('click', () => {
    Object.assign(state, {
      bladeId: 'viscaria', handle: 'FL', presetId: null,
      fh: { rubberId: 'tenergy05', color: 'black', thickness: 2.1 },
      bh: { rubberId: 'tenergy05', color: 'red', thickness: 2.1 },
    });
    $('bladeSearch').value = '';
    $('rubberSearch').value = '';
    state.bladeQuery = ''; state.rubberQuery = '';
    state.bladeBrand = 'all'; state.rubberBrand = 'all'; state.rubberType = 'all';
    $('edgeTape').checked = true;
    state.edgeTape = true;
    renderBrandChips(); renderRubberFilters();
    renderAll();
    viewer.setView('iso');
    document.querySelectorAll('.vbtn').forEach(b => b.classList.toggle('is-on', b.dataset.view === 'iso'));
    toast('已恢复到默认配置');
  });
  $('btnShot').addEventListener('click', () => {
    try {
      const url = viewer.snapshot();
      const a = document.createElement('a');
      const { blade, fh } = current();
      a.href = url;
      a.download = `${blade.name}-${fh.name}.png`.replace(/\s+/g, '_');
      a.click();
      toast('已保存当前视角截图');
    } catch (err) {
      toast('截图失败：' + err.message);
    }
  });

  // 仪表盘悬浮说明
  const tip = $('tooltip');
  $('meters').addEventListener('mousemove', e => {
    const box = e.target.closest('.meter');
    if (!box) { tip.hidden = true; return; }
    const { blade, fh, bh } = current();
    const m = metricsOf(blade, fh, bh)[box.dataset.key];
    const name = METRICS.find(x => x.key === box.dataset.key).name;
    tip.innerHTML =
      `<b>${name}</b>　合计 <i>${m.total.toFixed(1)}</i><br>` +
      `底板贡献 <i>${m.blade.toFixed(1)}</i>　胶皮贡献 <i>${m.rubber.toFixed(1)}</i>`;
    tip.hidden = false;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 10) + 'px';
    tip.style.top = Math.max(e.clientY - tip.offsetHeight - 12, 8) + 'px';
  });
  $('meters').addEventListener('mouseleave', () => { tip.hidden = true; });
}

/* ================= 启动 ================= */

export async function boot() {
  renderBrandChips();
  renderRubberFilters();
  renderSideControls();
  renderRubbers();
  $('edgeTape').checked = state.edgeTape;

  let viewerError = null;
  try {
    viewer = new RacketViewer($('view'), { onError: m => { viewerError = m; } });
  } catch (err) {
    // 不把构造期的一切异常都甩锅给 WebGL —— 只有真的拿不到上下文才这么说
    const noGL = /webgl|context/i.test(err.message || '');
    $('stageLoading').hidden = true;
    $('stageErr').hidden = false;
    $('stageErr').textContent = noGL
      ? '无法创建 WebGL 上下文，3D 预览不可用。请确认浏览器已启用硬件加速。\n' + err.message
      : '3D 模块初始化失败：' + err.message;
    // 即便 3D 不可用，参数面板与性能评估仍然照常工作
    renderBlades(); renderPresets(); renderHandleChips();
    renderHudOnly();
    bindEvents();
    return;
  }

  renderBlades();
  renderPresets();
  renderHandleChips();
  renderAll();
  bindEvents();

  // 便于在浏览器控制台里检查场景与当前状态
  window.__racketLab = { viewer, state, metricsOf, legalityOf, classify };

  $('stageLoading').hidden = true;
  if (viewerError) {
    $('stageErr').hidden = false;
    $('stageErr').textContent = viewerError;
  }
  viewer.setAutoRotate(true);
}
