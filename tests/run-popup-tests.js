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
  storedSettings = { speakerId: 2, speed: 1, volume: 100 }
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

  window.eval(popupJs);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return {
    window,
    doc: window.document,
    sentToTab,
    savedSettings,
    click: (id) => window.document.getElementById(id).dispatchEvent(new window.Event('click')),
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
