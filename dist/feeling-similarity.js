// Ghosting's small, transparent expression dictionary.
// Labels come from dance_descriptions.txt. Tags and aliases are editorial
// comparisons of those descriptions, not an emotion model or calibrated score.
(function (root) {
  'use strict';
  const profiles = {
    '우아한': 'soft fluid refined beautiful',
    '유려한': 'soft fluid continuous smooth',
    '감미로운': 'soft fluid warm lyrical',
    '나비 같은': 'light airy soft beautiful',
    '연연한': 'soft delicate slender',
    '미려한': 'beautiful refined graceful',
    '매끄러운': 'fluid continuous smooth',
    '사뿐한': 'light airy gentle',
    '나풀거리는': 'light airy flowing oscillating',
    '역동적인': 'energetic fast changing expansive',
    '폭발적인': 'energetic forceful sudden expansive',
    '절도 있는': 'sharp precise rhythmic controlled',
    '파워풀한': 'energetic forceful grounded',
    '격정적인': 'energetic forceful intense expressive',
    '거침없는': 'direct expansive continuous forceful',
    '저돌적인': 'direct forceful intense forward',
    '직선적인': 'direct linear sharp',
    '압도적인': 'expansive forceful intense',
    '몽환적인': 'dreamy airy slow mysterious',
    '신비로운': 'mysterious dreamy enigmatic',
    '의식적인': 'solemn controlled repeated mysterious',
    '홀린 듯한': 'absorbed intense mysterious',
    '환상적인': 'dreamy changing beautiful mysterious',
    '정령 같은': 'airy light mysterious',
    '매혹적인': 'mysterious sensual refined',
    '몽롱한': 'dreamy slow absorbed',
    '경쾌한': 'light rhythmic buoyant playful',
    '재치 있는': 'playful surprising changing',
    '그루비한': 'rhythmic syncopated fluid',
    '분주한': 'fast changing small playful',
    '자유분방한': 'free expansive changing playful',
    '익살스러운': 'playful surprising expressive',
    '리드미컬한': 'rhythmic repeated timed',
    '통통 튀는': 'light buoyant rhythmic',
    '애절한': 'sorrowful expressive intense',
    '서정적인': 'lyrical expressive soft',
    '처연한': 'sorrowful delicate soft',
    '격앙된': 'intense energetic sudden expressive',
    '절제된': 'controlled restrained small',
    '묵직한': 'grounded heavy slow intense',
    '호소력 짙은': 'expressive intense lyrical',
    '처절한': 'intense forceful expressive',
    '정교한': 'precise detailed small controlled',
    '감각적인': 'sensual refined beautiful',
    '기하학적인': 'linear angular precise shaped',
    '날카로운': 'sharp sudden precise direct',
    '유연한': 'soft fluid flowing flexible',
    '아크로바틱한': 'technical expansive forceful flexible',
    '미니멀한': 'small restrained controlled',
    '유기적인': 'fluid flowing expanding natural'
  };
  const aliases = {
    우아: '우아한', 유려: '유려한', 부드러운: '유려한', 부드럽게: '유려한',
    감미: '감미로운', 나비: '나비 같은', 가녀린: '연연한', 아름다운: '미려한',
    매끄럽게: '매끄러운', 사뿐: '사뿐한', 가벼운: '사뿐한', 나풀나풀: '나풀거리는',
    역동적: '역동적인', 폭발적: '폭발적인', 절도: '절도 있는', 파워풀: '파워풀한',
    격정적: '격정적인', 거침없이: '거침없는', 저돌적: '저돌적인',
    직선적: '직선적인', 압도적: '압도적인', 몽환적: '몽환적인', 신비: '신비로운',
    의식적: '의식적인', 홀린듯: '홀린 듯한', 환상적: '환상적인', 정령: '정령 같은',
    매혹적: '매혹적인', 몽롱: '몽롱한', 경쾌: '경쾌한', 재치: '재치 있는',
    그루비: '그루비한', 분주: '분주한', 자유로운: '자유분방한', 자유롭게: '자유분방한',
    익살: '익살스러운', 리드미컬: '리드미컬한', 리듬감: '리드미컬한',
    통통튀는: '통통 튀는', 통통: '통통 튀는', 애절: '애절한', 슬픈: '애절한',
    슬픔: '애절한', 서정적: '서정적인', 처연: '처연한', 격앙: '격앙된',
    절제: '절제된', 묵직: '묵직한', 무거운: '묵직한', 호소력: '호소력 짙은',
    처절: '처절한', 정교: '정교한', 감각적: '감각적인', 기하학적: '기하학적인',
    날카롭게: '날카로운', 예리한: '날카로운', 유연: '유연한', 유연하게: '유연한',
    아크로바틱: '아크로바틱한', 미니멀: '미니멀한', 유기적: '유기적인'
  };
  // Common short intentions not themselves in the supplied AI vocabulary.
  const intentions = {
    '빠른': 'fast energetic sudden',
    '느린': 'slow gentle restrained',
    '차분한': 'controlled restrained gentle slow',
    '초조한': 'fast repeated sudden small',
    '긴장된': 'controlled intense sudden',
    '편안한': 'soft gentle natural fluid',
    '행복한': 'playful light buoyant',
    '신나는': 'energetic playful rhythmic',
    '강한': 'forceful energetic intense',
    '조심스러운': 'controlled small delicate restrained',
    '머뭇거리는': 'restrained repeated small',
    '섬세한': 'delicate precise detailed small'
  };
  Object.assign(aliases, {
    빠르게: '빠른', 빠름: '빠른', 느리게: '느린', 느림: '느린',
    차분: '차분한', 차분하게: '차분한', 초조: '초조한', 긴장: '긴장된',
    편안: '편안한', 행복: '행복한', 신나게: '신나는', 강하게: '강한',
    조심: '조심스러운', 조심스런: '조심스러운', 머뭇: '머뭇거리는', 섬세: '섬세한'
  });
  const normalize = value => typeof value === 'string'
    ? value.normalize('NFC').toLocaleLowerCase('ko').replace(/[\s.,!?·'“”‘’]/gu, '') : '';
  const words = new Map(Object.entries({...profiles, ...intentions})
    .map(([label, tags]) => [normalize(label), {label, tags: new Set(tags.split(' '))}]));
  const names = new Map(Object.entries(aliases).map(([alias, label]) => [normalize(alias), normalize(label)]));
  const resolve = value => {
    const key = normalize(value);
    return words.get(names.get(key) || key);
  };
  const vocabulary = Object.freeze(Object.keys(profiles));

  function compare(intent, qualities) {
    const phrase = typeof intent === 'string' ? intent.trim() : '';
    if (!phrase) return {score: null, matched: null, reason: '5자 이내로 의도한 느낌을 입력해 주세요.'};
    const target = resolve(phrase);
    if (!target) return {
      score: null, matched: null,
      reason: '이 표현은 아직 사전에 없어 수치를 계산하지 않았어요. 경쾌한·유연한 등으로 적어보세요.'
    };
    const candidates = (Array.isArray(qualities) ? qualities : [])
      .filter(label => Object.hasOwn(profiles, label));
    if (!candidates.length) return {score: null, matched: null, reason: 'AI 해석이 도착하면 표현을 비교합니다.'};
    let best = {score: -1, matched: null};
    for (const label of candidates) {
      const candidate = resolve(label);
      const shared = [...target.tags].filter(tag => candidate.tags.has(tag)).length;
      const score = candidate.label === target.label ? 100
        : Math.round(200 * shared / (target.tags.size + candidate.tags.size));
      if (score > best.score) best = {score, matched: label};
    }
    return {
      ...best,
      reason: `AI 표현 중 ‘${best.matched}’과 가장 가깝게 비교했어요. 같은 표현·동의어는 100%, 그 외에는 사전에 정리한 의미 특징의 겹침을 계산합니다.`
    };
  }
  const api = Object.freeze({compare, vocabulary});
  root.GhostingSimilarity = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'object' ? window : globalThis);
