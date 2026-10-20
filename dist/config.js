/* 공개 설정만 넣습니다. API 키는 절대로 이 파일에 넣지 마세요.
   GitHub Pages: 배포한 Cloudflare Worker의 루트 URL을 apiBase에 입력합니다.
   로컬 node server.cjs: 공개 apiBase 값과 관계없이 같은 로컬 서버의 /api/*를 사용합니다.
   apiBase에는 공개 서버의 HTTPS 주소만 사용합니다. */
window.JANSANG_CONFIG = Object.freeze({
  apiBase: 'https://jansang-motion-api.jansang.workers.dev'
});
