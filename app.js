'use strict';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const form       = document.getElementById('lyricsForm');
const slider     = document.getElementById('maskPct');
const pctLabel   = document.getElementById('pctLabel');
const errorMsg   = document.getElementById('errorMsg');
const generateBtn = document.getElementById('generateBtn');
const btnText    = document.getElementById('btnText');
const btnSpinner = document.getElementById('btnSpinner');
const qrContainer = document.getElementById('qrContainer');

// ---------------------------------------------------------------------------
// Slider live update
// ---------------------------------------------------------------------------
slider.addEventListener('input', () => {
  const v = slider.value;
  pctLabel.textContent = v + '%';
  slider.style.setProperty('--pct', v + '%');
});
// Init gradient on load
slider.style.setProperty('--pct', slider.value + '%');

// ---------------------------------------------------------------------------
// Form submit
// ---------------------------------------------------------------------------
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideError();

  const title    = document.getElementById('songTitle').value.trim();
  const lyrics   = document.getElementById('lyrics').value;
  const appleUrl = document.getElementById('appleUrl').value.trim();
  const pct      = parseInt(slider.value, 10);

  if (!title || !lyrics || !appleUrl) {
    showError('Please fill in all fields before generating.');
    return;
  }

  setLoading(true);
  try {
    const maskedLyrics = maskLyrics(lyrics, pct);
    const qrDataUrl    = await generateQRDataUrl(appleUrl);
    generatePDF(title, maskedLyrics, qrDataUrl);
  } catch (err) {
    showError('Something went wrong: ' + err.message);
  } finally {
    setLoading(false);
  }
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

/**
 * Replace a random `pct` percent of words in `text` with underscore blanks.
 * Words include contractions (don't) and accented characters (café).
 */
function maskLyrics(text, pct) {
  if (pct === 0) return text;

  // Match words: Unicode letters + optional apostrophe-continuation
  const wordRe = /[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu;
  const matches = [...text.matchAll(wordRe)];

  if (matches.length === 0) return text;

  const count = Math.round(matches.length * pct / 100);
  if (count === 0) return text;

  // Pick `count` random indices via partial Fisher-Yates
  const pool = matches.map((_, i) => i);
  for (let i = pool.length - 1; i > 0 && pool.length - i <= count; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const masked = new Set(pool.slice(pool.length - count));

  // Build result: process matches from the end to preserve indices
  const sortedMatches = matches
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => masked.has(i))
    .sort((a, b) => b.m.index - a.m.index);

  let result = text;
  for (const { m } of sortedMatches) {
    const blank = '_'.repeat(Math.max(5, m[0].length + 2));
    result = result.slice(0, m.index) + blank + result.slice(m.index + m[0].length);
  }
  return result;
}

// ---------------------------------------------------------------------------
// QR code
// ---------------------------------------------------------------------------
function generateQRDataUrl(url) {
  return new Promise((resolve, reject) => {
    qrContainer.innerHTML = '';

    let qr;
    try {
      qr = new QRCode(qrContainer, {
        text: url,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (err) {
      reject(new Error('Could not generate QR code: ' + err.message));
      return;
    }

    // qrcodejs renders asynchronously via an internal setTimeout
    setTimeout(() => {
      const canvas = qrContainer.querySelector('canvas');
      if (canvas) {
        resolve(canvas.toDataURL('image/png'));
      } else {
        // Fallback: some environments render an <img> instead
        const img = qrContainer.querySelector('img');
        if (img && img.src) {
          resolve(img.src);
        } else {
          reject(new Error('QR canvas element not found.'));
        }
      }
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------
function generatePDF(title, maskedLyrics, qrDataUrl) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  const PAGE_W  = 210;
  const PAGE_H  = 297;
  const MARGIN  = 16;          // mm, all sides
  const QR_SIZE = 36;          // mm, square QR image
  const QR_LABEL = 'Scan to listen';
  const QR_LABEL_H = 5;        // mm below QR image for label
  const QR_X = PAGE_W - MARGIN - QR_SIZE;
  const QR_Y = MARGIN;

  // --- QR code (top-right) ---
  doc.addImage(qrDataUrl, 'PNG', QR_X, QR_Y, QR_SIZE, QR_SIZE);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 100, 100);
  doc.text(QR_LABEL, QR_X + QR_SIZE / 2, QR_Y + QR_SIZE + QR_LABEL_H, { align: 'center' });

  // --- Title (left portion, avoiding QR overlap) ---
  const titleZoneW = PAGE_W - MARGIN - QR_SIZE - 6 - MARGIN; // space left of QR
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(29, 29, 31);

  const titleLines = doc.splitTextToSize(title, titleZoneW);
  let titleBottom = MARGIN + 10;
  for (const line of titleLines) {
    doc.text(line, MARGIN, titleBottom);
    titleBottom += 9;
  }

  // Separator line below header area
  const qrBottom = QR_Y + QR_SIZE + QR_LABEL_H + 3;
  const headerBottom = Math.max(titleBottom + 4, qrBottom + 4);

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, headerBottom, PAGE_W - MARGIN, headerBottom);

  // --- Lyrics ---
  const CONTENT_W  = PAGE_W - MARGIN * 2;
  const FONT_SIZE  = 13;       // pt — readable for kids
  const LINE_H     = 9;        // mm between baselines
  const EMPTY_H    = 4;        // mm for blank/verse-break lines

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(FONT_SIZE);
  doc.setTextColor(29, 29, 31);

  let y = headerBottom + LINE_H;

  const rawLines = maskedLyrics.split('\n');
  for (const rawLine of rawLines) {
    if (rawLine.trim() === '') {
      y += EMPTY_H;
      continue;
    }

    const wrapped = doc.splitTextToSize(rawLine, CONTENT_W);
    for (const segment of wrapped) {
      if (y + LINE_H > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN + LINE_H;
      }
      doc.text(segment, MARGIN, y);
      y += LINE_H;
    }
  }

  // --- Save ---
  const safeName = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'lyrics';
  doc.save(safeName + '.pdf');
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function setLoading(on) {
  generateBtn.disabled = on;
  btnText.hidden = on;
  btnSpinner.hidden = !on;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}
