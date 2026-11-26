import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ===== 설정 =====
const TEXTURE_SIZE = 1024;                 // 면 하나(음절 하나)에 쓰는 텍스처 해상도(px)
// 글자 텍스처를 그릴 때의 바탕색. 흰색으로 그려 두고(= 글자는 흑백 명암),
// 실제 면 배경색은 머티리얼의 color로 곱해서 입힌다 → 배경색을 바꿔도 텍스처를 다시 그릴 필요가 없다.
const FACE_BACKGROUND = [1.0, 1.0, 1.0];

// 장면(화면) 배경색. 기본은 흰색이고, 좌측 하단 팔레트에서 바꾼다. 선택된 색을 다시 누르면 기본색으로 돌아간다.
const DEFAULT_BACKGROUND = '#ffffff';
// 3x3 팔레트 (왼쪽 위부터 가로 순서). 색은 자유롭게 수정 가능 — 항목은 9개로 유지
const BACKGROUND_PALETTE = [
  '#ffd6e0', '#ffe3c2', '#fff6bf',  // 분홍, 살구, 연노랑
  '#d6f2cf', '#c6efe6', '#cfe3f8',  // 연두, 민트, 하늘
  '#dccff5', '#f3d0ec', '#e6e0d6',  // 연보라, 연분홍보라, 베이지
];
const MAX_CELLS = 8;                       // shaders/frag.glsl의 MAX_CELLS와 동일하게 유지
const EDGE_BIT = { top: 1, right: 2, bottom: 4, left: 8, diagRight: 16, diagLeft: 32, circle: 64, circleOut: 128 };

// 큐브의 어느 면에 어느 자모를 보여줄지. BoxGeometry 면 순서: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z
// 카메라가 (+x, +y, +z) 쪽에서 볼 때: 윗면(+y) = 초성, 왼쪽 옆면(+z) = 중성, 오른쪽 옆면(+x) = 종성.
// 각 면의 마주보는 면(-x, -y, -z)에도 같은 자모를 넣는다. (면 번호 ^ 1)
const FACE_INDEX = { initial: 2, medial: 4, final: 0 };

// 처음에 보여줄 글자
const DEFAULT_TEXT = '한글큐브';

// 큐브 격자 크기 (열 x 행). 기본 3x3, 사용자가 최대 MAX_GRID x MAX_GRID까지 늘릴 수 있다.
const DEFAULT_COLS = 2;
const DEFAULT_ROWS = 2;
const MAX_GRID = 7;

// ===== 한글 음절 분해 =====
const INITIALS = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const MEDIALS  = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
// 종성 index 0 = 받침 없음
const FINALS   = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];

// 문자 하나를 { initial, medial, final } 로 분해. 한글이 아니면 null.
// - 완성형 음절(가~힣): 초성/중성/종성으로 분해
// - 낱자(ㄱ, ㅏ 등): 입력 도중(IME 조합 중)에 나타나므로 해당 슬롯에 하나만 표시
function decompose(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 0xAC00 && code <= 0xD7A3) {
    const n = code - 0xAC00;
    return {
      initial: INITIALS[Math.floor(n / 588)],
      medial: MEDIALS[Math.floor((n % 588) / 28)],
      final: FINALS[n % 28] || null,
    };
  }
  if (INITIALS.includes(ch)) return { initial: ch, medial: null, final: null };
  if (MEDIALS.includes(ch)) return { initial: null, medial: ch, final: null };
  return null;
}

// ===== 외부 파일 로드 =====
async function loadText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`로드 실패: ${path} (${res.status})`);
  return res.text();
}

// ===== 자모 → 캔버스 텍스처 =====
// 오프스크린 WebGL2로 shaders/의 글자 셰이더를 렌더링한 뒤, 2D 캔버스로 복사한다. (자모 하나 = 면 하나)
function createGlyphRenderer(vertexSrc, fragmentSrc) {
  const glCanvas = document.createElement('canvas');
  glCanvas.width = glCanvas.height = TEXTURE_SIZE;
  const gl = glCanvas.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2를 지원하지 않는 환경입니다.');

  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSrc));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSrc));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);

  const loc = {
    resolution:  gl.getUniformLocation(program, 'u_resolution'),
    blockOrigin: gl.getUniformLocation(program, 'u_blockOrigin'),
    background:  gl.getUniformLocation(program, 'u_background'),
    cellCount:   gl.getUniformLocation(program, 'u_cellCount'),
    cellRect:    gl.getUniformLocation(program, 'u_cellRect'),
    cellEdges:   gl.getUniformLocation(program, 'u_cellEdges'),
  };

  // 글자가 텍스처 전체를 채우므로 타일 = 텍스처 전체
  gl.viewport(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  gl.uniform2f(loc.resolution, TEXTURE_SIZE, TEXTURE_SIZE);
  gl.uniform2f(loc.blockOrigin, 0, 0);
  gl.uniform3f(loc.background, ...FACE_BACKGROUND);

  // 자모 하나(칸 목록)를 그려서 독립된 2D 캔버스로 반환
  return function renderGlyph(cells) {
    if (cells.length > MAX_CELLS) throw new Error(`칸이 너무 많습니다 (최대 ${MAX_CELLS})`);
    const rects = new Float32Array(MAX_CELLS * 4);
    const edges = new Int32Array(MAX_CELLS);
    cells.forEach((cell, i) => {
      rects.set(cell.rect, i * 4);
      edges[i] = cell.edges.reduce((m, name) => m | EDGE_BIT[name], 0);
    });
    gl.uniform1i(loc.cellCount, cells.length);
    gl.uniform4fv(loc.cellRect, rects);
    gl.uniform1iv(loc.cellEdges, edges);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const out = document.createElement('canvas');
    out.width = out.height = TEXTURE_SIZE;
    out.getContext('2d').drawImage(glCanvas, 0, 0);
    return out;
  };
}

// ===== three.js 장면 =====
async function main() {
  const [vertexSrc, fragmentSrc, glyphJson] = await Promise.all([
    loadText('shaders/vert.glsl'),
    loadText('shaders/frag.glsl'),
    loadText('shaders/glyphs.json'),
  ]);
  const glyphs = JSON.parse(glyphJson);  // { initial: {...}, medial: {...}, final: {...} }
  const renderGlyph = createGlyphRenderer(vertexSrc, fragmentSrc);

  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DEFAULT_BACKGROUND);
  let currentBackground = DEFAULT_BACKGROUND;  // 화면 배경 = 큐브 면 배경

  // 화면 배경색과 큐브 면 배경색을 함께 바꾼다.
  function applyBackground(color) {
    currentBackground = color;
    scene.background.set(color);
    blankMaterial.color.set(color);
    for (const mat of materialCache.values()) mat.color.set(color);
  }

  // ----- 좌측 하단 패널: 배경색 팔레트 (3x3 파스텔 + '배경색' 옆의 흰색 1칸) -----
  const swatchesEl = document.getElementById('swatches');
  const whiteSwatch = document.getElementById('white-swatch');
  const swatchEls = [];

  function addSwatch(el, color) {
    el.style.background = color;
    el.title = color;
    el.addEventListener('click', () => {
      swatchEls.forEach(s => s.classList.remove('selected'));
      el.classList.add('selected');
      applyBackground(color);
    });
    swatchEls.push(el);
  }

  addSwatch(whiteSwatch, DEFAULT_BACKGROUND);
  whiteSwatch.classList.add('selected');  // 기본은 흰색
  for (const color of BACKGROUND_PALETTE) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'swatch';
    addSwatch(el, color);
    swatchesEl.appendChild(el);
  }

  // 직교(orthographic) 카메라: 직교 투영에서는 거리에 따라 크기가 변하지 않으므로,
  // "멀리서 보는 효과"는 화면에 보이는 높이(VIEW_HEIGHT)를 키워서 구현한다.
  // 값이 클수록 큐브가 작게 보임. 큐브 한 변은 2.
  const VIEW_HEIGHT = 12;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(10, 10, 10);  // 거리도 함께 늘려 near/far 범위 안에서 여유를 둠

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // ----- 자모 → 머티리얼 (캐시) -----
  // 같은 풀의 같은 자모는 텍스처를 한 번만 만들어 재사용한다. (초성 ㅇ과 종성 ㅇ은 별개 항목)
  const materialCache = new Map();
  const blankMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(currentBackground) });

  function glyphMaterial(pool, jamo) {
    if (!jamo) return blankMaterial;
    const cells = glyphs[pool][jamo];
    if (!cells) return blankMaterial;  // 정의가 없는 자모는 빈 면
    const key = `${pool}:${jamo}`;
    let mat = materialCache.get(key);
    if (!mat) {
      const texture = new THREE.CanvasTexture(renderGlyph(cells));
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = maxAniso;
      mat = new THREE.MeshBasicMaterial({ map: texture, color: new THREE.Color(currentBackground) });
      materialCache.set(key, mat);
    }
    return mat;
  }

  // 문자 하나 → 큐브의 6면 머티리얼 배열 (초성/중성/종성 면만 채우고 나머지는 빈 면)
  function facesFor(ch) {
    const faces = Array(6).fill(blankMaterial);
    const parts = decompose(ch);  // 공백, 영문, 숫자 등은 null → 전부 빈 면
    if (parts) {
      for (const pool of ['initial', 'medial', 'final']) {
        const mat = glyphMaterial(pool, parts[pool]);
        const idx = FACE_INDEX[pool];
        faces[idx] = mat;
        faces[idx ^ 1] = mat;  // 마주보는 면 (0↔1, 2↔3, 4↔5)에 같은 자모
      }
    }
    return faces;
  }

  // ----- 바닥(XZ 평면) 격자. cols: X 방향 개수, rows: Z 방향 개수. 간격 0 -----
  // 큐브 한 변 2 → 중심 간격도 2. 밑면이 바닥(y=0)에 닿도록 y = 1
  const CUBE_SIZE = 2;
  const geometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
  let cols = DEFAULT_COLS;
  let rows = DEFAULT_ROWS;
  let cubes = [];
  let viewHeight = VIEW_HEIGHT;

  // 격자를 (다시) 만든다. 큐브 순서: X 방향으로 먼저, 그다음 Z 방향 (글을 읽는 순서 = 입력 칸 순서)
  function buildCubes() {
    for (const cube of cubes) scene.remove(cube);  // 지오메트리/머티리얼은 공유하므로 dispose 불필요
    cubes = [];
    const offsetX = (cols - 1) * CUBE_SIZE / 2;  // 격자를 원점 중심에 맞추기 위한 오프셋
    const offsetZ = (rows - 1) * CUBE_SIZE / 2;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const cube = new THREE.Mesh(geometry, Array(6).fill(blankMaterial));
        cube.position.set(i * CUBE_SIZE - offsetX, CUBE_SIZE / 2, j * CUBE_SIZE - offsetZ);
        scene.add(cube);
        cubes.push(cube);
      }
    }
    // 격자가 커질수록 화면에 보이는 높이도 키워서 전체가 들어오게 한다 (3x3일 때 VIEW_HEIGHT)
    viewHeight = VIEW_HEIGHT * Math.max(1, Math.max(cols, rows) / 3);
  }

  // 큐브 하나 = 음절 하나. 윗면=초성, 왼쪽 옆면=중성, 오른쪽 옆면=종성.
  // 글자 수보다 큐브가 많으면 나머지는 빈 큐브, 글자가 더 많으면 앞쪽 글자만 보인다.
  function showText(text) {
    const chars = Array.from(text);
    cubes.forEach((cube, k) => {
      cube.material = k < chars.length ? facesFor(chars[k]) : Array(6).fill(blankMaterial);
    });
  }

  // ----- 우측 하단 패널: 크기 선택(드래그) + 입력 칸 -----
  // 입력은 숨겨진 <input> 하나가 받고(한글 IME 조합이 안전하게 동작), 칸(cell)은 그 글자를 순서대로 보여준다.
  // 칸을 클릭하면 그 칸으로 커서가 이동하고, 타이핑하면 글자가 칸을 채우며 다음 칸으로 넘어간다.
  const input = document.getElementById('typing');
  const cellsEl = document.getElementById('cells');
  const pickerEl = document.getElementById('picker');
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  let cellEls = [];
  let composing = false;  // 한글 조합 중인지

  function buildCells() {
    cellsEl.style.gridTemplateColumns = `repeat(${cols}, var(--cell))`;
    cellsEl.replaceChildren();
    cellEls = [];
    for (let k = 0; k < cols * rows; k++) {
      const el = document.createElement('div');
      el.className = 'cell';
      el.addEventListener('mousedown', e => { e.preventDefault(); selectCell(k); });
      cellsEl.appendChild(el);
      cellEls.push(el);
    }
  }

  // 지금 커서가 있는 칸 (포커스가 없으면 -1)
  function activeCell() {
    if (document.activeElement !== input) return -1;
    const pos = input.selectionStart ?? 0;
    return clamp(composing ? pos - 1 : pos, 0, cols * rows - 1);  // 조합 중인 글자는 커서 앞에 있음
  }

  // 칸 수보다 긴 입력은 잘라낸다
  function clampText() {
    const chars = Array.from(input.value);
    const max = cols * rows;
    if (chars.length > max) {
      input.value = chars.slice(0, max).join('');
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  // k번째 칸으로 커서 이동. 이미 글자가 있으면 선택해서 바로 덮어쓸 수 있게 한다.
  function selectCell(k) {
    const chars = Array.from(input.value);
    while (chars.length < k) chars.push(' ');  // 앞쪽 빈 칸은 공백으로 채움
    input.value = chars.join('');
    input.focus();
    if (k < chars.length) input.setSelectionRange(k, k + 1);
    else input.setSelectionRange(k, k);
    refresh();
  }

  function refresh() {
    const chars = Array.from(input.value);
    const active = activeCell();
    cellEls.forEach((el, k) => {
      const ch = chars[k] ?? '';
      el.textContent = ch.trim();  // 공백은 빈 칸으로
      el.classList.toggle('active', k === active);
    });
    showText(input.value);
  }

  input.addEventListener('input', () => { clampText(); refresh(); });  // 한글 조합(IME) 중에도 발생
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionupdate', refresh);
  input.addEventListener('compositionend', () => { composing = false; refresh(); });
  for (const type of ['keyup', 'mouseup', 'focus', 'blur']) input.addEventListener(type, refresh);
  // 위/아래 방향키: 한 행 이동
  input.addEventListener('keydown', e => {
    if (e.isComposing || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const k = (input.selectionStart ?? 0) + (e.key === 'ArrowDown' ? cols : -cols);
    if (k >= 0 && k < cols * rows) selectCell(k);
  });

  // ----- 크기 선택기: MAX_GRID x MAX_GRID 칸 위에서 왼쪽 위부터 드래그한 만큼이 열 x 행 -----
  const PICK_PITCH = 16;  // style.css의 .pick 크기 + 간격과 같아야 함
  const pickEls = [];
  for (let n = 0; n < MAX_GRID * MAX_GRID; n++) {
    const el = document.createElement('div');
    el.className = 'pick';
    pickerEl.appendChild(el);
    pickEls.push(el);
  }

  function paintPicker(c, r) {
    pickEls.forEach((el, n) => {
      el.classList.toggle('on', n % MAX_GRID < c && Math.floor(n / MAX_GRID) < r);
    });
  }

  function pickAt(e) {
    const rect = pickerEl.getBoundingClientRect();
    return [
      clamp(Math.floor((e.clientX - rect.left) / PICK_PITCH) + 1, 1, MAX_GRID),
      clamp(Math.floor((e.clientY - rect.top) / PICK_PITCH) + 1, 1, MAX_GRID),
    ];
  }

  let dragging = false;
  pickerEl.addEventListener('pointerdown', e => {
    dragging = true;
    pickerEl.setPointerCapture(e.pointerId);
    paintPicker(...pickAt(e));
  });
  pickerEl.addEventListener('pointermove', e => {
    if (dragging) paintPicker(...pickAt(e));
  });
  pickerEl.addEventListener('pointerup', e => {
    if (!dragging) return;
    dragging = false;
    setGridSize(...pickAt(e));
    input.focus();
  });
  pickerEl.addEventListener('pointercancel', () => {
    dragging = false;
    paintPicker(cols, rows);  // 선택 취소 → 현재 크기로 복귀
  });

  // 열 x 행 크기를 바꾼다: 큐브 격자, 입력 칸, 선택기, 카메라를 모두 갱신
  function setGridSize(c, r) {
    cols = c;
    rows = r;
    clampText();
    buildCubes();
    buildCells();
    paintPicker(cols, rows);
    resize();
    refresh();
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, CUBE_SIZE / 2, 0);  // 격자의 중심을 회전 중심으로
  controls.enableDamping = true;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    const halfH = viewHeight / 2;
    const halfW = halfH * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  // ----- 초성만 보기: 바로 위에서 내려다보는 토글 -----
  // 켜면 카메라가 큐브 격자 바로 위로 이동해 윗면(초성)만 2D 평면처럼 보이고, 다시 누르면 원래 앵글로 돌아간다.
  const topViewBtn = document.getElementById('top-view');
  let savedView = null;  // 토글 전 카메라 상태 (null이면 평소 시점)

  topViewBtn.addEventListener('click', () => {
    const on = savedView === null;
    if (on) {
      savedView = { position: camera.position.clone(), target: controls.target.clone(), zoom: camera.zoom };
      // 방위각 0(카메라가 +z 쪽에 살짝 치우침)으로 내려다보면 윗면 글자가 바르게 서서 보인다.
      const dist = camera.position.distanceTo(controls.target);
      const phi = 0.001;  // 수직에 거의 가깝게 (정확히 90도면 카메라 up 방향이 불안정)
      camera.position.set(
        controls.target.x,
        controls.target.y + dist * Math.cos(phi),
        controls.target.z + dist * Math.sin(phi),
      );
      controls.enableRotate = false;  // 2D 평면 유지 (줌/이동은 가능)
    } else {
      camera.position.copy(savedView.position);
      controls.target.copy(savedView.target);
      camera.zoom = savedView.zoom;
      camera.updateProjectionMatrix();
      controls.enableRotate = true;
      savedView = null;
    }
    controls.update();
    topViewBtn.classList.toggle('on', on);
    topViewBtn.setAttribute('aria-pressed', String(on));
  });

  // ----- 이미지 저장: 아트워크(큐브 격자)만 PNG로 -----
  // 패널 등 UI는 캔버스 밖(DOM)이라 자동으로 빠진다. CROP_TO_ARTWORK가 true면 격자 영역만 잘라서 저장한다.
  const CROP_TO_ARTWORK = true;
  const SAVE_PADDING = 0.04;  // 잘라낼 때 아트워크 크기 대비 여백 비율

  document.getElementById('save').addEventListener('click', () => {
    renderer.render(scene, camera);  // 그리기 버퍼가 비워지기 전에, 같은 작업 안에서 읽어야 한다
    const src = renderer.domElement;
    let sx = 0, sy = 0, sw = src.width, sh = src.height;

    if (CROP_TO_ARTWORK) {
      // 격자 전체를 감싸는 상자의 8개 꼭짓점을 화면(픽셀) 좌표로 투영해 영역을 구한다
      const hx = cols * CUBE_SIZE / 2;
      const hz = rows * CUBE_SIZE / 2;
      const v = new THREE.Vector3();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const x of [-hx, hx]) for (const y of [0, CUBE_SIZE]) for (const z of [-hz, hz]) {
        v.set(x, y, z).project(camera);
        const px = (v.x * 0.5 + 0.5) * src.width;
        const py = (1 - (v.y * 0.5 + 0.5)) * src.height;
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const pad = Math.max(maxX - minX, maxY - minY) * SAVE_PADDING;
      const x0 = Math.max(0, Math.floor(minX - pad));
      const y0 = Math.max(0, Math.floor(minY - pad));
      const x1 = Math.min(src.width, Math.ceil(maxX + pad));
      const y1 = Math.min(src.height, Math.ceil(maxY + pad));
      if (x1 > x0 && y1 > y0) { sx = x0; sy = y0; sw = x1 - x0; sh = y1 - y0; }
    }

    const out = document.createElement('canvas');
    out.width = sw;
    out.height = sh;
    out.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
    out.toBlob(blob => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'hangul_cube.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  });

  // 초기 상태: 2x2, 칸마다 DEFAULT_TEXT의 글자가 하나씩
  input.value = DEFAULT_TEXT;
  setGridSize(DEFAULT_COLS, DEFAULT_ROWS);
  input.focus();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch(err => console.error(err));
