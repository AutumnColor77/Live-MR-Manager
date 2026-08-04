/**
 * Songbook 업로드용 썸네일 리사이즈 (작은 JPEG data URL)
 */
import { convertFileSrc } from './tauri-bridge.js';

/** UI song-thumb(48px) 대비 여유 있는 해상도 */
export const SONGBOOK_THUMB_MAX_SIDE = 96;
/** Songbook SONG_THUMBNAIL_MAX_DATA_URL_CHARS 와 맞춤 */
export const SONGBOOK_THUMB_MAX_CHARS = 80_000;

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value);
}

function isDataImageUrl(value) {
  return /^data:image\//i.test(value);
}

/** 앱 로컬 경로·http URL → 웹뷰에서 로드 가능한 src */
export function resolveThumbnailSrc(song) {
  const raw = String(song?.thumbnail || '').trim();
  if (!raw) return '';
  if (isHttpUrl(raw) || isDataImageUrl(raw)) return raw;
  if (raw.startsWith('asset:') || raw.startsWith('blob:')) return raw;
  try {
    return convertFileSrc(raw);
  } catch {
    return '';
  }
}

/**
 * 이미지를 maxSide 이하 JPEG data URL로 압축.
 * CORS/로드 실패 시 null.
 */
export async function resizeImageSrcToJpegDataUrl(
  src,
  {
    maxSide = SONGBOOK_THUMB_MAX_SIDE,
    maxChars = SONGBOOK_THUMB_MAX_CHARS,
  } = {},
) {
  if (!src) return null;

  let bitmap;
  try {
    const res = await fetch(src, { mode: 'cors' });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/') && blob.type !== '') {
      // some servers omit type; still try
    }
    bitmap = await createImageBitmap(blob);
  } catch {
    // fallback: Image element (may still fail CORS for canvas)
    try {
      bitmap = await loadBitmapViaImage(src);
    } catch {
      return null;
    }
  }

  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);

    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > maxChars && quality > 0.35) {
      quality -= 0.1;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > maxChars) return null;
    return dataUrl;
  } finally {
    try {
      bitmap.close();
    } catch {
      /* ignore */
    }
  }
}

function loadBitmapViaImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = async () => {
      try {
        resolve(await createImageBitmap(img));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = src;
  });
}

/**
 * 동기화용 썸네일:
 * - http(s)는 URL 그대로 (DB·CDN에 유리)
 * - 로컬 경로/asset은 JPEG data URL로 압축
 * - 실패 시 ''
 */
export async function prepareSongbookThumbnail(song) {
  const raw = String(song?.thumbnail || '').trim();
  if (!raw) return '';

  if (isDataImageUrl(raw) && raw.length <= SONGBOOK_THUMB_MAX_CHARS) {
    return raw;
  }

  if (isHttpUrl(raw) && raw.length <= 2048) {
    return raw;
  }

  const src = resolveThumbnailSrc(song);
  if (!src) return '';

  const resized = await resizeImageSrcToJpegDataUrl(src);
  return resized || '';
}
