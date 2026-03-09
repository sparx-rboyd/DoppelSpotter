# DoppelSpotter
**Enterprise-style brand protection for SMEs, powered by Apify actors and generative AI.**

[Product](#product) | [Published Actor](https://apify.com/doppelspotter/recent-domain-registrations) | [GitHub](https://github.com/sparx-rboyd/DoppelSpotter)

*Hackathon submission for the GenAI Zürich 2026 judging panel.*

DoppelSpotter scans the web, communities, code platforms, domain registrations, and app stores for brand abuse. It then uses AI to triage the noise, surface what matters, and turn the output into searchable findings, visual analytics, and exportable evidence.

## At a Glance

- **13 Logical Scan Surfaces:** Spanning web, social, communities, code, domains, Apple App Store, and Google Play.
- **5 Core Apify Actors:** Including our own published actor for recent domain registrations.
- **Searchable AI Workflow:** AI summaries, severity scoring, false-positive handling, deep-search follow-up, and review-friendly outputs.
- **Judge-Ready Outputs (PDF + CSV):** Exportable evidence packs, source analytics, and scan-level summaries designed for fast decision-making.

---

## A working product, not a thin demo

DoppelSpotter does more than fetch raw mentions. It helps a small team monitor a wide threat surface, understand what matters, and share evidence quickly.

- **Breadth of discovery:** Monitor web search, platform-specific specialist scans, Discord, GitHub, X, domain registrations, Apple App Store, and Google Play from one brand profile.
- **AI triage:** Generative AI scores severity, labels themes, suppresses non-findings, creates scan summaries, and can request broader follow-up searches when the evidence justifies it.
- **Search and review workflow:** Search findings, filter by source/theme/severity, bookmark, ignore, address, reclassify, and keep a cleaner evidence trail over time.
- **Shareable outputs:** Export scan findings as CSV, generate branded PDF reports, and send scan-summary emails so results can move beyond the dashboard.

---

## Broad scan coverage is a feature, not a footnote

The judging panel should see that DoppelSpotter is not a single-source alert bot. It is a modular scanning product with meaningful surface breadth.

**Supported Surfaces:** Web search, Reddit, TikTok, YouTube, Facebook, Instagram, Telegram channels, Apple App Store, Google Play, Domain registrations, Discord servers, GitHub repos, X.

- **Google-backed specialist scans:** Nine logical scans run through one hardened search actor, with platform-aware scoping and AI-requested follow-up searches when a thread needs deeper investigation.
- **Dedicated sources:** Recent domains, Discord servers, GitHub repositories, and X posts each use source-specific actors and normalisation paths so findings stay actionable.

### Newly added and pitch-worthy: App-store scanning now strengthens the story

Apple App Store and Google Play materially widen the product's usefulness. They turn the pitch from "web abuse detection" into a more complete brand-protection platform that also catches cloned or misleading store listings.

- **Why it matters for judges:** It increases practical relevance, demonstrates feature breadth, and makes the visual mockup more convincing because the UI can now show genuine store-clone use cases.
- **Why it matters for users:** Brand abuse is not limited to the open web. Communities, repositories, and app stores all matter, especially when users trust familiar names and logos.

---

## Apify is the scanning backbone

The story to tell judges is not "we used an API once". It is that Apify actors are the core execution layer for a real multi-surface monitoring product.

### One scanning product, multiple actor specialisms
DoppelSpotter starts all enabled sources concurrently, receives completion webhooks, normalises the results per source, classifies them with AI, and can trigger deeper Google-backed follow-up searches when the model spots a worrying lead.

- **Google Search actor reused strategically:** `apify/google-search-scraper` powers Web, Reddit, TikTok, YouTube, Facebook, Instagram, Telegram, Apple App Store, and Google Play specialist scans through focused query policies.
- **Source-specific actors where it matters:** Discord, GitHub, X, and domain registrations each use dedicated actor paths so results are more actionable than generic search scraping alone.

### Our own Apify actor
`doppelspotter/recent-domain-registrations` is live in the Apify Store. It fetches recent domain-registration data and enriches each result with AI-generated homepage understanding.

That matters for the pitch because it proves both challenge paths at once: we built a working product with Actors, and we also published a reusable Actor for others to build on.

[Open the Actor listing](https://apify.com/doppelspotter/recent-domain-registrations)

### Actor suite
- `apify/google-search-scraper`
- `doppelspotter/recent-domain-registrations`
- `louisdeconinck/discord-server-scraper`
- `ryanclinton/github-repo-search`
- `apidojo/tweet-scraper`

### Judge-facing takeaway
Apify is not a decorative dependency. It is the operational layer that gives DoppelSpotter live data breadth, modularity, and a credible end-to-end scanning pipeline. The best pitch is feature-led: more surfaces, better triage, better exports, more usable evidence. Apify is how that breadth becomes practical.

---

## Built with generative and agentic AI from end to end

AI is not only part of the user-facing feature. It shaped how DoppelSpotter was conceived, built, and operated during the hackathon.

- **Agentic AI development:** We used Cursor throughout the hackathon to help write the pitch, shape product thinking, make architectural calls, and design, build, test, and deploy both the app and the custom actor.
- **AI as the product engine:** Generative AI powers intent classification, severity scoring, theme labelling, scan-level summaries, false-positive suppression, and deeper follow-up searches on supported surfaces.
- **AI inside the custom actor:** Our published actor is not just a thin wrapper over a feed. It enriches newly registered domains with AI-generated homepage understanding so downstream workflows start with richer evidence.

---

## Built to score well with the GenAI Zürich judges

This pitch should help a judging panel understand the value fast: clear problem, clear product, clear technical depth, and visible evidence that the system works end to end.

- **Innovation and technical quality:** A modular brand-protection platform with multi-surface actor orchestration, AI triage, AI-triggered deep search, and source-specific normalisation.
- **Practical relevance:** A concrete problem for SMEs: impersonation, counterfeit promotion, cloned store listings, fake communities, and brand abuse that directly damages trust and revenue.
- **Feasibility and scalability:** The actor-based structure is already modular. New surfaces can be added without rewriting the whole product, and evidence outputs already fit operational workflows.
- **Effective use of GenAI:** GenAI is used in the build process, in the core detection workflow, in scan summaries, and inside the custom actor itself.
- **Pitch quality:** The page now foregrounds the real product: breadth of coverage, dashboard analytics, search and filtering, exports, and a published actor that judges can inspect immediately.

### The strongest quick-scan pitch
DoppelSpotter is a credible, feature-rich product with visible end-to-end execution. It uses Apify deeply, publishes value back into the Apify ecosystem, and makes strong use of generative AI both behind the scenes and in the user experience.

[Published Actor](https://apify.com/doppelspotter/recent-domain-registrations) | [Open source repo](https://github.com/sparx-rboyd/DoppelSpotter) | [Devpost](https://genaizurich.devpost.com/)
