# Medium — Playwright setup (publikace pres prohlizec)

Medium nevydava API tokeny, takze pouzivame Playwright browser automaci.
Princip: jednorazove se prihlasite, cookies se ulozi, a pak je workflow pouziva headless.

---

## 1. Lokalni prihlaseni (jednorazove)

Spustte na lokalnim pocitaci (potrebujete GUI prohlizec):

```bash
cd medium-poster
pip install .
playwright install chromium
python -c "
import asyncio
from agent_m.publishers.medium_playwright import MediumPlaywrightPublisher
asyncio.run(MediumPlaywrightPublisher().login())
"
```

Otevire se okno Chromium na `medium.com/m/signin`.
Prihlaste se (Google/email/cokoliv) a pockejte nez budete na `medium.com`.
Cookies se automaticky ulozi do `data/medium_cookies.json`.

> **Alternativne** muzete pouzit Telegram prikaz `/medium_login`
> (vyzaduje bezici bot na stroji s GUI).

---

## 2. Zakodovani cookies do base64

```bash
base64 -w 0 data/medium_cookies.json
```

Vystup (dlouhy retezec) si zkopirujte do schranky.

---

## 3. Pridani GitHub secretu

1. Jdete na: **github.com/kubiczech808/apps/settings/secrets/actions**
2. Kliknete **New repository secret**
3. Name: `MEDIUM_COOKIES`
4. Value: vlozite base64 retezec z kroku 2
5. **Add secret**

---

## 4. Hotovo

Workflow uz je nakonfigurovany:

- `MEDIUM_PLAYWRIGHT=true` v `.env`
- Krok **Restore Medium cookies** dekoduje secret do `data/medium_cookies.json`
- Krok **Install Playwright browser** se spusti automaticky kdyz existuje `MEDIUM_COOKIES` secret

Pri dalsim publish runu Agent M automaticky publikuje i na Medium.

---

## Obnova cookies (kdyz expiruje session)

Medium cookies typicky vydrzi tydny az mesice. Kdyz vyprsi:

1. V debug issue uvidite chybu: `Session expired — cookies are invalid`
2. Zopakujte kroky 1-3 vyse
3. Aktualizujte `MEDIUM_COOKIES` secret novou hodnotou

---

## Struktura

```
medium-poster/
  data/
    medium_cookies.json   ← lokalni cookies (v .gitignore)
  agent_m/
    publishers/
      medium_playwright.py  ← Playwright publisher
    config.py               ← MEDIUM_PLAYWRIGHT=true/false
```
