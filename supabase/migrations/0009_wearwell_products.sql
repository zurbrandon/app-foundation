-- Wearwell's credit packs.
--
-- Only the mapping from a product to credits lives here. What it *costs* is
-- set in App Store Connect (or Stripe), because the store owns the money and
-- the currency and the regional pricing, and duplicating that here would just
-- create two numbers that can disagree.
--
-- Sized against the measured cost of a tag: 3 credits each, so 1000 credits is
-- 333 garments, around 90c of provider spend.
--
-- Same NOTE as 0004: app-specific rows in the shared foundation repo only work
-- while there is one app. When the second arrives these move to that app's own
-- migrations directory.

insert into foundation.products (product_id, credits, description) values
  ('wearwell.credits_1000', 1000, '1,000 credits — about 330 garment tags')
on conflict (product_id) do update
  set credits = excluded.credits, description = excluded.description, updated_at = now();
