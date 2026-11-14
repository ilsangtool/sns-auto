# sns-auto · 일상툴 SNS 완전자동화

글 작성 → 카드 이미지 제작 → 스레드·인스타 게시 → 토큰 갱신까지 **사람 손 없이** 돌아갑니다.

```
[매주 일 21:00]  Claude가 다음 주 글 5개 작성 → 카드 이미지(JPG)·릴스 영상(MP4) 생성 → Pages에 배포
[매시간]         게시 시각이 지난 글을 스레드·인스타에 게시 → 결과를 posts.json에 기록
[매월 1·15일]    인스타·스레드 토큰 자동 갱신
```

| 파일 | 역할 | 직접 고칠 일 |
|---|---|---|
| `apps.json` | 홍보할 앱 목록 | ⭐ 앱 추가할 때만 |
| `config.json` | 게시 요일·시각·글 유형, 자동 승인 여부 | 가끔 |
| `prompts/system.md` | 글 말투·규칙 (Claude 지시문) | 말투 바꿀 때 |
| `templates/card.html` | 카드 이미지 디자인 | 디자인 바꿀 때 |
| `templates/reel.html` | 릴스 영상(1080×1920, 약 17초) 디자인 | 디자인 바꿀 때 |
| `posts.json` | 게시 대기열 + 결과 기록 | 자동 관리 |
| `scripts/` · `.github/workflows/` | 실행 코드 | 없음 |

---

## 1회 설정 (약 1시간)

### ① 저장소
1. GitHub 조직 `ilsangtool`에 **공개 저장소 `sns-auto`** 생성 → 이 폴더 전체 업로드
2. Settings → Pages → Source: **GitHub Actions** 선택

### ② 인스타그램
- 인스타 앱 → 설정 → 계정 유형 → **프로페셔널(크리에이터)** 전환
- 프로필 링크에 일상툴 주소 등록 (카드에 "프로필 링크에서"라고 안내됨)

### ③ Meta 개발자 앱 (developers.facebook.com)
1. 앱 만들기 → 사용 사례에 **Instagram API**, **Threads API** 추가
2. Instagram: "Instagram 로그인을 통한 API 설정" → 내 계정 추가 → **토큰 생성** + **사용자 ID(숫자)** 복사
3. Threads: 앱 역할 → Threads 테스터에 내 계정 추가 → 스레드 앱 설정 › 웹사이트 권한에서 초대 수락 → 토큰 생성 후 장기 토큰으로 교환 (권한 `threads_basic`, `threads_content_publish`)
4. 내 계정에만 게시하므로 **개발 모드 그대로 사용** (앱 검수 불필요)

### ④ Claude API 키
- console.anthropic.com → API Keys → 키 발급, 결제수단 등록 (주 5개 글 기준 사용량은 매우 적음)

### ⑤ Secrets / Variables 등록
Settings → Secrets and variables → Actions

| 종류 | 이름 | 값 |
|---|---|---|
| Secret | `ANTHROPIC_API_KEY` | Claude API 키 |
| Secret | `IG_ACCESS_TOKEN` | 인스타 장기 토큰 |
| Secret | `IG_USER_ID` | 인스타 사용자 ID (숫자) |
| Secret | `THREADS_ACCESS_TOKEN` | 스레드 장기 토큰 |
| Secret | `THREADS_USER_ID` | `me` |
| Secret | `GH_PAT` | GitHub Fine-grained 토큰 (이 저장소, **Secrets: Read and write**) |
| Variable | `IMAGE_BASE_URL` | `https://ilsangtool.github.io/sns-auto/images` |

### ⑥ apps.json 확인
- `url`이 실제 앱 주소인지 확인 (예시 주소는 추정값)

### ⑦ 첫 실행 (순서대로)
1. Actions → **주간 글 자동 생성** → Run workflow (`week: this`) → posts.json과 images/ 확인
2. Actions → **SNS 자동 게시** → "미리보기만" ✅ 실행 → 로그 확인
3. Actions → **토큰 자동 갱신** → 실행해서 성공 확인
4. 끝. 이후는 전부 자동

---

## 운영

### 새 앱 추가
`apps.json`에 항목 하나 추가 → 다음 주부터 자동으로 순환 홍보
```json
{
  "slug": "영문-이름",
  "name": "앱 이름",
  "url": "https://ilsangtool.github.io/tools/폴더/",
  "target": "누가 쓰는지",
  "problem": "어떤 고민을 해결하는지",
  "features": ["장점1", "장점2", "장점3"],
  "color": "#카드색상",
  "active": true
}
```
- 홍보를 잠시 멈출 앱은 `"active": false`
- 앱 페이지 내용도 자동으로 읽어서 글에 반영합니다

### 릴스(영상) 글
- `config.json` 슬롯에 `"video": true` → 그 요일은 세로 영상으로 인스타 릴스·스레드 영상 게시 (기본: 금요일 사용법형)
- 영상은 Claude가 쓴 문구(첫 장면 → 1·2·3 → 마무리)로 `templates/reel.html`을 프레임 단위 녹화 → FFmpeg로 MP4(H.264·AAC 무음) 변환
- 영상 하나만 다시 만들기: 로컬에서 `ONLY_ID=글ID node scripts/render-reels.mjs`
- 배경음은 넣지 않음 (저작권 사고 방지). 자막형이라 소리 없이도 이해되게 구성

### 게시 전에 검토하고 싶을 때
`config.json`의 `"auto_approve": false` → 생성된 글이 `"paused": true` 상태로 대기
→ posts.json에서 확인 후 `false`로 바꾸면 게시

> 기본값(true)이어도 일요일 밤 생성 → 월요일 낮 첫 게시라 **검토할 시간이 반나절 있습니다.**
> 마음에 안 드는 글은 posts.json에서 지우거나 고치면 됩니다.

### 특정 글 멈추기 / 다시 만들기
- 멈추기: 해당 글에 `"paused": true`
- 이번 주 글 전체 재생성: 주간 글 자동 생성 → `force` ✅ (이미 게시된 글은 유지)

---

## 문제 해결

| 증상 | 조치 |
|---|---|
| 실패 메일 수신 | Actions 로그 또는 posts.json의 `last_error` 확인. 3회 실패 시 멈춤 → 해당 `result` 삭제하면 재시도 |
| "이미지 아직 배포되지 않음" | 자동으로 다음 시간에 재시도. 계속되면 Actions → 이미지 배포(Pages) 수동 실행 |
| Claude API 오류 | API 키·결제 잔액 확인. 모델명은 `config.json`의 `model` |
| 토큰 만료 | ③에서 재발급 → Secret 교체 |
| 예약이 몇 분 늦음 | GitHub Actions의 정상 지연 (5~30분) |
| 예약 실행이 꺼짐 | 60일간 저장소 활동이 없으면 꺼짐 → 이 봇은 매주 커밋하므로 보통 유지됨 |

## 안전장치
- 게시 자동화만 함 — 좋아요·팔로우·댓글 자동화 없음 (계정 정지 위험)
- 한 번 실행에 1개만 게시 → 밀린 글 도배 방지
- 이용자 수·후기 등 사실이 아닌 내용은 쓰지 않도록 지시 (`prompts/system.md`)
- 형식이 안 맞는 글은 Claude에 자동으로 고쳐달라고 재요청 (최대 3회)
- 토큰은 Secrets에만 보관, 로그 노출 없음
