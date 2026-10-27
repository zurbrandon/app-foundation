-- Wearwell's operations.
--
-- NOTE ON STRUCTURE: this is app-specific data sitting in the shared
-- foundation repo, which only works because the foundation is currently
-- deployed into exactly one project. When a second app arrives, each app wants
-- its own migrations directory — foundation migrations plus its own — and this
-- file moves there. Flagged rather than solved now because solving it before
-- there is a second app would be guesswork about what the second app needs.
--
-- Pricing is the provider's list price, recorded so real cost can be compared
-- against what users were charged. Changing model is an UPDATE here; the app
-- never names one.
--
-- Garment tagging is flat-charged: the user pays the same per piece regardless
-- of how many tokens a particular photo costs, which is what keeps a balance
-- meaning "about this many garments" rather than a meter to watch.

insert into foundation.ai_operations
  (operation, provider, model, charge_mode, credits_flat,
   input_usd_per_mtok, output_usd_per_mtok, max_output_tokens, params)
values
  ('wearwell.tag_garment', 'openai', 'gpt-4o-mini', 'flat', 1,
   0.15, 0.60, 512, '{"temperature": 0}'::jsonb)
on conflict (operation) do update set
  provider            = excluded.provider,
  model               = excluded.model,
  charge_mode         = excluded.charge_mode,
  credits_flat        = excluded.credits_flat,
  input_usd_per_mtok  = excluded.input_usd_per_mtok,
  output_usd_per_mtok = excluded.output_usd_per_mtok,
  max_output_tokens   = excluded.max_output_tokens,
  params              = excluded.params,
  enabled             = true,
  updated_at          = now();
