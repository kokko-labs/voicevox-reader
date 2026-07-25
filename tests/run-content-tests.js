const { readFileSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const testHtmlPath = path.join(__dirname, 'content-test.html');
const html = readFileSync(testHtmlPath, 'utf8');
const virtualConsole = new VirtualConsole();

virtualConsole.on('error', message => console.error(message));
virtualConsole.on('warn', message => console.warn(message));

const dom = new JSDOM(html, {
  url: pathToFileURL(testHtmlPath).href,
  resources: 'usable',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole
});

dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};

const timeout = setTimeout(() => {
  console.error('FAIL\nTimed out waiting for browser tests');
  dom.window.close();
  process.exit(1);
}, 10000);

function finish() {
  const status = dom.window.document.documentElement.dataset.testStatus;
  if (!status) {
    setTimeout(finish, 50);
    return;
  }

  clearTimeout(timeout);
  const output = dom.window.document.getElementById('result').textContent;
  console.log(output);
  dom.window.close();
  process.exit(status === 'pass' ? 0 : 1);
}

finish();