/**
 * app.js — UI logic for the Japanese Flowchart Description Tool
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */
/** PNG エクスポート時の解像度倍率（Retina ディスプレイ対応） */
const PNG_EXPORT_SCALE = 2;
/** PDF エクスポート時の解像度倍率（文字化け回避のため画像化） */
const PDF_EXPORT_SCALE = 2;
/* ------------------------------------------------------------------ */
const SAMPLE = `# 受注処理システム のフローチャートサンプル
フロー: 受注処理システム

[start]    端子: 開始
[recv]     処理: 注文受付
[validate] 判断: 入力チェックOK？
[error]    処理: エラー通知
[stock]    判断: 在庫あり？
[no_stock] 処理: 在庫切れ通知
[prepare]  処理: 発送準備
[ship]     処理: 商品発送
[end]      端子: 終了

start    --> recv
recv     --> validate
validate --> stock    : はい
validate --> error    : いいえ
error    --> recv
stock    --> prepare  : はい
stock    --> no_stock : いいえ
prepare  --> ship
ship     --> end
no_stock --> end`;

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
function $(id) { return document.getElementById(id); }

let _debounce = null;
function scheduleRender() {
  clearTimeout(_debounce);
  _debounce = setTimeout(doRender, 400);
}

/* ------------------------------------------------------------------ */
/* Core render cycle                                                    */
/* ------------------------------------------------------------------ */
function doRender() {
  const input   = $('editor').value;
  const errDiv  = $('errors');
  const preview = $('preview');

  try {
    const { ast, svg } = JFCD.compile(input);

    /* エラー表示 */
    if (ast.errors.length) {
      errDiv.textContent = ast.errors
        .map(e => (e.line ? `行${e.line}: ` : '') + e.message)
        .join('  |  ');
      errDiv.className = 'errors errors--warn';
    } else {
      errDiv.textContent = '';
      errDiv.className = 'errors';
    }

    /* プレビュー更新 */
    preview.innerHTML = svg;
  } catch (err) {
    errDiv.textContent = `予期しないエラー: ${err.message}`;
    errDiv.className = 'errors errors--error';
    console.error(err);
  }
}

/* ------------------------------------------------------------------ */
/* Export SVG                                                           */
/* ------------------------------------------------------------------ */
function exportSVG() {
  const svgEl = document.querySelector('#preview svg');
  if (!svgEl) { alert('まず描画してください。'); return; }

  const blob = new Blob([svgEl.outerHTML], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: 'flowchart.svg' });
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Export PNG                                                           */
/* ------------------------------------------------------------------ */
function exportPNG() {
  const svgEl = document.querySelector('#preview svg');
  if (!svgEl) { alert('まず描画してください。'); return; }

  const SCALE  = PNG_EXPORT_SCALE;
  const vb     = svgEl.viewBox.baseVal;
  const canvas = Object.assign(document.createElement('canvas'), {
    width:  vb.width  * SCALE,
    height: vb.height * SCALE,
  });
  const ctx = canvas.getContext('2d');
  ctx.scale(SCALE, SCALE);

  const xml  = new XMLSerializer().serializeToString(svgEl);
  const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const img  = new Image();

  img.onload = () => {
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    const a = Object.assign(document.createElement('a'), {
      download: 'flowchart.png',
      href:     canvas.toDataURL('image/png'),
    });
    a.click();
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    alert('PNG への変換に失敗しました。SVG での保存をお試しください。');
  };
  img.src = url;
}

/* ------------------------------------------------------------------ */
/* Export PDF                                                           */
/* ------------------------------------------------------------------ */
async function exportPDF() {
  const svgEl = document.querySelector('#preview svg');
  if (!svgEl) { alert('まず描画してください。'); return; }

  const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
  if (typeof jsPDFCtor !== 'function') {
    alert('PDF 変換ライブラリの読み込みに失敗しました。vendor/jspdf.umd.min.js が配置されているか確認してください。');
    return;
  }

  const vb = svgEl.viewBox.baseVal;
  const width = vb && vb.width ? vb.width : svgEl.getBoundingClientRect().width;
  const height = vb && vb.height ? vb.height : svgEl.getBoundingClientRect().height;
  const orientation = width >= height ? 'landscape' : 'portrait';
  const pdf = new jsPDFCtor({ orientation, unit: 'pt', format: [width, height], compress: true });

  try {
    const scale = PDF_EXPORT_SCALE;
    const canvas = Object.assign(document.createElement('canvas'), {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    });
    const ctx = canvas.getContext('2d');

    /* JPEG変換時の背景黒化を防ぐため白で塗りつぶし */
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.scale(scale, scale);

    const xml = new XMLSerializer().serializeToString(svgEl);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    await new Promise((resolve, reject) => {
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, width, height);
          resolve();
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('SVG image decode failed'));
      };
      img.src = url;
    });

    pdf.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, width, height);
    pdf.save('flowchart.pdf');
  } catch (err) {
    console.error(err);
    alert('PDF への変換に失敗しました。SVG での保存をお試しください。');
  }
}

/* ------------------------------------------------------------------ */
/* Keyboard shortcut helper (Tab → spaces)                             */
/* ------------------------------------------------------------------ */
function handleEditorKey(e) {
  if (e.ctrlKey && e.key === 'Enter') {
    e.preventDefault();
    doRender();
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    const ta    = e.target;
    const start = ta.selectionStart;
    const end   = ta.selectionEnd;
    ta.value = ta.value.slice(0, start) + '  ' + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 2;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                 */
/* ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', () => {
  const editor = $('editor');

  $('btnGitHub').addEventListener('click', () => {
    window.open('https://github.com/mendoitarou/Flowchart-Draw-Tool');
  });

  $('btnSample').addEventListener('click', () => {
    editor.value = SAMPLE;
    doRender();
  });

  $('btnRender').addEventListener('click', doRender);
  $('btnExportSvg').addEventListener('click', exportSVG);
  $('btnExportPng').addEventListener('click', exportPNG);
  $('btnExportPdf').addEventListener('click', exportPDF);

  editor.addEventListener('input',   scheduleRender);
  editor.addEventListener('keydown', handleEditorKey);

  /* 初期サンプルを読み込んで描画 */
  editor.value = SAMPLE;
  doRender();
});
