const VOICEVOX_URL = 'http://localhost:50021';

// DOM要素
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const stopBtn = document.getElementById('stopBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const speakerSelect = document.getElementById('speakerSelect');
const speedRange = document.getElementById('speedRange');
const speedValue = document.getElementById('speedValue');
const volumeRange = document.getElementById('volumeRange');
const volumeValue = document.getElementById('volumeValue');
const statusText = document.getElementById('status');
const errorMessage = document.getElementById('errorMessage');
const toggleFloatingBtn = document.getElementById('toggleFloatingBtn');

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  await loadSpeakers();
  await loadSettings();
  await updateStatus();
  await updateFloatingButtonState();
});

// スピーカー一覧を取得できているか（VOICEVOX 起動後の読み直し要否の判定に使う）
let speakersLoaded = false;

// スピーカー一覧を取得
async function loadSpeakers() {
  try {
    const response = await fetch(`${VOICEVOX_URL}/speakers`);
    if (!response.ok) throw new Error('VOICEVOX APIに接続できません');
    
    const speakers = await response.json();
    speakerSelect.innerHTML = '';
    
    speakers.forEach(speaker => {
      speaker.styles.forEach(style => {
        const option = document.createElement('option');
        option.value = style.id;
        option.textContent = `${speaker.name} (${style.name})`;
        speakerSelect.appendChild(option);
      });
    });
    
    speakersLoaded = true;
    hideError();
  } catch (error) {
    speakersLoaded = false;
    showError('VOICEVOXに接続できません。VOICEVOXが起動しているか確認してください。');
    speakerSelect.innerHTML = '<option value="">接続エラー</option>';
  }
}

// 設定を読み込み
async function loadSettings() {
  const settings = await chrome.storage.local.get(['speakerId', 'speed', 'volume', 'floatingPanelEnabled']);
  
  if (settings.speakerId !== undefined) {
    speakerSelect.value = settings.speakerId;
  }
  
  if (settings.speed) {
    speedRange.value = settings.speed;
    speedValue.textContent = settings.speed;
  }
  
  if (settings.volume !== undefined) {
    volumeRange.value = settings.volume;
    volumeValue.textContent = settings.volume;
  }
}

// 設定を保存
async function saveSettings() {
  await chrome.storage.local.set({
    speakerId: speakerSelect.value,
    speed: speedRange.value,
    volume: volumeRange.value
  });
}

// ステータスを更新
async function updateStatus() {
  try {
    // 状態を見るだけなので注入はしない。ポップアップを開いただけのタブに常駐させないため。
    const response = await sendToActiveTab({ action: 'getStatus' }, { injectIfMissing: false });
    updateUIState(response);
  } catch (error) {
    updateUIState({ isPlaying: false, isPaused: false });
  }
}

// UI状態を更新
function updateUIState(status) {
  const isPlaying = status && status.isPlaying;
  const isPaused = status && status.isPaused;
  const currentIndex = status && status.currentIndex >= 0 ? status.currentIndex : 0;
  const totalSentences = status && status.totalSentences > 0 ? status.totalSentences : 0;
  
  if (isPlaying && !isPaused) {
    statusText.textContent = totalSentences > 0 ? `再生中... (${currentIndex + 1}/${totalSentences})` : '再生中...';
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'flex';
    stopBtn.disabled = false;
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= totalSentences - 1;
  } else if (isPlaying && isPaused) {
    statusText.textContent = totalSentences > 0 ? `一時停止 (${currentIndex + 1}/${totalSentences})` : '一時停止';
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    stopBtn.disabled = false;
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= totalSentences - 1;
  } else {
    statusText.textContent = '停止中';
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    playBtn.disabled = false;
    stopBtn.disabled = true;
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  }
}

// 再生ボタン
playBtn.addEventListener('click', async () => {
  // 設定の保存は起動確認のあとに行う。
  // VOICEVOX 未起動だと話者一覧が空のため、先に保存すると選択済みの話者IDを空で上書きしてしまう。
  const voicevoxReady = await ensureVoicevoxReady();
  if (!voicevoxReady) {
    return;
  }

  await saveSettings();

  try {
    await sendToActiveTab({
      action: 'play',
      speakerId: parseInt(speakerSelect.value) || 0,
      speed: parseFloat(speedRange.value),
      volume: parseInt(volumeRange.value) / 100
    });
    
    await updateStatus();
    hideError();
  } catch (error) {
    showError('ページとの通信に失敗しました。ページを再読み込みしてください。');
  }
});

async function ensureVoicevoxReady() {
  const status = await checkVoicevoxStatus();
  if (!status.available) {
    // 再確認ダイアログは設けない。起動後にもう一度再生を押せば同じ経路を通るため。
    showError('VOICEVOXが起動していません。起動してから、もう一度再生してください。');
    return false;
  }

  // VOICEVOX の起動前にポップアップを開いていた場合、話者一覧が「接続エラー」のままなので読み直す
  if (!speakersLoaded) {
    await loadSpeakers();
    await loadSettings();
  }

  hideError();
  return true;
}

// content script は manifest で常時注入せず、操作された時点でこの関数から注入する。
// injectIfMissing を false にすると注入を伴わない問い合わせになる（状態取得など）。
async function sendToActiveTab(message, { injectIfMissing = true } = {}) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error('アクティブなタブが見つかりません。');
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!injectIfMissing) {
      throw error;
    }

    // 未注入のタブでは通信に失敗するため、注入してから一度だけ再試行する
    await injectContentScript(tab.id);
    return await chrome.tabs.sendMessage(tab.id, message);
  }
}

async function injectContentScript(tabId) {
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
}

async function checkVoicevoxStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkVoicevoxStatus' });
    if (response && response.success) {
      return response;
    }
  } catch (error) {
    console.error('[VOICEVOX Popup] 状態確認失敗:', error);
  }

  return { available: false };
}

// 一時停止ボタン
pauseBtn.addEventListener('click', async () => {
  await sendPlaybackCommand('pause');
});

// 停止ボタン
stopBtn.addEventListener('click', async () => {
  await sendPlaybackCommand('stop');
});

// 前へボタン
prevBtn.addEventListener('click', async () => {
  await sendPlaybackCommand('prev');
});

// 次へボタン
nextBtn.addEventListener('click', async () => {
  await sendPlaybackCommand('next');
});

async function sendPlaybackCommand(action) {
  try {
    await sendToActiveTab({ action });
    await updateStatus();
  } catch (error) {
    showError('ページとの通信に失敗しました。');
  }
}

// 速度変更
speedRange.addEventListener('input', () => {
  speedValue.textContent = speedRange.value;
});

speedRange.addEventListener('change', saveSettings);

// 音量変更
volumeRange.addEventListener('input', () => {
  volumeValue.textContent = volumeRange.value;
});

volumeRange.addEventListener('change', async () => {
  await saveSettings();
  
  // 再生中の場合は音量を即座に更新
  try {
    // 再生中の音量を反映するだけなので注入はしない
    await sendToActiveTab({
      action: 'updateVolume',
      volume: parseInt(volumeRange.value) / 100
    }, { injectIfMissing: false });
  } catch (error) {
    // エラーは無視（再生中でない可能性）
  }
});

// スピーカー変更
speakerSelect.addEventListener('change', saveSettings);

// フローティングパネルトグル
toggleFloatingBtn.addEventListener('click', async () => {
  const settings = await chrome.storage.local.get(['floatingPanelEnabled']);
  const newState = !settings.floatingPanelEnabled;
  
  await chrome.storage.local.set({ floatingPanelEnabled: newState });
  
  try {
    await sendToActiveTab({
      action: 'toggleFloatingPanel',
      enabled: newState
    });
    
    updateFloatingButtonState();
  } catch (error) {
    showError('ページとの通信に失敗しました。ページを再読み込みしてください。');
  }
});

// フローティングボタンの状態を更新
async function updateFloatingButtonState() {
  const settings = await chrome.storage.local.get(['floatingPanelEnabled']);
  if (settings.floatingPanelEnabled) {
    toggleFloatingBtn.classList.add('active');
  } else {
    toggleFloatingBtn.classList.remove('active');
  }
}

// エラー表示
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
}

function hideError() {
  errorMessage.style.display = 'none';
}

// コンテンツスクリプトからのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'statusUpdate') {
    updateUIState(message);
  }
});
