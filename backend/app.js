'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const SUPABASE_URL = (process.env.SUPABASE_URL || "https://irvkhqzmzepnzsxfzbud.supabase.co").replace(/\/+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlydmtocXptemVwbnpzeGZ6YnVkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTc5NjMwNiwiZXhwIjoyMTA3MzcyMzA2fQ.xE_sJq-y1M6xU4xMd6evTRfBKO7zH1QgA9Rz9WvwsCU";
function getSupabaseKeyRole(key) {
  const parts = key.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || null;
  } catch {
    return null;
  }
}
const SUPABASE_KEY_ROLE = getSupabaseKeyRole(SUPABASE_SERVICE_ROLE_KEY);
const FRONTEND_DIR = path.resolve(__dirname, '..', 'frontend');
const MAX_BODY_SIZE = 1024 * 1024;

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_SIZE) {
        tooLarge = true;
        body = '';
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Ukuran permintaan terlalu besar.'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(Object.assign(new Error('Format JSON tidak valid.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

async function supabase(pathname, options = {}) {
  if (SUPABASE_KEY_ROLE !== 'service_role' && !SUPABASE_SERVICE_ROLE_KEY.startsWith('sb_secret_')) {
    throw Object.assign(
      new Error('Kunci Supabase bukan key server. Gunakan service_role/Secret key hanya di backend.'),
      { status: 502 },
    );
  }
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null ? data.message || data.hint : data;
    throw Object.assign(new Error(message || `Supabase menolak permintaan (${response.status}).`), { status: 502 });
  }
  return data;
}

function requireText(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw Object.assign(new Error(`${label} wajib diisi (maksimal ${maxLength} karakter).`), { status: 400 });
  }
  return value.trim();
}

function positiveNumber(value, label, allowZero = false) {
  if (value === null || value === undefined || value === '') {
    throw Object.assign(new Error(`${label} wajib diisi.`), { status: 400 });
  }
  const number = Number(value);
  if (!Number.isFinite(number) || (allowZero ? number < 0 : number <= 0)) {
    throw Object.assign(new Error(`${label} harus berupa angka ${allowZero ? 'nol atau lebih' : 'lebih dari nol'}.`), { status: 400 });
  }
  return number;
}

function validUuid(value, label, optional = false) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw Object.assign(new Error(`${label} tidak valid.`), { status: 400 });
  }
  return value;
}

async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/persediaan') {
    return sendJson(response, 200, await supabase('ringkasan_persediaan?select=*&order=nama.asc'));
  }
  if (method === 'GET' && pathname === '/api/pemasok') {
    return sendJson(response, 200, await supabase('pemasok?select=id,nama,kontak&order=nama.asc'));
  }
  if (method === 'GET' && pathname === '/api/transaksi') {
    return sendJson(response, 200, await supabase('transaksi_persediaan?select=id,jenis,jumlah,harga_satuan,catatan,dibuat_pada,bahan_baku(nama,satuan),pemasok(nama)&order=dibuat_pada.desc&limit=100'));
  }

  if (method === 'POST' && pathname === '/api/bahan-baku') {
    const body = await readJson(request);
    const row = {
      nama: requireText(body.nama, 'Nama bahan baku', 100),
      satuan: requireText(body.satuan, 'Satuan', 30),
      stok_minimum: positiveNumber(body.stok_minimum, 'Stok minimum', true),
    };
    const result = await supabase('bahan_baku', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return sendJson(response, 201, result[0]);
  }

  if (method === 'POST' && pathname === '/api/pemasok') {
    const body = await readJson(request);
    const row = {
      nama: requireText(body.nama, 'Nama pemasok', 120),
      kontak: body.kontak ? requireText(body.kontak, 'Kontak', 120) : null,
    };
    const result = await supabase('pemasok', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    return sendJson(response, 201, result[0]);
  }

  if (method === 'POST' && pathname === '/api/transaksi') {
    const body = await readJson(request);
    if (!['pembelian', 'pemakaian'].includes(body.jenis)) {
      throw Object.assign(new Error('Jenis transaksi harus pembelian atau pemakaian.'), { status: 400 });
    }
    const result = await supabase('rpc/catat_pergerakan_persediaan', {
      method: 'POST',
      body: JSON.stringify({
        p_bahan_baku_id: validUuid(body.bahan_baku_id, 'Bahan baku'),
        p_jenis: body.jenis,
        p_jumlah: positiveNumber(body.jumlah, 'Jumlah'),
        p_harga_satuan: body.jenis === 'pembelian' ? positiveNumber(body.harga_satuan, 'Harga satuan') : null,
        p_pemasok_id: body.jenis === 'pembelian' ? validUuid(body.pemasok_id, 'Pemasok', true) : null,
        p_catatan: body.catatan ? requireText(body.catatan, 'Catatan', 500) : null,
      }),
    });
    return sendJson(response, 201, { id: result });
  }

  return sendJson(response, 404, { error: 'Endpoint tidak ditemukan.' });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (staticFiles[url.pathname] && request.method === 'GET') {
      const [filename, contentType] = staticFiles[url.pathname];
      const contents = await fs.promises.readFile(path.join(FRONTEND_DIR, filename));
      response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      return response.end(contents);
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    return sendJson(response, 404, { error: 'Halaman tidak ditemukan.' });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}] ${error.message}`);
    if (!response.headersSent) sendJson(response, status, { error: status === 500 ? 'Terjadi kesalahan pada server.' : error.message });
    else response.end();
  }
});

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Konfigurasi wajib: SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tentang Kita berjalan di http://localhost:${PORT}`);
});
