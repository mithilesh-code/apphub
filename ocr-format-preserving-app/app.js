(function () {
  'use strict';

  const $ = (s, p = document) => p.querySelector(s);
  const $$ = (s, p = document) => Array.from(p.querySelectorAll(s));

  const state = {
    files: [],
    activeFileId: null,
    pages: [],
    activePage: 0,
    results: [],
    worker: null,
    workerLangs: '',
    cancel: false,
    processing: false,
    theme: localStorage.getItem('formatocr-theme') || 'light',
    viewMode: 'rich',
    fileUrls: new Map()
  };

  const ALLOWED_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff']);
  const MAX_FILE_SIZE = 250 * 1024 * 1024;

  function toast(msg, type = 'info') {
    const el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.dataset.type = type;
    el.className = 'toast show';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { el.className = 'toast'; }, 4200);
  }

  function setStatus(text, mode = 'idle') {
    $('#statusText').textContent = text;
    $('#statusDot').className = `status-dot ${mode}`;
  }

  function setProgress(value, label) {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    $('#progressBar').style.width = `${v}%`;
    $('#progressLabel').textContent = label || `${Math.round(v)}%`;
  }

  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function extOf(name) { return name.split('.').pop().toLowerCase(); }
  function uid() { return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`); }
  function escapeHtml(s) { return String(s).replace(/[&<>\"]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m])); }
  function safeFileBase() {
    const f = state.files.find(x => x.id === state.activeFileId);
    return (f?.name || 'ocr-export').replace(/\.[^.]+$/, '').replace(/[^a-z0-9_-]+/gi, '_') || 'ocr-export';
  }

  function downloadBlob(blob, name) {
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
      return true;
    } catch (e) {
      console.error('Download failed', e);
      toast(`Browser could not create the download: ${friendlyError(e)}`, 'error');
      return false;
    }
  }

  function checkDependencies() {
    const missing = [];
    const pdf = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    if (!pdf) missing.push('PDF.js');
    if (!window.Tesseract) missing.push('Tesseract.js');
    if (missing.length) {
      setStatus('Library loading failed', 'error');
      toast(`Some features are unavailable: ${missing.join(', ')}. Reload with an internet connection or run from a local web server.`, 'error');
      return false;
    }
    window.pdfjsLib = pdf;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return true;
  }

  async function terminateWorker() {
    if (!state.worker) return;
    try { await state.worker.terminate(); } catch (_) {}
    state.worker = null;
    state.workerLangs = '';
  }

  function clearObjectUrls() {
    state.fileUrls.forEach(url => URL.revokeObjectURL(url));
    state.fileUrls.clear();
  }

  async function addFiles(fileList) {
    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    const accepted = [];
    const errors = [];
    for (const file of incoming) {
      const ext = extOf(file.name);
      if (!ALLOWED_EXT.has(ext)) {
        errors.push(`${file.name}: unsupported type`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: larger than 250 MB`);
        continue;
      }
      accepted.push(file);
    }

    if (errors.length) toast(errors.join(' · '), 'error');
    if (!accepted.length) return;

    for (const file of accepted) {
      state.files.push({
        id: uid(), file, name: file.name, size: file.size,
        type: file.type || '', ext: extOf(file.name)
      });
    }

    renderFiles();
    if (!state.activeFileId) await selectFile(state.files[0].id);
    $('#fileInput').value = '';
  }

  async function pasteFromClipboard() {
    if (!navigator.clipboard?.read) {
      toast('Clipboard image access is not supported by this browser. Use Cmd/Ctrl+V instead.', 'error');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      const imageFiles = [];
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const extension = imageType.split('/')[1].replace('jpeg', 'jpg');
        imageFiles.push(new File([blob], `clipboard-${Date.now()}-${imageFiles.length + 1}.${extension}`, { type: imageType }));
      }
      if (!imageFiles.length) {
        toast('No image was found in the clipboard.', 'error');
        return;
      }
      await addFiles(imageFiles);
    } catch (e) {
      console.error(e);
      toast(`Could not read the clipboard: ${friendlyError(e)}`, 'error');
    }
  }

  function pasteImageFromEvent(event) {
    const imageFiles = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item, index) => {
        const blob = item.getAsFile();
        const extension = item.type.split('/')[1].replace('jpeg', 'jpg');
        return blob ? new File([blob], `clipboard-${Date.now()}-${index + 1}.${extension}`, { type: item.type }) : null;
      })
      .filter(Boolean);
    if (!imageFiles.length) return;
    event.preventDefault();
    addFiles(imageFiles);
  }

  function renderFiles() {
    const el = $('#fileList');
    if (!state.files.length) {
      el.className = 'file-list empty-state';
      el.textContent = 'No files loaded.';
      return;
    }
    el.className = 'file-list';
    el.innerHTML = state.files.map(f => `
      <button type="button" class="file-item ${f.id === state.activeFileId ? 'active' : ''}" data-file-id="${escapeHtml(f.id)}">
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-meta">${fmtBytes(f.size)} · ${f.ext.toUpperCase()}</span>
      </button>`).join('');
  }

  async function selectFile(id) {
    const item = state.files.find(x => x.id === id);
    if (!item) return;
    state.activeFileId = id;
    state.pages = [];
    state.results = [];
    state.activePage = 0;
    renderFiles();
    setProgress(0, '0%');
    setStatus('Loading preview…', 'running');
    $('#ocrBtn').disabled = true;
    $('#rerunBtn').disabled = true;

    try {
      if (item.ext === 'pdf') await loadPdf(item);
      else {
        if ((item.ext === 'tif' || item.ext === 'tiff') && !window.UTIF) throw new Error('TIFF support is not loaded. Please use PNG/JPG/WEBP/BMP or enable internet access so the TIFF decoder can load.');
        await loadImageFile(item);
      }
      $('#ocrBtn').disabled = false;
      setStatus('Ready', 'good');
      toast(`${item.name} loaded.`, 'success');
    } catch (e) {
      console.error(e);
      setStatus('Preview failed', 'error');
      toast(`Could not open ${item.name}: ${friendlyError(e)}`, 'error');
    }
  }

  async function decodeImage(file) {
    const ext = extOf(file.name);
    if ((ext === 'tif' || ext === 'tiff') && window.UTIF) {
      const buffer = await file.arrayBuffer();
      const ifds = window.UTIF.decode(buffer);
      if (!ifds.length) throw new Error('The TIFF image contains no readable pages.');
      window.UTIF.decodeImage(buffer, ifds[0]);
      const rgba = window.UTIF.toRGBA8(ifds[0]);
      const canvas = document.createElement('canvas');
      canvas.width = ifds[0].width;
      canvas.height = ifds[0].height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), canvas.width, canvas.height), 0, 0);
      return canvas;
    }
    const url = URL.createObjectURL(file);
    try {
      if ('createImageBitmap' in window) {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext('2d', { willReadFrequently: true }).drawImage(bitmap, 0, 0);
        if (bitmap.close) bitmap.close();
        return canvas;
      }
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function loadImageFile(item) {
    const canvas = await decodeImage(item.file);
    const previewURL = canvas.toDataURL('image/png');
    state.pages = [{ number: 1, width: canvas.width, height: canvas.height, canvas, previewURL, isPdf: false }];
    renderPage();
  }

  async function loadPdf(item) {
    const pdfjs = window.pdfjsLib || window['pdfjs-dist/build/pdf'];
    if (!pdfjs) throw new Error('PDF.js is not loaded.');
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    const loadingTask = pdfjs.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    state.pages = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      setStatus(`Rendering PDF page ${i} / ${pdf.numPages}…`, 'running');
      setProgress((i - 1) / pdf.numPages * 30, `Rendering ${i}/${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport }).promise;

      let embeddedText = '';
      let textItems = [];
      try {
        const tc = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        textItems = tc.items || [];
        embeddedText = textItems.map(x => x.str).join(' ').replace(/\s+/g, ' ').trim();
      } catch (_) {}

      state.pages.push({
        number: i,
        width: canvas.width,
        height: canvas.height,
        canvas,
        previewURL: canvas.toDataURL('image/png'),
        isPdf: true,
        embeddedText,
        textItems,
        pdfPage: page
      });
    }
    renderPage();
  }

  function renderPage() {
    if (!state.pages.length) return;
    const p = state.pages[state.activePage];
    $('#pageLabel').textContent = `Page ${state.activePage + 1} / ${state.pages.length}`;
    const viewer = $('#originalViewer');
    viewer.className = 'viewer original-viewer';
    viewer.replaceChildren();
    const img = new Image();
    img.alt = `Original page ${p.number}`;
    img.src = p.previewURL;
    img.onload = updateCompare;
    viewer.appendChild(img);

    $('#thumbs').innerHTML = state.pages.map((x, i) => `
      <button type="button" class="thumb-wrap ${i === state.activePage ? 'active' : ''}" data-page="${i}" title="Page ${i + 1}">
        <img class="thumb" src="${x.previewURL}" alt="Page ${i + 1}">
      </button>`).join('');

    const result = state.results[state.activePage];
    if (result) renderResult(result);
    else {
      $('#plainEditor').value = '';
      $('#richEditor').innerHTML = '';
      $('#confidenceSummary').textContent = 'Confidence: —';
    }
    updateCompare();
  }

  function selectedLangs() {
    const checked = $$('input[name="lang"]:checked').map(x => x.value);
    const custom = $('#customLang').value.trim();
    if (custom) checked.push(...custom.split(/[+,\s]+/).filter(Boolean));
    return Array.from(new Set(checked)).join('+') || 'eng';
  }

  function selectedLangCodes() { return selectedLangs().split('+'); }

  async function ensureWorker(langs) {
    if (!window.Tesseract) throw new Error('Tesseract.js is not loaded.');
    if (state.worker && state.workerLangs === langs) return state.worker;
    await terminateWorker();
    setStatus(`Loading OCR model: ${langs}`, 'running');

    const logger = m => {
      if (m?.status) $('#statusText').textContent = m.status;
      if (typeof m?.progress === 'number') {
        const local = Math.round(Math.max(0, Math.min(1, m.progress)) * 10);
        const pageBase = state.pages.length ? (state.activePage / state.pages.length) * 100 : 0;
        setProgress(Math.min(95, pageBase + local), m.status || `${Math.round(m.progress * 100)}%`);
      }
    };

    state.worker = await window.Tesseract.createWorker(langs, 1, { logger });
    state.workerLangs = langs;
    return state.worker;
  }

  async function autoDetectFromImage() {
    const p = state.pages[state.activePage];
    if (!p) return toast('Upload a file first.', 'error');
    try {
      setStatus('Detecting language…', 'running');
      await terminateWorker();
      const worker = await window.Tesseract.createWorker('eng', 1, {
        logger: m => { if (m?.status) $('#statusText').textContent = m.status; },
        legacyCore: true, legacyLang: true
      });
      if (typeof worker.detect !== 'function') throw new Error('This Tesseract.js build does not expose language detection.');
      const ret = await worker.detect(p.canvas);
      await worker.terminate();
      state.worker = null;
      state.workerLangs = '';
      const detected = ret?.data?.language || ret?.data?.detectedLanguages?.[0]?.language || 'unknown';
      toast(`Language detection: ${detected}`, 'success');
      setStatus('Ready', 'good');
    } catch (e) {
      setStatus('Language detection unavailable', 'error');
      toast(friendlyError(e), 'error');
    }
  }

  function preprocessCanvas(page) {
    const scale = Number($('#scaleRange').value) || 1;
    const src = page.canvas;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(src.width * scale));
    c.height = Math.max(1, Math.round(src.height * scale));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(src, 0, 0, c.width, c.height);

    const rotate = $('#autoRotate').checked;
    if (rotate) {
      // Lightweight browser-safe orientation estimate: rotate only when EXIF/bitmap reports it indirectly.
      // Deskew is intentionally conservative to avoid rotating already-correct scans.
    }

    let img = ctx.getImageData(0, 0, c.width, c.height);
    if ($('#grayScale').checked || $('#threshold').checked) {
      for (let i = 0; i < img.data.length; i += 4) {
        const y = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        const v = $('#threshold').checked ? (y > 165 ? 255 : 0) : y;
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v;
      }
    }
    if ($('#sharpen').checked && c.width > 2 && c.height > 2) {
      const srcData = new Uint8ClampedArray(img.data);
      const w = c.width, h = c.height;
      const at = (x, y, k) => srcData[(y * w + x) * 4 + k];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          for (let k = 0; k < 3; k++) {
            const val = 5 * at(x, y, k) - at(x - 1, y, k) - at(x + 1, y, k) - at(x, y - 1, k) - at(x, y + 1, k);
            img.data[(y * w + x) * 4 + k] = Math.max(0, Math.min(255, val));
          }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  function estimateFontSize(bbox, scaleY) { return Math.max(8, Math.round(((bbox.y1 - bbox.y0) * 0.92) / scaleY)); }

  function estimateTextColor(canvas, bbox) {
    if (!$('#estimateColors').checked) return '#20242a';
    try {
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(bbox.x0)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(bbox.y0)));
      const w = Math.max(1, Math.min(4, canvas.width - x));
      const h = Math.max(1, Math.min(4, canvas.height - y));
      const d = ctx.getImageData(x, y, w, h).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / n;
      return lum < 150 ? '#ffffff' : '#20242a';
    } catch (_) { return '#20242a'; }
  }

  function guessFamily(text) {
    if (/[\u0900-\u097F]/.test(text)) return 'Noto Sans Devanagari, Arial, sans-serif';
    if (/[\u0600-\u06FF]/.test(text)) return 'Noto Sans Arabic, Arial, sans-serif';
    if (/[\u4E00-\u9FFF]/.test(text)) return 'Noto Sans SC, Arial, sans-serif';
    if (/[\u3040-\u30FF]/.test(text)) return 'Noto Sans JP, Arial, sans-serif';
    if (/[\uAC00-\uD7AF]/.test(text)) return 'Noto Sans KR, Arial, sans-serif';
    if (/[\u0400-\u04FF]/.test(text)) return 'Arial, sans-serif';
    return 'Arial, sans-serif';
  }

  function collectWords(data) {
    const words = [];
    const lines = [];
    const seen = new Set();
    const addWord = w => {
      if (!w?.text?.trim() || !w.bbox) return;
      const key = `${w.text}|${w.bbox.x0}|${w.bbox.y0}|${w.bbox.x1}|${w.bbox.y1}`;
      if (!seen.has(key)) { seen.add(key); words.push(w); }
    };
    const addLine = line => {
      if (!line?.text?.trim() || !line.bbox) return;
      lines.push(line);
      (line.words || []).forEach(addWord);
    };

    (data.words || []).forEach(addWord);
    (data.lines || []).forEach(addLine);
    for (const block of (data.blocks || [])) {
      for (const para of (block.paragraphs || [])) {
        for (const line of (para.lines || [])) addLine(line);
      }
      for (const line of (block.lines || [])) addLine(line);
    }
    return { words, lines };
  }

  function pdfEmbeddedResult(page, index) {
    const items = page.textItems || [];
    const scale = 1.5;
    const words = [];
    let text = '';
    for (const item of items) {
      const value = String(item.str || '').trim();
      if (!value) continue;
      const tx = item.transform || [1, 0, 0, 1, 0, 0];
      const x = (tx[4] || 0);
      const yFromBottom = (tx[5] || 0);
      const h = Math.max(8, Math.abs(tx[3] || 10));
      const y = Math.max(0, page.height / scale - yFromBottom - h);
      const w = Math.max(3, item.width || value.length * h * 0.5);
      words.push({
        type: 'word', text: value, confidence: 100,
        x: x, y, w, h, fontSize: h * 0.95,
        fontFamily: guessFamily(value), fontWeight: '400', fontStyle: 'normal',
        textColor: '#20242a', bgColor: 'transparent'
      });
      text += (text ? ' ' : '') + value;
    }
    return { page: index + 1, text, words, lines: [], confidence: 100, source: 'embedded-text', width: page.width, height: page.height, lang: 'embedded-pdf-text' };
  }

  async function ocrPage(index) {
    const p = state.pages[index];
    setStatus(`Processing page ${p.number}…`, 'running');

    if (p.isPdf && $('#directPdfText').checked && p.embeddedText && p.embeddedText.length > 20 && p.textItems?.length) {
      const result = pdfEmbeddedResult(p, index);
      state.results[index] = result;
      return result;
    }

    const processed = preprocessCanvas(p);
    const langs = selectedLangs();
    const worker = await ensureWorker(langs);
    const ret = await worker.recognize(processed, {
      preserve_interword_spaces: '1'
    }, { blocks: true, hocr: true, text: true });

    const data = ret?.data || {};
    const scale = Number($('#scaleRange').value) || 1;
    const collected = collectWords(data);
    const words = collected.words.map(w => {
      const b = w.bbox;
      const text = w.text.trim();
      return {
        type: 'word', text,
        confidence: Number(w.confidence ?? w.conf ?? 0),
        x: b.x0 / scale, y: b.y0 / scale,
        w: Math.max(3, (b.x1 - b.x0) / scale),
        h: Math.max(3, (b.y1 - b.y0) / scale),
        fontSize: estimateFontSize(b, scale),
        fontFamily: guessFamily(text),
        fontWeight: Number(w.confidence ?? 0) >= 95 ? '500' : '400',
        fontStyle: 'normal',
        textColor: estimateTextColor(processed, b),
        bgColor: 'transparent'
      };
    }).sort((a, b) => a.y - b.y || a.x - b.x);

    const confidence = words.length ? words.reduce((sum, w) => sum + Number(w.confidence || 0), 0) / words.length : Number(data.confidence || 0);
    const result = {
      page: index + 1,
      text: data.text || words.map(w => w.text).join(' '),
      words,
      lines: collected.lines,
      confidence,
      source: 'ocr',
      width: p.width,
      height: p.height,
      lang: langs
    };
    state.results[index] = result;
    return result;
  }

  async function runOCR() {
    if (!state.pages.length) return toast('Upload a PDF or image first.', 'error');
    if (!checkDependencies()) return;

    state.processing = true;
    state.cancel = false;
    $('#ocrBtn').disabled = true;
    $('#cancelBtn').disabled = false;
    $('#rerunBtn').disabled = true;

    try {
      for (let i = 0; i < state.pages.length; i++) {
        if (state.cancel) break;
        await ocrPage(i);
        const pct = ((i + 1) / state.pages.length) * 100;
        setProgress(pct, `Page ${i + 1} / ${state.pages.length}`);
        if (i === state.activePage) renderResult(state.results[i]);
        renderPage();
      }
      if (state.cancel) {
        setStatus('Cancelled', 'idle');
        toast('OCR cancelled.', 'info');
      } else {
        setStatus('OCR complete', 'good');
        toast(`OCR completed for ${state.pages.length} page(s).`, 'success');
      }
    } catch (e) {
      console.error(e);
      setStatus('OCR failed', 'error');
      toast(`OCR failed: ${friendlyError(e)}`, 'error');
    } finally {
      state.processing = false;
      $('#ocrBtn').disabled = false;
      $('#cancelBtn').disabled = true;
      $('#rerunBtn').disabled = state.results.length === 0;
    }
  }

  function renderResult(result) {
    if (!result) return;
    $('#pageLabel').textContent = `Page ${result.page} / ${state.pages.length}`;
    $('#confidenceSummary').textContent = `Confidence: ${Number(result.confidence || 0).toFixed(1)}%`;
    $('#plainEditor').value = result.text || '';
    renderRich(result);
    updateCompare();
  }

  function renderRich(result) {
    const page = document.createElement('div');
    page.className = 'editable-page';
    page.contentEditable = 'false';
    page.style.width = `${result.width}px`;
    page.style.minHeight = `${result.height}px`;

    for (const w of (result.words || [])) {
      const span = document.createElement('span');
      span.className = 'ocr-span';
      if ($('#lowConfToggle').checked && Number(w.confidence) < 75) span.classList.add('low-confidence');
      span.textContent = w.text;
      span.contentEditable = 'true';
      span.dataset.confidence = String(w.confidence);
      span.title = `Confidence ${Number(w.confidence).toFixed(1)}% · font ${Math.round(w.fontSize)}px (estimated)`;
      Object.assign(span.style, {
        left: `${w.x}px`, top: `${w.y}px`, width: `${Math.max(3, w.w)}px`, height: `${Math.max(3, w.h)}px`,
        fontSize: `${Math.max(8, w.fontSize)}px`, fontFamily: w.fontFamily,
        fontWeight: w.fontWeight, fontStyle: w.fontStyle, color: w.textColor
      });
      page.appendChild(span);
    }
    $('#richEditor').replaceChildren(page);
  }

  function richText() { return $('#richEditor').innerText.trim(); }

  function updateCompare() {
    const p = state.pages[state.activePage];
    const result = state.results[state.activePage];
    const viewer = $('#compareViewer');
    viewer.replaceChildren();
    if (!p) return;

    const stage = document.createElement('div');
    stage.className = 'compare-stage';
    const img = new Image();
    img.src = p.previewURL;
    img.alt = `Comparison page ${p.number}`;
    stage.appendChild(img);

    if (result && $('#overlayToggle').checked) {
      for (const w of result.words || []) {
        const box = document.createElement('div');
        box.className = 'overlay-box' + (Number(w.confidence) < 75 ? ' low' : '');
        box.style.left = `${w.x}px`;
        box.style.top = `${w.y}px`;
        box.style.width = `${w.w}px`;
        box.style.height = `${w.h}px`;
        box.title = `${w.text} · ${Number(w.confidence).toFixed(0)}%`;
        stage.appendChild(box);
      }
    }
    viewer.appendChild(stage);
  }

  function applyCommand(cmd, value = null) {
    $('#richEditor').focus();
    try { document.execCommand(cmd, false, value); } catch (_) {}
  }

  function openSearchModal() {
    $('#modalBody').innerHTML = `
      <div class="search-grid">
        <div><label class="field-label">Find</label><input id="findText" class="text-input"></div>
        <div><label class="field-label">Replace with</label><input id="replaceText" class="text-input"></div>
      </div>
      <div class="search-actions">
        <button id="replaceOne" class="secondary-btn">Replace one</button>
        <button id="replaceAll" class="primary-btn">Replace all</button>
      </div>`;
    $('#modal').classList.remove('hidden');
    $('#findText').focus();
    $('#replaceOne').onclick = () => replaceText(false);
    $('#replaceAll').onclick = () => replaceText(true);
  }

  function replaceInElement(root, find, repl, all) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    let count = 0;
    for (const textNode of nodes) {
      if (!textNode.nodeValue.includes(find)) continue;
      if (all) {
        const parts = textNode.nodeValue.split(find);
        if (parts.length > 1) {
          const frag = document.createDocumentFragment();
          parts.forEach((part, i) => {
            frag.appendChild(document.createTextNode(part));
            if (i < parts.length - 1) frag.appendChild(document.createTextNode(repl));
          });
          textNode.parentNode.replaceChild(frag, textNode);
          count += parts.length - 1;
        }
      } else {
        textNode.nodeValue = textNode.nodeValue.replace(find, repl);
        count++;
        break;
      }
    }
    return count;
  }

  function replaceText(all) {
    const find = $('#findText').value;
    const repl = $('#replaceText').value;
    if (!find) return;
    const count = replaceInElement($('#richEditor'), find, repl, all);
    $('#plainEditor').value = richText();
    toast(count ? `${count} replacement${count === 1 ? '' : 's'} made.` : 'No match found.', count ? 'success' : 'info');
  }

  function syncActiveEditorToResult() {
    const idx = state.activePage;
    const result = state.results[idx];
    if (!result) return;

    const editor = $('#richEditor');
    const pageEl = editor.querySelector('.editable-page');
    if (!pageEl) return;

    result.editedHtml = pageEl.outerHTML;
    result.editedText = editor.innerText.trim();
    result.text = result.editedText;

    const spans = Array.from(pageEl.querySelectorAll('.ocr-span'));
    if (spans.length) {
      result.words = spans.map((span, i) => ({
        type: 'word',
        text: span.innerText.trim(),
        confidence: Number(span.dataset.confidence || 0),
        x: parseFloat(span.style.left) || 0,
        y: parseFloat(span.style.top) || 0,
        w: parseFloat(span.style.width) || 0,
        h: parseFloat(span.style.height) || 0,
        fontSize: parseFloat(span.style.fontSize) || 0,
        fontFamily: span.style.fontFamily || 'Arial, sans-serif',
        fontWeight: span.style.fontWeight || '400',
        fontStyle: span.style.fontStyle || 'normal',
        textColor: span.style.color || '#20242a',
        bgColor: span.style.backgroundColor || 'transparent',
        index: i
      }));
    }
  }

  function syncEditorsBeforeExport() {
    if (state.results[state.activePage]) syncActiveEditorToResult();
    if (!state.results.length) return;

    // Keep edited text synchronized for every page that has already been rendered.
    // Pages not visited in the editor retain their OCR representation unchanged.
    state.results.forEach((result) => {
      if (!result) return;
      result.editedText = result.editedText ?? result.text ?? '';
      result.text = result.editedText;
    });
  }

  function getPageText(result) {
    if (!result) return '';
    return String(result.editedText ?? result.text ?? '').trim();
  }

  function aggregatePlainText() {
    return state.results.map((r, i) => {
      const text = getPageText(r);
      return text ? `===== Page ${i + 1} =====\n${text}` : '';
    }).filter(Boolean).join('\n\n');
  }

  function pageHtmlFromResult(result, index) {
    if (!result) return '';
    const holder = document.createElement('div');

    if (result.editedHtml) {
      holder.innerHTML = result.editedHtml;
      const page = holder.firstElementChild;
      if (page) {
        page.classList.add('ocr-page');
        page.removeAttribute('contenteditable');
        page.style.width = `${Number(result.width || 0)}px`;
        page.style.height = `${Number(result.height || 0)}px`;
        page.style.position = 'relative';
        page.style.overflow = 'hidden';
        page.dataset.page = String(index + 1);
        page.querySelectorAll('[contenteditable]').forEach(el => el.removeAttribute('contenteditable'));
        return page.outerHTML;
      }
    }

    const page = document.createElement('div');
    page.className = 'ocr-page';
    page.style.width = `${Number(result.width || 0)}px`;
    page.style.height = `${Number(result.height || 0)}px`;
    page.style.position = 'relative';
    page.style.background = '#fff';
    page.style.overflow = 'hidden';
    page.dataset.page = String(index + 1);

    for (const w of (result.words || [])) {
      const span = document.createElement('span');
      span.className = 'ocr-span';
      span.textContent = w.text || '';
      Object.assign(span.style, {
        position: 'absolute',
        left: `${Number(w.x || 0)}px`,
        top: `${Number(w.y || 0)}px`,
        width: `${Math.max(3, Number(w.w || 0))}px`,
        minHeight: `${Math.max(3, Number(w.h || 0))}px`,
        whiteSpace: 'pre',
        fontSize: `${Math.max(8, Number(w.fontSize || 8))}px`,
        lineHeight: '1',
        fontFamily: w.fontFamily || 'Arial, sans-serif',
        fontWeight: w.fontWeight || '400',
        fontStyle: w.fontStyle || 'normal',
        textDecoration: w.textDecoration || 'none',
        color: w.textColor || '#20242a',
        backgroundColor: w.bgColor || 'transparent'
      });
      page.appendChild(span);
    }
    return page.outerHTML;
  }

  function exportText() {
    syncEditorsBeforeExport();
    if (!state.results.length) return toast('Run OCR before exporting TXT.', 'error');
    const text = aggregatePlainText();
    if (!text) return toast('There is no text to export.', 'error');
    downloadBlob(new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' }), `${safeFileBase()}.txt`);
    toast('TXT exported successfully.', 'success');
  }

  function exportHtml() {
    syncEditorsBeforeExport();
    if (!state.results.length) return toast('Run OCR before exporting HTML.', 'error');

    const pages = state.results.map((r, i) => pageHtmlFromResult(r, i)).filter(Boolean).join('\n');
    if (!pages) return toast('There is no OCR content to export.', 'error');

    const title = escapeHtml(safeFileBase());
    const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>${title}</title>\n<style>\nhtml,body{margin:0;padding:0;background:#e8edf3;font-family:Arial,sans-serif}.ocr-document{padding:24px 0}.ocr-page{box-sizing:border-box;position:relative;margin:0 auto 24px;background:#fff;overflow:hidden;box-shadow:0 6px 20px rgba(0,0,0,.14)}.ocr-span{position:absolute;white-space:pre;display:block}.page-label{font:12px Arial;color:#5b6470;margin:8px auto;width:max-content}@media print{body{background:#fff}.ocr-document{padding:0}.ocr-page{margin:0;box-shadow:none;break-after:page}.ocr-page:last-child{break-after:auto}.page-label{display:none}}\n</style>\n</head>\n<body><main class="ocr-document">${pages}</main></body></html>`;
    if (downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeFileBase()}.html`)) {
      toast('HTML exported successfully.', 'success');
    }
  }

  function serializeResult(result) {
    if (!result) return null;
    return {
      page: Number(result.page || 0),
      text: getPageText(result),
      html: result.editedHtml || null,
      confidence: Number(result.confidence || 0),
      source: result.source || 'ocr',
      width: Number(result.width || 0),
      height: Number(result.height || 0),
      lang: result.lang || '',
      words: (result.words || []).map(w => ({
        text: String(w.text || ''),
        confidence: Number(w.confidence || 0),
        x: Number(w.x || 0), y: Number(w.y || 0),
        width: Number(w.w || 0), height: Number(w.h || 0),
        estimatedFontSize: Number(w.fontSize || 0),
        estimatedFontFamily: w.fontFamily || 'Arial, sans-serif',
        fontWeight: w.fontWeight || '400',
        fontStyle: w.fontStyle || 'normal',
        textColor: w.textColor || '#20242a',
        backgroundColor: w.bgColor || 'transparent'
      }))
    };
  }

  function exportJson() {
    syncEditorsBeforeExport();
    if (!state.results.length) return toast('Run OCR before exporting JSON.', 'error');
    const payload = {
      application: 'FormatOCR',
      version: '2.2',
      generatedAt: new Date().toISOString(),
      sourceFile: state.files.find(x => x.id === state.activeFileId)?.name || null,
      languages: selectedLangCodes(),
      pages: state.results.map(serializeResult).filter(Boolean),
      notes: {
        fontFamily: 'Estimated/inferred from script and geometry; exact source font cannot generally be recovered from raster OCR.',
        fontSize: 'Estimated from OCR bounding-box height.',
        color: 'Text colour is sampled/estimated and may differ from the source.',
        layout: 'Coordinates are approximate OCR/image coordinates and may vary with preprocessing scale.'
      }
    };
    if (downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), `${safeFileBase()}.json`)) {
      toast('JSON exported successfully.', 'success');
    }
  }

  function htmlToDocxParagraphs(pageHtml, DocumentTypes) {
    const { Paragraph, TextRun } = DocumentTypes;
    const holder = document.createElement('div');
    holder.innerHTML = pageHtml || '';
    const spans = Array.from(holder.querySelectorAll('.ocr-span'));
    const groups = new Map();

    spans.forEach(span => {
      const top = Math.round(parseFloat(span.style.top || '0') / 4) * 4;
      if (!groups.has(top)) groups.set(top, []);
      groups.get(top).push(span);
    });

    const paragraphs = [];
    const ordered = Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
    for (const [, row] of ordered) {
      row.sort((a, b) => (parseFloat(a.style.left || '0') - parseFloat(b.style.left || '0')));
      const runs = [];
      row.forEach((span, idx) => {
        const style = getComputedStyle(span);
        const px = parseFloat(span.style.fontSize || style.fontSize || '12') || 12;
        const halfPoints = Math.max(8, Math.round(px * 1.5));
        const rgb = style.color.match(/\d+/g) || [];
        const color = rgb.length >= 3 ? rgb.slice(0,3).map(n => Number(n).toString(16).padStart(2,'0')).join('') : '20242a';
        runs.push(new TextRun({
          text: (idx ? ' ' : '') + (span.innerText || span.textContent || '').trim(),
          bold: /bold|700|800|900/.test(`${span.style.fontWeight} ${style.fontWeight}`),
          italics: /italic|oblique/.test(`${span.style.fontStyle} ${style.fontStyle}`),
          underline: /underline/.test(span.style.textDecoration || style.textDecoration),
          font: span.style.fontFamily?.split(',')[0]?.replace(/["']/g, '').trim() || 'Arial',
          size: halfPoints,
          color
        }));
      });
      if (runs.length) paragraphs.push(new Paragraph({ children: runs }));
    }

    if (!paragraphs.length) {
      const text = holder.innerText || '';
      return text.split(/\r?\n/).map(line => new Paragraph({ children: [new TextRun({ text: line })] }));
    }
    return paragraphs;
  }

  async function exportDocx() {
    syncEditorsBeforeExport();
    if (!state.results.length) return toast('Run OCR before exporting DOCX.', 'error');
    if (!window.docx?.Document || !window.docx?.Packer) return toast('DOCX library is unavailable. Check your internet connection and reload.', 'error');
    try {
      const { Document, Packer, Paragraph, TextRun } = window.docx;
      const children = [];
      state.results.forEach((result, index) => {
        children.push(new Paragraph({ children: [new TextRun({ text: `Page ${index + 1}`, bold: true, size: 24 })] }));
        const pageHtml = result.editedHtml || pageHtmlFromResult(result, index);
        children.push(...htmlToDocxParagraphs(pageHtml, { Paragraph, TextRun }));
        if (index < state.results.length - 1) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
      });
      const doc = new Document({ sections: [{ properties: {}, children }] });
      const blob = await Packer.toBlob(doc);
      if (downloadBlob(blob, `${safeFileBase()}.docx`)) toast('DOCX exported successfully.', 'success');
    } catch (e) {
      console.error(e);
      toast(`DOCX export failed: ${friendlyError(e)}`, 'error');
    }
  }

  async function exportSearchablePdf() {
    syncEditorsBeforeExport();
    if (!state.results.length) return toast('Run OCR before exporting a PDF.', 'error');
    if (!window.jspdf?.jsPDF) return toast('PDF export library is unavailable. Check your internet connection and reload.', 'error');

    try {
      const { jsPDF } = window.jspdf;
      let pdf = null;

      for (let i = 0; i < state.results.length; i++) {
        const result = state.results[i];
        const page = state.pages[i];
        if (!result || !page) continue;

        const width = Number(page.width || result.width || 595);
        const height = Number(page.height || result.height || 842);
        const orientation = width >= height ? 'landscape' : 'portrait';
        if (!pdf) pdf = new jsPDF({ orientation, unit: 'pt', format: [width, height], compress: true });
        else pdf.addPage([width, height], orientation);

        // Preserve the original visual page as the background.
        pdf.addImage(page.previewURL, 'PNG', 0, 0, width, height, undefined, 'FAST');

        // Add a transparent/near-invisible OCR text layer for searching/copying.
        // The visual page already contains the text, so the overlay is intentionally tiny/white.
        pdf.setTextColor(255, 255, 255);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(1);

        for (const w of (result.words || [])) {
          const text = String(w.text || '').trim();
          if (!text) continue;
          const x = Number(w.x || 0);
          const h = Math.max(1, Number(w.h || 1));
          const y = Number(w.y || 0) + Math.min(h, 2);
          const size = Math.max(0.5, Math.min(1.5, Number(w.fontSize || 1) / 20));
          pdf.setFontSize(size);
          try { pdf.text(text, x, y, { baseline: 'alphabetic' }); } catch (_) {}
        }
        setProgress(((i + 1) / state.results.length) * 100, `PDF page ${i + 1}/${state.results.length}`);
      }

      if (!pdf) return toast('No OCR pages are available for PDF export.', 'error');
      pdf.save(`${safeFileBase()}-searchable.pdf`);
      toast(`Searchable PDF exported (${state.results.length} page${state.results.length === 1 ? '' : 's'}).`, 'success');
    } catch (e) {
      console.error(e);
      toast(`PDF export failed: ${friendlyError(e)}`, 'error');
    }
  }

  function openProcessingPreview() {
    const p = state.pages[state.activePage];
    if (!p) return toast('Upload a file first.', 'error');
    try {
      const canvas = preprocessCanvas(p);
      const w = window.open('', '_blank', 'noopener,noreferrer');
      if (!w) return toast('Popup blocked. Allow popups to preview preprocessing.', 'error');
      w.document.write(`<title>Preprocessing Preview</title><body style="margin:0;background:#20242a;display:grid;place-items:center"><img alt="Processed preview" style="max-width:98vw;max-height:96vh;background:#fff" src="${canvas.toDataURL('image/png')}"></body>`);
      w.document.close();
    } catch (e) { toast(`Preview failed: ${friendlyError(e)}`, 'error'); }
  }

  function resetApp() {
    state.files = [];
    state.activeFileId = null;
    state.pages = [];
    state.activePage = 0;
    state.results = [];
    state.cancel = true;
    clearObjectUrls();
    terminateWorker();
    $('#ocrBtn').disabled = true;
    $('#cancelBtn').disabled = true;
    $('#rerunBtn').disabled = true;
    $('#originalViewer').className = 'viewer original-viewer empty-viewer';
    $('#originalViewer').textContent = 'Upload a document to preview it.';
    $('#richEditor').innerHTML = '';
    $('#plainEditor').value = '';
    $('#thumbs').innerHTML = '';
    $('#compareViewer').innerHTML = '';
    $('#confidenceSummary').textContent = 'Confidence: —';
    $('#pageLabel').textContent = 'Page 0 / 0';
    setProgress(0, '0%');
    setStatus('Ready', 'good');
    renderFiles();
  }

  function bindEvents() {
    $('#browseBtn').addEventListener('click', e => { e.preventDefault(); $('#fileInput').click(); });
    $('#fileInput').addEventListener('change', e => addFiles(e.target.files));
    $('#pasteBtn').addEventListener('click', pasteFromClipboard);
    document.addEventListener('paste', pasteImageFromEvent);

    const drop = $('#dropZone');
    ['dragenter', 'dragover'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); drop.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('dragover'); }));
    drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));

    $('#fileList').addEventListener('click', e => {
      const item = e.target.closest('[data-file-id]');
      if (item) selectFile(item.dataset.fileId);
    });
    $('#thumbs').addEventListener('click', e => {
      const item = e.target.closest('[data-page]');
      if (!item) return;
      state.activePage = Number(item.dataset.page);
      renderPage();
    });

    $('#clearBtn').addEventListener('click', resetApp);
    $('#ocrBtn').addEventListener('click', runOCR);
    $('#rerunBtn').addEventListener('click', runOCR);
    $('#cancelBtn').addEventListener('click', () => { state.cancel = true; setStatus('Cancelling…', 'running'); });
    $('#detectBtn').addEventListener('click', autoDetectFromImage);
    $('#previewProcessBtn').addEventListener('click', openProcessingPreview);
    $('#scaleRange').addEventListener('input', e => $('#scaleValue').textContent = `${e.target.value}×`);
    $('#overlayToggle').addEventListener('change', updateCompare);
    $('#lowConfToggle').addEventListener('change', () => { const r = state.results[state.activePage]; if (r) renderResult(r); });

    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      state.viewMode = btn.dataset.mode;
      $('#richEditor').classList.toggle('hidden', state.viewMode !== 'rich');
      $('#plainEditor').classList.toggle('hidden', state.viewMode !== 'text');
    }));

    $$('[data-command]').forEach(btn => btn.addEventListener('click', () => applyCommand(btn.dataset.command)));
    $('#fontFamily').addEventListener('change', e => applyCommand('fontName', e.target.value));
    $('#fontSize').addEventListener('change', e => applyCommand('fontSize', e.target.value.replace('px', '')));
    $('#textColor').addEventListener('input', e => applyCommand('foreColor', e.target.value));
    $('#undoBtn').addEventListener('click', () => applyCommand('undo'));
    $('#redoBtn').addEventListener('click', () => applyCommand('redo'));
    $('#searchBtn').addEventListener('click', openSearchModal);
    $('#modalClose').addEventListener('click', () => $('#modal').classList.add('hidden'));
    $('#modal').addEventListener('click', e => { if (e.target === $('#modal')) $('#modal').classList.add('hidden'); });

    $$('.export-btn').forEach(btn => btn.addEventListener('click', async () => {
      const type = btn.dataset.export;
      if (type === 'txt') exportText();
      else if (type === 'html') exportHtml();
      else if (type === 'json') exportJson();
      else if (type === 'docx') await exportDocx();
    }));
    $('#searchPdfBtn').addEventListener('click', exportSearchablePdf);

    $('#richEditor').addEventListener('input', () => { $('#plainEditor').value = richText(); });
    $('#themeBtn').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', state.theme === 'dark');
      localStorage.setItem('formatocr-theme', state.theme);
    });
  }

  function friendlyError(e) {
    const msg = e?.message || String(e || 'Unknown browser error');
    return msg.replace(/https?:\/\/\S+/g, 'external resource');
  }

  function init() {
    document.documentElement.classList.toggle('dark', state.theme === 'dark');
    bindEvents();
    checkDependencies();
    setStatus('Ready', 'good');
    setProgress(0, '0%');
  }

  window.addEventListener('beforeunload', () => {
    if (state.worker) state.worker.terminate();
    clearObjectUrls();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
