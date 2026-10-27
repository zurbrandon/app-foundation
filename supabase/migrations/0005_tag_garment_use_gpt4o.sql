-- wearwell.tag_garment: switch to gpt-4o, and price the flat charge to cover cost.
--
-- Measured, not assumed. The same 900x1200 garment photo through the deployed
-- gateway:
--
--   gpt-4o-mini   25,601 input tokens   $0.003861
--   gpt-4o            865 input tokens   $0.002463
--
-- mini is the cheaper model per token and the more expensive one per image: it
-- multiplies image tokens roughly 33x (2833 base + 5667 per tile, against
-- gpt-4o's 85 + 170). For a vision operation that inverts the usual choice —
-- gpt-4o came out 36% cheaper and tagged the shirt better, reading a microdot
-- pattern and formality 4 where mini said polka dots and 3.
--
-- The flat charge was also underwater. At credits_per_usd = 1000 a tag costs
-- about 2.5 credits of real money while we were charging 1, so every tag lost
-- money. 3 covers it with a little room.

update foundation.ai_operations
   set model                 = 'gpt-4o',
       input_usd_per_mtok    = 2.50,
       output_usd_per_mtok   = 10.00,
       credits_flat          = 3,
       max_output_tokens     = 300
 where operation = 'wearwell.tag_garment';
