# 알림·경고·확인 문구 목록

프론트엔드 토스트(`showNotification`), 확인 모달(`openConfirmModal` / `confirm`), 백엔드 한국어 `Err` 메시지를 수집한 목록입니다.

- 수집일: 2026-07-31 (싱크 초기화 확인 모달화·확인창 X/소형화 반영)
- 고유 문구 수: **약 150+** (자동 수집 + 동적 문구 보강, 중복 제거)
- `{…}` 는 런타임에 채워지는 자리입니다. (`{err}` = 예외/상세 메시지, `{}` = Rust format 자리)
- 백엔드 `Err`는 프론트에서 `… 실패: {err}` 형태로 이어 붙는 경우가 많습니다.

> 문구 정리·톤앤매너 통일용 참고 문서입니다. 앱 동작에는 영향 없습니다.
> 기능 변경 요약은 [`RELEASE_NOTES.md`](../RELEASE_NOTES.md) v0.6.0, 사용자 안내는 [`UserManual.md`](../UserManual.md)를 참고하세요.

## 토스트 알림 (`showNotification`)

| 유형 | 문구 | 출처 |
| --- | --- | --- |
| 오류 | {raw}. 네트워크 상태 또는 URL 접근 가능 여부를 확인해 주세요. | `src/js/events/backend.js`<br>YouTube 오디오 관련 실패 |
| 오류 | {raw}. 대기 후 다시 시도해 주세요. | `src/js/events/backend.js`<br>모델 초기화 재시도 대기 중 |
| 오류 | {raw}. 잠시 후 재시도하거나 앱 재시작/모델 재다운로드를 권장합니다. | `src/js/events/backend.js`<br>모델 로딩 시간 초과 시 |
| 오류 | 가져오기 중 오류: {err} | `src/js/events/controls/settings.js` |
| 오류 | 경로 확인 중 오류: {err} | `src/js/events/controls/settings.js` |
| 오류 | 곡 경로가 없어 저장할 수 없습니다. | `src/js/events/modals.js` |
| 오류 | 곡 삭제 실패 | `src/js/ui/manager.js` |
| 오류 | 곡 삭제 중 오류가 발생했습니다. | `src/js/ui/library.js` |
| 오류 | 라이브러리에서 곡을 찾을 수 없습니다. | `src/js/events/controls/playback.js`<br>하단 ⋯ 메뉴 |
| 오류 | 기본 분리 모델 저장에 실패했습니다. | `src/js/separation-mode-modal.js` |
| 오류 | 다운로드 실패: {err} | `src/js/events/controls/ai.js` |
| 오류 | 등록 실패: {err} | `src/js/ui/manager.js` |
| 오류 | 릴리스 페이지를 열지 못했습니다. | `src/js/utils.js` |
| 오류 | 모델 변경 실패: {err} | `src/js/events/controls/ai.js` |
| 오류 | 방송 제원 보호 모드 변경 실패: {err} | `src/js/events/controls/settings.js` |
| 오류 | 백업 중 오류가 발생했습니다: {err} | `src/js/events/controls/settings.js` |
| 오류 | 복구 중 오류가 발생했습니다: {err} | `src/js/events/controls/settings.js` |
| 오류 | 복원 중 오류가 발생했습니다: {err} | `src/js/events/controls/settings.js` |
| 오류 | 분리 실패: {raw} | `src/js/events/backend.js` |
| 오류 | 분리 실패: 원인을 확인할 수 없습니다. | `src/js/events/backend.js` |
| 오류 | 분석 실패: {err} | `src/js/events/modals.js` |
| 오류 | 브라우저에서 페이지를 열지 못했습니다. | `src/js/events/controls/settings.js` |
| 오류 | 삭제 실패: {err} | `src/js/events/controls/ai.js` |
| 오류 | 수정 실패: {err} | `src/js/events/modals.js` |
| 오류 | 알 수 없는 정렬 언어입니다. 설정에서 언어를 다시 선택해주세요. | `src/js/alignment-viewer.js` |
| 오류 | 양식 저장 중 오류: {err} | `src/js/events/controls/settings.js` |
| 오류 | 업데이트 확인 실패: {err} | `src/js/events/controls/settings.js` |
| 오류 | 오디오 로드 실패: {err} | `src/js/alignment-viewer.js` |
| 오류 | 일부 곡 삭제 중 오류가 발생했습니다. | `src/js/ui/manager.js` |
| 오류 | 재생 오류: {err} | `src/js/events/backend.js` |
| 오류 | 재생 제어 실패 | `src/js/audio.js` |
| 오류 | 재생에 실패했습니다: {err} | `src/js/player.js` |
| 오류 | 재설정 실패: {err} | `src/js/events/controls/settings.js` |
| 오류 | 저장 실패: {err} | `src/js/events/controls/settings.js` |
| 오류 | 저장 중 오류가 발생했습니다: {err} | `src/js/ui/manager.js` |
| 오류 | 저장할 가사 데이터가 없습니다. | `src/js/alignment-viewer.js` |
| 오류 | 정렬 모델 다운로드 실패: {err} | `src/js/alignment-viewer.js` |
| 오류 | 정렬 모델 목록을 불러오지 못했습니다: {err} | `src/js/alignment-viewer.js` |
| 오류 | 정보를 가져오는데 실패했습니다. | `src/js/add-song-modal.js` |
| 오류 | 파일 선택에 실패했습니다. | `src/js/add-song-modal.js` |
| 오류 | 파일 정보를 읽지 못했습니다. | `src/js/add-song-modal.js` |
| 오류 | 곡 추가에 실패했습니다. | `src/js/add-song-modal.js` |
| 오류 | 태그 목록을 불러오지 못했습니다. | `src/js/ui/manager.js` |
| 오류 | 편집 중인 곡을 찾을 수 없습니다. | `src/js/events/modals.js` |
| 오류 | AI 정렬 준비 실패: {err} | `src/js/alignment-viewer.js` |
| 오류 | BPM 그리드 배치 실패: {err} | `src/js/alignment-viewer.js`<br>UI 버튼은 숨김(`#bpm-grid-btn` `hidden`), 코드 경로 유지 |
| 오류 | BPM을 분석하지 못했습니다. | `src/js/alignment-viewer.js` |
| 오류 | CSV 보내기 중 오류: {err} | `src/js/events/controls/settings.js` |
| 오류 | LAN 설정 변경 실패: {err} | `src/js/events/controls/overlay.js` |
| 오류 | LRC 저장 실패: {err} | `src/js/alignment-viewer.js` |
| 오류 | MR 분리 실패: {err} | `src/js/audio.js` |
| 오류 | MR 저장 형식 변경 실패: {err} | `src/js/events/controls/settings.js` |
| 경고 / 성공 | 가져오기 완료: 추가 {added}곡, 갱신 {updated}곡[, 유튜브 정보 {enriched}곡][, 건너뜀 {skipped}행][, 오류 {errCount}건] | `src/js/events/controls/settings.js`<br>스프레드시트 가져오기 결과 |
| 경고 | 모델 이름을 입력해주세요. | `src/js/events/controls/custom-models.js` (notify()) |
| 경고 / 성공 | 복구 완료: 스캔 {scanned}곡 / 복구 {recovered}곡 / 실패 {failed}곡 | `src/js/events/controls/settings.js`<br>캐시 복구 결과 |
| 경고 | 분리 방식 선택 UI를 찾지 못해 기본 모델로 분리합니다. | `src/js/separation-mode-modal.js` |
| 경고 | 분리 작업(진행/대기열)이 있는 동안에는 모델을 삭제할 수 없습니다. | `src/js/events/controls/ai.js` |
| 경고 | 붙여넣기에 실패했습니다. (클립보드 접근 권한 확인) | `src/js/events/controls/shared.js` |
| 경고 | 선택된 곡이 없습니다. | `src/js/ui/manager.js` |
| 경고 | 아키텍처 프리셋을 선택해주세요. | `src/js/events/controls/custom-models.js` (notify()) |
| 경고 | 원문과 번역문을 모두 입력해주세요. | `src/js/ui/manager.js` |
| 경고 | 음원을 먼저 불러오세요. | `src/js/alignment-viewer.js` |
| 경고 | 음원을 먼저 선택하세요. | `src/js/alignment-viewer.js` |
| 경고 | 이미 대기열에 있거나 처리 중인 곡입니다. | `src/js/audio.js` |
| 경고 | 이미 등록된 곡입니다. | `src/js/add-song-modal.js` |
| 경고 | 파형 로드 실패: {err} | `src/js/alignment-viewer.js` |
| 경고 | HTTPS URL만 사용할 수 있습니다. | `src/js/events/controls/custom-models.js` (notify()) |
| 경고 | LAN 접속을 껐습니다. 앱을 다시 시작해야 적용됩니다. | `src/js/events/controls/overlay.js`<br>삼항 분기 |
| 경고 | LAN 접속을 켰습니다. 앱을 다시 시작해야 다른 기기에서 접속할 수 있습니다. | `src/js/events/controls/overlay.js`<br>삼항 분기 |
| 경고 | SHA-256은 64자리 16진수여야 합니다. | `src/js/events/controls/custom-models.js` (notify()) |
| 안내 | 멜로밍 연동으로만 있던 곡 {count}개를 정리했습니다. | `src/js/events/backend.js`<br>라이브러리 로드 시 Meloming 전용 곡 정리 |
| 안내 | {label} 모델로 변경되었습니다. | `src/js/events/controls/ai.js` |
| 안내 | 다음부터는 이 모델로 바로 분리합니다. 설정 > AI 분리 엔진에서 되돌릴 수 있어요. | `src/js/separation-mode-modal.js` |
| 안내 | 데이터 복구를 시작합니다. 유튜브 곡의 경우 시간이 소요될 수 있습니다. | `src/js/events/controls/settings.js` |
| 안내 | 모델이 삭제되었습니다. | `src/js/events/controls/ai.js` |
| 안내 | 배치할 미싱크 가사가 없습니다. | `src/js/alignment-viewer.js` |
| 안내 | 싱크 데이터가 초기화되었습니다. | `src/js/alignment-viewer.js` |
| 안내 | 오디오 설정이 초기화되었습니다. | `src/js/events/controls/playback.js` |
| 안내 | 이 곡은 이미 정렬 대기열에 있거나 처리 중입니다. | `src/js/alignment-viewer.js` |
| 안내 | 재생 중인 곡이 없습니다. | `src/js/events/controls/playback.js`<br>하단 ⋯ 메뉴 |
| 안내 | 재생할 곡이 선택되지 않았습니다. | `src/js/player.js` |
| 안내 | 정렬 모델이 삭제되었습니다. | `src/js/events/controls/alignment-model.js` (notify()) |
| 안내 | 커스텀 모델이 삭제되었습니다. | `src/js/events/controls/custom-models.js` (notify()) |
| 안내 | 커스텀 모델이 제거되었습니다. | `src/js/events/controls/ai.js` |
| 안내 | 태그 목록이 클립보드에 복사되었습니다. | `src/js/ui/manager.js` |
| 안내 | AI로 정렬할 미싱크 가사가 없습니다. | `src/js/alignment-viewer.js` |
| 안내 | MR 저장 형식이 {label}로 변경되었습니다. | `src/js/events/controls/settings.js` |
| 성공 | {n}개의 곡 정보가 저장되었습니다. | `src/js/ui/manager.js` |
| 성공 | {n}곡이 삭제되었습니다. | `src/js/ui/manager.js` |
| 성공 | 가사 싱크 저장 완료 | `src/js/alignment-viewer.js` |
| 성공 | 가져오기 양식(CSV)을 저장했습니다. | `src/js/events/controls/settings.js` |
| 성공 | 곡이 삭제되었습니다. | `src/js/ui/library.js` |
| 성공 | 기본 위치로 되돌렸습니다. 앱을 다시 시작하면 적용됩니다. | `src/js/events/controls/settings.js` |
| 성공 | 다른 정렬이 진행 중이라 대기열에 추가했습니다. 완료되면 자동으로 결과가 반영돼요. | `src/js/alignment-viewer.js` |
| 성공 | 라이브러리 목록이 성공적으로 백업되었습니다. | `src/js/events/controls/settings.js` |
| 성공 | 라이브러리를 CSV로 저장했습니다. | `src/js/events/controls/settings.js` |
| 성공 | 모델 다운로드 완료 | `src/js/events/controls/ai.js` |
| 성공 | 백업본에서 없는 곡들을 성공적으로 병합했습니다. | `src/js/events/controls/settings.js` |
| 성공 | 사전에 등록되었으며 곡 정보에 반영되었습니다. | `src/js/ui/manager.js` |
| 성공 | 이미 최신 버전을 사용 중입니다. | `src/js/events/controls/settings.js` |
| 성공 | 정보가 수정되었습니다. | `src/js/events/modals.js` |
| 성공 | 추가되었습니다. | `src/js/add-song-modal.js` |
| 성공 | 추가되었습니다. (추가 파일 {n}개 포함) | `src/js/add-song-modal.js` |
| 성공 | 커스텀 모델이 추가되었습니다. | `src/js/events/controls/custom-models.js` (notify()) |
| 성공 | AI 가사 정렬 모델 다운로드가 완료되었습니다. | `src/js/events/controls/alignment-model.js` (notify()) |
| 성공 | AI 자동 정렬을 시작했습니다. 완료되면 자동으로 결과가 반영돼요.[ (랩/혼합: …)] | `src/js/alignment-viewer.js` |
| 성공 | AI 정렬 결과 {n}줄이 반영되었습니다. 결과는 AI 초안이니 필요한 부분만 검토해 다듬어 주세요. | `src/js/alignment-viewer.js` |
| 성공 | BPM {bpm} 그리드로 {n}줄 대략 배치했습니다. 필요한 부분만 수동 보정하세요. | `src/js/alignment-viewer.js`<br>UI 버튼 숨김·코드 유지 |
| 성공 | KEY/BPM 분석을 반영했습니다. | `src/js/events/modals.js` |
| 성공 | MR 분리가 완료되었습니다. | `src/js/events/backend.js` |
| 성공 | MR 캐시 저장 위치를 저장했습니다. 앱을 다시 시작하면 적용됩니다. | `src/js/events/controls/settings.js` |
| 성공 | URL이 클립보드에 복사되었습니다. | `src/js/events/controls/overlay.js` |

## 확인 다이얼로그 (`openConfirmModal`)

| 유형 | 제목 | 본문 | 출처 |
| --- | --- | --- | --- |
| 확인 | 곡 삭제 | '{title}' 곡을 삭제하시겠습니까? | `src/js/ui/library.js, src/js/ui/manager.js`<br>곡 삭제 |
| 확인 | AI 가사 정렬 모델 다운로드 | {언어} 가사 정렬 모델을 다운로드합니다. 용량 약 {size} · 라이선스: {license} 정렬 결과는 AI 초안이며, 정확한 싱크를 보장하지 않습니다. 다운로드를 진행할까요? | `src/js/events/controls/alignment-model.js`<br>설정 화면 |
| 확인 | AI 가사 정렬 모델 다운로드 | {언어} 가사 정렬 모델을 다운로드합니다. 출처: {sourceUrl} 라이선스: {license} 예상 용량: {size} AI 초안, 사용자가 다듬기 - 정렬 결과는 참고용 초안이며 정확한 싱크를 보장하지 않습니다. 다운로드를 진행할까요? | `src/js/alignment-viewer.js`<br>가사 싱크 화면 |
| 확인 | 커스텀 모델 URL 등록 | 다음 주소에서 모델을 받습니다. {url} 모델 라이선스와 사용 가능 여부는 직접 확인해 주세요. 계속할까요? | `src/js/events/controls/custom-models.js`<br>커스텀 |
| 확인 | 선택 삭제 | 정말로 선택한 {n}곡을 삭제하시겠습니까? | `src/js/ui/manager.js`<br>선택 삭제 |
| 확인 | 싱크 초기화 | 모든 싱크 데이터를 초기화하시겠습니까? | `src/js/alignment-viewer.js` |

## 브라우저 `confirm()`

_없음_ (앱 내 네이티브 `confirm()` 사용처 없음)

## 백엔드 사용자 노출 오류 (`Err("…")`)

| 유형 | 문구 | 출처 |
| --- | --- | --- |
| 오류 | 다운로드 실패: HTTP {} | `src-tauri/src/alignment.rs` |
| 오류 | 다운로드 용량이 허용 상한({} bytes)을 초과했습니다. | `src-tauri/src/alignment.rs` |
| 오류 | 다운로드 URL을 입력해주세요. | `src-tauri/src/model_commands.rs` |
| 오류 | 데이터 행이 없습니다. 2행부터 곡 정보를 입력해 주세요. | `src-tauri/src/spreadsheet.rs` |
| 오류 | 디코딩 실패: {} | `src-tauri/src/audio_commands.rs` |
| 오류 | 모델 이름을 입력해주세요. | `src-tauri/src/model_commands.rs` |
| 오류 | 모델 입력 형식이 프리셋과 맞지 않습니다 (입력 rank {}, 기대 rank {}). 아키텍처 프리셋을 다시 확인해주세요. | `src-tauri/src/model_commands.rs` |
| 오류 | 모델 파일을 찾을 수 없습니다: {:?} | `src-tauri/src/alignment.rs` |
| 오류 | 무결성 검증에 실패했습니다({}). | `src-tauri/src/model_commands.rs` |
| 오류 | 무결성 검증에 실패했습니다({}). 다시 시도해 주세요. | `src-tauri/src/alignment.rs` |
| 오류 | 분석할 오디오가 너무 짧습니다. | `src-tauri/src/key_bpm.rs` |
| 오류 | 서버가 보고한 파일 크기({} bytes)가 허용 상한({} bytes)을 초과합니다. | `src-tauri/src/alignment.rs` |
| 오류 | 알 수 없는 소스 종류: {} | `src-tauri/src/model_commands.rs` |
| 오류 | 오디오 경로가 파일이 아닙니다: {} | `src-tauri/src/alignment.rs` |
| 오류 | 오디오 출력을 열지 못했습니다: {} | `src-tauri/src/audio_player.rs` |
| 오류 | 오디오 파일을 찾을 수 없습니다. | `src-tauri/src/key_bpm.rs` |
| 오류 | 원본 오디오 파일을 찾을 수 없습니다: {} | `src-tauri/src/alignment.rs` |
| 오류 | 원본이 온라인 곡이며 MR 파일이 없어 분석할 수 없습니다. | `src-tauri/src/key_bpm.rs` |
| 오류 | 유튜브 오디오 경로를 해소할 수 없습니다. | `src-tauri/src/alignment.rs` |
| 오류 | 첫 행에 'path'(경로) 열이 필요합니다. | `src-tauri/src/spreadsheet.rs` |
| 오류 | 파일을 열 수 없습니다: {} | `src-tauri/src/audio_commands.rs` |
| 오류 | 파일을 찾을 수 없습니다 | `src-tauri/src/audio_commands.rs` |
| 오류 | 파일을 찾을 수 없습니다: {} | `src-tauri/src/alignment.rs` |
| 오류 | HTTPS URL만 허용됩니다: {} | `src-tauri/src/alignment.rs` |
| 오류 | Inst 파일을 열 수 없습니다: {} (Path: {:?}) | `src-tauri/src/audio_commands.rs` |
| 오류 | SHA-256 불일치 (expected {}, actual {}) | `src-tauri/src/alignment.rs` |
| 오류 | SHA-256은 64자리 16진수여야 합니다. | `src-tauri/src/model_commands.rs` |
| 오류 | Vocal 파일을 열 수 없습니다: {} (Path: {:?}) | `src-tauri/src/audio_commands.rs` |
| 오류 | YouTube 오디오 다운로드 실패: {} | `src-tauri/src/youtube.rs` |
| 오류 | YouTube 오디오 파일 생성 실패: {} | `src-tauri/src/youtube.rs` |
| 오류 | YouTube 오디오 파일을 완전히 다운로드하지 못했습니다 | `src-tauri/src/youtube.rs` |
| 오류 | YouTube 오디오 파일이 생성되지 않았습니다 (Timeout) | `src-tauri/src/youtube.rs` |

## 유형 범

| 코드 | 의미 |
| --- | --- |
| `success` | 성공 |
| `info` | 안내 |
| `warning` | 경고 |
| `error` | 오류 |
| `confirm` | 사용자 확인 |
