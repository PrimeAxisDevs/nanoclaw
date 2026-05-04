# JARVIS-007 Client Onboarding Checklist

> Hand this to every new client after they sign up. Walk through it together on the onboarding call.

---

## Before the Call

- [ ] Send client the pre-onboarding form (phone number, city, timezone, primary calendar email)
- [ ] Confirm they have a WhatsApp number they'll use for JARVIS
- [ ] Spin up their n8n instance (or confirm access to shared instance)
- [ ] Duplicate the JARVIS-007 workflow templates into their workspace

---

## Section 1 — Credentials (30 min)

### Anthropic (Claude AI)
- [ ] Client creates account at console.anthropic.com
- [ ] Generate API key → copy to n8n credential: **HTTP Header Auth** → name `x-api-key`
- [ ] Recommended model: `claude-opus-4-5` (set in all Claude nodes)

### WhatsApp Business API
- [ ] Client creates Meta Business account at business.facebook.com
- [ ] Add WhatsApp product → set up phone number
- [ ] Copy **Phone Number ID** and **WhatsApp Business Account ID**
- [ ] Generate permanent token → n8n credential: **HTTP Bearer Auth**
- [ ] Set webhook URL in Meta App Dashboard:
  - URL: `https://YOUR_N8N_DOMAIN/webhook/jarvis-007`
  - Verify token: (set a custom string, match in webhook node)
  - Subscribe to: `messages`
- [ ] Test: send a message from client's personal WhatsApp to JARVIS number

### Google Calendar
- [ ] Client goes to Google Cloud Console → create project "JARVIS-007"
- [ ] Enable **Google Calendar API** and **Google People API**
- [ ] Create OAuth2 credentials (Desktop app type)
- [ ] Add n8n credential: **Google Calendar OAuth2** → authenticate
- [ ] Note primary calendar ID (usually their Gmail address)

### Weather API (OpenWeatherMap)
- [ ] Client creates free account at openweathermap.org
- [ ] Copy API key → paste into Weather nodes in n8n
- [ ] Set city name in weather nodes (e.g. "Sydney,AU")

### Search API (for Find/Book operations — optional)
- [ ] Client creates SerpAPI account (serpapi.com) — free tier: 100 searches/mo
- [ ] Copy API key → paste into Search node

---

## Section 2 — Workflow Configuration (20 min)

### Intelligence Core Workflow
- [ ] Import `jarvis-007-intelligence-core.json` into n8n
- [ ] Set **YOUR_PHONE_NUMBER** in the Identity Check node (international format, no +)
  - Example: `61412345678` for Australian number
- [ ] Set **PHONE_NUMBER_ID** in all WhatsApp send nodes
- [ ] Set **CALENDAR_ID** in Google Calendar nodes (`primary` works for main calendar)
- [ ] Attach credentials to all nodes (Claude, WhatsApp, Google Calendar)
- [ ] Activate workflow

### Daily Briefing Workflow
- [ ] Import `jarvis-007-daily-briefing.json` into n8n
- [ ] Set phone number + phone number ID in WhatsApp send node
- [ ] Set city + weather API key
- [ ] Confirm timezone in n8n instance settings matches client timezone
- [ ] Activate workflow
- [ ] Ask client: "Do you want 7AM briefings every day, or just weekdays?"
  - Weekdays only: change cron to `0 7 * * 1-5`

---

## Section 3 — Personalisation (15 min)

These are set in conversation with the client — JARVIS learns and stores them.

- [ ] Ask client to message JARVIS: _"Remember that I prefer meetings after 10am"_
- [ ] Ask client to message JARVIS: _"My timezone is [timezone]"_
- [ ] Ask client to message JARVIS: _"My work calendar is [email], personal is [email]"_
- [ ] Set up any recurring reminders they want (e.g. "remind me every Friday arvo to review the week")
- [ ] Test each operation type:
  - [ ] Schedule: _"Book a coffee with Sarah next Tuesday at 10am"_
  - [ ] Briefing: _"Give me a briefing"_
  - [ ] Message: _"Draft a message to Tom saying I'll be 10 minutes late"_
  - [ ] Find: _"Find me a good Italian restaurant near the CBD for dinner Saturday"_

---

## Section 4 — Handoff

- [ ] Share n8n login credentials with client (or set up their own login)
- [ ] Walk through the workflow canvas — show them the flow visually
- [ ] Show them execution history in n8n (left sidebar → Executions)
- [ ] Explain: "If JARVIS ever misunderstands, just reply with more detail — it'll try again"
- [ ] Share the client support contact (your details)
- [ ] Book 2-week check-in call

---

## Credentials Reference Card

_Send this to the client after onboarding (fill in their values):_

```
JARVIS-007 — Your Credentials

WhatsApp Number:    _______________
JARVIS Number:      _______________
n8n Dashboard:      _______________
n8n Login:          _______________

To wake JARVIS:     Just message your JARVIS number
Briefings:          7AM daily + 6PM Sunday

Support:            _______________
```

---

## Common Issues & Fixes

| Problem | Fix |
|---|---|
| JARVIS not responding | Check Meta webhook subscription is active |
| "Unauthorized" responses | Verify phone number in Identity Check node (no + prefix) |
| Calendar events not showing | Re-authenticate Google Calendar credential |
| Briefings not arriving | Check n8n timezone matches client timezone, confirm workflow is active |
| Wrong calendar | Set correct `calendarId` in Google Calendar nodes |
| Claude errors | Check API key is valid, check Anthropic account has credits |
