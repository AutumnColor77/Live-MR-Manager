/**
 * 가사 정렬 전용 디리버브 컨트롤 (AI 가사 정렬 섹션).
 * 백엔드: get_dereverb_status / set_dereverb_enabled / open_dereverb_dir.
 */
import { invoke } from './tauri-bridge.js';

async function notify(message, type) {
  try {
    const { showNotification } = await import('./utils.js');
    showNotification(message, type);
  } catch (_) {}
}

export async function refreshDereverbStatus() {
  const chk = document.getElementById('dereverb-enable');
  const st = document.getElementById('dereverb-status');
  if (!chk) return;
  try {
    const s = await invoke('get_dereverb_status');
    chk.checked = s.enabled !== false;
    if (st) {
      // GPU 가속 팩이 없으면 모델이 있어도 건너뛴다(CPU로는 비현실적으로 느림) —
      // 그 사실을 먼저 알려서 "왜 안 되지" 혼란을 막는다.
      let label, cls;
      if (!s.installed) {
        label = '모델 없음'; cls = 'status-offline';
      } else if (!s.gpuPackInstalled) {
        label = 'GPU 가속 팩 필요'; cls = 'status-offline';
      } else {
        label = '사용 가능'; cls = 'status-online';
      }
      st.textContent = label;
      st.className = 'ai-status-badge ' + cls;
    }
  } catch (_) {}
}

export function initDereverbControls() {
  const chk = document.getElementById('dereverb-enable');
  const openBtn = document.getElementById('dereverb-open-dir');
  if (chk) {
    chk.addEventListener('change', async () => {
      try {
        await invoke('set_dereverb_enabled', { enabled: chk.checked });
      } catch (err) {
        await notify('디리버브 설정 실패: ' + err, 'error');
      }
    });
  }
  if (openBtn) {
    openBtn.addEventListener('click', async () => {
      try {
        await invoke('open_dereverb_dir');
        await refreshDereverbStatus();
      } catch (_) {}
    });
  }
}
