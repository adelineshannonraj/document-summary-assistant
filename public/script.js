const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const browseBtn = document.getElementById('browse-btn');
const filenameEl = document.getElementById('filename');
const processBtn = document.getElementById('process-btn');
const lengthSelect = document.getElementById('length-select');

const uploadPanel = document.getElementById('upload-panel');
const statusPanel = document.getElementById('status-panel');
const resultPanel = document.getElementById('result-panel');
const errorPanel = document.getElementById('error-panel');

const statusText = document.getElementById('status-text');
const summaryText = document.getElementById('summary-text');
const keyPointsEl = document.getElementById('key-points');
const statLine = document.getElementById('stat-line');
const lengthBadge = document.getElementById('length-badge');
const errorText = document.getElementById('error-text');

const resetBtn = document.getElementById('reset-btn');
const errorResetBtn = document.getElementById('error-reset-btn');

let selectedFile = null;
let selectedLength = 'medium';

browseBtn.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) setFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach(evt => {
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add('drag-active');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.remove('drag-active');
  });
});
dropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});

lengthSelect.addEventListener('click', e => {
  const btn = e.target.closest('.length-opt');
  if (!btn) return;
  document.querySelectorAll('.length-opt').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  selectedLength = btn.dataset.length;
});

function setFile(file) {
  // Accept by MIME type when available, but fall back to checking the filename extension
  // because some browsers or OSes report legacy MIME types like 'image/x-png'.
  const allowedMime = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  const allowedExt = ['pdf', 'png', 'jpg', 'jpeg', 'webp'];
  const filename = (file && file.name) ? file.name.toLowerCase() : '';
  const ext = filename.includes('.') ? filename.split('.').pop() : '';
  const mimeOk = file.type && allowedMime.includes(file.type);
  const extOk = ext && allowedExt.includes(ext);
  if (!mimeOk && !extOk) {
    showError('Please upload a PDF or an image file (PNG, JPG, WEBP).');
    return;
  }
  selectedFile = file;
  filenameEl.textContent = `Selected: ${file.name}`;
  processBtn.disabled = false;
}

processBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  // Disable controls while processing to prevent duplicate submissions
  processBtn.disabled = true;
  browseBtn.disabled = true;

  showPanel(statusPanel);
  const isPdfClient = (selectedFile.type && selectedFile.type.toLowerCase().includes('pdf')) || (selectedFile.name && selectedFile.name.toLowerCase().endsWith('.pdf'));
  statusText.textContent = isPdfClient ? 'Extracting text from PDF…' : 'Analyzing document with AI…';

  const formData = new FormData();
  formData.append('document', selectedFile);
  formData.append('length', selectedLength);

  try {
    const res = await fetch('/api/process', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Failed to process the document.');
      return;
    }

    renderResult(data);
  } catch (err) {
    showError('Could not reach the server. Please check your connection and try again.');
  } finally {
    // re-enable controls after processing completes (success or failure)
    processBtn.disabled = false;
    browseBtn.disabled = false;
  }
});

function renderResult(data) {
  summaryText.textContent = data.summary;
  keyPointsEl.innerHTML = '';
  data.keyPoints.forEach(point => {
    const li = document.createElement('li');
    li.textContent = point;
    keyPointsEl.appendChild(li);
  });
  // Show word count for PDFs or when OCR returned text. For image results with zero words, show a more appropriate label.
  const isPdfClient = selectedFile && ((selectedFile.type && selectedFile.type.toLowerCase().includes('pdf')) || (selectedFile.name && selectedFile.name.toLowerCase().endsWith('.pdf')));
  if (data.wordCount && data.wordCount > 0) {
    statLine.textContent = `${data.wordCount.toLocaleString()} words extracted`;
  } else if (!isPdfClient) {
    statLine.textContent = 'Image analyzed';
  } else {
    statLine.textContent = '0 words extracted';
  }
  lengthBadge.textContent = data.summaryLength;

  // Ensure any loading/status panel is explicitly hidden so no floating loader remains.
  if (statusPanel) {
    statusPanel.hidden = true;
    // clear any inline display override so the panel can be shown again later
    statusPanel.style.removeProperty('display');
  }

  showPanel(resultPanel);
}

function showError(message) {
  errorText.textContent = message;
  showPanel(errorPanel);
}

function showPanel(panel) {
  [uploadPanel, statusPanel, resultPanel, errorPanel].forEach(p => p.hidden = true);
  panel.hidden = false;
}

function resetFlow() {
  selectedFile = null;
  fileInput.value = '';
  filenameEl.textContent = '';
  processBtn.disabled = true;
  showPanel(uploadPanel);
}

resetBtn.addEventListener('click', resetFlow);
errorResetBtn.addEventListener('click', resetFlow);
