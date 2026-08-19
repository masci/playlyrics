'use strict';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const form        = document.getElementById('lyricsForm');
const slider      = document.getElementById('maskPct');
const pctLabel    = document.getElementById('pctLabel');
const errorMsg    = document.getElementById('errorMsg');
const generateBtn = document.getElementById('generateBtn');
const btnText     = document.getElementById('btnText');
const btnSpinner  = document.getElementById('btnSpinner');
const qrContainer = document.getElementById('qrContainer');

const fetchBtn     = document.getElementById('fetchBtn');
const fetchBtnText = document.getElementById('fetchBtnText');
const fetchSpinner = document.getElementById('fetchSpinner');
const fetchMsg     = document.getElementById('fetchMsg');
const lyricsPreview = document.getElementById('lyricsPreview');

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — keeps preview and PDF in sync
// ---------------------------------------------------------------------------
let maskSeed = null;

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Slider live update + preview
// ---------------------------------------------------------------------------
slider.addEventListener('input', () => {
  const v = slider.value;
  pctLabel.textContent = v + '%';
  slider.style.setProperty('--pct', v + '%');
  renderPreview();
});
slider.style.setProperty('--pct', slider.value + '%');

document.getElementById('lyrics').addEventListener('input', () => {
  maskSeed = null; // fresh seed whenever the text changes
  renderPreview();
});

lyricsPreview.addEventListener('click', () => {
  lyricsPreview.hidden = true;
  const lyricsEl = document.getElementById('lyrics');
  lyricsEl.hidden = false;
  lyricsEl.focus();
});

function renderPreview() {
  const lyricsEl = document.getElementById('lyrics');
  const lyrics = lyricsEl.value;
  const pct = parseInt(slider.value, 10);

  if (!lyrics || pct === 0) {
    lyricsPreview.hidden = true;
    lyricsEl.hidden = false;
    return;
  }

  if (maskSeed === null) maskSeed = Date.now();
  const masked = maskLyrics(lyrics, pct, maskSeed);

  lyricsPreview.innerHTML = masked
    .split('\n')
    .map(line => {
      const esc = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return esc.replace(/_{5,}/g, m => `<span class="blank">${' '.repeat(m.length)}</span>`);
    })
    .join('\n');

  lyricsEl.hidden = true;
  lyricsPreview.hidden = false;
}

// ---------------------------------------------------------------------------
// Fetch lyrics: iTunes Lookup (track metadata) + LRCLIB (lyrics).
// Both APIs are free, CORS-enabled, and need no authentication.
// ---------------------------------------------------------------------------

fetchBtn.addEventListener('click', async () => {
  const url = document.getElementById('appleUrl').value.trim();
  if (!url) {
    showFetchMsg('Paste an Apple Music track URL first.', 'error');
    return;
  }

  const parsed = parseAppleMusicUrl(url);
  if (!parsed) {
    showFetchMsg('That URL doesn\'t look like a specific Apple Music track. Make sure it links to a single song (not an album).', 'error');
    return;
  }

  setFetchLoading(true);
  hideFetchMsg();

  try {
    const track = await fetchTrackInfo(parsed.songId, parsed.storefront);
    document.getElementById('songTitle').value = `${track.trackName} — ${track.artistName}`;

    const lyrics = await fetchLyrics(track);
    document.getElementById('lyrics').value = lyrics;
    maskSeed = null;
    renderPreview();
    showFetchMsg('Lyrics fetched! Review them before generating the PDF.', 'ok');
  } catch (err) {
    console.error('Fetch lyrics error:', err);
    showFetchMsg(err?.message || String(err) || 'An unknown error occurred.', 'error');
  } finally {
    setFetchLoading(false);
  }
});

// Parse an Apple Music URL into { storefront, songId }.
// Handles:
//   /us/album/name/ALBUMID?i=SONGID  →  songId = SONGID
//   /us/song/name/SONGID             →  songId = last path segment
function parseAppleMusicUrl(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith('music.apple.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    // parts[0] = storefront, parts[1] = 'album'/'song'/'music-video', parts[-1] = id
    const storefront = parts[0];
    const songId = u.searchParams.get('i') || parts[parts.length - 1];
    if (!storefront || !songId || !/^\d+$/.test(songId)) return null;
    return { storefront, songId };
  } catch {
    return null;
  }
}

// iTunes Lookup: resolves an Apple track ID to metadata. The storefront from
// the URL doubles as the country code.
async function fetchTrackInfo(songId, country) {
  const res = await fetch(`https://itunes.apple.com/lookup?id=${songId}&country=${country}`);
  if (!res.ok) throw new Error(`Track lookup failed (${res.status}). Check the URL.`);
  // The endpoint responds with content-type text/javascript, so parse manually.
  const data = JSON.parse(await res.text());
  if (!data.resultCount || !data.results?.[0]?.trackName) {
    throw new Error('Track not found. Make sure the URL points to a single song.');
  }
  return data.results[0];
}

// LRCLIB: exact match first (artist + track + album + duration), then a looser
// search as fallback.
async function fetchLyrics(track) {
  const params = new URLSearchParams({
    artist_name: track.artistName,
    track_name: track.trackName,
  });
  if (track.collectionName) params.set('album_name', track.collectionName);
  if (track.trackTimeMillis) params.set('duration', Math.round(track.trackTimeMillis / 1000));

  const res = await fetch(`https://lrclib.net/api/get?${params}`);

  if (res.ok) {
    const data = await res.json();
    if (data.instrumental) throw new Error('This track is instrumental — no lyrics to fetch.');
    if (data.plainLyrics) return data.plainLyrics;
  } else if (res.status !== 404) {
    throw new Error(`Lyrics lookup failed (${res.status}). Try again in a moment.`);
  }

  return searchLyrics(track);
}

async function searchLyrics(track) {
  const params = new URLSearchParams({
    artist_name: track.artistName,
    track_name: track.trackName,
  });
  const res = await fetch(`https://lrclib.net/api/search?${params}`);
  if (!res.ok) throw new Error(`Lyrics search failed (${res.status}). Try again in a moment.`);

  const results = await res.json();
  const hit = Array.isArray(results) && results.find(r => r.plainLyrics);
  if (!hit) {
    throw new Error('No lyrics found for this track. You can paste them manually below.');
  }
  return hit.plainLyrics;
}

// ---------------------------------------------------------------------------
// Generate PDF (form submit)
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
    const maskedLyrics = maskLyrics(lyrics, pct, maskSeed ?? undefined);
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
function maskLyrics(text, pct, seed) {
  if (pct === 0) return text;

  const wordRe = /[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu;
  const matches = [...text.matchAll(wordRe)];
  if (matches.length === 0) return text;

  const count = Math.round(matches.length * pct / 100);
  if (count === 0) return text;

  const rng = seed !== undefined ? mulberry32(seed) : Math.random;
  const pool = matches.map((_, i) => i);
  for (let i = pool.length - 1; i > 0 && pool.length - i <= count; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const masked = new Set(pool.slice(pool.length - count));

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
    try {
      new QRCode(qrContainer, {
        text: url,
        width: 300,
        height: 300,
        correctLevel: QRCode.CorrectLevel.M,
      });
    } catch (err) {
      reject(new Error('Could not generate QR code: ' + err.message));
      return;
    }
    setTimeout(() => {
      const canvas = qrContainer.querySelector('canvas');
      if (canvas) { resolve(canvas.toDataURL('image/png')); return; }
      const img = qrContainer.querySelector('img');
      if (img && img.src) { resolve(img.src); return; }
      reject(new Error('QR canvas element not found.'));
    }, 150);
  });
}

// ---------------------------------------------------------------------------
// PDF generation
// ---------------------------------------------------------------------------
function generatePDF(title, maskedLyrics, qrDataUrl) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });

  const PAGE_W   = 210;
  const PAGE_H   = 297;
  const MARGIN   = 16;
  const QR_SIZE  = 36;
  const QR_X     = PAGE_W - MARGIN - QR_SIZE;
  const QR_Y     = MARGIN;

  // QR code + label
  doc.addImage(qrDataUrl, 'PNG', QR_X, QR_Y, QR_SIZE, QR_SIZE);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(100, 100, 100);
  doc.text('Scan to listen', QR_X + QR_SIZE / 2, QR_Y + QR_SIZE + 5, { align: 'center' });

  // Title (constrained to the zone left of the QR)
  const titleZoneW = QR_X - MARGIN - 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(29, 29, 31);
  const titleLines = doc.splitTextToSize(title, titleZoneW);
  let titleBottom = MARGIN + 10;
  for (const line of titleLines) {
    doc.text(line, MARGIN, titleBottom);
    titleBottom += 9;
  }

  // Separator below header
  const qrBottom = QR_Y + QR_SIZE + 8;
  const headerBottom = Math.max(titleBottom + 4, qrBottom + 4);
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(MARGIN, headerBottom, PAGE_W - MARGIN, headerBottom);

  // Lyrics
  const CONTENT_W = PAGE_W - MARGIN * 2;
  const FONT_SIZE = 13;
  const LINE_H    = 9;
  const EMPTY_H   = 4;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(FONT_SIZE);
  doc.setTextColor(29, 29, 31);

  let y = headerBottom + LINE_H;

  for (const rawLine of maskedLyrics.split('\n')) {
    if (rawLine.trim() === '') {
      y += EMPTY_H;
      continue;
    }
    for (const segment of doc.splitTextToSize(rawLine, CONTENT_W)) {
      if (y + LINE_H > PAGE_H - MARGIN) {
        doc.addPage();
        y = MARGIN + LINE_H;
      }
      doc.text(segment, MARGIN, y);
      y += LINE_H;
    }
  }

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

function setFetchLoading(on) {
  fetchBtn.disabled = on;
  fetchBtnText.hidden = on;
  fetchSpinner.hidden = !on;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.hidden = false;
}

function hideError() {
  errorMsg.hidden = true;
}

function showFetchMsg(msg, type) {
  fetchMsg.textContent = msg;
  fetchMsg.className = 'fetch-msg ' + type;
  fetchMsg.hidden = false;
}

function hideFetchMsg() {
  fetchMsg.hidden = true;
}
