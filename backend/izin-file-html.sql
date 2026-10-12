grant usage on schema public to anon;

grant select on public.bahan_baku, public.pemasok, public.transaksi_persediaan to anon;
grant insert on public.bahan_baku, public.pemasok to anon;
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
