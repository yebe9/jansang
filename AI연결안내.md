# 잔상 · 실제 Gemini 해석 연결하기

현재 웹캠과 기본 수치 분석은 키 없이 동작한다. **2026년 10월 20일, 로컬 키 인증·합성 좌표에 대한 실제 Gemini 응답·브라우저 결과 표시를 확인했다.** 로컬 페이지에서 **예시 먼저 보기 → AI로 움직임 해석하기**를 실행해 **Gemini 해석** 표시와 생성된 설명, 근거 3개를 확인했다. 기존 `gemini-2.5-flash`의 신규 사용자 이용 제한을 발견해 기본 모델을 `gemini-3.8-flash`로 수정했다. 실제 웹캠 장치의 인식 품질은 아직 검증하지 않았다. **현재는 AI 해석을 내 컴퓨터에서 사용하며 공개 AI 서버는 배포하지 않는다.** 공개 Pages의 웹캠·잔상·수치 분석은 계속 사용할 수 있다. 아래 3번은 나중에 공개 AI 연결을 원할 때의 선택 사항이다.

화면의 **기본 수치 분석**은 속도와 방향 변화 등을 계산한 규칙 기반 설명이다. 서버에서 실제 응답을 받은 경우에만 **Gemini 해석**으로 바뀐다.

## 1. 무료 API 키 발급

[Google AI Studio의 API 키 화면](https://aistudio.google.com/apikey)에서 Google 계정으로 로그인하고 프로젝트에 API 키를 만든다. 자세한 발급 절차는 [공식 API 키 안내](https://ai.google.dev/gemini-api/docs/api-key)를 따른다.

기본 모델은 `gemini-3.8-flash`다. 공식 요금표의 무료 사용 범위에서 시작할 수 있지만 무료가 무제한을 뜻하지 않는다. 프로젝트·모델·지원 지역에 따라 실제 사용 가능 여부와 할당량을 확인해야 한다. 무료 구간에서는 입력과 출력이 Google 제품 개선에 사용될 수 있다. [Gemini 요금표](https://ai.google.dev/gemini-api/docs/pricing)

API 키는 이 문서, 채팅, GitHub, `dist/config.js`에 적지 않는다. 로컬에서는 `.env`, 공개 서버에서는 Cloudflare의 비밀 값으로 보관한다.

## 2. 내 컴퓨터에서 연결

Node.js 20.6 이상이 필요하다. 새로 설치한다면 최신 LTS를 사용한다. 프로젝트 폴더에서 다음 순서로 실행한다.

1. 처음 설정할 때 `.env.example`을 `.env`로 복사한다. 이미 `.env`가 있으면 이 단계는 건너뛴다.

   ```powershell
   Copy-Item -LiteralPath '.env.example' -Destination '.env'
   ```

2. 편집기로 `.env`를 열고 `GEMINI_API_KEY=` 뒤에 발급한 키를 넣어 저장한다. 다른 설정은 기본값을 사용한다.

   ```dotenv
   GEMINI_API_KEY=발급한_키를_여기에
   GEMINI_MODEL=gemini-3.8-flash
   ALLOWED_ORIGIN=https://yebe9.github.io
   ```

   `.env`는 저장소의 `.gitignore`에서 제외되어 있다. 제출 ZIP에도 넣지 않는다. `.env.example`에는 실제 키를 넣지 않는다.

3. `dist/config.js`의 `apiBase`가 빈 문자열인지 확인한다. 로컬에서는 같은 서버의 API를 사용한다.

   ```js
   window.JANSANG_CONFIG = Object.freeze({
     apiBase: ''
   });
   ```

4. 서버를 시작한다.

   ```powershell
   node --env-file=.env server.cjs
   ```

5. [로컬 잔상](http://127.0.0.1:4173/)을 연다. 손으로 그리기 또는 몸으로 남기기로 움직임을 기록하고 결과에서 **AI로 움직임 해석하기**를 누른다.

6. 카드에 **Gemini 해석**이 표시되고 현재 기록에 대한 설명과 근거가 오면 연결된 것이다. 시작 팝업의 **기록 후 AI로 인상 해석하기**를 선택하면 다음 기록부터 자동 요청할 수도 있다.

응답에 30초 이상 걸릴 수 있으며 서버는 최대 90초 동안 기다린다. 분석 중에는 다시 누르지 말고 진행 안내를 기다린다. 시간 초과가 나면 기본 수치 분석을 유지하므로 잠시 뒤 다시 시도할 수 있다.

서버 종료는 터미널의 `Ctrl+C`다. 키를 바꿨다면 서버를 재시작한다. 단순히 `dist/index.html` 파일을 열면 로컬 API 서버에 연결되지 않으므로 반드시 위 주소로 접속한다.

## 3. 나중에 공개 GitHub Pages에도 AI 연결하기 · 선택 사항

GitHub Pages는 정적 파일만 제공한다. API 키를 보관하고 Gemini를 호출하는 서버로 Cloudflare Worker를 별도 배포한다. Cloudflare 계정과 Wrangler가 지원하는 Node.js 버전이 필요하다.

Cloudflare Workers에는 무료 사용 구간과 요청·실행 한도가 있다. Gemini의 무료 할당량과는 별개다. [Workers 요금과 제한](https://developers.cloudflare.com/workers/platform/pricing/)

프로젝트 폴더에서 다음 순서로 진행한다.

1. Cloudflare에 로그인한다.

   ```powershell
   npx wrangler login
   ```

2. `wrangler.toml`을 확인한다. 현재 `ALLOWED_ORIGIN`은 `https://yebe9.github.io`이고, API 코드는 `api/worker.mjs`다. 배포한다.

   ```powershell
   npx wrangler deploy
   ```

3. 비밀 입력 프롬프트에서 Gemini 키를 등록한다. 키를 명령어 뒤에 붙이지 않는다.

   ```powershell
   npx wrangler secret put GEMINI_API_KEY
   ```

4. 배포 출력에 표시된 **Worker의 루트 HTTPS 주소**를 복사한다. `dist/config.js`의 `apiBase`에 그 주소만 입력한다. 아래 주소는 형식 예시이므로 실제 배포 주소로 바꾼다.

   ```js
   window.JANSANG_CONFIG = Object.freeze({
     apiBase: 'https://jansang-motion-api.본인주소.workers.dev'
   });
   ```

   끝에 `/api/analyze`를 붙이지 않는다. 코드가 자동으로 붙인다. 이 파일에는 공개 서버 주소만 있으며 API 키는 들어가지 않는다.

5. 공개 주소 설정을 저장소에 반영한다.

   ```powershell
   git add dist/config.js
   git commit -m "Connect the public movement analysis API"
   git push origin main
   ```

6. GitHub Pages 배포가 끝나면 [공개 잔상](https://yebe9.github.io/jansang/)을 새로고침한다. 짧은 움직임을 기록하고 AI 버튼으로 실제 결과를 확인한다.

Wrangler 로그인·배포·비밀 값 등록은 [공식 Wrangler 명령 안내](https://developers.cloudflare.com/workers/wrangler/commands/)를 참고한다. ZIP을 푼 폴더에는 Git 저장소 정보가 없으므로 5번은 GitHub 저장소를 내려받아 작업하는 폴더에서 수행한다. ZIP만 사용하는 경우 설정 파일 변경 내용을 기존 저장소에 옮겨 반영한다.

Worker에는 요청 빈도 제한이 들어 있다. 이는 남용을 줄이는 장치이며 전 세계 사용량이나 비용의 절대 상한은 아니다. 무료 체험을 유지하려면 Gemini와 Workers 계정의 무료 사용 상태 및 할당량도 함께 확인한다.

## 전송되는 정보

- 손으로 그리기: 정규화된 궤적 좌표, 시간, 획 번호, 요약 수치.
- 웹캠: 최대 8개 상체 관절의 2D 좌표, 시간, 기록 구간, 요약 수치. AI 요청에는 최대 60개 시점만 넣는다.
- **전송하지 않는 것:** 원본 영상, 얼굴 이미지, 음성, 이름, 결과 화면에 적은 의도.

영상은 브라우저에서 MediaPipe 자세 인식에만 사용한다. Gemini는 이 숫자 자료로 표현의 인상을 묘사한다. 실제 감정이나 마음을 판정하지 않으며, 원본 영상을 보고 분석했다고 소개하면 안 된다. [MediaPipe 웹 가이드](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)

## 연결이 안 될 때

| 화면 상태 | 확인할 내용 |
| --- | --- |
| AI 서버가 아직 연결되지 않았습니다 | 공개 Pages의 `dist/config.js`에 실제 Worker 루트 주소가 있는지 확인한다. |
| Gemini API 키가 아직 연결되지 않았습니다 | 로컬 `.env` 로딩 또는 Worker의 `GEMINI_API_KEY` 비밀 값 등록을 확인한다. |
| API 키·모델 사용 권한·지원 지역 안내 | AI Studio에서 키, 프로젝트, `gemini-3.8-flash` 사용 가능 여부를 확인한다. |
| 구모델에 신규 사용자 이용 제한 안내가 나옵니다 | 키가 유효해도 모델 접근은 제한될 수 있다. `GEMINI_MODEL=gemini-3.8-flash`로 설정하고 로컬 서버를 재시작하거나 Worker를 다시 배포한다. |
| 분석이 오래 걸리거나 시간 초과 안내가 나옵니다 | 서버는 최대 90초 동안 응답을 기다린다. 진행 중에는 중복 요청을 피하고, 실패 안내가 나온 뒤 잠시 기다렸다 다시 시도한다. |
| 무료 사용량 또는 요청 한도에 도달했습니다 | 연속 요청을 멈추고 AI Studio의 할당량을 확인한다. |
| 서버에 연결하지 못했습니다 | 인터넷, Worker 주소, 배포 상태, `ALLOWED_ORIGIN`을 확인한다. |
| 분석 버튼이 비활성화되어 있습니다 | 1초 이상 움직이고, 웹캠에서는 어깨와 손목이 보이게 다시 기록한다. |
| 카메라를 사용할 수 없습니다 | HTTPS 또는 로컬 서버인지, 카메라 권한과 다른 앱의 점유 여부를 확인한다. |

실패하면 오류 안내와 기본 수치 분석을 표시한다. 이전에 성공한 AI 해석이 있다면 그 결과를 유지한다. 오류 상태를 새 AI 결과로 표시하지 않는다.
