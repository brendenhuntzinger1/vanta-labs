# Database Compatibility Report

Generated: 2026-07-19T23:35:32.860Z

## Summary

- Tables referenced in app code: 24
- Missing tables: 4
- Tables with column mismatches: 0
- RPC functions referenced: 1
- Missing RPC functions: 1

## Table Compatibility

| Table | Exists in Supabase | Required Columns Match | Required Column Count |
|---|---|---|---|
| public.admin_audit_logs | Yes | Yes | 5 |
| public.admin_credentials | Yes | Yes | 4 |
| public.admin_login_attempts | Yes | Yes | 1 |
| public.admin_sessions | Yes | Yes | 3 |
| public.ambassadors | Yes | Yes | 5 |
| public.commissions | Yes | n/a | 0 |
| public.coupons | No | n/a | 1 |
| public.inventory_items | No | n/a | 2 |
| public.notification_queue | No | n/a | 1 |
| public.order_items | Yes | Yes | 2 |
| public.order_shipments | No | n/a | 1 |
| public.orders | Yes | Yes | 13 |
| public.partner_clicks | Yes | Yes | 2 |
| public.partner_payouts | Yes | Yes | 1 |
| public.partner_program_stats | Yes | Yes | 2 |
| public.partners | Yes | Yes | 10 |
| public.payment_events | Yes | Yes | 1 |
| public.payouts | Yes | n/a | 0 |
| public.product_doses | Yes | Yes | 17 |
| public.product_images | Yes | Yes | 6 |
| public.products | Yes | Yes | 28 |
| public.referral_orders | Yes | Yes | 6 |
| public.referrals | Yes | n/a | 0 |
| public.website_analytics_events | Yes | Yes | 1 |

## Missing Tables

- public.coupons
  - Probe error: {"code":"PGRST205","details":null,"hint":"Perhaps you meant the table 'public.commissions'","message":"Could not find the table 'public.coupons' in the schema cache"}
- public.inventory_items
  - Probe error: {"code":"PGRST205","details":null,"hint":"Perhaps you meant the table 'public.order_items'","message":"Could not find the table 'public.inventory_items' in the schema cache"}
- public.notification_queue
  - Probe error: {"code":"PGRST205","details":null,"hint":null,"message":"Could not find the table 'public.notification_queue' in the schema cache"}
- public.order_shipments
  - Probe error: {"code":"PGRST205","details":null,"hint":"Perhaps you meant the table 'public.order_items'","message":"Could not find the table 'public.order_shipments' in the schema cache"}

## RPC Compatibility

| RPC Function | Exists in Supabase | Probe Result |
|---|---|---|
| public.validate_referral_code | No | {"code":"PGRST202","details":"Searched for the function public.validate_referral_code without parameters or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.","hint":null,"message":"Could not find the function public.validate_referral_code without parameters in the schema cache"} |
