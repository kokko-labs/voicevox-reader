const VOICEVOX_URL = 'http://localhost:50021';
const VOICEVOX_TIMEOUT_MS = 15000;

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'synthesizeSpeech') {
    handleSynthesizeSpeech(message.text, message.speakerId, message.speed)
      .then(audioData => {
        sendResponse({ success: true, audioData: Array.from(new Uint8Array(audioData)) });
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

// アイコンを更新
function updateIcon(isPlaying, isPaused, tabId) {
  if (isPlaying && !isPaused) {
    // 再生中：緑色のアイコン
    setIconColor('#4CAF50', tabId);
  } else if (isPaused) {
    // 一時停止中：オレンジ色のアイコン
    setIconColor('#ff9800', tabId);
  } else {
    // 停止中：通常のアイコン
    setIconColor('#667eea', tabId);
  }
}

// 指定した色でアイコンを生成
function setIconColor(color, tabId) {
  const sizes = [16, 48, 128];
  const imageData = {};
  
  sizes.forEach(size => {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d');
    
    // 背景のグラデーション
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, adjustColor(color, -20));
    
    // 角丸の背景
    const radius = size / 4;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, radius);
    ctx.fill();
    
    // 再生アイコン（三角形）
    ctx.fillStyle = 'white';
    ctx.beginPath();
    const triangleSize = size * 0.5;
    const offsetX = size * 0.33;
    const offsetY = size * 0.25;
    ctx.moveTo(offsetX, offsetY);
    ctx.lineTo(offsetX, offsetY + triangleSize);
    ctx.lineTo(offsetX + triangleSize * 0.866, offsetY + triangleSize / 2);
    ctx.closePath();
    ctx.fill();
    
    imageData[size] = ctx.getImageData(0, 0, size, size);
  });
  
  // アイコンを設定
  if (tabId) {
    chrome.action.setIcon({ imageData, tabId });
  } else {
    chrome.action.setIcon({ imageData });
  }
}

// 色を暗く/明るく調整
function adjustColor(hex, percent) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, Math.min(255, (num >> 16) + percent));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00FF) + percent));
  const b = Math.max(0, Math.min(255, (num & 0x0000FF) + percent));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
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
