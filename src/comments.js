// src/comments.js
// 속성 기반 코멘트 생성.
// 신규 데이터엔 큐레이션 코멘트 컬럼이 없으므로, (장소 성격 × 군 톤)으로 조합해
// 덜 반복적이고 상태에 맞는 문구를 만든다. row_id를 시드로 써서 장소마다 결정적으로
// 다른 조합을 고른다. 이름은 카드 제목에 이미 있으므로 코멘트엔 넣지 않는다.

const DESCRIPTORS = {
  park: [
    "탁 트인 자연 속에서 아무 생각 없이 걷기 좋은 곳이에요",
    "초록 사이를 천천히 거닐며 머리를 비우기 좋아요",
    "맑은 공기 마시며 한 바퀴 걷기 좋은 곳이에요",
  ],
  outdoor: [
    "탁 트인 바깥에서 천천히 걷고 둘러보기 좋은 곳이에요",
    "바람 쐬며 가볍게 둘러보기 좋아요",
  ],
  art: [
    "조용히 작품 사이를 거니는 공간이에요",
    "그림 앞에 가만히 머무는 시간을 가질 수 있어요",
    "전시를 천천히 둘러보며 마음을 채우기 좋아요",
  ],
  museum: [
    "이야기와 전시물을 차분히 둘러보는 공간이에요",
    "천천히 둘러보며 잠시 다른 세계에 머물기 좋아요",
  ],
  performance: [
    "객석에 앉아 무대에 가만히 빠져드는 시간이에요",
    "공연 한 편에 몰입하며 잠시 쉬어가기 좋아요",
  ],
  movie: [
    "스크린 앞에 앉아 잠시 딴 세상으로 떠나기 좋아요",
    "영화 한 편에 푹 빠져드는 시간이에요",
  ],
  reading: [
    "책 사이에서 나만의 아늑한 시간을 보내기 좋아요",
    "서가를 거닐며 조용히 마음을 채우는 공간이에요",
  ],
  active: [
    "몸을 움직이며 머릿속을 비우기 좋은 곳이에요",
    "가볍게 땀 흘리며 기분을 전환하기 좋아요",
  ],
  community: [
    "따뜻한 사람들과 가벼운 체험을 즐기기 좋은 곳이에요",
    "소박한 분위기 속에서 가볍게 어울리기 좋아요",
  ],
  generic: [
    "잠시 일상에서 벗어나 머물기 좋은 곳이에요",
    "가볍게 들러 나만의 시간을 보내기 좋아요",
  ],
};

const TONE = {
  cli:  ["부담 갖지 말고, 마음 내킬 때 잠깐이면 충분해요.", "꼭 가지 않아도 괜찮아요. 이런 곳이 있다는 것만 기억해요.", "그냥 이런 곳이 있구나, 하고 알아두기만 해도 돼요."],
  burn: ["에너지 많이 쓰지 않아도 되는 곳이라 지금 딱 좋아요.", "짧게 들렀다 와도 충분해요.", "느긋하게, 쉬엄쉬엄 둘러봐도 좋아요."],
  isol: ["혼자 가도 전혀 이상하지 않은 곳이에요.", "누구와 말 섞지 않아도 괜찮아요.", "조용히 나만의 속도로 머물다 와도 돼요."],
  mix:  ["작게, 부담 없는 선에서 시작해봐요.", "무리하지 말고 혼자 조용히 다녀와도 좋아요.", "편한 마음으로, 한 걸음만 떼어봐요."],
  norm: ["오늘 같은 날 가볍게 다녀오기 좋아요.", "마음 가는 대로 편하게 즐겨봐요.", "기분 전환 삼아 한번 들러봐요."],
};

// 장소를 코멘트 풀(archetype)로 분류. 순서가 중요: 공원·야외가 먼저 걸러진다.
export function archetypeOf(r) {
  const c = r.category_key || "";
  if (r.is_outdoor_park) return "park";
  if (r.indoor_outdoor === "야외") return "outdoor";
  if (/미술|갤러리|전시|예술감상/.test(c)) return "art";
  if (/박물관|기념관|유적|향토/.test(c)) return "museum";
  if (/공연|연극|예술센터|문화센터|클래식/.test(c)) return "performance";
  if (/영화|시네마|극장/.test(c)) return "movie";
  if (/도서|문화탐색|교양/.test(c)) return "reading";
  if (/액티브|체육|오락|스포츠/.test(c)) return "active";
  if (/관계|체험|마을|농어촌/.test(c)) return "community";
  return "generic";
}

// 장소마다 결정적인 시드. row_id가 정수면 그대로, 아니면 시설명 해시.
function commentSeed(r) {
  if (Number.isInteger(r.row_id)) return r.row_id;
  let h = 0;
  const s = r.facility_name || "";
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** (archetype 문구 × 군 톤) 조합. nudge로 변형 → 결과 세트 내 중복 회피에 사용. */
export function composeComment(r, group, nudge = 0) {
  const dPool = DESCRIPTORS[archetypeOf(r)] || DESCRIPTORS.generic;
  const tPool = TONE[group] || TONE.norm;
  const seed = commentSeed(r);
  const desc = dPool[(seed + nudge) % dPool.length];
  const tone = tPool[(Math.floor(seed / 7) + nudge) % tPool.length];
  return `${desc}. ${tone}`;
}

export function pickComment(r, group) {
  // Attribute-based composer (장소 성격 × 군 톤). The new file has no curated comment
  // columns, so this is the only source. composeComment always returns a string.
  return composeComment(r, group);
}
