create or replace function public.current_auth_email() returns text language sql stable as $function$ select lower(auth.jwt() ->> 'email'); $function$;
create or replace function public.current_auth_role() returns text language sql stable as $function$ select auth.jwt() ->> 'role'; $function$;
create or replace function public.current_auth_uid() returns uuid language sql stable as $function$ select auth.uid(); $function$;
create or replace function public.order_attribution_touch_updated_at() returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin new.updated_at := now(); return new; end; $function$;
create or replace function public.admin_ops_summary(p_today_start timestamptz, p_month_start timestamptz)
 returns table(live_sales_today numeric, live_sales_month numeric, new_customers bigint, returning_customers bigint, total_customers bigint)
 language sql stable security definer set search_path to 'public','pg_temp' as $function$
  with per_customer as (
    select customer_email, count(*) as cnt from public.orders
    where payment_status = 'paid' and customer_email is not null group by customer_email
  )
  select coalesce((select sum(coalesce(amount_paid,0)) from public.orders where payment_status='paid' and created_at >= p_today_start),0),
         coalesce((select sum(coalesce(amount_paid,0)) from public.orders where payment_status='paid' and created_at >= p_month_start),0),
         coalesce((select count(*) from per_customer where cnt=1),0),
         coalesce((select count(*) from per_customer where cnt>1),0),
         coalesce((select count(*) from per_customer),0);
$function$;
create or replace function public.admin_points_outstanding() returns numeric language sql stable security definer set search_path to 'public','pg_temp' as $function$
  select coalesce(sum(amount),0) from public.points_ledger;
$function$;
