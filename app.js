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

// ---------------------------------------------------------------------------
// Slider live update
// ---------------------------------------------------------------------------
slider.addEventListener('input', () => {
  const v = slider.value;
  pctLabel.textContent = v + '%';
  slider.style.setProperty('--pct', v + '%');
});
slider.style.setProperty('--pct', slider.value + '%');

// ---------------------------------------------------------------------------
// Fetch lyrics from Apple Music
// ---------------------------------------------------------------------------

let cachedDevToken  = null;
let musicKitInstance = null;

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
    const devToken = await getDeveloperToken();
    const { musicUserToken } = await getAuthorizedMusicKit(devToken);

    // Fetch song metadata and lyrics in parallel
    const [songAttrs, ttml] = await Promise.all([
      fetchSongAttributes(devToken, parsed.storefront, parsed.songId),
      fetchLyricsTtml(devToken, musicUserToken, parsed.storefront, parsed.songId),
    ]);

    document.getElementById('songTitle').value = `${songAttrs.name} — ${songAttrs.artistName}`;
    document.getElementById('lyrics').value = parseTtml(ttml);
    showFetchMsg('Lyrics fetched! Review them before generating the PDF.', 'ok');
  } catch (err) {
    console.error('Fetch lyrics error:', err);
    showFetchMsg(err?.message || err?.description || String(err) || 'An unknown error occurred.', 'error');
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

async function getDeveloperToken() {
  if (cachedDevToken) return cachedDevToken;
  const res = await fetch('/.netlify/functions/token');
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || 'Could not reach the token endpoint. Is the app deployed on Netlify?');
  }
  const { token, error } = await res.json();
  if (error) throw new Error(error);
  cachedDevToken = token;
  return token;
}

async function getAuthorizedMusicKit(devToken) {
  if (!musicKitInstance) {
    await MusicKit.configure({
      developerToken: devToken,
      app: { name: 'PlayLyrics', build: '1.0.0' },
    });
    musicKitInstance = MusicKit.getInstance();
  }

  // authorize() resolves to the Music User Token string; prefer that over the
  // instance property, which may not be set yet when the promise first resolves.
  let musicUserToken = musicKitInstance.musicUserToken;
  if (!musicUserToken) {
    musicUserToken = await musicKitInstance.authorize();
  }
  if (!musicUserToken) {
    throw new Error('Apple Music sign-in succeeded but no user token was returned. Please try again.');
  }

  return { instance: musicKitInstance, musicUserToken };
}

async function fetchSongAttributes(devToken, storefront, songId) {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/songs/${songId}`,
    { headers: { Authorization: `Bearer ${devToken}` } }
  );
  if (!res.ok) throw new Error(`Song lookup failed (${res.status}). Check the URL or your developer token.`);
  const data = await res.json();
  if (!data.data || data.data.length === 0) throw new Error('Song not found in Apple Music catalog.');
  return data.data[0].attributes;
}

async function fetchLyricsTtml(devToken, musicUserToken, storefront, songId) {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/songs/${songId}/lyrics`,
    {
      headers: {
        Authorization: `Bearer ${devToken}`,
        'Music-User-Token': musicUserToken,
      },
    }
  );
  if (res.status === 404) throw new Error('No lyrics available for this track in Apple Music.');
  if (!res.ok) throw new Error(`Lyrics fetch failed (${res.status}).`);
  const data = await res.json();
  // The lyrics relationship endpoint may return data as a single object or as an array.
  const resource = Array.isArray(data.data) ? data.data[0] : data.data;
  const ttml = resource?.attributes?.ttml;
  if (!ttml) {
    console.error('Unexpected lyrics response structure:', JSON.stringify(data));
    throw new Error('Apple Music returned no lyrics for this track (or the response format was unexpected).');
  }
  return ttml;
}

// Extract plain text from Apple Music TTML.
// Each <p> element is one lyric line; text content of spans is concatenated.
function parseTtml(ttml) {
  const doc = new DOMParser().parseFromString(ttml, 'text/xml');
  const paragraphs = Array.from(doc.querySelectorAll('p'));
  return paragraphs
    .map(p => p.textContent.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
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
function maskLyrics(text, pct) {
  if (pct === 0) return text;

  const wordRe = /[\p{L}\p{M}]+(?:'[\p{L}\p{M}]+)*/gu;
  const matches = [...text.matchAll(wordRe)];
  if (matches.length === 0) return text;

  const count = Math.round(matches.length * pct / 100);
  if (count === 0) return text;

  const pool = matches.map((_, i) => i);
  for (let i = pool.length - 1; i > 0 && pool.length - i <= count; i--) {
    const j = Math.floor(Math.random() * (i + 1));
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
