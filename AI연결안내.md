# 로컬 AI와 공개 페이지 연결

## 실행 경로

- **공개 Pages / 손 입력:** 움직임 좌표 → 키를 가진 Node 또는 Cloudflare API → Gemini.
- **MotionGPT를 설정한 로컬 전신:** 얼굴 제외 3D world 좌표 → 이 컴퓨터의 MotionGPT CPU 서비스 → 실제 동작 설명 → Gemini의 한국어 인상·5개 후보.
- **한국어 유사도:** 브라우저의 fastText 벡터로 계산한다. 입력 문장을 외부 AI API에 보내지 않는다. 비공개 기록함에 로그인한 뒤에는 의도·유사도 결과를 로그에 보관한다.

MotionGPT를 공개 Cloudflare Worker 안에서 실행하지 않는다. 공식 무료 Hugging Face 데모는 개발 시 확인한 상태에서 작동하지 않아 의존하지 않는다. 해당 서비스의 복구나 무료 이용을 보장하지 않는다. 여기서는 공식 소스·체크포인트를 사용하는 로컬 CPU 경로를 준비한다.

## 최초 준비

프로젝트는 `C:\Projects_AI\Codex\라운지서울_잔상`에 있다. Node 22 이상과 Python 3.11 환경을 권장한다. GPU는 필요하지 않지만 모델 파일 약 2.33GB 외에 Python 패키지·캐시와 실행 메모리가 필요하다.

```powershell
Set-Location -LiteralPath 'C:\Projects_AI\Codex\라운지서울_잔상'
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install -r motion_service/requirements.txt
.\.venv\Scripts\python.exe -m motion_service.download_models
```

다운로더는 고정된 공식 소스와 체크포인트를 내려받고 바이트 수·SHA-256을 검증한다. 중간 파일이나 Python 패키지 설치만으로 모델 준비가 끝난 것은 아니다. 가중치는 기본적으로 `.models/motiongpt`에 두며 공개 Git·ZIP에 넣지 않는다. 모델 카드의 가중치 표기가 구체적인 CC 종류를 명시하지 않으므로 소스의 MIT 라이선스와 같은 조건으로 가중치를 재배포한다고 설명하지 않는다. [공식 모델 카드](https://huggingface.co/OpenMotionLab/MotionGPT-base)

`.env.example`을 `.env`로 복사해 개인 키를 입력한다. 실제 키는 채팅·브라우저 공개 설정·저장소에 넣지 않는다.

```dotenv
GEMINI_API_KEY=발급한_키
GEMINI_MODEL=gemini-3.5-flash-lite
MOTIONGPT_URL=http://127.0.0.1:8765
```

Gemini는 현재 연결한 무료 할당 구간을 사용한다. API 키 발급이 필요하고 사용량·지역·제공자 조건이 적용된다. 무료 할당량을 넘으면 성공 결과 대신 오류를 표시한다. [Google AI Studio](https://aistudio.google.com/apikey) · [공식 요금 안내](https://ai.google.dev/gemini-api/docs/pricing)

## 실행

준비한 Python 환경을 사용하는 시작 스크립트:

```powershell
.\scripts\start-local.ps1
```

또는 터미널 두 개에서 다음을 실행한다.

```powershell
# 터미널 1: 프로젝트 폴더에서
.\.venv\Scripts\python.exe -m motion_service.server --port 8765
```

```powershell
# 터미널 2: 프로젝트 폴더에서
node --env-file=.env server.cjs
```

[로컬 페이지](http://127.0.0.1:4173/)를 연다. Python 서비스는 127.0.0.1에만 바인딩하고 Node가 호출한다. `MOTIONGPT_URL`에는 이 컴퓨터의 loopback HTTP 주소만 허용한다. 외부 서버 URL을 넣어 동작 좌표를 전송하는 용도로 쓰지 않는다.

`http://127.0.0.1:8765/health`의 실제 준비 상태와 오류를 확인하고, 어깨부터 양발까지 보이게 새 전신 기록을 남긴다. MediaPipe가 측정한 3D world 좌표가 부족하면 다시 촬영하라는 안내가 나온다. 손 좌표를 전신 MotionGPT 입력처럼 채우거나 화면 2D 좌표를 미터 단위처럼 바꾸지 않는다.

로컬 전신 요청의 최대 대기 시간은 180초다. 느린 환경의 CPU 해석은 120–180초가 걸릴 수 있으며 첫 로딩은 더 길 수 있다. 장치·관측 길이·모델 준비 상태에 따라 달라지므로 30초 안의 결과를 보장하지 않는다. 설치·모델 로딩·실제 요청 성공을 각각 확인한다. 모델 로딩 후 2초·41개 시점의 합성 3D 자료로 한 번 시험했을 때 실제 CPU 설명을 받았으며 HTTP 왕복은 1.218초였다. 첫 로딩 시간과 실제 춤의 해석 품질을 검증한 값은 아니다. MotionGPT 없이 Gemini만 쓰려면 `MOTIONGPT_URL`을 비운다.

## 입력 변환의 한계

MediaPipe world 좌표는 골반 중심의 추정치다. MotionGPT가 요구하는 HumanML3D 관절·운동 특징으로 옮기면서 척추·목·머리·루트 일부를 근사한다. 얼굴을 측정해 구성한 좌표가 아니며 전체 몸의 실제 공간 이동을 복원할 수 없다. 변환의 출처·가정과 모델 정보를 결과의 `motionCaption`에 남긴다. MotionGPT 설명을 사람의 동작에 대한 정답으로 보지 않는다.

## 공개 배포

Pages의 `dist/config.js`에는 공개 API·개인 기록함 URL만 둔다. Gemini 키는 Cloudflare Worker의 `GEMINI_API_KEY` 비밀 값으로 보관한다. 공개 Worker에 로컬 `MOTIONGPT_URL`을 설정하지 않는다. 공개 Pages와 로컬 MotionGPT는 실행 경로가 다르다.

```powershell
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
npx wrangler deploy --config logbook/wrangler.toml
```

이 명령은 이미 연결한 계정·저장소 설정을 전제로 한다. 새 계정에 설치할 경우 D1·KV·비밀번호 비밀 값을 별도로 준비한다. [개인 기록함 안내](./logbook/README.md)

## 문제를 확인할 때

| 상태 | 확인할 내용 |
| --- | --- |
| 로컬 전신 해석 연결 실패 | Python 8765 서비스 실행, 모델 다운로드 검증, `/health` 실제 상태 |
| 전신 3D 좌표 부족 | 어깨·골반·무릎·발목이 함께 보이는 연속 동작으로 다시 기록 |
| 모델 준비 중 / 다른 기록 분석 중 | 첫 로딩 또는 현재 CPU 요청이 끝난 뒤 다시 시도 |
| 무료 API 제한 | 제공자가 반환한 할당량·지역·키 오류 안내 확인 |
| 유사도 측정 불가 | 알려진 한국어 단어가 포함됐는지, 약 15MB 벡터 파일 로딩이 끝났는지 확인 |
| 기기에 보관 중 | 첫 시작에서 열린 비공개 기록함 로그인·팝업·연결 상태 확인 |

검증 명령:

```powershell
node --test tests/*.test.cjs
.\.venv\Scripts\python.exe -m unittest motion_service.test_preprocessing
```
