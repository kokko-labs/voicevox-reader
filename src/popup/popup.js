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
const showPanelBtn = document.getElementById('showPanelBtn');

// このポップアップが対象とするタブ。
// 状態通知はどのタブからでも届くため、対象を覚えておいて選り分ける。
let targetTabId = null;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  targetTabId = tab && tab.id !== undefined ? tab.id : null;

  await loadSpeakers();
  watchSystemVoices();
  await loadSettings();
  await updateStatus();
});

// スピーカー一覧を取得できているか（VOICEVOX 起動後の読み直し要否の判定に使う）
let speakersLoaded = false;

// 読み上げモデルの一覧を作る。
// 値は 'voicevox:<話者ID>' または 'system:<voiceURI>' の形で、
// content 側はこれだけを見て読み上げ方式を決める。
async function loadSpeakers() {
  speakerSelect.innerHTML = '';

  try {
    const response = await fetch(`${VOICEVOX_URL}/speakers`);
    if (!response.ok) throw new Error('VOICEVOX APIに接続できません');

    const speakers = await response.json();
    const group = document.createElement('optgroup');
    group.label = 'VOICEVOX';

    speakers.forEach(speaker => {
      speaker.styles.forEach(style => {
        group.appendChild(createVoiceOption(`voicevox:${style.id}`, `${speaker.name} (${style.name})`));
      });
    });

    speakerSelect.appendChild(group);
    speakersLoaded = true;
    hideError();
  } catch (error) {
    speakersLoaded = false;
    showError('VOICEVOXに接続できません。VOICEVOXが起動しているか確認してください。');
    speakerSelect.appendChild(createVoiceOption('', 'VOICEVOX: 接続エラー'));
  }

  appendSystemVoices();
}

// Windows などOSに入っている音声。英語の読み上げに使える。
// VOICEVOX が起動していなくても選べる。
//
// 一覧は非同期に用意されるため、最初の getVoices() は空で返ることがある。
// その場合は voiceschanged を待って組み直す。
function appendSystemVoices() {
  speakerSelect.querySelectorAll('optgroup[data-system]').forEach(group => group.remove());

  if (!window.speechSynthesis) {
    return;
  }

  const voices = window.speechSynthesis.getVoices();
  if (!voices || voices.length === 0) {
    return;
  }

  // 言語ごとにまとめる。ブラウザが OS から受け取った順は言語が入り混じるため、
  // そのままでは目的の音声を探しにくい。
  // 地域は区別せず、en-US と en-GB は同じ「英語」の組に入れる。
  const byLanguage = new Map();
  voices.forEach(voice => {
    const language = baseLanguage(voice.lang);
    const group = byLanguage.get(language) || [];
    group.push(voice);
    byLanguage.set(language, group);
  });

  // 言語は言語コード順、音声はその中で名前順。どちらも順序が毎回変わらないようにする
  [...byLanguage.keys()].sort().forEach(language => {
    const group = document.createElement('optgroup');
    group.label = `OS 標準 (${languageLabel(language)})`;
    group.dataset.system = 'true';

    byLanguage.get(language)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(voice => group.appendChild(createVoiceOption(`system:${voice.voiceURI}`, voice.name)));

    speakerSelect.appendChild(group);
  });
}

// 'en-US' から 'en' を取り出す
function baseLanguage(lang) {
  return typeof lang === 'string' && lang ? lang.split('-')[0] : '';
}

// 'en' から「英語」のような表示名を作る。
// 変換できない環境では言語コードをそのまま見せる。
function languageLabel(language) {
  try {
    return new Intl.DisplayNames(['ja'], { type: 'language' }).of(language) || language;
  } catch (error) {
    return language;
  }
}

// 音声の一覧が後から届いたら並べ直し、保存済みの選択を当て直す。
// 一覧が揃う前に選択を復元しようとしても、選択肢が無いため反映されない。
function watchSystemVoices() {
  if (!window.speechSynthesis || typeof window.speechSynthesis.addEventListener !== 'function') {
    return;
  }

  window.speechSynthesis.addEventListener('voiceschanged', async () => {
    appendSystemVoices();
    await restoreVoiceSelection();
  });
}

function createVoiceOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

// 保存済みの読み上げモデルを選択し直す。
// voice が無い場合は、以前の設定（speakerId）を VOICEVOX の指定とみなす。
async function restoreVoiceSelection() {
  const settings = await chrome.storage.local.get(['voice', 'speakerId']);
  const voice = settings.voice !== undefined ? settings.voice
    : (settings.speakerId !== undefined ? `voicevox:${settings.speakerId}` : undefined);

  if (voice !== undefined) {
    speakerSelect.value = voice;
  }
}

// 設定を読み込み
async function loadSettings() {
  const settings = await chrome.storage.local.get(['voice', 'speakerId', 'speed', 'volume']);

  await restoreVoiceSelection();

  if (settings.speed) {
    speedRange.value = settings.speed;
    speedValue.textContent = settings.speed;
  }
  
  if (settings.volume !== undefined) {
    volumeRange.value = settings.volume;
    volumeValue.textContent = settings.volume;
  }
}

// 設定を保存する。
// content script は chrome.storage.local を直接見て再生に反映するため、
// ここでの保存がそのまま再生中の設定変更になる。型は数値へ揃えておく。
async function saveSettings() {
  const settings = {
    speed: parseFloat(speedRange.value),
    volume: parseInt(volumeRange.value, 10)
  };

  // 「接続エラー」の選択肢は値が空。保存済みの選択を空で上書きしないようにする
  if (speakerSelect.value) {
    settings.voice = speakerSelect.value;
  }

  await chrome.storage.local.set(settings);
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
  // VOICEVOX 未起動だと一覧が空のため、先に保存すると選択済みの声を空で上書きしてしまう。
  // OS 標準の音声を選んでいるときは VOICEVOX を使わないので確認しない。
  if (isVoicevoxSelected() && !await ensureVoicevoxReady()) {
    return;
  }

  await saveSettings();

  try {
    // 状態は content 側から statusUpdate で届く。
    // ここで問い合わせると、まだ再生が始まっていない古い値で上書きしてしまう。
    await sendToActiveTab({ action: 'play' });
    hideError();
  } catch (error) {
    showError('ページとの通信に失敗しました。ページを再読み込みしてください。');
  }
});

// VOICEVOX の声を選んでいるか。未選択（接続エラー）のときも VOICEVOX 扱いにして、
// 起動確認から案内が出るようにする。
function isVoicevoxSelected() {
  return !speakerSelect.value.startsWith('system:');
}

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
    // 再生ボタンと同じ理由で、送るだけにする。表示は statusUpdate で更新される
    await sendToActiveTab({ action });
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

// 保存すると content script が storage の変更を受け取り、再生中の音声へ即座に反映する
volumeRange.addEventListener('change', saveSettings);

// スピーカー変更
speakerSelect.addEventListener('change', saveSettings);

// フローティングパネルトグル
// パネルを出すだけのボタン。閉じるのはパネルの × に任せる。
// 状態を持たせないので、ボタンの見た目と実際の表示がずれる余地がない。
showPanelBtn.addEventListener('click', async () => {
  try {
    await sendToActiveTab({ action: 'showFloatingPanel' });
    hideError();
  } catch (error) {
    showError('ページとの通信に失敗しました。ページを再読み込みしてください。');
  }
});

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
  if (message.action !== 'statusUpdate') {
    return;
  }

  // 読み上げ開始時に他タブを停止させるため、他タブからも「停止した」という
  // 通知が届く。これを取り込むと、再生中なのに停止中の表示になってしまう。
  if (targetTabId !== null && sender.tab && sender.tab.id !== targetTabId) {
    return;
  }

  updateUIState(message);
});
