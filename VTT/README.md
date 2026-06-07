# VTT Maker

영상 나레이션 타이밍에 맞춰 스크립트를 VTT 자막 파일로 변환하는 웹 앱입니다.  
사용자는 로그인 후 Gemini AI로 자막을 생성합니다. API 키 입력 불필요.

---

## 배포 순서

### 1단계 — 계정 설정 (worker.js)

`worker.js` 상단의 ACCOUNTS를 원하는 아이디/비밀번호로 변경하세요:

```javascript
const ACCOUNTS = {
  account_a: 'password_a',   // ← 원하는 값으로 변경
  account_b: 'password_b',
  account_c: 'password_c',
};
```

---

### 2단계 — Cloudflare Worker 배포

```bash
# Wrangler 설치 (최초 1회)
npm install -g wrangler
wrangler login

# KV 네임스페이스 생성 (사용량 추적용)
wrangler kv:namespace create USAGE_KV
```

출력된 `id` 값을 `wrangler.toml`의 해당 위치에 붙여넣으세요:

```toml
[[kv_namespaces]]
binding = "USAGE_KV"
id      = "여기에_출력된_ID_붙여넣기"
```

```bash
# Gemini API 키를 Secret으로 등록 (코드에 절대 입력하지 마세요)
wrangler secret put GEMINI_API_KEY
# → 입력 프롬프트가 뜨면 Gemini API 키를 붙여넣고 Enter

# Worker 배포
wrangler deploy
```

배포 완료 후 출력되는 Worker URL을 메모해두세요:
```
https://vtt-maker.YOUR-SUBDOMAIN.workers.dev
```

---

### 3단계 — index.html에 Worker URL 입력

`index.html` 상단의 `WORKER_URL`을 실제 Worker URL로 교체하세요:

```javascript
const WORKER_URL = 'https://vtt-maker.YOUR-SUBDOMAIN.workers.dev';
//                  ↑ 실제 URL로 교체
```

---

### 4단계 — GitHub Pages 배포

```bash
git init
git add .
git commit -m "Initial deploy"
git remote add origin https://github.com/아이디/저장소명.git
git push -u origin main
```

GitHub 저장소 → **Settings → Pages → Source: GitHub Actions** 선택 후 저장.

배포 완료 후 접속 주소:
```
https://아이디.github.io/저장소명/
```

---

## 사용 방법

1. 사이트 접속 → 아이디/비밀번호로 로그인
2. 영상 파일 업로드 (최대 25 MB)
3. 스크립트 붙여넣기
4. **VTT 생성** 클릭
5. VTT 다운로드

---

## 사용량 확인

로그인 후 우측 상단 **📊 사용량** 버튼을 클릭하면  
계정별 사용 횟수와 마지막 사용 시간을 확인할 수 있습니다.

---

## 파일 크기 제한 (25 MB 초과 시)

```bash
# FFmpeg로 오디오만 추출
ffmpeg -i input.mp4 -q:a 0 -map a output.mp3
```

---

## 비용

- **Cloudflare Workers**: 무료 (10만 req/일)
- **Cloudflare KV**: 무료 (10만 reads/일)
- **Gemini 1.5 Flash**: 유료 API 키 사용 시 토큰당 과금
  - 약 10분 영상 기준 $0.01~$0.05 수준
