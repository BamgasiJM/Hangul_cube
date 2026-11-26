#version 300 es
precision highp float;

// 글자 정의: 칸(cell) 목록. 좌표는 아트워크 기준 0~1 (원점: 좌하단)
const int MAX_CELLS = 8;
uniform int  u_cellCount;
uniform vec4 u_cellRect[MAX_CELLS];   // (x0, y0, x1, y1)
uniform int  u_cellEdges[MAX_CELLS];  // 비트마스크: top=1, right=2, bottom=4, left=8, diagRight=16, diagLeft=32, circle=64

uniform vec2 u_resolution;   // 블록(한 글자 영역) 크기
uniform vec2 u_blockOrigin;  // 블록의 캔버스 내 좌하단 위치 (gl_FragCoord는 캔버스 기준이라 보정)
out vec4 outColor;

// ===== 그라데이션 조정값 (모든 변/대각선/원에 공통 적용) =====
// FALLOFF: 그라데이션이 퍼지는 거리 (아트워크 전체 기준 0~1). 클수록 멀리 퍼짐
const float FALLOFF = 0.9;
// K: 곡선 모양. 1.0 = 기본 smoothstep, 1 미만 = 검정이 강하고 꼬리가 길게, 1 초과 = 빨리 옅어짐
const float K = 15.0;

// 가장자리에서의 거리 d → 0(검정) ~ 1(투명)
float falloffCurve(float d) {
  return 1.0 - pow(1.0 - smoothstep(0.0, FALLOFF, d), K);
}

void main() {
  // 아트워크 영역: 캔버스 중앙의 500x500 (픽셀 단위)
  const float ART_SIZE = 500.0;
  vec2 origin = (u_resolution - vec2(ART_SIZE)) * 0.5;
  vec2 p = gl_FragCoord.xy - u_blockOrigin - origin;

  // 아트워크 영역 밖은 투명
  if (p.x < 0.0 || p.y < 0.0 || p.x >= ART_SIZE || p.y >= ART_SIZE) {
    outColor = vec4(0.0);
    return;
  }

  // 아트워크 영역 기준 0~1 정규화 좌표 (원점: 좌하단)
  vec2 uv = p / ART_SIZE;

  // 현재 픽셀이 속한 칸을 찾아, 그 칸의 지정된 변들로부터 그라데이션 계산
  float t = 1.0;  // 1 = 투명, 0 = 검정
  for (int i = 0; i < MAX_CELLS; i++) {
    if (i >= u_cellCount) break;

    vec4 r = u_cellRect[i];
    if (uv.x < r.x || uv.y < r.y || uv.x >= r.z || uv.y >= r.w) continue;

    int e = u_cellEdges[i];
    if ((e & 1) != 0) t *= falloffCurve(r.w - uv.y);  // 위
    if ((e & 2) != 0) t *= falloffCurve(r.z - uv.x);  // 오른쪽
    if ((e & 4) != 0) t *= falloffCurve(uv.y - r.y);  // 아래
    if ((e & 8) != 0) t *= falloffCurve(uv.x - r.x);  // 왼쪽

    // 대각선: 칸의 두 꼭짓점을 잇는 선에서 수직 거리로 그라데이션
    // 선 반대쪽(획 바깥)은 투명
    float w = r.z - r.x;
    float h = r.w - r.y;
    float len = length(vec2(w, h));
    if ((e & 16) != 0) {
      // "/" 선: 좌하단 → 우상단, 그라데이션은 선의 오른쪽(오른쪽 아래)으로
      float s = dot(uv - r.xy, vec2(h, -w)) / len;
      float cover = clamp(s * ART_SIZE + 0.5, 0.0, 1.0);  // 선 경계 안티앨리어싱
      t *= mix(1.0, falloffCurve(s), cover);
    }
    if ((e & 32) != 0) {
      // "\" 선: 좌상단 → 우하단, 그라데이션은 선의 왼쪽(왼쪽 아래)으로
      float s = dot(uv - vec2(r.x, r.w), vec2(-h, -w)) / len;
      float cover = clamp(s * ART_SIZE + 0.5, 0.0, 1.0);
      t *= mix(1.0, falloffCurve(s), cover);
    }
    if ((e & 64) != 0) {
      // 원: 칸에 내접하는 원의 둘레에서 안쪽으로, 원 바깥은 투명
      vec2 c = (r.xy + r.zw) * 0.5;
      float d = 0.5 * min(w, h) - length(uv - c);
      float cover = clamp(d * ART_SIZE + 0.5, 0.0, 1.0);
      t *= mix(1.0, falloffCurve(d), cover);
    }
    break;
  }

  // 변에 가까울수록 검정(불투명), 멀어질수록 투명
  outColor = vec4(vec3(0.0), 1.0 - t);
}
