# Live-MR-Manager UI 디자인 복구 계획

> 근거 파일: `original_style.css.bak` (4237줄) / `ui.js.bak` (1482줄) / `events.js.bak` (1401줄)

---

## 분석 요약: 손상 원인

리팩토링 과정에서 **세 가지 계층**에서 불일치가 발생했습니다.

| 계층 | 문제 |
|---|---|
| **CSS 구조** | 백업의 핵심 클래스들이 분할 파일에 누락되거나 전혀 다른 클래스명으로 대체됨 |
| **JS HTML 생성** | `addSongCard()`가 출력하는 클래스명이 현재 CSS와 맞지 않음 (`song-name` vs `song-title` 등) |
| **플레이어 독 구조** | 백업의 `grid-template-columns: auto 1fr auto auto` 4열 독이 구식 Flexbox 구조로 대체됨 |

---

## 1단계: `src/styles/base.css` 수정

**변경 규모: 추가만 (안전)**

현재 파일에 누락된 전역 리셋 규칙 추가.

```css
/* 추가할 규칙 (백업 165~171줄) */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  font-family: 'SUITE', sans-serif;
  user-select: none;
}
```

---

## 2단계: `src/styles/layout.css` 수정

**변경 규모: 일부 추가**

### 2-1. `title-row` 스타일 추가 (백업 358~362줄)
```css
.title-row {
  display: flex;
  align-items: center;
  gap: 15px;
}
```

### 2-2. `view-subtitle` 애니메이션 복구 (백업 364~370줄)
현재 파일의 `.view-subtitle`에 `animation: fadeIn 0.3s ease;` 추가.

### 2-3. `@keyframes pulse` 추가 (백업 379~391줄)
```css
@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.4; }
  100% { opacity: 1; }
}
```

### 2-4. `alignment-viewer` 뷰포트 오버라이드 복구 (백업 315~454줄)
```css
.viewport[data-view="alignment-viewer"] { ... }
.viewport[data-view="alignment-viewer"] .scroll-area { ... }
.viewport[data-view="alignment-viewer"] #alignment-page,
.viewport[data-view="alignment-viewer"] #alignment-viewer-root { ... }
```

---

## 3단계: `src/styles/library.css` 전면 재작성 ⭐ 핵심

**변경 규모: 대규모 (현재 176줄 → 약 350줄)**

### 3-1. 누락된 카드 내부 요소 클래스 (백업 829~1083줄)
- `.song-info-content`, `.metadata-stack`, `.song-name`, `.song-artist-badge` 등

### 3-2. 리스트 뷰 6열 그리드 (백업 966~1083줄)
- `grid-template-columns: 48px minmax(200px, 1.3fr) 50px 100px 1.7fr 70px;`

### 3-3. 카드 상태 및 썸네일 오버레이 (백업 1180~1260줄)
- `.song-card.active`, `.song-card.selected`
- `.thumb-overlay` (playing, loading, paused 아이콘 토글)

---

## 4단계: `src/styles/player.css` 전면 재작성 ⭐ 핵심

**변경 규모: 전면 교체 (현재 152줄 → 약 250줄)**

### 4-1. 클래스명 불일치 해결
- `.playback-dock` → `.control-dock`
- `.dock-content` → `.dock-inner`
- `.song-info-area` → `.playing-details`
- `.dock-thumbnail` → `.mini-thumb`
- `.control-buttons` → `.player-controls`
- `.play-pause-btn` → `.play-main-btn`
- `.progress-area` → `.playback-container`
- `.progress-bar-container` → `.progress-bar-wrapper`
- `.progress-bar-fill` → `.progress-fill`

### 4-2. 4열 그리드 레이아웃 복구 (백업 3163줄)
- `grid-template-columns: auto 1fr auto auto;`

---

## 5단계: `src/styles/components.css` 보완

**변경 규모: 추가**
- 버튼 크기 시스템 복구 (`.btn-sm`, `.btn-md`, `.btn-lg`, `.btn-xl`)
- 레이아웃 유틸리티 (`.flex-row`, `.gap-md`, `.mt-sm` 등)
- 컨텍스트 메뉴 스타일 (`.context-menu`, `.context-menu-item`)

---

## 6단계: JS 파일 점검
- `src/js/events/controls.js` 등에서 `state.songLibrary` 참조를 `state.library`로 수정 여부 확인

---

## 검증 방법
`npm run tauri dev` 실행 후 각 레이아웃 및 상태 시각화 확인.
