create extension if not exists pgcrypto;

create table if not exists public.bahan_baku (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique check (char_length(trim(nama)) between 1 and 100),
  satuan text not null check (char_length(trim(satuan)) between 1 and 30),
  stok_minimum numeric(14, 3) not null default 0 check (stok_minimum >= 0),
  dibuat_pada timestamptz not null default now()
);

create table if not exists public.pemasok (
  id uuid primary key default gen_random_uuid(),
  nama text not null unique check (char_length(trim(nama)) between 1 and 120),
  kontak text check (kontak is null or char_length(trim(kontak)) <= 120),
  dibuat_pada timestamptz not null default now()
);

create table if not exists public.transaksi_persediaan (
  id uuid primary key default gen_random_uuid(),
  bahan_baku_id uuid not null references public.bahan_baku(id) on delete restrict,
  pemasok_id uuid references public.pemasok(id) on delete restrict,
  jenis text not null check (jenis in ('pembelian', 'pemakaian')),
  jumlah numeric(14, 3) not null check (jumlah > 0),
  harga_satuan numeric(14, 2) not null check (harga_satuan > 0),
  catatan text check (catatan is null or char_length(catatan) <= 500),
  dibuat_pada timestamptz not null default now(),
  check (jenis = 'pembelian' or pemasok_id is null)
);

create index if not exists transaksi_persediaan_bahan_waktu_idx
  on public.transaksi_persediaan (bahan_baku_id, dibuat_pada);
create index if not exists transaksi_persediaan_waktu_idx
  on public.transaksi_persediaan (dibuat_pada desc);

create or replace view public.ringkasan_persediaan
with (security_invoker = true)
as
select
  b.id,
  b.nama,
  b.satuan,
  b.stok_minimum,
  coalesce(sum(case when t.jenis = 'pembelian' then t.jumlah else -t.jumlah end), 0)::numeric(14, 3) as stok_tersedia,
  coalesce(sum(case when t.jenis = 'pembelian' then t.jumlah * t.harga_satuan else -t.jumlah * t.harga_satuan end), 0)::numeric(16, 2) as nilai_persediaan,
  case
    when coalesce(sum(case when t.jenis = 'pembelian' then t.jumlah else -t.jumlah end), 0) > 0
    then (
      sum(case when t.jenis = 'pembelian' then t.jumlah * t.harga_satuan else -t.jumlah * t.harga_satuan end)
      / sum(case when t.jenis = 'pembelian' then t.jumlah else -t.jumlah end)
    )::numeric(14, 2)
    else 0::numeric(14, 2)
  end as biaya_rata_rata
from public.bahan_baku b
left join public.transaksi_persediaan t on t.bahan_baku_id = b.id
group by b.id, b.nama, b.satuan, b.stok_minimum;

create or replace function public.catat_pergerakan_persediaan(
  p_bahan_baku_id uuid,
  p_jenis text,
  p_jumlah numeric,
  p_harga_satuan numeric default null,
  p_pemasok_id uuid default null,
  p_catatan text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stok numeric;
  v_nilai numeric;
  v_biaya numeric;
  v_harga numeric;
  v_id uuid;
begin
  if p_jenis not in ('pembelian', 'pemakaian') then
    raise exception 'Jenis transaksi harus pembelian atau pemakaian.';
  end if;
  if p_jumlah is null or p_jumlah <= 0 then
    raise exception 'Jumlah harus lebih dari nol.';
  end if;

  perform 1
  from public.bahan_baku
  where id = p_bahan_baku_id
  for update;
  if not found then
    raise exception 'Bahan baku tidak ditemukan.';
  end if;

  select
    coalesce(sum(case when jenis = 'pembelian' then jumlah else -jumlah end), 0),
    coalesce(sum(case when jenis = 'pembelian' then jumlah * harga_satuan else -jumlah * harga_satuan end), 0)
  into v_stok, v_nilai
  from public.transaksi_persediaan
  where bahan_baku_id = p_bahan_baku_id;

  if p_jenis = 'pembelian' then
    if p_harga_satuan is null or p_harga_satuan <= 0 then
      raise exception 'Harga pembelian harus lebih dari nol.';
    end if;
    v_harga := p_harga_satuan;
  else
    if p_jumlah > v_stok then
      raise exception 'Stok tidak mencukupi. Stok tersedia: %.', v_stok;
    end if;
    if v_stok <= 0 then
      raise exception 'Tidak ada stok yang dapat digunakan.';
    end if;
    v_biaya := v_nilai / v_stok;
    v_harga := round(v_biaya, 2);
  end if;

  insert into public.transaksi_persediaan (
    bahan_baku_id, pemasok_id, jenis, jumlah, harga_satuan, catatan
  ) values (
    p_bahan_baku_id,
    case when p_jenis = 'pembelian' then p_pemasok_id else null end,
    p_jenis,
    p_jumlah,
    v_harga,
    nullif(trim(p_catatan), '')
  )
  returning id into v_id;

  return v_id;
end;
$$;

alter table public.bahan_baku enable row level security;
alter table public.pemasok enable row level security;
alter table public.transaksi_persediaan enable row level security;

revoke all on public.bahan_baku, public.pemasok, public.transaksi_persediaan from anon, authenticated;
revoke all on public.ringkasan_persediaan from anon, authenticated;
grant select, insert on public.bahan_baku, public.pemasok to service_role;
grant select on public.transaksi_persediaan, public.ringkasan_persediaan to service_role;
revoke all on function public.catat_pergerakan_persediaan(uuid, text, numeric, numeric, uuid, text) from public, anon, authenticated;
grant execute on function public.catat_pergerakan_persediaan(uuid, text, numeric, numeric, uuid, text) to service_role;

grant usage on schema public to anon;
grant select on public.bahan_baku, public.pemasok, public.transaksi_persediaan to anon;
grant select (id, nama, satuan, stok_minimum) on public.bahan_baku to anon;
grant insert (nama, satuan, stok_minimum) on public.bahan_baku to anon;
grant select (id, nama, kontak) on public.pemasok to anon;
grant insert (nama, kontak) on public.pemasok to anon;
grant select (id, bahan_baku_id, pemasok_id, jenis, jumlah, harga_satuan, catatan, dibuat_pada)
  on public.transaksi_persediaan to anon;
grant select on public.ringkasan_persediaan to anon;
grant execute on function public.catat_pergerakan_persediaan(uuid, text, numeric, numeric, uuid, text) to anon;

drop policy if exists "anon_read_bahan_baku" on public.bahan_baku;
create policy "anon_read_bahan_baku" on public.bahan_baku
  for select to anon using (true);
drop policy if exists "anon_add_bahan_baku" on public.bahan_baku;
create policy "anon_add_bahan_baku" on public.bahan_baku
  for insert to anon with check (true);

drop policy if exists "anon_read_pemasok" on public.pemasok;
create policy "anon_read_pemasok" on public.pemasok
  for select to anon using (true);
drop policy if exists "anon_add_pemasok" on public.pemasok;
create policy "anon_add_pemasok" on public.pemasok
  for insert to anon with check (true);

drop policy if exists "anon_read_transaksi" on public.transaksi_persediaan;
create policy "anon_read_transaksi" on public.transaksi_persediaan
  for select to anon using (true);
