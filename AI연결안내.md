# Ghosting · Gemini 해석 연결하기

Ghosting은 실제 AI 응답을 받은 경우에만 움직임의 감상을 표시한다. API가 연결되지 않았거나 요청이 실패하면 연결·오류 안내를 보여주며 다른 감상으로 대체하지 않는다. 카메라 기록과 자취 재생은 키 없이 사용할 수 있다.

공개 GitHub Pages의 AI 요청은 [Cloudflare Worker](https://jansang-motion-api.jansang.workers.dev)를 거쳐 Gemini로 보낸다. Worker 배포와 `GEMINI_API_KEY` 비밀 값 등록을 마쳤고 `/api/status`의 사용 가능 상태를 확인했다. 방문자는 키를 입력하지 않는다. 로컬에서는 공개 설정과 관계없이 같은 컴퓨터의 API를 사용한다.

## 1. API 키와 모델

[Google AI Studio](https://aistudio.google.com/apikey)에서 키를 발급한다. 키는 채팅, GitHub 또는 `dist/config.js`에 적지 않고 로컬 `.env`나 서버의 비밀 값에 보관한다. [공식 키 안내](https://ai.google.dev/gemini-api/docs/api-key)

기본 모델은 `gemini-3.5-flash-lite`이며 추론 수준은 `minimal`로 지정한다. 무료 사용 구간에도 할당량·지역·계정 조건이 적용되므로 실제 프로젝트의 이용 가능 상태를 확인한다. 무료 구간의 입력·출력에는 Google의 제품 개선 관련 조건이 적용된다. [모델 안내](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite) · [추론 설정](https://ai.google.dev/gemini-api/docs/thinking) · [요금표](https://ai.google.dev/gemini-api/docs/pricing)

서버 요청 제한은 **29초**, 브라우저 대기 제한은 **30초**다. 제한에 도달하면 오류와 재시도 안내가 나온다. 30초 이내에 AI 해석이 반드시 성공한다는 뜻은 아니다.

표현 정의와 후보 분석을 추가하기 전의 단건 시험에서는 빠른 합성 양손이 공개 API에서 약 26.8초에 성공하고 완만한 자료가 시간 초과됐다. 로컬 비교에서는 입력 토큰을 약 51% 줄여도 응답이 더 오래 걸렸다. 과거 수치를 현재 성능이나 동작 속도와의 인과관계로 보지 않는다. 요청 크기·공급자 대기 시간·오류를 따로 확인해야 한다.

현재 공개 API의 합성 양손 단건 시험은 완만한 자료 **12.822초·HTTP 200·유기적인**, 빠른 자료 **12.636초·HTTP 200·역동적인**이었다. 후보는 각각 5개와 3개를 받았고, 두 자료에서 선택 기준을 충족하지 않은 `유연한`·`유려한`은 반환되지 않았다. 두 번의 시험으로 전체 표현의 품질이나 응답 성공 시간을 보장하지 않는다.

일시적인 외부 서버 오류(5xx)나 네트워크 오류(TypeError)에만 전체 29초 안에서 최대 한 번 재시도한다. 사용량 제한(429), 키·지역·안전 차단 오류와 시간 초과는 자동 재시도하지 않는다.

브라우저에서 무료 API 할당량 초과(429) 안내가 표시된 경우도 확인했다. 연결이 성공했던 키라도 남은 할당량에 따라 후속 요청은 실패할 수 있다.

## 2. 로컬에서 실행

Node.js 20.6 이상에서 프로젝트 폴더를 연다.

1. 처음 설정할 때만 `.env.example`을 복사한다. 이미 `.env`가 있으면 덮어쓰지 않는다.

   ```powershell
   Copy-Item -LiteralPath '.env.example' -Destination '.env'
   ```

2. 편집기로 `.env`를 열고 키와 모델을 설정한다. 이전 버전에서 다른 `GEMINI_MODEL`을 적어 두었다면 아래 값으로 바꾼다.

   ```dotenv
   GEMINI_API_KEY=발급한_키를_여기에
   GEMINI_MODEL=gemini-3.5-flash-lite
   ALLOWED_ORIGIN=https://yebe9.github.io
   ```

   실제 `.env`는 Git과 제출 ZIP에서 제외한다. `.env.example`에는 키를 넣지 않는다.

3. `dist/config.js`에는 공개 Worker 주소를 유지한다. `localhost` 또는 `127.0.0.1`에서 열면 이 설정과 관계없이 같은 서버의 `/api`를 사용한다.

   ```js
   window.JANSANG_CONFIG = Object.freeze({
     apiBase: 'https://jansang-motion-api.jansang.workers.dev',
     logBase: 'https://ghosting-logbook.jansang.workers.dev'
   });
   ```

4. 서버를 실행한다. 키나 모델을 바꾸었다면 기존 서버를 `Ctrl+C`로 종료하고 다시 실행한다.

   ```powershell
   node --env-file=.env server.cjs
   ```

5. [로컬 Ghosting](http://127.0.0.1:4173/)에서 **손끝으로 그리기 / 몸으로 남기기**를 고른다. 카메라를 준비하고 10초간 움직임을 기록한다.
6. 결과에서 **AI로 움직임 해석하기**를 누른다. 자동 해석을 켰다면 기록 종료 후 요청된다. 어두운 분석 팝업에서 완료 또는 오류를 기다린다.
7. **Gemini 해석**이 표시된 실제 결과를 확인한다. 내 느낌을 5글자 이내로 적고 상세 설명을 덧붙일 수 있다. 긴 입력의 원문은 상세 설명으로 옮겨 보존한다.

단순히 `dist/index.html` 파일을 열면 로컬 API에 연결되지 않으므로 AI는 위 서버 주소에서 사용한다. 다른 앱이 카메라를 쓰거나 영상 시작이 실패하면 **사용할 카메라**에서 물리 카메라를 고르고 **카메라 다시 연결**을 누른다. 이 컴퓨터에서는 **LGE Camera** 연결을 확인했다.

손 입력은 한 손 또는 양손의 검지 끝·손목을 따로 그린다. 한 손이 사라져도 다른 손은 이어지고, 모두 사라지면 시간이 멈춘다. 전신 입력은 어깨·골반·양 발목이 함께 보여야 시작할 수 있다.

## 3. 공개 AI 서버와 배포 관리

GitHub Pages는 화면 파일을 제공하고, 배포된 [Cloudflare Worker](https://jansang-motion-api.jansang.workers.dev)가 키를 보관하며 Gemini를 호출한다. 키 등록은 완료되어 있으며 아래 명령은 서버 코드를 갱신하거나 키를 교체할 때 사용한다. Cloudflare 계정과 Wrangler가 지원하는 Node.js가 필요하다. [Workers 요금과 제한](https://developers.cloudflare.com/workers/platform/pricing/)

1. 배포할 Cloudflare 계정으로 로그인한다.

   ```powershell
   npx wrangler login
   ```

2. 서버 코드를 수정했다면 `wrangler.toml`의 모델이 `gemini-3.5-flash-lite`, `ALLOWED_ORIGIN`이 `https://yebe9.github.io`인지 확인한다. 공개 호출의 지역 오류를 해결한 `[placement]`의 `region = "aws:us-east-1"`도 유지한 뒤 다시 배포한다. 이 설정은 해당 클라우드 지역에 가까운 Cloudflare 위치를 고른다. [Placement 안내](https://developers.cloudflare.com/workers/configuration/placement/)

   ```powershell
   npx wrangler deploy
   ```

3. 키를 새로 등록하거나 교체할 때만 비밀 입력 프롬프트를 사용한다. 키를 명령어 뒤에 붙이지 않는다.

   ```powershell
   npx wrangler secret put GEMINI_API_KEY
   ```

4. `dist/config.js`의 공개 주소는 다음과 같다. Worker 주소가 바뀐 경우에만 수정한다.

   ```js
   window.JANSANG_CONFIG = Object.freeze({
     apiBase: 'https://jansang-motion-api.jansang.workers.dev',
     logBase: 'https://ghosting-logbook.jansang.workers.dev'
   });
   ```

   끝에 `/api/analyze`를 붙이지 않는다. 이 파일에는 공개 주소만 넣는다.

5. 공개 주소나 화면 설정을 바꿨다면 Git 저장소에 반영하고 Pages 배포 후 실제 AI 요청을 확인한다.

   ```powershell
   git add dist/config.js
   git commit -m "Connect the public movement analysis API"
   git push origin main
   ```

ZIP을 푼 폴더에는 Git 정보가 없으므로 5번은 기존 Git 저장소에서 수행한다. Worker의 요청 빈도 제한은 사용량이나 비용의 절대 상한이 아니다. Gemini와 Workers의 할당량은 각각 확인한다. [Wrangler 명령 안내](https://developers.cloudflare.com/workers/wrangler/commands/)

## AI가 사용하는 정보

- 브라우저는 최대 60개 시점의 좌표·시간·기록 구간과 요약 수치를 서버에 보낸다. 손 입력은 최대 두 손의 21개 지점을 임시 식별자로 구분하고, 전신은 얼굴을 제외한 22개 지점을 사용한다.
- 서버는 Gemini 입력을 최대 24개 실제 시점으로 줄이며 기록 구간의 경계를 우선 보존한다. 손은 손목·검지 뿌리·다섯 손끝의 7개 지점을 손마다 사용하고 양손의 같은 시점을 함께 전달한다. 선택한 검지 끝·손목은 유지한다. 전신은 22개 지점을 유지하며 좌표는 소수 셋째 자리까지 정리한다.
- Gemini에 보낼 때는 관절 이름을 한 번만 정의하고 좌표를 숫자 배열로 묶는다. 기존 0.001 정밀도 좌표를 1,000배 정수로 표기해 추가 정밀도 손실 없이 크기를 줄인다. 시점 수·시간·손 ID·누락 관절·끊김은 그대로 유지한다. 이 변환에는 `api/motion-encoding.mjs`가 필요하다.
- 입력 종류와 속도·멈춤·범위·방향 변화 등을 함께 보낸다. 전신은 상체·하체·몸통 속도와 전신 관측 비율도 포함한다. 손 자료만으로 전신을 본 것처럼 설명하지 않도록 한다.
- 실제 사람 기록과 합성 예시는 구분한다. 보이지 않는 손이나 관절의 좌표를 채워 넣지 않는다.
- 영상 가로세로 비율을 함께 사용해 2D 관절 각도를 보정한다. 비율이 없는 이전 기록에서는 신체 유연성을 근거로 한 표현을 허용하지 않는다.
- **원본 영상·얼굴 좌표·이미지·음성·이름·내 짧은 의도·상세 설명은 Google에 보내지 않는다.** 사용자가 선택한 영상·의도·분석 결과의 보관은 아래의 별도 비공개 로그 기능이다.

Gemini의 대표 표현과 인상 단어는 [dance_descriptions.txt](./dance_descriptions.txt)의 50개 표현 중에서만 선택한다. 각 표현을 구분하는 짧은 시각적 정의를 함께 보내고 100자 이내의 감상 1–2문장과 근거 하나를 요청한다. 서버는 출력 길이를 1,200토큰까지 허용하고 사소한 공백·코드펜스·중복을 정리해 모델이 실제로 쓴 허용 표현 1–3개를 사용한다. 허용 어휘를 사용해도 동작을 잘못 묘사할 수 있으므로 근거를 함께 살펴본다. 감상은 실제 감정이나 성격의 진단이 아니다.

`api/expression-rubric.mjs`의 경험적 기준은 `유연한`과 `유려한`의 사용 범위를 제한한다. `유연한`에는 전신의 관절 굽힘과 펴짐 근거가 필요하므로 손·포인터·합성 예시에는 쓰지 않는다. `유려한`은 기록의 충분한 구간에서 안정된 속도·방향과 지속적 이동을 함께 확인한다. 문턱값은 구현상의 판단이며 과학적 정답이나 신체 가동 능력의 의학적 측정이 아니다. 기준 충족은 자동 선택을 뜻하지 않는다.

AI는 근거 있는 후보를 최대 5개와 적합도 0–100으로 보고한다. 적합도는 보정된 확률·정확도·내부 logprob가 아니고 합계가 100일 필요도 없다. 미보고 값을 0으로 채우지 않으며 대표 인상과 최고점 후보가 다르면 보고값을 고치지 않고 기록함에 차이를 표시한다. 다양한 표현을 보여주려고 무작위로 선택하지 않는다.

분석 진단 로그에는 오류 코드, 처리 단계, 요청 크기, 경과·공급자 대기 시간, 시도 횟수와 공급자가 반환한 토큰 수 같은 운영 수치만 남긴다. 키, 움직임 좌표와 AI 응답 본문은 로그에 넣지 않는다.

MediaPipe는 브라우저 안에서 실행한다. 전신 모델 내부는 얼굴을 포함한 33개 포즈 지점을 추정하지만 앱은 얼굴 0–10번을 즉시 버린다. 카메라 미리보기의 얼굴을 흐리게 가리는 기능은 아니다. [손 모델](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) · [전신 모델](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)

## 비공개 영상·분석 로그

[개인 기록함](https://ghosting-logbook.jansang.workers.dev/logs/)은 Gemini 서버와 별도의 Cloudflare Worker다. **영상 보관은 기본 꺼짐**이다. 새 촬영 전에 설정의 **이번 움직임의 영상도 보관**을 선택하면 기존 카메라 스트림의 영상 트랙을 복제해 녹화한다. 소리는 녹음하지 않지만 얼굴과 주변 환경은 포함될 수 있다.

결과 화면의 **비공개 로그에 저장**을 누르면 새 로그 창이 열린다. 소유자 비밀번호로 로그인하면 원래 화면에서 저장 요청한 내용과 영상이 바로 업로드된다. 촬영을 마친 것만으로 자동 저장되지는 않으므로 저장 완료 표시를 확인한다. 비밀번호 없이는 저장·조회 모두 불가능하며 공개 페이지의 다른 방문자 영상을 자동 수집하지 않는다. 영상 없이 의도·분석 결과만 저장할 수도 있다.

영상은 Cloudflare KV, 기록 메타데이터와 세션은 D1에 저장한다. 세션은 최대 12시간이고 로그 창의 쿠키로 인증한다. 영상당 15 MiB, 영상 전체 500 MiB, 기록 500개가 앱의 상한이다. 새 영상의 지역 간 반영이 늦으면 잠시 후 다시 열어본다. 로그 창의 새로고침 후에는 원래 결과 화면이 열려 있으면 기록을 다시 받는다. 두 창을 모두 닫으면 미저장 자료는 사라진다.

로그 화면에서는 영상 재생, 후보 적합도·근거, 표현 기준의 참고 수치, 대표 인상의 빈도, JSON·영상 다운로드, 삭제를 제공한다. 로그 관리·별도 배포 안내는 [logbook/README.md](./logbook/README.md)를 따른다. Gemini API 키와 개인 로그 비밀번호는 다른 비밀 값이며 공개 코드·ZIP에 넣지 않는다.

## 연결이 안 될 때

| 상태 | 확인할 내용 |
| --- | --- |
| AI 서버 연결 안내 | 로컬은 같은 컴퓨터의 서버 실행 상태를, 공개 Pages는 Worker 상태와 `dist/config.js` 주소를 확인한다. |
| API 키가 연결되지 않음 | `.env` 로딩 또는 Worker 비밀 값 `GEMINI_API_KEY`를 확인한다. |
| 모델 사용 권한·지역 오류 | AI Studio의 모델 사용 가능 여부를 확인한다. 공개 서버의 `PROVIDER_REGION` 오류라면 Worker의 `placement.region` 설정과 배포 상태도 확인한다. |
| 시간 초과 | 서버 29초·화면 30초 제한에 도달한 상태다. 현재 요청이 끝난 뒤 다시 시도한다. 성공 응답을 보장하는 제한이 아니다. |
| 동작이 많을 때 느리게 느껴짐 | 입력은 이미 브라우저 60시점·Gemini 24시점으로 제한된다. 빠른 동작이 원인이라고 단정하지 말고 오류 코드·처리 단계·공급자 대기 시간을 함께 확인한다. |
| 사용량 한도 도달 | AI Studio의 할당량을 확인하고 연속 요청을 멈춘다. |
| 분석 버튼 비활성화 | 1초 이상 유효한 움직임을 기록한다. 손 입력은 선택 지점, 전신은 어깨·골반·양 발목이 보여야 한다. |
| 카메라 X 화면 또는 연결 실패 | 가상 카메라 대신 물리 카메라를 선택한다. 권한·다른 앱의 사용·장치 상태를 확인하되 오류만으로 고장 원인을 단정하지 않는다. |
| 로그 창이 열리지 않음 | 브라우저에서 팝업을 허용하고 결과 화면의 저장 버튼을 다시 누른다. |
| 로그가 다시 로그인하도록 안내함 | 최대 12시간의 세션이 끝났을 수 있다. 개인 비밀번호로 다시 로그인한다. |
| 저장 직후 영상이 열리지 않음 | KV 반영 지연일 수 있으므로 로그 창의 영상 다시 열기를 사용한다. |
| 로그 저장 한도·미완료 기록 안내 | 목록에서 기존 또는 미완료 기록을 확인·삭제한 뒤 다시 저장한다. 저장 전 자료는 창을 새로고침하지 않아야 유지된다. |

요청이 실패하면 오류를 알려준다. 궤적과 내 입력은 유지하지만 규칙 기반 감상을 새 AI 결과처럼 표시하지 않는다. 실제 양손·전신 사용 품질과 다양한 요청의 응답 안정성은 추가 검증이 필요하다.
