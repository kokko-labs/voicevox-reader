const VOICEVOX_URL = 'http://localhost:50021';
const VOICEVOX_TIMEOUT_MS = 15000;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'synthesizeSpeech') {
    handleSynthesizeSpeech(message.text, message.speakerId, message.speed)
      .then(audioData => {
        sendResponse({ success: true, audioBase64: arrayBufferToBase64(audioData) });
      })
      .catch(error => {
        console.error('[VOICEVOX Background] エラー:', error);
        sendResponse({
          success: false,
          error: error.message,
          errorCode: error.code || null
        });
      });
    return true; // 非同期レスポンスを示す
  } else if (message.action === 'checkVoicevoxStatus') {
    checkVoicevoxStatus()
      .then(result => {
        sendResponse({ success: true, ...result });
      })
      .catch(error => {
        console.error('[VOICEVOX Background] 状態確認エラー:', error);
        sendResponse({ success: false, available: false, error: error.message });
      });
    return true;
  } else if (message.action === 'updateIcon') {
    updateIcon(message.isPlaying, message.isPaused, sender.tab?.id);
    sendResponse({ success: true });
    return true;
  }
});

// 選択したテキストをその場で読み上げるためのコンテキストメニュー。
// contexts: ['selection'] により、テキストを選択しているときだけ項目が現れる。
// この項目のクリックで activeTab が付与されるため、全ページへの常時注入は必要ない。
const READ_SELECTION_MENU_ID = 'voicevox-reader-read-selection';

chrome.runtime.onInstalled.addListener(() => {
  // 更新時に同じIDで作り直すと失敗するため、一度消してから作る
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: READ_SELECTION_MENU_ID,
      title: '選択範囲を読み上げる',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== READ_SELECTION_MENU_ID || !tab || !tab.id) {
    return;
  }

  try {
    await sendToTab(tab.id, { action: 'playSelection' });
  } catch (error) {
    console.error('[VOICEVOX Background] 選択範囲の読み上げに失敗:', error.message);
  }
});

// 未注入のタブでは通信に失敗するため、注入してから一度だけ再試行する。
// content script は二重注入に備えたガードを持つため、重ねて注入しても安全。
async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

// 再生状態ごとのアイコンの接頭辞。icons/<接頭辞><サイズ>.png を指す
const ICON_PREFIX = {
  playing: 'playing',
  paused: 'paused',
  idle: 'icon'
};

// アイコンを更新する。
// 以前は OffscreenCanvas で毎回描き直していたが、絵柄が icons/src/*.svg と
// 描画コードの二重管理になるため、生成済みの PNG を参照する方式へ変えた。
function updateIcon(isPlaying, isPaused, tabId) {
  const prefix = isPaused ? ICON_PREFIX.paused : (isPlaying ? ICON_PREFIX.playing : ICON_PREFIX.idle);
  // 相対パスは呼び出し元スクリプト（src/background.js）の位置を基準に解決されうるため、
  // getURL で拡張機能ルートからの絶対URLに変換してから渡す
  const path = {
    16: chrome.runtime.getURL(`icons/${prefix}16.png`),
    48: chrome.runtime.getURL(`icons/${prefix}48.png`),
    128: chrome.runtime.getURL(`icons/${prefix}128.png`)
  };

  const target = tabId ? { path, tabId } : { path };
  chrome.action.setIcon(target).catch(error => {
    // タブが閉じられた直後などに失敗する。アイコンの更新自体は失敗しても実害がない
    console.warn('[VOICEVOX Background] アイコン更新に失敗:', prefix, error.message);
  });
}

// VOICEVOXの起動状態を確認
async function checkVoicevoxStatus() {
  try {
    const response = await fetchWithTimeout(`${VOICEVOX_URL}/version`, {}, 3000);
    if (!response.ok) {
      return { available: false, error: `Status: ${response.status}` };
    }

    const version = await response.text();
    return {
      available: true,
      version: version.replace(/^"|"$/g, '')
    };
  } catch (error) {
    return {
      available: false,
      error: error.message
    };
  }
}

// 音声合成処理
async function handleSynthesizeSpeech(text, speakerId, speed) {
  try {
    console.log('[VOICEVOX Background] 音声合成開始:', { text: text.substring(0, 50), speakerId, speed });
    
    // 音声クエリを作成
    const queryResponse = await fetchWithTimeout(
      `${VOICEVOX_URL}/audio_query?text=${encodeURIComponent(text)}&speaker=${speakerId}`,
      { method: 'POST' }
    );
    
    if (!queryResponse.ok) {
      const errorText = await queryResponse.text();
      console.error('[VOICEVOX Background] クエリエラー:', errorText);
      throw new Error(`音声クエリの作成に失敗しました (Status: ${queryResponse.status})`);
    }
    
    const query = await queryResponse.json();
    
    // 再生速度を設定
    query.speedScale = speed;
    
    // 音声合成
    const synthesisResponse = await fetchWithTimeout(
      `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query)
      }
    );
    
    if (!synthesisResponse.ok) {
      const errorText = await synthesisResponse.text();
      console.error('[VOICEVOX Background] 合成エラー:', errorText);
      throw new Error(`音声合成に失敗しました (Status: ${synthesisResponse.status})`);
    }
    
    const arrayBuffer = await synthesisResponse.arrayBuffer();
    console.log('[VOICEVOX Background] 音声合成完了:', arrayBuffer.byteLength, 'bytes');
    return arrayBuffer;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('VOICEVOXの応答がタイムアウトしました。VOICEVOXの状態を確認してください。');
      timeoutError.code = 'VOICEVOX_TIMEOUT';
      throw timeoutError;
    }

    if (error.message.includes('Failed to fetch')) {
      const connectionError = new Error('VOICEVOXに接続できません。VOICEVOXが起動しているか確認してください。');
      connectionError.code = 'VOICEVOX_NOT_RUNNING';
      throw connectionError;
    }
    throw error;
  }
}

// 音声データを base64 へ変換する。
// chrome.runtime のメッセージは JSON へ直列化されるため ArrayBuffer をそのまま渡せない。
// 数値配列にすると1バイトが最大4文字（"255,"）へ膨らむが、base64 なら約1.33文字で済む。
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // String.fromCharCode に一度に大量の引数を渡すとスタックを溢れさせるため分割する
  const CHUNK_SIZE = 0x8000;
  let binary = '';

  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK_SIZE));
  }

  return btoa(binary);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = VOICEVOX_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
