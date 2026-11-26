import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ===== 설정 =====
const TEXTURE_SIZE = 1024;                 // 면 하나에 쓰는 텍스처 해상도(px)
const FACE_BACKGROUND = [1.0, 1.0, 1.0]; // 면 배경색 (0~1 RGB)
const MAX_CELLS = 8;                       // shaders/frag.glsl의 MAX_CELLS와 동일하게 유지
const EDGE_BIT = { top: 1, right: 2, bottom: 4, left: 8, diagRight: 16, diagLeft: 32, circle: 64 };

// ===== 외부 파일 로드 =====
async function loadText(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`로드 실패: ${path} (${res.status})`);
  return res.text();
}

// ===== 글자 → 캔버스 텍스처 =====
// 오프스크린 WebGL2로 shaders/의 글자 셰이더를 렌더링한 뒤, 2D 캔버스로 복사해서 CanvasTexture의 소스로 쓴다.
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
    resolution: gl.getUniformLocation(program, 'u_resolution'),
    background: gl.getUniformLocation(program, 'u_background'),
    cellCount:  gl.getUniformLocation(program, 'u_cellCount'),
    cellRect:   gl.getUniformLocation(program, 'u_cellRect'),
    cellEdges:  gl.getUniformLocation(program, 'u_cellEdges'),
  };

  gl.viewport(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  gl.uniform2f(loc.resolution, TEXTURE_SIZE, TEXTURE_SIZE);
  gl.uniform3f(loc.background, ...FACE_BACKGROUND);

  // 글자 하나를 그려서 독립된 2D 캔버스로 반환
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
  const glyphs = JSON.parse(glyphJson);
  const names = Object.keys(glyphs).slice(0, 6);  // 앞에서부터 6개 (ㄱ ㄴ ㄷ ㄹ ㅁ ㅂ)
  if (names.length < 6) throw new Error('큐브에 쓸 글자가 6개 미만입니다.');

  const renderGlyph = createGlyphRenderer(vertexSrc, fragmentSrc);

  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  // 직교(orthographic) 카메라: 화면 세로로 보이는 높이(월드 단위)를 고정하고, 가로는 창 비율에 맞춘다
  const VIEW_HEIGHT = 4;  // 큐브 한 변이 2이므로 여백을 위해 4
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(3, 2.5, 4);

  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  // 큐브 면 순서: +x, -x, +y, -y, +z, -z  ← names[0..5] 순서대로
  const materials = names.map(name => {
    const texture = new THREE.CanvasTexture(renderGlyph(glyphs[name]));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAniso;
    return new THREE.MeshBasicMaterial({ map: texture });
  });

  const cube = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), materials);
  scene.add(cube);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    const halfH = VIEW_HEIGHT / 2;
    const halfW = halfH * (w / h);
    camera.left = -halfW;
    camera.right = halfW;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  renderer.setAnimationLoop(() => {
    controls.update();
    renderer.render(scene, camera);
  });
}

main().catch(err => console.error(err));
