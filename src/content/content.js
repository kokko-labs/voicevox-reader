// 同一タブへの二重注入対策。
// manifest による宣言注入と popup からの動的注入が競合すると、このファイルが2回評価され、
// トップレベルの const/let 再宣言で SyntaxError になる（早期 return では防げない。
// 再宣言エラーは文の実行前、スクリプト評価時に発生するため）。
// 全体をブロックで囲むと宣言がブロックスコープに閉じるためエラー自体が起きず、
// フラグで2回目の実行（リスナーの二重登録）も無効化できる。
// ※ 差分と blame を保つため、ブロック内の既存コードはあえて字下げしていない。
if (!window.__VOICEVOX_READER_INJECTED__) {
window.__VOICEVOX_READER_INJECTED__ = true;

// 状態管理
let isPlaying = false;
let isPaused = false;
let currentAudio = null;
let sentences = [];
let currentIndex = 0;
let currentHighlight = null;
let speakerId = 0;
let speed = 1.0;
let volume = 1.0;
let floatingPanel = null;
let playbackToken = 0;
let finishCurrentAudio = null;
let synthesizeSpeechOverride = null;
let playAudioOverride = null;
let extractedTextCache = null;
let floatingPanelDragCleanup = null;
let noticeElement = null;
let noticeTimerId = null;
// 再生中の音声を合成したときの速度。設定変更後に再生レートを補正するために保持する
let currentAudioSpeed = 1.0;

// ページ内通知を自動的に閉じるまでの時間
const NOTICE_DURATION_MS = 6000;

// 再生設定は chrome.storage.local を唯一の情報源とし、popup と content で共有する。
// volume は popup のスライダーの単位に合わせて 0〜100 で保存されている。
const PLAYBACK_SETTING_KEYS = ['speakerId', 'speed', 'volume'];

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'play':
      // 設定は storage から読むため、メッセージでは運ばない
      if (isPaused) {
        resumeReading();
      } else {
        startReading();
      }
      sendResponse({ success: true });
      break;
    case 'playSelection':
      // コンテキストメニューから呼ばれる。項目名のとおり選択範囲だけを読む。
      // この経路ではポップアップが開いていないため、操作パネルを出さないと
      // 停止も一時停止もできなくなる。設定の値によらず表示する。
      showFloatingPanel();
      startReading({ selectionOnly: true });
      sendResponse({ success: true });
      break;
    case 'pause':
      pauseReading();
      sendResponse({ success: true });
      break;
    case 'stop':
      stopReading();
      sendResponse({ success: true });
      break;
    case 'prev':
      skipToPrevious();
      sendResponse({ success: true });
      break;
    case 'next':
      skipToNext();
      sendResponse({ success: true });
      break;
    case 'getStatus':
      sendResponse({
        isPlaying,
        isPaused,
        currentIndex,
        totalSentences: sentences.length
      });
      break;
    case 'toggleFloatingPanel':
      toggleFloatingPanel(message.enabled);
      sendResponse({ success: true });
      break;
  }
  // すべてのケースで同期的に sendResponse 済みのため、応答ポートを開いたままにしない
});

// popup で設定が変わったら即座に取り込む
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') {
    return;
  }

  const changedSettings = {};
  for (const key of PLAYBACK_SETTING_KEYS) {
    if (changes[key]) {
      changedSettings[key] = changes[key].newValue;
    }
  }

  if (Object.keys(changedSettings).length > 0) {
    applyPlaybackSettings(changedSettings);
  }

  // パネルの表示設定も追従させる。
  // 復元処理は content script の注入時にしか走らないため、これがないと
  // 「すでに注入済みのタブ」では設定を変えてもパネルが現れない。
  if (changes.floatingPanelEnabled) {
    toggleFloatingPanel(changes.floatingPanelEnabled.newValue === true);
  }
});

// 保存済みの再生設定を読み込んで反映する
async function loadPlaybackSettings() {
  try {
    const stored = await chrome.storage.local.get(PLAYBACK_SETTING_KEYS);
    applyPlaybackSettings(stored);
  } catch (error) {
    console.error('[VOICEVOX Reader] 再生設定の読み込みに失敗:', error);
  }
}

// 再生設定を取り込む。値が欠けている項目は現在値を保つ
function applyPlaybackSettings(values) {
  const parsedSpeakerId = toFiniteNumber(values.speakerId);
  if (parsedSpeakerId !== null) {
    speakerId = parsedSpeakerId;
  }

  const parsedSpeed = toFiniteNumber(values.speed);
  if (parsedSpeed !== null && parsedSpeed > 0) {
    speed = parsedSpeed;
  }

  const parsedVolume = toFiniteNumber(values.volume);
  if (parsedVolume !== null) {
    volume = Math.min(1, Math.max(0, parsedVolume / 100));
  }

  applyPlaybackSettingsToCurrentAudio();
}

// 再生中の音声へ、いま反映できる設定だけを適用する。
// 音量はそのまま反映できる。
// 速度は合成時の speedScale で決まっているため、再生レートの比で近似し、
// 本来の速度は次の文の合成から反映される。
// 話者は合成済みの音声には反映できないため、次の文から切り替わる。
function applyPlaybackSettingsToCurrentAudio() {
  if (!currentAudio) {
    return;
  }

  currentAudio.volume = volume;

  if (currentAudioSpeed > 0) {
    currentAudio.playbackRate = speed / currentAudioSpeed;
  }
}

// storage には文字列で保存されている場合があるため、数値として解釈できるときだけ返す
function toFiniteNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// 読み上げ開始
// selectionOnly を指定すると、選択の仕方によらず選択範囲だけを読み上げる。
// コンテキストメニューは項目名で動作を明示しているため、そちらから使う。
async function startReading({ selectionOnly = false } = {}) {
  if (isPlaying) {
    stopReading();
  }

  console.log('[VOICEVOX Reader] 読み上げ開始');

  const voicevoxReady = await ensureVoicevoxAvailable();
  if (!voicevoxReady) {
    return;
  }

  // 選択範囲を読み上げ対象そのものとみなすか、読み始める位置とみなすかを決める
  const selection = window.getSelection();
  const selectedText = selection ? selection.toString().trim() : '';

  if (selectionOnly && selectedText === '') {
    showNotice('テキストが選択されていません。');
    return;
  }

  const readsSelectionOnly = selectedText !== '' && (selectionOnly || spansMultipleSentences(selectedText));

  if (selectedText) {
    console.log('[VOICEVOX Reader] 選択テキスト:', selectedText.substring(0, 50),
      readsSelectionOnly ? '(範囲として読む)' : '(開始位置として扱う)');
  }

  const sourceText = readsSelectionOnly ? selectedText : extractMainContent();
  console.log('[VOICEVOX Reader] 抽出テキスト長:', sourceText.length);
  console.log('[VOICEVOX Reader] 抽出テキストプレビュー:', sourceText.substring(0, 200));

  sentences = splitIntoSentences(sourceText);
  console.log('[VOICEVOX Reader] 分割された文章数:', sentences.length);

  if (sentences.length === 0) {
    console.error('[VOICEVOX Reader] 読み上げるテキストがありません');
    showNotice('読み上げるテキストが見つかりませんでした。');
    return;
  }

  // 開始位置を決定。範囲として読む場合は選択の先頭から始まるので探索は不要
  currentIndex = 0;
  if (!readsSelectionOnly && selectedText) {
    const foundIndex = findSentenceIndex(selectedText);
    if (foundIndex >= 0) {
      currentIndex = foundIndex;
      console.log('[VOICEVOX Reader] 選択位置から開始:', currentIndex);
    }
  }

  if (readsSelectionOnly && !selectionOnly) {
    // 自動で判定した結果なので、どちらの動作になったかを利用者に見せる。
    // コンテキストメニュー経由では項目名で動作が分かっているため出さない。
    showNotice('選択した範囲のみ読み上げます。');
  }

  console.log('[VOICEVOX Reader] 最初の文章:', sentences[currentIndex]);

  isPlaying = true;
  isPaused = false;
  const token = ++playbackToken;
  notifyStatusChange();
  await readNextSentence(token);
}

// 読み上げ一時停止
function pauseReading() {
  console.log('[VOICEVOX Reader] 一時停止');
  if (!isPlaying || isPaused) {
    return;
  }

  isPaused = true;

  if (currentAudio) {
    // 再生中の音声はそのまま一時停止し、同じ位置から再開できるようにする
    currentAudio.pause();
  } else {
    // 音声合成中の一時停止：進行中の処理を無効化し、再開時に現在の文を読み直す
    playbackToken++;
  }

  notifyStatusChange();
}

// 読み上げ再開
function resumeReading() {
  console.log('[VOICEVOX Reader] 再開');
  if (!isPlaying || !isPaused) {
    return;
  }

  isPaused = false;

  if (currentAudio) {
    // 一時停止していた音声を続きから再生する（読み直さない）
    // 一時停止中に変更された音量と速度を反映してから再開する
    applyPlaybackSettingsToCurrentAudio();
    notifyStatusChange();
    currentAudio.play().catch(error => {
      // 停止・スキップで再生開始が中断されたときの AbortError は正常系なので無視する
      if (error && error.name === 'AbortError') {
        return;
      }
      console.error('[VOICEVOX Reader] 再開エラー:', error);
    });
  } else {
    // 合成中に一時停止していた場合は現在の文を読み直す
    const token = ++playbackToken;
    notifyStatusChange();
    readNextSentence(token);
  }
}

// 読み上げ停止
function stopReading() {
  console.log('[VOICEVOX Reader] 読み上げ停止');
  isPlaying = false;
  isPaused = false;
  playbackToken++;
  interruptCurrentAudio();

  removeHighlight();
  notifyStatusChange();
}

// 前の文章へスキップ
function skipToPrevious() {
  if (currentIndex > 0) {
    console.log('[VOICEVOX Reader] 前の文章へスキップ');

    playbackToken++;
    interruptCurrentAudio();

    currentIndex--;
    notifyStatusChange(); // 先にステータス更新

    if (isPlaying && !isPaused) {
      readNextSentence(playbackToken);
    } else {
      // 一時停止中はハイライトだけ更新
      highlightSentence(sentences[currentIndex]);
    }
  }
}

// 次の文章へスキップ
function skipToNext() {
  if (currentIndex < sentences.length - 1) {
    console.log('[VOICEVOX Reader] 次の文章へスキップ');

    playbackToken++;
    interruptCurrentAudio();

    currentIndex++;
    notifyStatusChange(); // 先にステータス更新

    if (isPlaying && !isPaused) {
      readNextSentence(playbackToken);
    } else {
      // 一時停止中はハイライトだけ更新
      highlightSentence(sentences[currentIndex]);
    }
  }
}

// 本文コンテンツを抽出
function extractMainContent() {
  // 1回の抽出内で同じ要素のテキストを何度も再計算しないようにキャッシュする
  extractedTextCache = new WeakMap();
  try {
    return extractMainContentInternal();
  } finally {
    extractedTextCache = null;
  }
}

function extractMainContentInternal() {
  const contentSelectors = [
    '#readability-page-1',
    '.entry-content',
    '.reader-content',
    '.moz-reader-content',
    '.article-body',
    '.article_body',
    '.articleBody',
    '.post-content',
    '.article-content',
    '[itemprop="articleBody"]',
    'article',
    'main',
    '[role="main"]',
    '.article',
    '.content',
    '#content',
    '.post',
    '.entry',
    '.news-article',
    '.story-body'
  ];

  const candidates = new Set();

  for (const selector of contentSelectors) {
    document.querySelectorAll(selector).forEach(element => {
      if (element instanceof HTMLElement) {
        candidates.add(element);
      }
    });
  }

  document.querySelectorAll('article, main, [role="main"], section, div').forEach(element => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    const text = extractTextFromElement(element);
    const paragraphCount = element.querySelectorAll('p').length;
    if (text.length >= 120 && paragraphCount >= 2) {
      candidates.add(element);
    }
  });

  let contentElement = null;
  let bestScore = -Infinity;

  candidates.forEach(element => {
    const score = scoreContentElement(element);
    if (score > bestScore) {
      bestScore = score;
      contentElement = element;
    }
  });

  if (contentElement) {
    console.log('[VOICEVOX Reader] コンテンツ要素を選択:', describeElement(contentElement), 'score=', bestScore);
  }

  // 見つからない場合はbodyを使用
  if (!contentElement) {
    console.log('[VOICEVOX Reader] メインコンテンツが見つからないため、bodyを使用');
    contentElement = document.body;
  }

  // テキストノードを収集
  return extractTextFromElement(contentElement);
}

// 要素からテキストを抽出
function extractTextFromElement(element) {
  if (extractedTextCache && extractedTextCache.has(element)) {
    return extractedTextCache.get(element);
  }

  const excludeTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'FORM', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'SVG', 'CANVAS'];
  const hiddenClassPattern = /(visually-hidden|visuallyhidden|sr-only|screen-reader-text)/i;
  let text = '';

  function traverse(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const trimmed = node.textContent.trim();
      if (trimmed) {
        text += trimmed + ' ';
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (excludeTags.includes(node.tagName)) return;
      if (node.getAttribute('aria-hidden') === 'true') return;
      if (node.hasAttribute('hidden')) return;
      if (node.getAttribute('role') === 'presentation') return;
      if (hiddenClassPattern.test(node.className || '')) return;
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;

      // ブロック要素の前後に区切りを追加
      const blockElements = ['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TD', 'TH', 'BLOCKQUOTE', 'PRE', 'BR'];
      if (blockElements.includes(node.tagName)) {
        text += '\n';
      }

      for (const child of node.childNodes) {
        traverse(child);
      }

      if (blockElements.includes(node.tagName)) {
        text += '\n';
      }
    }
  }

  traverse(element);
  const normalized = normalizeExtractedText(text);
  if (extractedTextCache) {
    extractedTextCache.set(element, normalized);
  }
  return normalized;
}

function normalizeExtractedText(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function scoreContentElement(element) {
  const text = extractTextFromElement(element);
  const textLength = text.length;
  const isPreferredContent = element.matches('#readability-page-1, .entry-content, .reader-content, .moz-reader-content, [itemprop="articleBody"], article, main, [role="main"]');

  if (textLength < (isPreferredContent ? 20 : 80)) {
    return -Infinity;
  }

  const paragraphCount = element.querySelectorAll('p').length;
  const headingCount = element.querySelectorAll('h1, h2, h3').length;
  const listItemCount = element.querySelectorAll('li').length;
  const linkCount = element.querySelectorAll('a').length;
  const imageCount = element.querySelectorAll('img').length;
  const readerModeBonus = isPreferredContent ? 400 : 0;
  const linkPenalty = Math.min(linkCount * 30, textLength * 0.2);
  const imagePenalty = imageCount > 3 && paragraphCount === 0 ? 300 : 0;

  return textLength + paragraphCount * 180 + headingCount * 120 + listItemCount * 40 + readerModeBonus - linkPenalty - imagePenalty;
}

function describeElement(element) {
  const id = element.id ? `#${element.id}` : '';
  const className = typeof element.className === 'string'
    ? '.' + element.className.trim().split(/\s+/).filter(Boolean).join('.')
    : '';
  return `${element.tagName.toLowerCase()}${id}${className}`;
}

// 選択範囲が複数の文や段落にまたがっているかを判定する。
// またいでいれば「その範囲だけを読みたい」、またいでいなければ
// 「そこから読み始めたい」という意図とみなす。
function spansMultipleSentences(text) {
  const trimmed = text.trim();

  // 段落やブロックをまたぐ選択は、範囲を指定する意図とみなす
  if (/\n/.test(trimmed)) {
    return true;
  }

  // 末尾の終端記号は1文を選んだだけなので判定から除く
  const body = trimmed.replace(/[。．！？.!?]+$/, '');

  // 半角の終端記号は「0.25.1」のような小数点と紛らわしいため、
  // 後ろに空白が続く場合だけ文の区切りとみなす
  return /[。．！？]|[.!?]\s/.test(body);
}

// テキストを文章単位に分割
function splitIntoSentences(text) {
  const sentences = [];
  const normalizedText = normalizeExtractedText(text);

  if (!normalizedText) {
    return [];
  }

  const paragraphs = normalizedText.split(/\n+/).map(paragraph => paragraph.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    const parts = paragraph.match(/[^。！？.!?]+[。！？.!?]?/g) || [];

    if (parts.length === 0) {
      appendChunkedSentence(sentences, paragraph);
      continue;
    }

    for (const part of parts) {
      const sentence = part.trim();
      if (!sentence) {
        continue;
      }

      if (sentence.length > 300) {
        appendChunkedSentence(sentences, sentence);
      } else {
        sentences.push(sentence);
      }
    }
  }

  if (sentences.length === 0 && normalizedText.length > 0) {
    appendChunkedSentence(sentences, normalizedText);
  }

  console.log('[VOICEVOX Reader] 最初の3文:', sentences.slice(0, 3));
  return sentences;
}

function appendChunkedSentence(sentences, text) {
  const chunkSize = 100;
  for (let index = 0; index < text.length; index += chunkSize) {
    const chunk = text.substring(index, index + chunkSize).trim();
    if (chunk) {
      sentences.push(chunk);
    }
  }
}

// 選択テキストに対応する文章のインデックスを探す
function findSentenceIndex(searchText) {
  const normalizedSearch = normalizeForSearch(searchText).substring(0, 50);
  if (normalizedSearch.length < 4) {
    return -1;
  }

  for (let i = 0; i < sentences.length; i++) {
    const normalizedSentence = normalizeForSearch(sentences[i]);
    if (normalizedSentence.includes(normalizedSearch)) {
      return i;
    }
    // フォールバック：選択テキストが文の先頭を含む場合。短い文の偶発一致を避けるため一定長以上のみ対象
    if (normalizedSentence.length >= 15 && normalizedSearch.includes(normalizedSentence.substring(0, 30))) {
      return i;
    }
  }
  return -1;
}

// 次の文章を読み上げ
async function readNextSentence(token = playbackToken) {
  if (token !== playbackToken || !isPlaying || isPaused || currentIndex >= sentences.length) {
    if (currentIndex >= sentences.length) {
      console.log('[VOICEVOX Reader] 読み上げ完了');
      stopReading();
    }
    return;
  }

  // 直前の変更を取り込む。再生・前へ・次へ・合成中の再開はすべてここを通るため、
  // 設定の読み直しはこの1箇所で足りる。
  await loadPlaybackSettings();
  if (token !== playbackToken || !isPlaying || isPaused) {
    return;
  }

  const sentence = sentences[currentIndex];
  console.log(`[VOICEVOX Reader] 文章 ${currentIndex + 1}/${sentences.length}:`, sentence.substring(0, 50));
  notifyStatusChange();

  // ハイライト表示
  highlightSentence(sentence);

  try {
    // 音声合成
    console.log('[VOICEVOX Reader] 音声合成開始...');
    // 合成に使った速度を控える。再生中に速度が変わったとき、再生レートの補正に必要になる
    const synthesisSpeed = speed;
    const audioData = await synthesizeSpeech(sentence);
    console.log('[VOICEVOX Reader] 音声合成完了');

    if (token !== playbackToken || !isPlaying || isPaused) return;

    // 音声再生
    console.log('[VOICEVOX Reader] 音声再生開始...');
    const playResult = await playAudio(audioData, synthesisSpeed);
    console.log('[VOICEVOX Reader] 音声再生完了');

    if (playResult !== 'ended' || token !== playbackToken || !isPlaying || isPaused) return;

    // 次の文章へ
    currentIndex++;
    await readNextSentence(token);
  } catch (error) {
    console.error('[VOICEVOX Reader] エラー:', error);
    showNotice(`エラーが発生しました: ${error.message}`);
    stopReading();
  }
}

// ページ内に通知を表示する。
// alert はページのJavaScriptを止めてしまううえ、ブラウザが発信元を閲覧中のドメイン名で示すため、
// サイト自身が出したダイアログのように見えてしまう。
function showNotice(message) {
  removeNotice();

  if (!document.body) {
    return;
  }

  const notice = document.createElement('div');
  notice.id = 'voicevox-reader-notice';

  const text = document.createElement('span');
  text.className = 'vr-notice-text';
  text.textContent = message;

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'vr-notice-close';
  closeButton.setAttribute('aria-label', '閉じる');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', removeNotice);

  notice.appendChild(text);
  notice.appendChild(closeButton);
  document.body.appendChild(notice);

  noticeElement = notice;
  noticeTimerId = setTimeout(removeNotice, NOTICE_DURATION_MS);
}

function removeNotice() {
  if (noticeTimerId !== null) {
    clearTimeout(noticeTimerId);
    noticeTimerId = null;
  }

  if (noticeElement) {
    noticeElement.remove();
    noticeElement = null;
  }
}

async function ensureVoicevoxAvailable() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'checkVoicevoxStatus' });
    if (response && response.success && response.available) {
      return true;
    }
  } catch (error) {
    console.error('[VOICEVOX Reader] VOICEVOX状態確認失敗:', error);
  }

  // 再確認ダイアログは設けない。起動後にもう一度再生を押せば同じ経路を通るため。
  showNotice('VOICEVOXが起動していません。起動してから、もう一度再生してください。');
  return false;
}

// VOICEVOXで音声合成
async function synthesizeSpeech(text) {
  if (synthesizeSpeechOverride) {
    return synthesizeSpeechOverride(text);
  }

  try {
    console.log('[VOICEVOX Reader] Background経由で音声合成リクエスト... Speaker ID:', speakerId);

    // Background Service Workerに音声合成をリクエスト
    const response = await chrome.runtime.sendMessage({
      action: 'synthesizeSpeech',
      text: text,
      speakerId: speakerId,
      speed: speed
    });

    if (!response.success) {
      const synthesisError = new Error(response.error || '音声合成に失敗しました');
      synthesisError.code = response.errorCode || null;
      throw synthesisError;
    }

    const audioData = base64ToArrayBuffer(response.audioBase64);
    console.log('[VOICEVOX Reader] 音声データ受信:', audioData.byteLength, 'bytes');
    return audioData;
  } catch (error) {
    console.error('[VOICEVOX Reader] synthesizeSpeechエラー:', error);
    if (error.message.includes('Could not establish connection')) {
      throw new Error('拡張機能の再読み込みが必要です。chrome://extensions/ で拡張機能を再読み込みしてください。');
    }
    throw error;
  }
}

// background から base64 で受け取った音声データを ArrayBuffer へ戻す
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

// 音声を再生
function playAudio(audioData, synthesisSpeed = speed) {
  if (playAudioOverride) {
    return playAudioOverride(audioData, synthesisSpeed);
  }

  return new Promise((resolve, reject) => {
    if (!audioData || audioData.byteLength === 0) {
      reject(new Error('音声データが空です'));
      return;
    }

    const blob = new Blob([audioData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    console.log('[VOICEVOX Reader] 音声URL作成:', url);

    const audio = new Audio(url);
    currentAudio = audio;
    currentAudioSpeed = synthesisSpeed;
    applyPlaybackSettingsToCurrentAudio();
    let settled = false;

    const finish = (result, error) => {
      if (settled) {
        return;
      }

      settled = true;
      URL.revokeObjectURL(url);
      if (currentAudio === audio) {
        currentAudio = null;
        finishCurrentAudio = null;
      }

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    finishCurrentAudio = () => {
      audio.pause();
      finish('interrupted');
    };

    audio.onended = () => {
      console.log('[VOICEVOX Reader] 音声再生終了');
      finish('ended');
    };

    audio.onerror = (error) => {
      console.error('[VOICEVOX Reader] 音声再生エラー:', error);
      finish(null, new Error('音声の再生に失敗しました'));
    };

    audio.play().catch((error) => {
      // pause() で再生開始が中断されたときの AbortError は一時停止の正常系なので無視する。
      // （finish を呼ぶと playAudio が reject され、readNextSentence がエラー停止してしまう）
      if (error && error.name === 'AbortError') {
        return;
      }
      console.error('[VOICEVOX Reader] play()エラー:', error);
      finish(null, error);
    });
  });
}

function interruptCurrentAudio() {
  if (finishCurrentAudio) {
    finishCurrentAudio();
    return;
  }

  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

// 文章をハイライト表示
function highlightSentence(sentence) {
  removeHighlight();

  console.log('[VOICEVOX Reader] ハイライト対象:', sentence.substring(0, 50));

  const rangeInfo = findTextRange(sentence);
  if (rangeInfo) {
    highlightRange(rangeInfo);
    return;
  }

  console.log('[VOICEVOX Reader] ハイライト位置が見つかりませんでした');
}

function normalizeForSearch(text) {
  return text.replace(/\s+/g, '').trim();
}

function findTextRange(sentence) {
  const normalizedSentence = normalizeForSearch(sentence);
  const searchText = normalizedSentence.substring(0, Math.min(normalizedSentence.length, 30));

  if (!searchText) {
    return null;
  }

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: function(node) {
        // 空のテキストノードやスクリプトタグ内のテキストを除外
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (parent && ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME'].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }
        // 既存のハイライトは除外
        if (parent && parent.classList.contains('voicevox-reader-highlight')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    },
    false
  );

  const positions = [];
  let normalizedDocumentText = '';
  let node;
  while (node = walker.nextNode()) {
    const nodeText = node.textContent || '';
    for (let offset = 0; offset < nodeText.length; offset++) {
      if (/\s/.test(nodeText[offset])) {
        continue;
      }

      normalizedDocumentText += nodeText[offset];
      positions.push({ node, offset });
    }
  }

  const startIndex = normalizedDocumentText.indexOf(searchText);
  if (startIndex === -1) {
    return null;
  }

  const endIndex = Math.min(startIndex + normalizedSentence.length - 1, positions.length - 1);
  return {
    start: positions[startIndex],
    end: positions[endIndex]
  };
}

// 見つかった範囲をハイライト
function highlightRange(rangeInfo) {
  try {
    const range = document.createRange();
    range.setStart(rangeInfo.start.node, rangeInfo.start.offset);
    range.setEnd(rangeInfo.end.node, rangeInfo.end.offset + 1);

    const highlight = document.createElement('span');
    highlight.className = 'voicevox-reader-highlight';
    highlight.id = 'voicevox-reader-current';

    highlight.appendChild(range.extractContents());
    range.insertNode(highlight);
    currentHighlight = highlight;

    // ハイライト位置にスクロール
    highlight.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.log('[VOICEVOX Reader] ハイライト適用成功');
  } catch (e) {
    console.error('[VOICEVOX Reader] ハイライト失敗:', e);
    // フォールバック: 親要素をハイライト
    highlightParent(rangeInfo.start.node);
  }
}

// 親要素をハイライト（フォールバック）
function highlightParent(node) {
  const parent = node.parentElement;
  if (parent && !['HTML', 'BODY', 'SCRIPT', 'STYLE'].includes(parent.tagName)) {
    parent.classList.add('voicevox-reader-highlight-parent');
    currentHighlight = parent;
    parent.scrollIntoView({ behavior: 'smooth', block: 'center' });
    console.log('[VOICEVOX Reader] 親要素ハイライト適用');
  }
}

// ハイライト用spanを解除（中身を元の位置に戻す）
function unwrapHighlightSpan(span) {
  const parent = span.parentNode;
  if (!parent) {
    return;
  }
  // spanの子ノード（リンクや装飾要素・イベントリスナーを含む）をそのまま元の位置へ戻す。
  // textContent で置き換えると内部のマークアップが失われるため使用しない。
  while (span.firstChild) {
    parent.insertBefore(span.firstChild, span);
  }
  parent.removeChild(span);
  parent.normalize();
}

// ハイライトを削除
function removeHighlight() {
  if (currentHighlight) {
    if (currentHighlight.classList.contains('voicevox-reader-highlight-parent')) {
      // 親要素のクラスを削除
      currentHighlight.classList.remove('voicevox-reader-highlight-parent');
    } else {
      unwrapHighlightSpan(currentHighlight);
    }
    currentHighlight = null;
  }

  // 残っているハイライトも解除
  document.querySelectorAll('.voicevox-reader-highlight').forEach(unwrapHighlightSpan);

  document.querySelectorAll('.voicevox-reader-highlight-parent').forEach(el => {
    el.classList.remove('voicevox-reader-highlight-parent');
  });
}

// ステータス変更を通知
function notifyStatusChange() {
  // sendMessage は Promise を返すため、受信側（ポップアップ）が閉じているときの
  // rejection は .catch で無視する必要がある。同期 try/catch では捕捉できない。
  chrome.runtime.sendMessage({
    action: 'statusUpdate',
    isPlaying: isPlaying,
    isPaused: isPaused,
    currentIndex: currentIndex,
    totalSentences: sentences.length
  }).catch(() => {});

  // アイコンの更新
  chrome.runtime.sendMessage({
    action: 'updateIcon',
    isPlaying: isPlaying,
    isPaused: isPaused
  }).catch(() => {});

  // フローティングパネルの更新
  updateFloatingPanelState();
}

// フローティングパネルのトグル
function toggleFloatingPanel(enabled) {
  if (enabled) {
    showFloatingPanel();
  } else {
    hideFloatingPanel();
  }
}

// フローティングパネルを表示
function showFloatingPanel() {
  if (floatingPanel) return;

  // 読み込み途中のページへ注入されると body がまだ無い。
  // ここで throw すると floatingPanel に中途半端な要素が残り、
  // 以後 early return で二度と表示できなくなるため、先に確認する。
  if (!document.body) {
    console.warn('[VOICEVOX Reader] body がないためパネルを表示できません');
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'voicevox-reader-floating-panel';
  panel.innerHTML = `
    <div class="vr-panel-header">
      <span class="vr-panel-title">VOICEVOX Reader</span>
      <span class="vr-panel-actions">
        <span class="vr-panel-status">停止中</span>
        <button class="vr-panel-close" type="button" title="閉じる" aria-label="閉じる">×</button>
      </span>
    </div>
    <div class="vr-panel-controls">
      <button class="vr-btn vr-btn-prev" title="前へ">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z"/>
        </svg>
      </button>
      <button class="vr-btn vr-btn-play" title="再生">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path fill="currentColor" d="M8 5v14l11-7z"/>
        </svg>
      </button>
      <button class="vr-btn vr-btn-pause" title="一時停止" style="display: none;">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <path fill="currentColor" d="M6 4h4v16H6zm8 0h4v16h-4z"/>
        </svg>
      </button>
      <button class="vr-btn vr-btn-stop" title="停止">
        <svg viewBox="0 0 24 24" width="24" height="24">
          <rect fill="currentColor" x="6" y="6" width="12" height="12"/>
        </svg>
      </button>
      <button class="vr-btn vr-btn-next" title="次へ">
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path fill="currentColor" d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/>
        </svg>
      </button>
    </div>
  `;

  document.body.appendChild(panel);
  // 追加に成功してから保持する。失敗した場合に壊れた要素を残さないため
  floatingPanel = panel;

  // イベントリスナーを設定。
  // 設定は readNextSentence が storage から読み直すため、ここでは読み込まない
  panel.querySelector('.vr-btn-play').addEventListener('click', () => {
    if (isPaused) {
      resumeReading();
    } else {
      startReading();
    }
  });

  panel.querySelector('.vr-btn-pause').addEventListener('click', pauseReading);
  panel.querySelector('.vr-btn-stop').addEventListener('click', stopReading);
  panel.querySelector('.vr-btn-prev').addEventListener('click', skipToPrevious);
  panel.querySelector('.vr-btn-next').addEventListener('click', skipToNext);

  panel.querySelector('.vr-panel-close').addEventListener('click', () => {
    hideFloatingPanel();
    // 次にページを開いたときに復活しないよう、設定にも反映する
    chrome.storage.local.set({ floatingPanelEnabled: false });
  });

  // ドラッグ機能
  makeDraggable(panel);

  // 再生中に表示した場合も含め、現在の状態をボタンへ反映する
  updateFloatingPanelState();

  console.log('[VOICEVOX Reader] フローティングパネル表示');
}

// フローティングパネルを非表示
function hideFloatingPanel() {
  if (floatingPanel) {
    // ドラッグ用に document へ登録したリスナーを解放し、リークを防ぐ
    if (floatingPanelDragCleanup) {
      floatingPanelDragCleanup();
      floatingPanelDragCleanup = null;
    }
    floatingPanel.remove();
    floatingPanel = null;
    console.log('[VOICEVOX Reader] フローティングパネル非表示');
  }
}

// フローティングパネルの状態を更新
function updateFloatingPanelState() {
  if (!floatingPanel) return;

  const statusText = floatingPanel.querySelector('.vr-panel-status');
  const playBtn = floatingPanel.querySelector('.vr-btn-play');
  const pauseBtn = floatingPanel.querySelector('.vr-btn-pause');
  const prevBtn = floatingPanel.querySelector('.vr-btn-prev');
  const nextBtn = floatingPanel.querySelector('.vr-btn-next');

  // 読み上げ中（一時停止を含む）は閉じられないようにする。
  // 読み上げたまま操作手段を失うことを防ぐため。
  floatingPanel.querySelector('.vr-panel-close').disabled = isPlaying;

  if (isPlaying && !isPaused) {
    statusText.textContent = sentences.length > 0 ? `再生中 (${currentIndex + 1}/${sentences.length})` : '再生中';
    playBtn.style.display = 'none';
    pauseBtn.style.display = 'flex';
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= sentences.length - 1;
  } else if (isPaused) {
    statusText.textContent = sentences.length > 0 ? `一時停止 (${currentIndex + 1}/${sentences.length})` : '一時停止';
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    prevBtn.disabled = currentIndex <= 0;
    nextBtn.disabled = currentIndex >= sentences.length - 1;
  } else {
    statusText.textContent = '停止中';
    playBtn.style.display = 'flex';
    pauseBtn.style.display = 'none';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
  }
}

// ドラッグ可能にする
function makeDraggable(element) {
  const header = element.querySelector('.vr-panel-header');
  let isDragging = false;
  let currentX, currentY, initialX, initialY;

  header.style.cursor = 'move';

  const onMouseDown = (e) => {
    // ヘッダー上のボタン（閉じるなど）を押したときはドラッグを始めない
    if (e.target.closest('button')) {
      return;
    }

    isDragging = true;
    initialX = e.clientX - element.offsetLeft;
    initialY = e.clientY - element.offsetTop;
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;

    e.preventDefault();
    currentX = e.clientX - initialX;
    currentY = e.clientY - initialY;

    element.style.left = currentX + 'px';
    element.style.top = currentY + 'px';
    element.style.right = 'auto';
    element.style.bottom = 'auto';
  };

  const onMouseUp = () => {
    isDragging = false;
  };

  header.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // hideFloatingPanel から呼び出して document のリスナーを解放するためのクリーンアップ
  floatingPanelDragCleanup = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

// ページ読み込み時にフローティングパネルの状態を復元
chrome.storage.local.get(['floatingPanelEnabled'], (result) => {
  if (result.floatingPanelEnabled) {
    showFloatingPanel();
  }
});

if (window.__VOICEVOX_READER_ENABLE_TEST_HOOKS__) {
  window.__VOICEVOX_READER_TESTS__ = {
    extractMainContent,
    splitIntoSentences,
    spansMultipleSentences,
    toggleFloatingPanel,
    showFloatingPanel,
    highlightSentence,
    removeHighlight,
    startReading,
    stopReading,
    getState: () => ({
      isPlaying,
      isPaused,
      currentIndex,
      totalSentences: sentences.length,
      sentences: [...sentences],
      speakerId,
      speed,
      volume
    }),
    setSynthesizeSpeechOverride: (fn) => {
      synthesizeSpeechOverride = fn;
    },
    setPlayAudioOverride: (fn) => {
      playAudioOverride = fn;
    }
  };
}

} // 二重注入ガード終わり
