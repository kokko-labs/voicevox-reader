// 配布用の dist/ を作る。
// Chrome は読み込んだフォルダの中身を丸ごと拡張機能に含めるため、
// node_modules や tests が混ざらないよう、必要なファイルだけを明示的に集める。
//
//   npm run build     dist/ を作る
//   npm run package   dist/ を作り、ウェブストア用の zip まで作る

const { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync, unlinkSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const projectDir = path.join(__dirname, '..');
const distDir = path.join(projectDir, 'dist');

// 配布物に含めるもの。除外ではなく列挙で書く（追加物が意図せず紛れ込まないようにするため）
const INCLUDES = [
  { source: 'manifest.json' },
  { source: 'src', accepts: name => /\.(js|css|html)$/.test(name) },
  // アイコンは png のみ。svg は編集用の原本で、拡張機能からは参照していない
  { source: 'icons', accepts: name => name.endsWith('.png') }
];

// manifest には現れないが動作に必要なファイル。
// content script は常時注入をやめたため、popup から chrome.scripting で注入している。
const DYNAMICALLY_INJECTED = [
  'src/content/content.js',
  'src/content/content.css'
];

function collectFiles(relativePath, accepts) {
  const absolutePath = path.join(projectDir, relativePath);

  if (!existsSync(absolutePath)) {
    throw new Error(`${relativePath} が見つかりません`);
  }

  if (!statSync(absolutePath).isDirectory()) {
    return [relativePath];
  }

  return readdirSync(absolutePath).flatMap(name => {
    const childPath = path.posix.join(relativePath.split(path.sep).join('/'), name);
    const childAbsolute = path.join(projectDir, childPath);

    if (statSync(childAbsolute).isDirectory()) {
      return collectFiles(childPath, accepts);
    }

    return accepts && !accepts(name) ? [] : [childPath];
  });
}

function copyInto(distPath, relativePath) {
  const destination = path.join(distPath, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  copyFileSync(path.join(projectDir, relativePath), destination);
}

// manifest が参照するパスを集める。
// 綴りを間違えたまま公開すると、インストールしてはじめて壊れていることに気付くため、
// ビルドの時点で実在を確かめる。
function collectManifestPaths(manifest) {
  const paths = [];

  if (manifest.background?.service_worker) {
    paths.push(manifest.background.service_worker);
  }

  if (manifest.action?.default_popup) {
    paths.push(manifest.action.default_popup);
  }

  paths.push(...Object.values(manifest.action?.default_icon ?? {}));
  paths.push(...Object.values(manifest.icons ?? {}));

  for (const entry of manifest.content_scripts ?? []) {
    paths.push(...(entry.js ?? []), ...(entry.css ?? []));
  }

  return [...new Set(paths)];
}

function createZip(zipPath) {
  if (existsSync(zipPath)) {
    unlinkSync(zipPath);
  }

  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path '${distDir}\\*' -DestinationPath '${zipPath}'`
    ], { stdio: 'inherit' });
  } else {
    // zip はカレントディレクトリからの相対パスで格納するため dist/ の中で実行する
    execFileSync('zip', ['-r', zipPath, '.'], { cwd: distDir, stdio: 'inherit' });
  }
}

function formatSize(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function build() {
  const manifest = JSON.parse(readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));

  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  const copied = INCLUDES.flatMap(include => collectFiles(include.source, include.accepts));
  for (const relativePath of copied) {
    copyInto(distDir, relativePath);
  }

  const required = [...new Set([...collectManifestPaths(manifest), ...DYNAMICALLY_INJECTED])];
  const missing = required.filter(relativePath => !existsSync(path.join(distDir, relativePath)));

  if (missing.length > 0) {
    throw new Error(`配布物に必要なファイルが含まれていません:\n  ${missing.join('\n  ')}`);
  }

  let totalBytes = 0;
  console.log(`dist/ を作成しました (${manifest.name} ${manifest.version})`);
  for (const relativePath of copied.sort()) {
    const size = statSync(path.join(distDir, relativePath)).size;
    totalBytes += size;
    console.log(`  ${relativePath.padEnd(28)} ${formatSize(size).padStart(10)}`);
  }
  console.log(`  ${'合計'.padEnd(27)} ${formatSize(totalBytes).padStart(10)} / ${copied.length} ファイル`);
  console.log(`参照チェック: ${required.length} 件のパスがすべて存在します`);

  if (process.argv.includes('--zip')) {
    const zipPath = path.join(projectDir, `${manifest.name.replace(/\s+/g, '-').toLowerCase()}-${manifest.version}.zip`);
    createZip(zipPath);
    console.log(`zip を作成しました: ${path.basename(zipPath)} (${formatSize(statSync(zipPath).size)})`);
  }
}

try {
  build();
} catch (error) {
  console.error(`ビルドに失敗しました: ${error.message}`);
  process.exit(1);
}
