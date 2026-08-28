-- expire_stale_reservations: bound one sweep, so an overrun cannot roll back
-- every hold it had already released.
-- Applied to production 2026-08-28. Idempotent; safe to re-run.
--
-- The function drained the WHOLE backlog of expired holds in a single
-- transaction, with no per-tick limit. `for update skip locked` keeps it from
-- blocking a live checkout, but it does not bound the work: the transaction
-- holds every row it touches until commit, and if the drain ever exceeds the
-- statement or function budget the whole thing rolls back and NOTHING is
-- released. The next tick then attempts the same, now larger, doomed drain —
-- so past a certain backlog expired reservations keep stock off sale forever,
-- and the sweep reports a failure rather than partial progress.
--
-- Every other sweep in this codebase already carries a per-tick bound
-- (MEMBERSHIP_CHARGE_BATCH = 25, HOLD_SWEEP_BATCH = 200, CAMPAIGN_BATCH_SIZE
-- = 25, RECONCILE_MAX_PAGES = 10). This one was the outlier.
--
-- Safe to split: released rows leave the `status = 'active'` filter, so the
-- next tick continues rather than repeating, and OLDEST FIRST means the holds
-- that have been sitting on stock longest are always the ones released first —
-- there is no starvation. The signature is unchanged, so inventory-reservation.ts
-- needs no coordinated deploy.
--
-- 20,000 is far above any plausible half-hour of abandoned checkouts (holds
-- expire in 15 minutes and the sweep runs every 30), while still bounding the
-- transaction. Reaching it is logged, because a sweep that hits the ceiling
-- every tick means holds are being created faster than they are reclaimed.

create or replace function public.expire_stale_reservations()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  n integer := 0;
  batch_limit constant integer := 20000;
begin
  for r in
    select res.id, res.slug, res.variant_id, res.quantity
      from public.inventory_reservations res
     where res.status = 'active' and res.expires_at < now()
       and not exists (
         select 1 from public.orders o
          where o.order_id = res.order_id
            and o.payment_status in ('paid', 'partially_refunded')
       )
     order by res.expires_at
     for update skip locked
     limit batch_limit
  loop
    if r.variant_id is not null and r.variant_id <> '' then
      update public.product_doses
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where id::text = r.variant_id;
    else
      update public.products
         set reserved_quantity = greatest(0, reserved_quantity - r.quantity), updated_at = now()
       where slug = r.slug;
    end if;
    update public.inventory_reservations set status = 'released', updated_at = now() where id = r.id;
    n := n + 1;
  end loop;

  if n >= batch_limit then
    raise warning 'expire_stale_reservations released the full per-tick batch of % holds; more remain for the next sweep', batch_limit;
  end if;

  return n;
end;
$$;

-- Restate the posture the function must keep. `create or replace` does NOT
-- touch a function ACL, so production already held exactly this — but a
-- migration that creates a SECURITY DEFINER function has to say so beside it,
-- or the next reader has to go and check. Verified against production before
-- and after: anon and authenticated cannot execute it; only postgres and
-- service_role can, which is what the server-side sweep uses.
revoke all on function public.expire_stale_reservations() from public, anon, authenticated;
