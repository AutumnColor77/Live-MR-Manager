/**
 * alignment-model.js - AI 가사 정렬 언어 선택/모델 매핑 (프론트엔드 공용)
 *
 * `get_model_list`가 반환하는 로컬 정렬 모델은 `display|경로` 문자열이며,
 * 경로에는 다운로드된 모델의 폴더명(wav2vec2-korean-lyrics /
 * wav2vec2-english-lyrics)이 들어있다. 이 파일은 그 폴더명과 사용자가 고른
 * 언어(ko/en)를 매핑하는 순수 유틸리티만 담당한다 - 실제 다운로드/삭제/상태
 * 조회는 `model-api.js`의 백엔드 커맨드 래퍼를 사용한다.
 */

export const ALIGNMENT_LANGUAGES = {
  ko: { modelFolder: 'wav2vec2-korean-lyrics', label: '한국어' },
  en: { modelFolder: 'wav2vec2-english-lyrics', label: 'English' },
};

const LANG_KEY = 'alignmentLanguage';

/** 사용자가 마지막으로 고른 정렬 언어("ko"/"en"). 기본값 "ko". */
export function getAlignmentLanguage() {
  const v = localStorage.getItem(LANG_KEY);
  return ALIGNMENT_LANGUAGES[v] ? v : 'ko';
}

export function setAlignmentLanguage(lang) {
  if (ALIGNMENT_LANGUAGES[lang]) localStorage.setItem(LANG_KEY, lang);
}

/** `get_model_list` 결과("display|path" 배열)에서 해당 언어 모델 폴더를
 *  포함하는 항목을 찾아 반환한다. 없으면 null (아직 다운로드되지 않음). */
export function findModelForLanguage(models, lang) {
  const spec = ALIGNMENT_LANGUAGES[lang];
  if (!spec) return null;
  const usable = (models || []).filter((m) => !String(m).endsWith('|none'));
  const matched = usable.find((m) => {
    const path = (m.split('|').pop() || '').replace(/\\/g, '/').toLowerCase();
    return path.includes(spec.modelFolder.toLowerCase());
  });
  return matched || null;
}
