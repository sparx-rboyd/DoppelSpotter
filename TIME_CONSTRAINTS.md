## UI changes

Under the existing brand settings > scan settings section, add a new 'Lookback period' setting with options:
 - 1 year (default)
 - 1 month
 - 1 week
 - Since last scan

 Tootlip: "How far back (in time) scans should look for findings."

 Also include an info banner within the setting: "When you first create a brand, we recommend that you 


## Google-backed scan types

For these Google-back scan types...

- Web search
- Reddit
- TikTok
- YouTube
- Facebook
- Instagram
- Telegram channels
- Apple App Store
- Google Play

... append a after:<YYYY-MM-DD> operator to the google search query to time constrain the focus of the search (add an extra day for buffering). For example
 - If today is 10th March 2026 and the user has selected the 1 year lookback period, append after:2025-03-09
 - If the last scan for the brand was on 3rd March 2026, append after:2026-03-02


### Domain registrations scan type

Pass in the relevant date, alongside the 'Greater than or equal to' date comparison setting (allowing the same 1 day buffer as described above)


### Discord servers scan type

Doesn't support constraining search results by date so we can't apply the new logic to this


### GitHub repos scan type

Add created:>YYYY-MM-DD / pushed:>YYYY-MM-DD to the search terms (allowing the same 1 day buffer as described above)

### X scan type

Pass in the relevant date (start date param) (allowing the same 1 day buffer as described above)