const currency = new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 });
const quantityFormat = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 3 });
const dateFormat = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });
const SUPABASE_URL = 'https://irvkhqzmzepnzsxfzbud.supabase.co';
const SUPABASE_PUBLIC_KEY = 'sb_publishable_Oko8gV2kbLNnrYdzhpepUw_RQYHqWp8';
const OPENED_AS_FILE = window.location.protocol === 'file:';
const $ = (selector) => document.querySelector(selector);
let materials = [];
let suppliers = [];
let transactions = [];

$('#today').textContent = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full' }).format(new Date());
$('#transaction-date').textContent = new Intl.DateTimeFormat('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());

const viewContent = {
  overview: {
    eyebrow: 'OPERASIONAL CAFE',
    title: 'Ringkasan persediaan',
    description: 'Pantau kondisi stok dan aktivitas bahan baku cafe.',
  },
  inventory: {
    eyebrow: 'ENTITAS BAHAN BAKU',
    title: 'Daftar persediaan',
    description: 'Kelola bahan baku, satuan, dan batas stok minimum.',
  },
  suppliers: {
    eyebrow: 'ENTITAS PEMASOK',
    title: 'Data pemasok',
    description: 'Simpan dan lihat informasi pemasok bahan baku.',
  },
  transactions: {
    eyebrow: 'SELAMAT DATANG, ADMIN 👋',
    title: 'Sistem Pembelian & Persediaan',
    description: 'Kelola stok, transaksi, dan pemasok dengan lebih mudah dan terorganisir.',
  },
};

function showView(name) {
  const view = viewContent[name] ? name : 'overview';
  Object.keys(viewContent).forEach((key) => {
    $(`#view-${key}`).hidden = key !== view;
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  $('#page-eyebrow').textContent = viewContent[view].eyebrow;
  $('#page-title').textContent = viewContent[view].title;
  $('#page-description').textContent = viewContent[view].description;
  window.location.hash = view;
  $('#sidebar').classList.remove('open');
  $('#menu-toggle').setAttribute('aria-expanded', 'false');
}

function showNotice(message, isError = false) {
  const notice = $('#notice');
  notice.textContent = message;
  notice.className = `notice ${isError ? 'notice-error' : 'notice-success'}`;
  notice.hidden = false;
  window.clearTimeout(showNotice.timeout);
  showNotice.timeout = window.setTimeout(() => { notice.hidden = true; }, 6000);
}

async function request(path, options = {}) {
  let url = path;
  let requestOptions = options;
  if (OPENED_AS_FILE) {
    if (SUPABASE_PUBLIC_KEY === 'ISI_ANON_ATAU_PUBLISHABLE_KEY_DI_SINI') {
      throw new Error('Atur SUPABASE_PUBLIC_KEY di frontend/app.js memakai anon atau publishable key Supabase. Jangan gunakan service_role key.');
    }
    if (SUPABASE_PUBLIC_KEY.startsWith('sb_secret_')) {
      throw new Error('Jangan gunakan Secret/service_role key di frontend. Ganti dengan anon atau publishable key Supabase.');
    }
    const keyParts = SUPABASE_PUBLIC_KEY.split('.');
    if (keyParts.length === 3) {
      try {
        const claims = JSON.parse(atob(keyParts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.role === 'service_role') {
          throw new Error('Jangan gunakan service_role key di frontend. Ganti dengan anon atau publishable key Supabase.');
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Jangan gunakan')) throw error;
      }
    }
    const directRoutes = {
      'GET /api/persediaan': 'ringkasan_persediaan?select=*&order=nama.asc',
      'GET /api/pemasok': 'pemasok?select=id,nama,kontak&order=nama.asc',
      'GET /api/transaksi': 'transaksi_persediaan?select=id,jenis,jumlah,harga_satuan,catatan,dibuat_pada,bahan_baku(nama,satuan),pemasok(nama)&order=dibuat_pada.desc&limit=100',
      'POST /api/bahan-baku': 'bahan_baku',
      'POST /api/pemasok': 'pemasok',
      'POST /api/transaksi': 'rpc/catat_pergerakan_persediaan',
    };
    const route = directRoutes[`${options.method || 'GET'} ${path}`];
    if (!route) throw new Error('Endpoint aplikasi tidak ditemukan.');
    url = `${SUPABASE_URL}/rest/v1/${route}`;
    const headers = {
      apikey: SUPABASE_PUBLIC_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLIC_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    };
    requestOptions = { ...options, headers };
    if (path === '/api/transaksi' && options.method === 'POST') {
      const values = JSON.parse(options.body);
      requestOptions.body = JSON.stringify({
        p_bahan_baku_id: values.bahan_baku_id,
        p_jenis: values.jenis,
        p_jumlah: Number(values.jumlah),
        p_harga_satuan: values.harga_satuan,
        p_pemasok_id: values.pemasok_id,
        p_catatan: values.catatan || null,
      });
    } else if (options.method === 'POST') {
      headers.Prefer = 'return=minimal';
    }
  } else {
    requestOptions = {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
    };
  }
  const response = await fetch(url, {
    ...requestOptions,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!response.ok) {
    const databaseError = data.code === '42501' || /permission denied for (table|view)/i.test(data.message || '');
    if (OPENED_AS_FILE && databaseError) {
      throw new Error('Izin baca Supabase belum diterapkan. Jalankan di SQL Editor: GRANT SELECT ON public.bahan_baku, public.pemasok, public.transaksi_persediaan TO anon; GRANT SELECT ON public.ringkasan_persediaan TO anon;');
    }
    throw new Error(data.error || data.message || `Permintaan gagal (${response.status}).`);
  }
  return data;
}

function renderInventory(rows) {
  const body = $('#inventory-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty-cell">Belum ada bahan baku. Tambahkan bahan untuk memulai.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((item) => {
    const low = Number(item.stok_tersedia) <= Number(item.stok_minimum);
    return `<tr>
      <td>${escapeHtml(item.nama)}<br><span class="muted">${escapeHtml(item.satuan)}</span></td>
      <td>${quantityFormat.format(Number(item.stok_tersedia))} ${escapeHtml(item.satuan)}</td>
      <td>${quantityFormat.format(Number(item.stok_minimum))} ${escapeHtml(item.satuan)}</td>
      <td>${currency.format(Number(item.biaya_rata_rata || 0))}</td>
      <td>${currency.format(Number(item.nilai_persediaan || 0))}</td>
      <td><span class="status ${low ? 'status-low' : ''}">${low ? 'Stok rendah' : 'Tersedia'}</span></td>
    </tr>`;
  }).join('');
}

function renderTransactions(rows) {
  const markup = rows.length ? rows.map((row) => {
    const isPurchase = row.jenis === 'pembelian';
    const amount = Number(row.jumlah) * Number(row.harga_satuan);
    return `<tr>
      <td>${dateFormat.format(new Date(row.dibuat_pada))}</td>
      <td><span class="status ${isPurchase ? '' : 'status-low'}">${isPurchase ? 'Pembelian' : 'Pemakaian'}</span></td>
      <td>${escapeHtml(row.bahan_baku?.nama || '—')}</td>
      <td>${isPurchase ? '+' : '−'}${quantityFormat.format(Number(row.jumlah))} ${escapeHtml(row.bahan_baku?.satuan || '')}</td>
      <td>${currency.format(amount)}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-cell">Belum ada transaksi persediaan.</td></tr>';
  $('#transaction-rows').innerHTML = markup;
  $('#recent-transaction-rows').innerHTML = markup;
}

function renderSuppliers(rows) {
  const body = $('#supplier-rows');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="2" class="empty-cell">Belum ada pemasok. Tambahkan pemasok untuk memulai.</td></tr>';
    return;
  }
  body.innerHTML = rows.map((supplier) => `<tr>
    <td>${escapeHtml(supplier.nama)}</td>
    <td>${escapeHtml(supplier.kontak || '—')}</td>
  </tr>`).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderOptions() {
  const materialSelect = $('#movement-material');
  materialSelect.innerHTML = materials.length
    ? '<option value="">Pilih bahan baku</option>' + materials.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.nama)} (${escapeHtml(item.satuan)})</option>`).join('')
    : '<option value="">Tambahkan bahan baku terlebih dahulu</option>';
  materialSelect.disabled = materials.length === 0;
  const supplierSelect = $('#movement-supplier');
  supplierSelect.innerHTML = '<option value="">Pilih pemasok</option>' + suppliers
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.nama)}</option>`).join('');
}

function updateMovementSummary() {
  const form = $('#movement-form');
  const values = Object.fromEntries(new FormData(form));
  const purchase = values.jenis === 'pembelian';
  const material = materials.find((item) => item.id === values.bahan_baku_id);
  const supplier = suppliers.find((item) => item.id === values.pemasok_id);
  const quantity = Number(values.jumlah) || 0;
  const inputCost = Number(values.harga_satuan) || 0;
  const cost = purchase ? inputCost : Number(material?.biaya_rata_rata || 0);
  const lineValue = quantity * cost;
  $('#movement-title').textContent = purchase ? 'Buat Transaksi Pembelian' : 'Buat Transaksi Pemakaian';
  $('#summary-type').textContent = purchase ? 'Pembelian / stok masuk' : 'Pemakaian / stok keluar';
  $('#summary-material').textContent = material?.nama || '-';
  $('#summary-quantity').textContent = quantity ? `${quantityFormat.format(quantity)} ${material?.satuan || ''}`.trim() : '-';
  $('#summary-cost').textContent = cost ? currency.format(cost) : '-';
  $('#summary-total').textContent = lineValue ? currency.format(lineValue) : '-';
  $('#summary-supplier').textContent = purchase ? supplier?.nama || '-' : 'Tidak berlaku';
  $('#summary-note').textContent = values.catatan?.trim() || '-';
  $('#note-count').textContent = `${values.catatan?.length || 0}/500`;
}

async function loadData() {
  $('#refresh-button').disabled = true;
  try {
    const [inventory, transactionRows, supplierRows] = await Promise.all([
      request('/api/persediaan'),
      request('/api/transaksi'),
      request('/api/pemasok'),
    ]);
    materials = inventory;
    suppliers = supplierRows;
    transactions = transactionRows;
    renderInventory(inventory);
    renderTransactions(transactionRows);
    renderSuppliers(supplierRows);
    renderOptions();
    $('#material-count').textContent = inventory.length;
    $('#inventory-value').textContent = currency.format(inventory.reduce((total, item) => total + Number(item.nilai_persediaan || 0), 0));
    $('#low-stock-count').textContent = inventory.filter((item) => Number(item.stok_tersedia) <= Number(item.stok_minimum)).length;
    const today = new Date().toLocaleDateString('sv-SE');
    const todaysTransactions = transactionRows.filter((row) => new Date(row.dibuat_pada).toLocaleDateString('sv-SE') === today);
    const todaysPurchases = todaysTransactions.filter((row) => row.jenis === 'pembelian');
    $('#today-transaction-count').textContent = todaysTransactions.length;
    $('#today-purchase-value').textContent = currency.format(todaysPurchases.reduce((total, row) => total + Number(row.jumlah) * Number(row.harga_satuan), 0));
    updateMovementSummary();
  } catch (error) {
    showNotice(error.message, true);
    $('#inventory-rows').innerHTML = '<tr><td colspan="6" class="empty-cell">Data tidak dapat dimuat. Periksa koneksi backend dan Supabase.</td></tr>';
    $('#supplier-rows').innerHTML = '<tr><td colspan="2" class="empty-cell">Data pemasok tidak dapat dimuat.</td></tr>';
    $('#transaction-rows').innerHTML = '<tr><td colspan="5" class="empty-cell">Riwayat transaksi tidak dapat dimuat.</td></tr>';
    $('#recent-transaction-rows').innerHTML = '<tr><td colspan="5" class="empty-cell">Aktivitas tidak dapat dimuat.</td></tr>';
  } finally {
    $('#refresh-button').disabled = false;
  }
}

$('#show-material-form').addEventListener('click', () => {
  const form = $('#material-form');
  form.hidden = !form.hidden;
  if (!form.hidden) form.elements.nama.focus();
});

$('#show-supplier-form').addEventListener('click', () => {
  const form = $('#supplier-form');
  form.hidden = !form.hidden;
  if (!form.hidden) form.elements.nama.focus();
});

document.querySelectorAll('[data-view]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.view));
});
document.querySelectorAll('[data-open-view]').forEach((button) => {
  button.addEventListener('click', () => showView(button.dataset.openView));
});
$('#menu-toggle').addEventListener('click', () => {
  const isOpen = $('#sidebar').classList.toggle('open');
  $('#menu-toggle').setAttribute('aria-expanded', String(isOpen));
});
window.addEventListener('hashchange', () => showView(window.location.hash.slice(1)));
showView(window.location.hash.slice(1));

$('#material-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/bahan-baku', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    form.elements.stok_minimum.value = '0';
    form.hidden = true;
    showNotice('Bahan baku berhasil ditambahkan.');
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#movement-form').elements.jenis.addEventListener('change', (event) => {
  const purchase = event.target.value === 'pembelian';
  $('#cost-field').hidden = !purchase;
  $('#supplier-section').hidden = !purchase;
  $('#movement-form').elements.harga_satuan.required = purchase;
  updateMovementSummary();
});
$('#movement-form').addEventListener('input', updateMovementSummary);
$('#movement-form').addEventListener('change', updateMovementSummary);
$('#movement-form').addEventListener('reset', () => window.setTimeout(updateMovementSummary));

$('#movement-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = Object.fromEntries(new FormData(form));
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/transaksi', {
      method: 'POST',
      body: JSON.stringify({
        ...values,
        harga_satuan: values.jenis === 'pembelian' ? Number(values.harga_satuan) : null,
        pemasok_id: values.pemasok_id || null,
      }),
    });
    form.reset();
    $('#cost-field').hidden = false;
    $('#supplier-section').hidden = false;
    form.elements.harga_satuan.required = true;
    updateMovementSummary();
    showNotice(values.jenis === 'pembelian' ? 'Pembelian berhasil dicatat.' : 'Pemakaian berhasil dicatat.');
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#supplier-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await request('/api/pemasok', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    showNotice('Pemasok berhasil ditambahkan.');
    await loadData();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$('#refresh-button').addEventListener('click', loadData);
updateMovementSummary();
loadData();
