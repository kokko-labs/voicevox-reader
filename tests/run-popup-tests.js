// ポップアップ（src/popup）のテスト。
// 実際の popup.html と popup.js を jsdom 上で動かし、chrome API と
// VOICEVOX への通信だけを差し替える。
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const popupDir = path.join(__dirname, '..', 'src', 'popup');
const popupHtml = readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
const popupJs = readFileSync(path.join(popupDir, 'popup.js'), 'utf8');

const DEFAULT_SPEAKERS = [
  { name: '話者A', styles: [{ id: 2, name: 'ノーマル' }] }
];

// ポップアップを1つ起動する。テストごとに新しい状態から始める。
function openPopup({
  status = { isPlaying: false, isPaused: false },
  voicevoxAvailable = true,
  speakersReachable = true,
  systemVoices = [],
  voicesArriveLate = false,
  storedSettings = { voice: 'voicevox:2', speed: 1, volume: 100 }
} = {}) {
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(popupHtml, { runScripts: 'outside-only', virtualConsole });
  const { window } = dom;

  const sentToTab = [];
  const savedSettings = [];
  let messageListener = null;

  window.chrome = {
    runtime: {
      onMessage: { addListener(fn) { messageListener = fn; } },
      sendMessage: async () => ({ success: true, available: voicevoxAvailable })
    },
    storage: {
      local: {
        get: async () => ({ ...storedSettings }),
        set: async (values) => { savedSettings.push(values); }
      }
    },
    tabs: {
      query: async () => [{ id: 1 }],
      sendMessage: async (tabId, message) => {
        sentToTab.push(message.action);
        // content 側は play に即応答する。この時点ではまだ再生は始まっていない
        return message.action === 'getStatus' ? status : { success: true };
      }
    },
    scripting: { insertCSS: async () => {}, executeScript: async () => {} }
  };

  window.fetch = async () => {
    if (!speakersReachable) {
      throw new Error('failed to fetch');
    }
    return { ok: true, json: async () => DEFAULT_SPEAKERS };
  };

  // 実際のブラウザでは音声の一覧が非同期に用意され、最初の getVoices() は
  // 空で返ることがある。voicesArriveLate でその状況を再現する。
  let availableVoices = voicesArriveLate ? [] : systemVoices;
  const voiceListeners = [];

  window.speechSynthesis = {
    getVoices: () => availableVoices,
    addEventListener: (type, fn) => { if (type === 'voiceschanged') { voiceListeners.push(fn); } }
  };

  const deliverVoices = async () => {
    availableVoices = systemVoices;
    for (const fn of voiceListeners) {
      await fn();
    }
  };

  window.eval(popupJs);

  // 解析中なら jsdom がこの後 DOMContentLoaded を発火するので待つだけでよい。
  // ここで手動でも発火させると初期化が2回走り、実機と違う状態になる。
  if (window.document.readyState !== 'loading') {
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

  return {
    window,
    doc: window.document,
    sentToTab,
    savedSettings,
    click: (id) => window.document.getElementById(id).dispatchEvent(new window.Event('click')),
    // 音声の一覧が遅れて届いた場面を再現する
    deliverVoices,
    // content から状態通知が届いた場面を再現する。
    // fromTabId を変えると、別のタブから届いた場合を再現できる。
    notifyStatus: (state, fromTabId = 1) =>
      messageListener({ action: 'statusUpdate', ...state }, { tab: { id: fromTabId } }, () => {}),
    close: () => window.close()
  };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function assert(condition, message) { if (!condition) { throw new Error(message); } }

test('再生ボタンを押しても状態を問い合わせない', async () => {
  const popup = openPopup();
  await settle();

  popup.sentToTab.length = 0;
  popup.click('playBtn');
  await settle();

  assert(popup.sentToTab.includes('play'), '再生が送られていません');
  assert(!popup.sentToTab.includes('getStatus'),
    'getStatus を送っています。再生開始前の古い状態で表示を上書きしてしまいます');
  popup.close();
});

test('状態通知を受け取ると再生中の操作ができる', async () => {
  const popup = openPopup();
  await settle();

  popup.notifyStatus({ isPlaying: true, isPaused: false, currentIndex: 0, totalSentences: 3 });

  assert(popup.doc.getElementById('stopBtn').disabled === false, '停止ボタンが押せません');
  assert(popup.doc.getElementById('nextBtn').disabled === false, '「次へ」が押せません');
  assert(popup.doc.getElementById('prevBtn').disabled === true, '先頭なのに「前へ」が押せます');
  assert(popup.doc.getElementById('status').textContent.includes('1/3'),
    `読み上げ位置が出ていません: ${popup.doc.getElementById('status').textContent}`);
  popup.close();
});

test('停止中は停止・前へ・次へを押せない', async () => {
  const popup = openPopup();
  await settle();

  popup.notifyStatus({ isPlaying: false, isPaused: false });

  assert(popup.doc.getElementById('stopBtn').disabled === true, '停止中なのに停止ボタンが押せます');
  assert(popup.doc.getElementById('prevBtn').disabled === true, '停止中なのに「前へ」が押せます');
  assert(popup.doc.getElementById('nextBtn').disabled === true, '停止中なのに「次へ」が押せます');
  popup.close();
});

test('一時停止中は再生ボタンに戻る', async () => {
  const popup = openPopup();
  await settle();

  popup.notifyStatus({ isPlaying: true, isPaused: true, currentIndex: 4, totalSentences: 9 });

  assert(popup.doc.getElementById('playBtn').style.display !== 'none', '再生ボタンが出ていません');
  assert(popup.doc.getElementById('pauseBtn').style.display === 'none', '一時停止ボタンが残っています');
  assert(popup.doc.getElementById('status').textContent.includes('5/9'),
    `読み上げ位置が出ていません: ${popup.doc.getElementById('status').textContent}`);
  popup.close();
});

test('VOICEVOX が起動していなければ再生を送らずに知らせる', async () => {
  const popup = openPopup({ voicevoxAvailable: false });
  await settle();

  popup.sentToTab.length = 0;
  popup.click('playBtn');
  await settle();

  assert(!popup.sentToTab.includes('play'), 'VOICEVOX 未起動なのに再生を送っています');
  const error = popup.doc.getElementById('errorMessage');
  assert(error.style.display === 'block', 'エラーが表示されていません');
  assert(error.textContent.includes('起動'), `文言が期待と違います: ${error.textContent}`);
  popup.close();
});

test('OS標準の音声を選んでいれば VOICEVOX の起動を確認しない', async () => {
  // VOICEVOX が起動していなくても、OS標準の音声なら読み上げられる
  const popup = openPopup({
    voicevoxAvailable: false,
    speakersReachable: false,
    systemVoices: [{ voiceURI: 'Microsoft Zira', name: 'Microsoft Zira', lang: 'en-US' }],
    storedSettings: { voice: 'system:Microsoft Zira', speed: 1, volume: 100 }
  });
  await settle();

  popup.sentToTab.length = 0;
  popup.click('playBtn');
  await settle();

  assert(popup.sentToTab.includes('play'),
    'OS標準の音声なのに再生が送られていません');
  popup.close();
});

test('OS標準の音声も読み上げモデルの一覧に並ぶ', async () => {
  const popup = openPopup({
    systemVoices: [{ voiceURI: 'Microsoft Zira', name: 'Microsoft Zira', lang: 'en-US' }]
  });
  await settle();

  const values = Array.from(popup.doc.getElementById('speakerSelect').options).map(o => o.value);
  assert(values.includes('voicevox:2'), `VOICEVOX の声がありません: ${values.join(', ')}`);
  assert(values.includes('system:Microsoft Zira'), `OS標準の声がありません: ${values.join(', ')}`);
  popup.close();
});

test('音声の一覧が遅れて届いても、OS標準の音声が並ぶ', async () => {
  // ブラウザでは最初の getVoices() が空で返ることがある。
  // そこで諦めると「OS標準の音声」の組が出ないままになる。
  const voice = { voiceURI: 'Microsoft Zira', name: 'Microsoft Zira', lang: 'en-US' };
  const popup = openPopup({
    systemVoices: [voice],
    voicesArriveLate: true,
    storedSettings: { voice: 'system:Microsoft Zira', speed: 1, volume: 100 }
  });
  await settle();

  const select = popup.doc.getElementById('speakerSelect');
  const before = Array.from(select.options).map(o => o.value);
  assert(!before.includes('system:Microsoft Zira'), '前提: この時点ではまだ並んでいないはずです');

  await popup.deliverVoices();
  await settle();

  const after = Array.from(select.options).map(o => o.value);
  assert(after.includes('system:Microsoft Zira'), `OS標準の音声が並んでいません: ${after.join(', ')}`);
  assert(select.value === 'system:Microsoft Zira',
    `保存済みの選択が復元されていません: ${select.value}`);
  popup.close();
});

test('音声の一覧が届き直しても選択肢が重複しない', async () => {
  const voice = { voiceURI: 'Microsoft Zira', name: 'Microsoft Zira', lang: 'en-US' };
  const popup = openPopup({ systemVoices: [voice] });
  await settle();

  await popup.deliverVoices();
  await popup.deliverVoices();
  await settle();

  const select = popup.doc.getElementById('speakerSelect');
  const count = Array.from(select.options).filter(o => o.value === 'system:Microsoft Zira').length;
  assert(count === 1, `同じ音声が ${count} 個並んでいます`);
  popup.close();
});

test('OS標準の音声は言語ごとにまとまり、順序が安定する', async () => {
  // ブラウザが返す順は言語が入り混じる。実機で観測した並びに、地域違いを足して渡す。
  const popup = openPopup({
    systemVoices: [
      { voiceURI: 'Ayumi', name: 'Microsoft Ayumi', lang: 'ja-JP' },
      { voiceURI: 'Mark', name: 'Microsoft Mark', lang: 'en-US' },
      { voiceURI: 'Zira', name: 'Microsoft Zira', lang: 'en-US' },
      { voiceURI: 'Hazel', name: 'Microsoft Hazel', lang: 'en-GB' },
      { voiceURI: 'David', name: 'Microsoft David', lang: 'en-US' },
      { voiceURI: 'Haruka', name: 'Microsoft Haruka', lang: 'ja-JP' }
    ]
  });
  await settle();

  const groups = Array.from(popup.doc.querySelectorAll('optgroup[data-system]'));
  assert(groups.length === 2, `言語ごとに分かれていません: ${groups.length} 組`);
  assert(groups[0].label === 'OS 標準 (英語)', `1組目の見出しが違います: ${groups[0].label}`);
  assert(groups[1].label === 'OS 標準 (日本語)', `2組目の見出しが違います: ${groups[1].label}`);

  // en-US と en-GB は地域が違うだけなので同じ組に入る
  const english = Array.from(groups[0].children).map(o => o.textContent);
  assert(english.join(',') === 'Microsoft David,Microsoft Hazel,Microsoft Mark,Microsoft Zira',
    `英語の音声が名前順にまとまっていません: ${english.join(', ')}`);
  popup.close();
});

test('話者一覧を取得できないときは話者IDを保存しない', async () => {
  // 一覧が空のまま保存すると、選択済みの話者IDを空で上書きしてしまう
  const popup = openPopup({ speakersReachable: false });
  await settle();

  popup.savedSettings.length = 0;
  popup.click('playBtn');
  await settle();

  const saved = popup.savedSettings.find(s => 'speakerId' in s);
  assert(!saved, `話者IDを保存しています: ${JSON.stringify(saved)}`);
  popup.close();
});

test('別のタブの状態通知で表示が上書きされない', async () => {
  // 読み上げ開始時に他タブを停止させるため、他タブから「停止した」という
  // 通知が届く。これを取り込むと、再生中なのに停止中の表示になってしまう。
  const popup = openPopup();
  await settle();

  popup.notifyStatus({ isPlaying: true, isPaused: false, currentIndex: 0, totalSentences: 5 }, 1);
  assert(popup.doc.getElementById('stopBtn').disabled === false, '前提: 再生中の表示になっていません');

  popup.notifyStatus({ isPlaying: false, isPaused: false }, 99);

  assert(popup.doc.getElementById('stopBtn').disabled === false,
    '別タブの通知で停止中の表示に変わっています');
  assert(popup.doc.getElementById('nextBtn').disabled === false,
    '別タブの通知で「次へ」が押せなくなっています');
  popup.close();
});

test('表示ボタンはパネルの表示だけを指示する', async () => {
  const popup = openPopup();
  await settle();

  popup.sentToTab.length = 0;
  popup.click('showPanelBtn');
  await settle();

  assert(popup.sentToTab.includes('showFloatingPanel'), 'パネルの表示を指示していません');
  assert(popup.savedSettings.length === 0,
    '表示状態を保存しています。ボタンは動作であって設定ではありません');
  popup.close();
});

(async () => {
  const lines = [];

  for (const item of tests) {
    try {
      await item.fn();
      lines.push(`PASS ${item.name}`);
    } catch (error) {
      lines.push(`FAIL ${item.name}: ${error.message}`);
    }
  }

  const failed = lines.some(line => line.startsWith('FAIL'));
  console.log(`${failed ? 'FAIL' : 'PASS'}\n${lines.join('\n')}`);
  process.exit(failed ? 1 : 0);
})();
