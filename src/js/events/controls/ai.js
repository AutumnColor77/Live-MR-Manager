/**
 * AI toggle and model control listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { toggleAiFeature } from '../../audio.js';
import { getAppHandler } from '../../app-context.js';
import {
  checkModelReady,
  deleteAiModel,
  downloadAiModel,
  getActiveSeparations,
  getModelSettings,
  updateModelSettings,
} from '../../model-api.js';

const modelDescMap = {
  kim: "일반적인 보컬·MR 분리에 적합합니다. UVR 모델(잠정 MIT + 크레딧: Anjok07, aufr33).",
  inst_hq_3: "MR(반주) 품질이 더 중요할 때 추천합니다. UVR 모델(잠정 MIT + 크레딧: Anjok07, aufr33).",
};

async function hasPendingSeparations() {
  const localActive = Object.values(state.activeTasks || {}).some((task) => {
    const s = String(task?.status || "").toLowerCase();
    const done =
      s === "finished" ||
      s === "cancelled" ||
      s === "error" ||
      s.startsWith("error:") ||
      s.includes("cancel");
    return !done;
  });
  if (localActive) return true;
  try {
    const activePaths = await getActiveSeparations();
    return Array.isArray(activePaths) && activePaths.length > 0;
  } catch (_) {
    return localActive;
  }
}

async function refreshModelUiState(modelId) {
  const { updateAiModelStatus } = await import('../../ui/components.js');
  const isReady = await checkModelReady(modelId);
  updateAiModelStatus(isReady);
}

export function initAiListeners() {
  if (elements.toggleVocal) {
    elements.toggleVocal.onchange = async (e) => {
      const isEnabled = e.target.checked;
      state.vocalEnabled = isEnabled;
      localStorage.setItem("vocalEnabled", isEnabled);
      await toggleAiFeature("vocal", isEnabled);
    };
  }

  if (elements.toggleLyric) {
    elements.toggleLyric.onchange = async (e) => {
      const enabled = e.target.checked;
      state.lyricsEnabled = enabled;
      localStorage.setItem("lyricsEnabled", enabled);
      await toggleAiFeature("lyric", enabled);

      if (enabled) {
        getAppHandler('openLyricDrawer')?.();
      } else {
        getAppHandler('closeLyricDrawer')?.();
      }
    };
  }

  const aiModelSelect = document.getElementById("ai-model-select-dropdown");
  const aiModelDesc = document.getElementById("ai-model-desc");

  if (aiModelSelect) {
    aiModelSelect.addEventListener("click", async (e) => {
      const option = e.target.closest(".option-item");
      if (!option) return;
      const modelId = option.dataset.value;
      if (!modelId) return;

      try {
        await updateModelSettings(modelId);
        if (aiModelDesc && modelDescMap[modelId]) {
          aiModelDesc.textContent = modelDescMap[modelId];
        }
        await refreshModelUiState(modelId);
        const { showNotification } = await import('../../utils.js');
        showNotification(modelId === "kim" ? "Kim Vocal 2 모델로 변경되었습니다." : "Inst HQ 3 모델로 변경되었습니다.", "info");
      } catch (err) {
        const { showNotification } = await import('../../utils.js');
        showNotification("모델 변경 실패: " + err, "error");
      }
    });
  }

  if (elements.btnDownloadModel) {
    elements.btnDownloadModel.onclick = async () => {
      try {
        const modelId = await getModelSettings();
        elements.btnDownloadModel.classList.add("loading-btn");
        elements.btnDownloadModel.disabled = true;
        await downloadAiModel(modelId);
        await refreshModelUiState(modelId);
        import('../../utils.js').then(m => m.showNotification("모델 다운로드 완료", "success"));
      } catch (err) {
        import('../../utils.js').then(m => m.showNotification("다운로드 실패: " + err, "error"));
      } finally {
        elements.btnDownloadModel.classList.remove("loading-btn");
        elements.btnDownloadModel.disabled = false;
      }
    };
  }

  if (elements.btnDeleteModel) {
    elements.btnDeleteModel.onclick = async () => {
      try {
        if (await hasPendingSeparations()) {
          const { showNotification } = await import('../../utils.js');
          showNotification("분리 작업(진행/대기열)이 있는 동안에는 모델을 삭제할 수 없습니다.", "warning");
          return;
        }

        const modelId = await getModelSettings();
        elements.btnDeleteModel.disabled = true;
        await deleteAiModel(modelId);
        await refreshModelUiState(modelId);
        import('../../utils.js').then(m => m.showNotification("모델이 삭제되었습니다.", "info"));
      } catch (err) {
        import('../../utils.js').then(m => m.showNotification("삭제 실패: " + err, "error"));
      } finally {
        elements.btnDeleteModel.disabled = false;
      }
    };
  }
}
