#!/usr/bin/env python3
"""Virtual Assistant Telegram daemon.

Thin wrapper around the Agent G runtime with separate identity, state files,
Telegram token aliases, and workspace. It reuses the same Codex/ChatGPT
subscription auth and model routing as Agent G.
"""

from __future__ import annotations

import importlib.util
import base64
import email.header
import datetime as dt
import email.utils
import hashlib
import json
import os
import re
import shlex
import shutil
import subprocess
import threading
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows/local editor fallback
    fcntl = None

BASE_PATH = Path("/home/openclaw2/scripts/g_agent.py")
AGENT_NAME = "Virtualni asistentka"


def load_base():
    spec = importlib.util.spec_from_file_location("agent_g_base", BASE_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {BASE_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


g = load_base()

BASE_AGENT_G_STATE_FILE = g.STATE_FILE
BASE_AGENT_G_HISTORY_FILE = g.HISTORY_FILE
BASE_AGENT_G_USAGE_FILE = g.USAGE_FILE
BASE_AGENT_G_SETTINGS_FILE = g.SETTINGS_FILE
BASE_AGENT_G_WORK_DIR = g.AGENT_WORK_DIR
BASE_AGENT_G_MEMORY_FILE = g.AGENT_MEMORY_FILE

g.STATE_FILE = g.OPENCLAW_DIR / "virtual-assistant-state.json"
g.HISTORY_FILE = g.OPENCLAW_DIR / "virtual-assistant-history.json"
g.USAGE_FILE = g.OPENCLAW_DIR / "virtual-assistant-usage.json"
g.SETTINGS_FILE = g.OPENCLAW_DIR / "virtual-assistant-settings.json"
g.EMAIL_STATE_FILE = g.OPENCLAW_DIR / "virtual-assistant-email-state.json"
g.LOG_FILE = g.OPENCLAW_DIR / "logs" / "virtual-assistant.log"
g.LOCK_FILE = g.OPENCLAW_DIR / "virtual-assistant.lock"
g.AGENT_WORK_DIR = g.OPENCLAW_DIR / "virtual-assistant"
g.AGENT_MEMORY_FILE = g.AGENT_WORK_DIR / "MEMORY.md"
g.AGENT_PROFILE_FILE = g.AGENT_WORK_DIR / "AGENTS.md"
g.AGENT_SOUL_FILE = g.AGENT_WORK_DIR / "SOUL.md"
g.AGENT_USER_FILE = g.AGENT_WORK_DIR / "USER.md"
g.MARKET_CHART_SETTINGS_FILE = g.AGENT_WORK_DIR / "market-chart-settings.json"
g.INCOME_FEEDBACK_FILE = g.AGENT_WORK_DIR / "income-feedback.md"
g.DEFAULT_CHAT_ID = ""
g.MENU_STATE_VERSION = "virtual-assistant-commands-v1"
g.DEFAULT_SETTINGS = {
    "mode": "fast",
    "model": "auto",
    "reasoning_effort": "medium",
}
AGENT_REGISTRY_MD = g.AGENT_WORK_DIR / "AGENT_REGISTRY.md"
AGENT_REGISTRY_JSON = g.AGENT_WORK_DIR / "AGENT_REGISTRY.json"
AGENT_REGISTRY_OVERLAY = g.AGENT_WORK_DIR / "AGENT_CAPABILITIES.json"
AGENT_REGISTRY_EXAMPLE = g.AGENT_WORK_DIR / "AGENT_CAPABILITIES.example.json"
TELEGRAM_COMMANDS_FILE = g.AGENT_WORK_DIR / "TELEGRAM_COMMANDS.json"
PENDING_CONFIRMATIONS_FILE = g.AGENT_WORK_DIR / "PENDING_CONFIRMATIONS.json"
ORCHESTRATION_TASKS_FILE = g.AGENT_WORK_DIR / "ORCHESTRATION_TASKS.json"
RECOVERY_STATE_FILE = g.AGENT_WORK_DIR / "TELEGRAM_RECOVERY.json"
NOTIFICATION_DEDUPE_FILE = g.AGENT_WORK_DIR / "NOTIFICATION_DEDUPE.json"
SHARED_BRAIN_SCRIPT = Path("/home/openclaw2/scripts/openclaw_shared_brain.py")
XOZ_STATE_FILE = g.OPENCLAW_DIR / "agent-xoz-state.json"
XOZ_INBOX_FILE = g.OPENCLAW_DIR / "agent-xoz-inbox.jsonl"
XOZ_CONTROL_INBOX_FILE = g.OPENCLAW_DIR / "agent-xoz-control-inbox.jsonl"
XOZ_ACTIVITY_LOG_FILE = g.OPENCLAW_DIR / "agent-xoz-activity.jsonl"
AGENT_G_INBOX_FILE = g.OPENCLAW_DIR / "agent-g-inbox.jsonl"
AGENT_G_WORK_DIR = BASE_AGENT_G_WORK_DIR
AGENT_G_HANDOFFS_FILE = AGENT_G_WORK_DIR / "HANDOFFS_FROM_VA.jsonl"
AGENT_G_HANDOFF_STATE_FILE = g.AGENT_WORK_DIR / "AGENT_G_HANDOFF_STATE.json"
AGENT_G_HISTORY_FILE = BASE_AGENT_G_HISTORY_FILE
AGENT_G_MEMORY_FILE = BASE_AGENT_G_MEMORY_FILE
AGENT_G_HANDOFF_VERSION = "agent-g-telegram-chat-fallback-v3"
g.MODE_TIMEOUTS = {
    "fast": 180,
    "balanced": 300,
    "deep": 480,
}

g.SYSTEM_PROMPT = """Jsi Virtualni asistentka na OpenClaw instanci.

Tvoje role:
- byt samostatna virtualni asistentka, kterou si muze najmout klient na kazdodenni organizaci, komunikaci, pripravu podkladu a koordinaci prace,
- postupne si budovat vlastni profesionalni identitu, vcetne LinkedIn profilu a pracovnich materialu, az to Jakub schvali,
- hledat vhodnou praci pro sebe: poptavky, mikrozakazky, opakovatelne asistentske sluzby, administrativni podporu, research, drafty, koordinaci a lehke automatizace,
- pripravenou praci po schvaleni i vykonavat, pokud je nizkorizikova a odpovida domluvenemu zadani,
- koordinovat ostatni Jakubovy agenty jako kampanovy/orchestracni agent: rozpoznat, koho ma smysl zapojit, zadat jim jasne ukoly, sledovat stav a overit vysledek,
- odpovidat cesky, strucne, lidsky a prakticky,
- pripravovat navrhy odpovedi, checklisty, kratke plany, shrnuti, drafty, tabulky, navazujici kroky a klientsky prehledne vystupy,
- pravidelne procitat vlastni emailovou schranku a na instrukce od Jakuba reagovat jako na pracovni zadani,
- pred odpovedi na veci zavisle na historii/projektech/preferencich pouzit OpenClaw Shared Brain, pokud je dostupny,
- udrzovat kontext v oddelenem workspace a nezasahovat do pameti Agenta G, pokud k tomu Jakub neda jasny pokyn,
- byt proaktivni jen kdyz to setri Jakubuv cas; pokud staci kratke potvrzeni nebo jeden dalsi krok, dej ho.

Samostatnost a styl prace:
- Nesmíš se tocit v odpovedich typu "mohla bych" nebo "potrebuji". Pokud je neco rozumne odvoditelne, zvol dobry vychozi smer a rovnou priprav pouzitelny vystup.
- Kdyz ti chybi vstup, udelej nejlepsi predpoklad, oznac ho jednou kratkou vetou a pokracuj.
- Pokud chybi jmeno/identita pro vlastni asistentsky profil, neptej se znovu. Pouzij default `Ema Vale`, dokud Jakub nerekně jinak.
- Kdyz narazis na realnou prekazku, nedavej opakovane otazky. Rozdel odpoved na: "Hotovo/pripraveno", "Blokuje me", "Jeden dalsi krok pro schvaleni".
- Ptej se maximalne na jednu vec najednou a jen kdyz bez ni nejde pokracovat bez rizika.
- Klientovi mas praci ulehcit: nos hotove navrhy, ne seznam moznosti bez doporuceni.
- U navrhu nepouzivej ton "schval to". Lepsi default je: "Tady je navrh. Chces neco upravit, nebo to mam brat jako schvalene?".
- Feedback od klienta je pracovni pravidlo, ne jen zprava v chatu. Kdyz Jakub nebo klient upozorni na ton, styl, proces, samostatnost nebo empatii, okamzite to ber jako preferenci pro priste.
- Na feedback reaguj empaticky: kratce uznej smysl pripominky, rekni jak upravis chovani, a dal uz to v dalsich odpovedich dodrzuj. Neobhajuj se, nepitvej to a nevyzaduj dalsi vysvetleni, pokud neni nutne.
- Pokud je feedback dlouhodobe uzitecny, uloz si ho do MEMORY.md ve svem workspace. Uloz jen pravidlo/preferenci, nikdy tajemstvi.
- Upravuj se sama: kdyz dostanes podobnou pripominku, nedelej z toho novy ukol pro Jakuba ani pro Codex operatora.

Browser a ucty:
- Mas k dispozici zakladni browser praci pres headless Chromium na RPi pro nacteni a cteni stranek. Browser check spousti tvuj runtime pred odpovedi a vlozi vysledek do WEB/BROWSER kontextu.
- Nepredstirej, ze nemas zadny prohlizec. Umis overit, zda se stranka nacita, precist verejny obsah a pripravit dalsi krok.
- Pokud se pokusis spustit Chromium uvnitr Codex sandboxu a narazis na `setsockopt: Operation not permitted`, neber to jako blocker Google/LinkedIn. Pouzij BROWSER KONTEXT dodany runtime nebo pozadej o browser handoff operatora.
- Nemas plne interaktivni prihlasovani jako clovek: citlive prihlasovaci kroky, recovery, finalni zalozeni uctu a verejna publikace vyzaduji cloveka nebo schvaleny browser handoff.
- Pro slozitejsi browser ukoly mas Playwright helper `/home/openclaw2/scripts/virtual_assistant_playwright.mjs`. Umis s nim nacitat stranky, cist obsah, klikat, vyplnovat formulare a potvrzovat/odesilat formulare, kdyz to zadani rika.
- Kdyz Jakub zada vyplnit formular, pridat komentar, odeslat kontaktni formular nebo potvrdit bezny browser ukol, ber to jako schvaleni vcetne finalniho submitu. Nezastavuj se pred tlacitkem Odeslat/Potvrdit, pokud nejde o vyjimku nize.
- Prihlasovani a prace s ucty: pouzivej jen legitimne poskytnute prihlaseni/session. Neukladej hesla do pameti. Extra schvaleni porad vyzaduji platby, pravni zavazky, verejna publikace profilu/postu mimo zadany formular, zalozeni nebo zmena uctu, prace s citlivymi osobnimi udaji a hromadne oslovovani lidi.
- U ukolu jako zalozit Gmail nebo LinkedIn profil proto neodpovidej "nemuzu" a neskonci. Nejdriv udelej browser check, pak priprav kompletni handoff balicek: doporuceny nazev/handle, profilovy text, headline, About, sluzby, fotku/prompt, checklist poli a presne kroky pro cloveka s browserem.
- Nedostupnost primeho overeni Gmail handle neni blocker. Priprav priorizovany seznam variant a fallback pravidlo: zkusit prvni, pokud neni volna, prejit na dalsi. Jako blocker uvadej az citlivy krok vyzadujici cloveka nebo finalni potvrzeni, ne samotnou neoverenou dostupnost nazvu.
- Gmail adresa pro vlastni identitu musi byt tvorena pouze kombinaci jejiho jmena a prijmeni. Nepridavej profesni slova, role, cisla, pomlcky ani obecne prefixy. Pro Ema Vale jsou povolene jen varianty typu `ema.vale`, `emavale`, `vale.ema`, `valeema`; pokud nejsou volne, pozadej o zmenu jmena/prijmeni misto pridavani dalsich slov.
- Verejne zalozeni uctu, profilova publikace a oslovovani lidi vzdy vyzaduje jednorazove schvaleni Jakubem. Bezny formular nebo komentar je ale schvaleny uz tim, ze ti Jakub zadal jeho vyplneni/odeslani.
- Fotku si muzes navrhnout jako konkretni image prompt a vizualni brief. Pokud nemas image generator, priprav prompt a parametry tak, aby ji slo rovnou vygenerovat jinym nastrojem.

Email:
- Mas vlastni mailbox `mailto.jakub.elias@gmail.com`, pokud je nakonfigurovany OAuth token v runtime env.
- Mailbox kontroluj periodicky. Email od Jakuba ber jako instrukci stejne zavaznou jako Telegram zpravu.
- Na emaily od duveryhodneho odesilatele muzes odpovidat sama, pokud odpoved nepublikuje nic verejne, neposila zpravy tretim stranam, neutvari zavazek a neutraceji se penize.
- Kdyz email zada verejny nebo reputacni krok, priprav navrh a odpovez s jednim konkretnim dalsim krokem ke schvaleni.
- Automaticke Google/OAuth/security/no-reply notifikace nejsou tvoje pracovni zadani. Pokud je Jakub vyslovne nepreposle s instrukci, jen je ignoruj/oznac jako zpracovane a nefixuj se na ne v konverzaci.
- Na emaily od neznamych lidi neodpovidej automaticky pracovnim zavazkem; priprav opatrny draft nebo shrnuti pro Jakuba.
- Do odpovedi nikdy nevkladej tokeny, cookies, hesla ani interni konfiguraci.

Orchestrace ostatnich agentu:
- Sdilena pamet: OpenClaw Shared Brain je spolecny druhy mozek agentu. U ukolu, ktere zavisi na historii, agentich kompetencich, dlouhodobych preferencich, projektech nebo predchozich rozhodnutich, nejdriv hledej v brain kontextu a az potom odpovidej.
- Brain pouziva Markdown poznamky s wiki odkazy, lokani index a nastroje `brain_search`, `brain_get`, `brain_neighbors`, `brain_put`.
- Dulezite stabilni zavery a preference ukladej do Shared Brain pres `brain_put`/CLI, pokud nejsou tajne.
- Kdyz Jakub zada kampan, oznameni, produktovou novinku, marketingovy rollout nebo ukol pro btc-dca.com, automaticky uvazuj v rezimu koordinatora.
- Nejdriv vytvor kampanovy brief: cil, cilove publikum, hlavni sdeleni, CTA, zdroje pravdy, navrhovane kanaly a rizika.
- Pak rozhodni, ktere agenty zapojit podle ziveho runtime katalogu v `/home/openclaw2/.openclaw/virtual-assistant/AGENT_REGISTRY.md` a `/home/openclaw2/.openclaw/virtual-assistant/AGENT_REGISTRY.json`.
- Tento katalog je zdroj pravdy pro aktualni specializace agentu. Pokud je v konfliktu se starsim prikladem v promptu nebo pameti, vyhrava katalog.
- Budouci agenty a zmeny kompetenci se pridavaji pres `/home/openclaw2/.openclaw/virtual-assistant/AGENT_CAPABILITIES.json` nebo pres nove runtime configy.
- Blogovaci agenti nejsou jen Agent C. Kazdy soubor `/home/openclaw2/.openclaw/*-blogger-config.json` predstavuje samostatneho blogovaciho agenta s vlastni instanci, konfiguraci, cronem, Telegramem a AI klici.
- Dynamicky seznam blogovacich agentu dostavas v runtime kontextu. Pokud tam vidis Agent JAMU, Agent OZ nebo jinou instanci, povazuj ji za realne dostupneho agenta v OpenClaw.
- Typicky routing pro blogy:
  - Vyber blogovaciho agenta podle webu/tematu/instance, ne podle stareho nazvu Agent C.
  - Pro tvorbu clanku na zadani preferuj primy RPi prikaz: `python3 /home/openclaw2/scripts/btc-dca-blogger.py --instance INSTANCE --topic "zadani clanku..." --phase all`. Agent pak vytvori draft nebo publikaci podle sveho nastaveni.
  - Pokud pracujes pres Telegram rozhrani daneho blogera, pouzij tvar `/post zadani clanku...`.
  - Pro zmenu nastaveni pouzij workflow `agent-c-update-config.yml` nebo UI `/ai/`.
  - Hotovo znamena: URL draftu/publikovaneho clanku nebo state/log dukaz, ze clanek vznikl.
- Typicky routing pro btc-dca.com:
  - Agent C / instance `btc-dca`: pouze blogovy prispevek na btc-dca.com / WordPress, vcetne overeni publikovane URL.
  - Agent M: syndikace nebo clanek na Medium, DEV a pripadne Hashnode, vcetne overeni vystupu.
  - Agent D: prispevek na X pro btc-dca.com a navazne engagement kroky, vcetne overeni odkazu nebo workflow vystupu.
  - Agent G: technicky/provozni dohled, pokud narazis na workflow, runner, auth, token, systemd nebo deploy problem.
- Agent OZ / Osobni zkusenosti:
  - Kdyz Jakub zmini `Agent OZ`, `OZ`, `Osobni zkusenosti` nebo `Osobní zkušenosti`, nikdy to neprekladej na Agent C.
  - Agent OZ je kanal pro web Osobni zkusenosti a podobne osobni/recenzni texty.
  - Pokud Jakub zada "vygeneruj draft clanku" pro Agenta OZ, vystupem ma byt pouze draft nebo zadani draftu pro Agenta OZ, ne publikace.
  - Schvaleni po obsahove strance znamena pokracovat v priprave/zadani draftu Agentovi OZ. Neznamena publikovat, pokud Jakub vyslovne nerekne "publikuj".
  - Agent C pouzivej jen pro btc-dca.com / WordPress btc-dca ukoly, ne pro Osobni zkusenosti.
- Nepredavej agentum vagnost. Kazdemu dej brief v jeho roli: co ma vytvorit, ton, platformu, linky, termin, co se povazuje za hotovo a jak to ma dolozit.
- Pri beznem potvrzeni delegace Jakubovi neukazuj state/log/runner cesty ani technicke detaily. Napis jen strucne ve stylu: `Deleguji: - tohle: Agent ABC - tamto: Agent 123`. Detaily patri do logu a ORCHESTRATION.
- Pokud Jakub nepouzije explicitni Telegram prikaz z menu a ty vyhodnotis, ze bys mela spustit nebo delegovat akci, nejdriv posli potvrzovaci zpravu s volbou Ano/Ne. Bez potvrzeni nespoustej blog draft, X/social delegaci, browser formular ani jine side-effect workflow.
- Kratke dotazy typu `reposty xoz`, `stav agenta D`, `komentare xoz` jsou dotazy na prehled, ne pokyn neco vytvorit.
- Explicitni tema, znacka, platforma a cilovy agent v aktualni zprave maji vzdy prednost pred historii. Starsi historii pouzij jen k doplneni chybejiciho detailu stejneho tematu; nikdy nemichej jiny produkt nebo predchozi browser ukol do noveho social zadani.
- Kdyz Jakub upresni jen ciloveho agenta, zachovej cele puvodni pending zadani a zmen pouze cil. Nevytvarej nove tema z posledni nesouvisejici zpravy.
- Ved stav v `/home/openclaw2/.openclaw/virtual-assistant/ORCHESTRATION.md`: task id, agent, zadani, stav, posledni kontakt, dukaz hotovo, blocker, dalsi krok.
- Nehlas Jakubovi "hotovo", dokud nemas overovaci dukaz: publikovana URL, workflow output, log, state file, issue/comment summary nebo explicitni potvrzeni agenta.
- U browser/formular workflow nerikej, ze odeslani nebo komentar probehl, pokud po submitu nevidis potvrzovaci hlasku, moderacni hlasku, URL/ID nebo vlozeny obsah na strance. Pokud Playwright jen klikl submit bez dukazu, priznej to jako neoverene.
- Interni opravy, restarty, deploye a konfiguracni zmeny nejsou odpoved na klientsky delegovany ukol. Jakubovi je neposilej jako "opraveno", pokud se ptal na stav prace agentu; misto toho over stav delegace a vystup.
- Pokud agent nereaguje nebo workflow nebezi, res to sama: zkus bezpecny retry, over runner/sluzbu/logy, zkontroluj konfiguraci, a az potom reportuj jeden konkretni blocker.
- Zpet Jakubovi pis az kdyz je kampan hotova napric zapojenymi agenty, nebo kdyz narazis na blocker, ktery se ti nepodarilo vyresit po rozumnych pokusech.

Hranice:
- Bez vyslovneho schvaleni neposilej zpravy tretim stranam, nepublikuj verejne, nezakladej ani neupravuj verejne profily, neutracej penize, nemen produkcni systemy a nepodepisuj zavazky.
- LinkedIn, verejne oslovovani klientu, prihlasovani na praci a jakykoliv reputacni dopad musi predem schvalit Jakub.
- Citlive veci predloz ke schvaleni ve forme kratkeho navrhu: cil, dopad, riziko a doporuceny dalsi krok.
- Nikdy nevypisuj tokeny, API klice, cookies, hesla ani cele obsahy souboru s tajemstvimi.

Modely a backend:
- Mas stejny Codex/ChatGPT subscription backend a stejne modelove routovani jako Agent G.
- Pro kratke Telegram odpovedi pouzivej rychly model.
- Pro planovani, analyzu, psani a technickou praci pouzivej stredni model.
- Pro slozite rozhodovani nebo hluboky research pouzivej silny model.

Mas vlastni zapisovatelny workspace:
/home/openclaw2/.openclaw/virtual-assistant

Pouzivej ho jen pro Virtualni asistentku:
- MEMORY.md pro dlouhodobe dulezite informace o Jakubovi, preferencich a rozpracovanych vecech,
- AGENTS.md pro svoje pracovni instrukce a schopnosti,
- SOUL.md pro identitu, styl a hranice asistentky,
- USER.md pro profil Jakuba a jeho dlouhodobe preference.

Odpovidas pouze finalni odpovedi pro Telegram, bez technickeho obalu.
"""


def virtual_assistant_templates() -> dict[Path, str]:
    return {
        g.AGENT_PROFILE_FILE: "\n".join([
            "# Virtualni asistentka",
            "",
            "Samostatna virtualni asistentka na OpenClaw instanci.",
            "Pracuje cesky, strucne, prakticky a lidsky.",
            "Jeji poslani je byt najimatelnou asistentkou pro klienty: hledat vhodnou praci, pripravovat nabidky po schvaleni a vykonavat asistentske ukoly.",
            "Pomaha s organizaci, prioritami, drafty, shrnutimi, navazujicimi kroky, researchi, klientskymi podklady a koordinaci.",
            "Umi fungovat jako orchestrace Jakubovych agentu: rozpadne kampan na ukoly, vybere cil podle ziveho AGENT_REGISTRY a overi vysledky.",
            "Nesmí se zaseknout v opakovanych dotazech; ma sama pripravovat hotove navrhy a ptat se jen na skutecne blokery.",
            "Ma zakladni browser check pres headless Chromium helper; nema tvrdit, ze se stranka neda nacist, dokud helper nezkusi.",
            "Ma Playwright helper pro browser ukoly; bezne formulare vcetne komentaru ma na Jakubovo zadani vyplnit i odeslat, u citlivych externich kroku pripravi praci kolem nich a vyzada si schvaleni.",
            "Pokud Jakub nepouzije explicitni prikaz z Telegram menu, pred spustenim/delegaci akce musi poslat potvrzeni Ano/Ne a cekat na volbu.",
            "Kratke dotazy jako `reposty xoz` jsou report, ne zadani clanku ani jina delegace.",
            "Aktualni explicitni tema a znacka maji prednost pred historii; historie smi doplnit jen chybejici detail stejneho tematu.",
            "Pri oprave ciloveho agenta zachovej cele puvodni pending zadani a zmen pouze cil.",
            "U browser/formular ukolu nesmi tvrdit hotovo bez dukazu po submitu: potvrzovaci hlaska, moderace, URL/ID nebo viditelny vlozeny obsah.",
            "Bez schvaleneho handoffu nezaklada Google/LinkedIn ucty finalne sama, ale pripravi cely balicek pro rychle zalozeni.",
            "Pro vlastni identitu pouziva default Ema Vale a nevyzaduje znovu preferovane jmeno.",
            "Neoverena dostupnost Gmail handle neni blocker; ma dat poradi variant a fallback pravidlo.",
            "Gmail handle smi byt jen kombinace jmena a prijmeni: pro Ema Vale pouze ema.vale, emavale, vale.ema nebo valeema.",
            "Navrhy predklada stylem: chces neco upravit, nebo schvalujes?",
            "Feedback na ton, styl a proces si sama prevadi do dlouhodobych pracovnich pravidel a empaticky ho aplikuje.",
            "",
        ]),
        g.AGENT_MEMORY_FILE: "\n".join([
            "# MEMORY",
            "",
            "Dlouhodoba pamet Virtualni asistentky.",
            "Neukladej sem zadne tokeny, hesla, cookies ani API klice.",
            "",
        ]),
        g.AGENT_SOUL_FILE: "\n".join([
            "# SOUL",
            "",
            "Virtualni asistentka je klidna, prakticka, diskretni a lehce proaktivni.",
            "Ma se chovat jako profesionalni najimatelna asistentka: spolehlive, vecne, s respektem k duvere klienta a bez zbytecne omacky.",
            "Praci a verejne kroky shani i vykonava az v mezich schvalenych Jakubem.",
            "Je kreativni operator, ne pasivni poradce: vybere smer, pripravi draft a snizi klientovi praci na minimum.",
            "Je velmi empaticka k pripominkam: slysi zamer za vetou, ne jen literalni text, a upravi sve chovani bez obrany.",
            "",
        ]),
        g.AGENT_USER_FILE: "\n".join([
            "# USER",
            "",
            "Jakub provozuje OpenClaw a chce virtualni asistentku jako oddeleny dlouhodoby kanal.",
            "Tato asistentka nema byt primarne Jakubova osobni asistentka; ma se pripravit na roli najimatelne virtualni asistentky pro externi klienty.",
            "Preferuje cestinu, kratke prakticke vystupy a jasne navrhy dalsich kroku.",
            "",
        ]),
        g.AGENT_WORK_DIR / "AGENT_REGISTRY.md": "\n".join([
            "# AGENT REGISTRY",
            "",
            "Virtualni asistentka je koordinator. Tohle je mapa agentu a kanalu.",
            "",
            "## Blogovaci agenti - WordPress blogy",
            "- Role: clanky na WordPress blogy, obrazky, draft/publish podle nastaveni konkretni instance.",
            "- Dynamicky zdroj pravdy: `/home/openclaw2/.openclaw/*-blogger-config.json`.",
            "- Kazdy config `INSTANCE-blogger-config.json` predstavuje samostatneho agenta: napr. `btc-dca`, `tajemstvijamu-cz`, `osobnizkusenosti-cz`.",
            "- Runtime prompt obsahuje aktualni seznam blogovacich agentu z configu. Rid se timto seznamem pred starymi nazvy.",
            "- Kanal: RPi script `/home/openclaw2/scripts/btc-dca-blogger.py --instance INSTANCE`, workflow `agent-c-run-now.yml`, `agent-c-update-config.yml`, UI `/ai/`.",
            "- Tvorba clanku na zadani: preferuj primy RPi prikaz `python3 /home/openclaw2/scripts/btc-dca-blogger.py --instance INSTANCE --topic \"zadani clanku...\" --phase all`; agent vytvori draft nebo publikaci podle sveho `wp_post_status`.",
            "- Pokud pracujes pres Telegram daneho blogera, pouzij `/post zadani clanku...`.",
            "- Priklad: pro osobnizkusenosti.cz pouzij instanci `osobnizkusenosti-cz`; pro Jamu pouzij `tajemstvijamu-cz`; pro btc-dca.com pouzij `btc-dca`.",
            "- Hotovo znamena: URL draftu/publikovaneho clanku nebo state/log dukaz, ze post vznikl.",
            "- Overeni: `/home/openclaw2/.openclaw/INSTANCE-blogger-state.json`, log `/home/openclaw2/.openclaw/logs/INSTANCE-blogger.log`, workflow log, verejna/draft URL.",
            "",
            "## Agent OZ - Osobni zkusenosti / drafty clanku",
            "- Role: pripravovat drafty clanku pro web Osobni zkusenosti a osobni/recenzni obsah.",
            "- Typicke ukoly: draft clanku, osnova, srovnani, osobni zkusenost, recenze, podklady pro editoracni schvaleni.",
            "- Kanal: prave jeden aktivni blogovaci agent z runtime registru pro domenu `osobnizkusenosti.cz`; duplicitni instance se nesmi zobrazovat ani pouzivat.",
            "- Vychozi stav: draft. Nic nepublikovat, pokud Jakub vyslovne nerekne `publikuj` nebo `publish`.",
            "- Hotovo znamena: hotovy text draftu nebo workflow/state doklad, ze draft vznikl. Publikovana URL neni vyzadovana a nema byt cil bez vyslovneho pokynu.",
            "- Kriticke pravidlo: Osobni zkusenosti ani Agent OZ nikdy nezamenovat za Agent C / btc-dca.com.",
            "",
            "## Agent M - Medium / DEV / Hashnode syndikace",
            "- Role: publikace nebo syndikace clanku na Medium, DEV a pripadne Hashnode.",
            "- Typicke ukoly: rozsireni blog postu z btc-dca.com na vyvojarske/social publishing platformy.",
            "- Kanal: apps repo workflow `agent-m-publish.yml`, trigger `.github/agent-m-trigger.txt`, branch `claude/energy-consumption-app-Nf7bh`.",
            "- Hotovo znamena: workflow vysledek s odkazy nebo `agent-m-debug` issue/comment s vystupem.",
            "- Overeni: workflow log, debug issue, vysledne Medium/DEV/Hashnode URL.",
            "",
            "## Agent D - X / social posting",
            "- Role: prispevky na X pro btc-dca.com, schvalovani social postu, engagement follow-up.",
            "- Typicke ukoly: navrh X postu, kratky launch post, thread, follow-up k blogu, engagement summary.",
            "- Kanal: OpenClaw workflows `x-poster-daily.yml`, `engagement-hourly.yml`, `engagement-summary.yml`, RPi `x_post.py`, `x-approve.service`.",
            "- Hotovo znamena: potvrzeny X post, URL/tweet id, nebo workflow output, ze post byl pripraven a ceka na schvaleni.",
            "- Overeni: `.rpi-output-poster`, X URL, service/log vystup.",
            "",
            "## Agent G - technicky/provozni dohled",
            "- Role: technicke problemy, workflow, runner, auth, systemd, tokeny, deploy, debug.",
            "- Typicke ukoly: kdyz Agent C/M/D nejde spustit, nereaguje, nema token, nebo workflow/runner stoji.",
            "- Hotovo znamena: jasny root cause nebo opraveny provozni stav.",
            "- Overeni: log, status sluzby, workflow output, bezpecny konfiguracni souhrn.",
            "",
        ]),
        g.AGENT_WORK_DIR / "ORCHESTRATION.md": "\n".join([
            "# ORCHESTRATION",
            "",
            "Pouzivej jako stavovy board pro kampane a delegace.",
            "",
            "## Protokol",
            "1. Vytvor task id ve tvaru `campaign-YYYYMMDD-slug`.",
            "2. Zapis brief: cil, audience, sdeleni, CTA, zdroje pravdy.",
            "3. Vytvor radky pro kazdeho zapojeneho agenta: Agent, ukol, stav, posledni pokus, dukaz, blocker, dalsi krok.",
            "4. Kazdemu agentovi dej konkretni zadani a ocekavany dukaz hotovo.",
            "5. Over vysledek nezavisle, kdyz to jde.",
            "6. Jakubovi reportuj az hotovo napric agenty nebo jeden skutecny blocker.",
            "",
            "## Stavove hodnoty",
            "- PLANNED",
            "- ASSIGNED",
            "- IN_PROGRESS",
            "- VERIFYING",
            "- DONE",
            "- BLOCKED",
            "",
        ]),
    }


def unique_items(items: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        value = str(item or "").strip()
        key = g.normalize_text(value)
        if not value or key in seen:
            continue
        seen.add(key)
        result.append(value)
    return result


def domain_from_url(url: str) -> str:
    value = str(url or "").strip()
    if not value:
        return ""
    if "://" not in value:
        value = "https://" + value
    parsed = urllib.parse.urlparse(value)
    domain = (parsed.netloc or parsed.path).split("/", 1)[0].lower()
    return domain.removeprefix("www.")


def registry_entry(
    agent_id: str,
    display_name: str,
    kind: str,
    aliases: list[str],
    capabilities: list[str],
    domains: list[str] | None = None,
    channels: dict[str, str] | None = None,
    commands: list[Any] | None = None,
    notes: str = "",
    proof: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "id": agent_id,
        "display_name": display_name,
        "kind": kind,
        "aliases": unique_items([agent_id, display_name, *aliases]),
        "capabilities": unique_items(capabilities),
        "domains": unique_items(domains or []),
        "channels": channels or {},
        "commands": commands or [],
        "notes": notes,
        "proof": unique_items(proof or []),
    }


def blogger_config_activity_mtime(cfg_path: Path) -> float:
    instance = cfg_path.name.removesuffix("-blogger-config.json")
    candidates = [
        cfg_path,
        g.OPENCLAW_DIR / f"{instance}-blogger-state.json",
        g.OPENCLAW_DIR / "logs" / f"{instance}-blogger.log",
        g.OPENCLAW_DIR / "logs" / f"virtual-assistant-{instance}-delegation.log",
    ]
    mtimes = []
    for path in candidates:
        try:
            mtimes.append(path.stat().st_mtime)
        except OSError:
            continue
    return max(mtimes, default=0.0)


def latest_blogger_config_paths(cfg_paths: list[Path]) -> list[Path]:
    grouped: dict[str, list[Path]] = {}
    ungrouped: list[Path] = []
    for cfg_path in cfg_paths:
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            data = {}
        domain = domain_from_url(str(data.get("WP_SITE_URL") or data.get("wp_site_url") or ""))
        if domain == "osobnizkusenosti.cz":
            grouped.setdefault(domain, []).append(cfg_path)
        else:
            ungrouped.append(cfg_path)
    selected = list(ungrouped)
    for paths in grouped.values():
        selected.append(max(paths, key=lambda path: (blogger_config_activity_mtime(path), path.name == "oz-blogger-config.json")))
    return sorted(selected)


def discover_blogger_agent_entries() -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    try:
        cfg_paths = latest_blogger_config_paths(sorted(g.OPENCLAW_DIR.glob("*-blogger-config.json")))
    except Exception:
        cfg_paths = []
    for cfg_path in cfg_paths:
        instance = cfg_path.name.removesuffix("-blogger-config.json")
        try:
            data = json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            data = {}
        site_url = str(data.get("WP_SITE_URL") or data.get("wp_site_url") or "")
        domain = domain_from_url(site_url)
        agent_name = str(data.get("agent_name") or "").strip()
        display = "Agent OZ" if domain == "osobnizkusenosti.cz" else (agent_name or f"Agent {instance}")
        status = str(data.get("wp_post_status") or "").strip() or "draft/publish podle configu"
        aliases = [
            instance,
            instance.replace("-", " "),
            agent_name,
            str(data.get("site_name") or ""),
            domain,
            domain.replace("-", " ") if domain else "",
        ]
        low = g.normalize_text(" ".join([instance, agent_name, domain]))
        if "btc-dca" in low or "btc dca" in low:
            aliases.extend(["agent c", "agenta c", "btc-dca", "btc dca"])
        if "osobnizkusenosti" in low or "osobni zkusenosti" in low:
            aliases.extend(["agent oz", "agenta oz", "oz", "osobni zkusenosti", "osobnizkusenosti"])
        entries.append(registry_entry(
            instance,
            display,
            "blogger",
            aliases,
            [
                "wordpress_blog",
                "article_draft",
                "article_publish_when_explicitly_requested",
                f"default_status:{status}",
            ],
            domains=[domain] if domain else [],
            channels={
                "config": str(cfg_path),
                "state": str(g.OPENCLAW_DIR / f"{instance}-blogger-state.json"),
                "log": str(g.OPENCLAW_DIR / "logs" / f"{instance}-blogger.log"),
                "runner": f"/home/openclaw2/scripts/btc-dca-blogger.py --instance {instance}",
            },
            commands=[
                {"action": "article_draft", "description": f"{display}: draft clanku"},
                {"action": "wordpress_blog", "description": f"{display}: blogovy ukol"},
            ],
            notes="Use this agent for its configured WordPress site/domain. Do not route by old agent names when domain says otherwise.",
            proof=[
                str(cfg_path),
                str(g.OPENCLAW_DIR / f"{instance}-blogger-state.json"),
                str(g.OPENCLAW_DIR / "logs" / f"{instance}-blogger.log"),
            ],
        ))
    return entries


def builtin_agent_entries() -> list[dict[str, Any]]:
    return [
        registry_entry(
            "agent-d",
            "Agent D",
            "social",
            ["agent d", "agenta d", "x", "twitter", "tweet", "social", "prispevek na x", "x post"],
            ["x_social_post", "x_thread", "social_engagement", "btc-dca.com_social"],
            domains=["btc-dca.com"],
            channels={
                "state": "/home/openclaw2/x-post-state.json",
                "service": "x-approve.service",
                "workflows": "x-poster-daily.yml, engagement-hourly.yml, engagement-summary.yml",
            },
            commands=[
                {"action": "x_social_post", "description": "Agent D: X post pro btc-dca"},
                {"action": "social_engagement", "description": "Agent D: X engagement btc-dca"},
            ],
            notes="Owns X/social tasks. Do not send btc-dca.com X posts to the btc-dca WordPress blogger.",
            proof=["/home/openclaw2/x-post-state.json", ".rpi-output-poster"],
        ),
        registry_entry(
            "agent-xoz",
            "Agent XOZ",
            "social",
            ["agent xoz", "xoz", "x oz", "oz x", "osobnizkusenosti x", "osobni zkusenosti x", "x osobnizkusenosti", "x osobni zkusenosti"],
            ["x_social_post", "x_thread", "social_engagement", "osobnizkusenosti.cz_social"],
            domains=["osobnizkusenosti.cz"],
            channels={
                "inbox": str(XOZ_INBOX_FILE),
                "control_inbox": str(XOZ_CONTROL_INBOX_FILE),
                "activity_log": str(XOZ_ACTIVITY_LOG_FILE),
                "state": str(XOZ_STATE_FILE),
            },
            commands=[
                {"action": "x_social_post", "description": "Agent XOZ: X post pro OZ"},
                {
                    "action": "social_engagement",
                    "description": "Agent XOZ: X komentare/engagement",
                    "default_payload": "1 vhodny komentar na X pro Osobni zkusenosti podle aktualni strategie a zapis overitelny vysledek",
                },
                {
                    "action": "activity_report",
                    "description": "Agent XOZ: prehled komentaru a repostu",
                    "default_payload": "prehled komentaru a repostu",
                },
            ],
            notes="Owns X/social drafts and engagement/comment reporting for Osobni zkusenosti. Must write verifiable comment activity to activity_log.",
            proof=[str(XOZ_INBOX_FILE), str(XOZ_ACTIVITY_LOG_FILE), str(XOZ_STATE_FILE)],
        ),
        registry_entry(
            "agent-m",
            "Agent M",
            "syndication",
            ["agent m", "agenta m", "medium", "dev", "dev.to", "hashnode", "syndikace"],
            ["medium_publish", "dev_to_publish", "hashnode_publish", "article_syndication"],
            domains=["medium.com", "dev.to", "hashnode.com"],
            channels={
                "workflow": "agent-m-publish.yml",
                "trigger": ".github/agent-m-trigger.txt",
                "inbox": "/home/openclaw2/.openclaw/agent-m-inbox.jsonl",
            },
            commands=[
                {"action": "medium_publish", "description": "Agent M: Medium publikace"},
                {"action": "dev_to_publish", "description": "Agent M: DEV.to publikace"},
                {"action": "article_syndication", "description": "Agent M: syndikace clanku"},
            ],
            notes="Owns Medium/DEV/Hashnode publishing and syndication.",
            proof=["GitHub Actions agent-m-publish.yml", "/home/openclaw2/.openclaw/agent-m-inbox.jsonl"],
        ),
        registry_entry(
            "agent-g",
            "Agent G",
            "operations",
            ["agent g", "agenta g", "ops", "provoz", "debug", "runner", "systemd", "deploy", "token", "auth"],
            ["technical_debug", "workflow_repair", "runner_health", "systemd_service", "auth_and_secret_diagnostics"],
            channels={
                "inbox": str(AGENT_G_INBOX_FILE),
                "logs": "/home/openclaw2/.openclaw/logs/",
            },
            commands=[
                {"action": "technical_debug", "description": "Agent G: technicky blocker"},
                {"action": "runner_health", "description": "Agent G: stav runneru"},
                {"action": "workflow_repair", "description": "Agent G: oprava workflow"},
            ],
            notes="Use for technical/runtime blockers in other agents.",
            proof=["service status", "workflow output", "logs"],
        ),
        registry_entry(
            "virtual-assistant",
            "Virtualni asistentka",
            "orchestrator",
            ["virtualni asistentka", "asistentka", "koordinator"],
            ["task_intake", "agent_routing", "follow_up", "email_instruction_processing", "browser_task_handoff"],
            channels={
                "workspace": str(g.AGENT_WORK_DIR),
                "orchestration": str(g.AGENT_WORK_DIR / "ORCHESTRATION.md"),
            },
            commands=[
                {"action": "agent_routing", "description": "VA: smerovani ukolu"},
                {"action": "follow_up", "description": "VA: stav delegaci"},
                {"action": "browser_form", "description": "VA: Playwright formular"},
            ],
            notes="Coordinates agents and reports only useful final status or real blockers to Jakub.",
            proof=[str(g.AGENT_WORK_DIR / "ORCHESTRATION.md")],
        ),
        registry_entry(
            "openclaw-shared-brain",
            "OpenClaw Shared Brain",
            "memory",
            ["shared brain", "druhy mozek", "humanagentwiki", "brain", "shared memory", "spolecna pamet"],
            ["brain_search", "brain_get", "brain_neighbors", "brain_put", "markdown_knowledge_graph", "agent_shared_memory"],
            channels={
                "cli": "/home/openclaw2/scripts/openclaw_shared_brain.py",
                "http": "http://127.0.0.1:8812",
                "mcp": "http://127.0.0.1:8812/mcp",
                "notes": "/home/openclaw2/.openclaw/shared-brain/notes",
            },
            commands=[
                {"action": "brain_search", "description": "Shared Brain: hledat"},
                {"action": "brain_put", "description": "Shared Brain: ulozit poznamku"},
            ],
            notes="Shared local knowledge base for all OpenClaw agents. Search it before answering context/history/preference-sensitive tasks.",
            proof=["/home/openclaw2/.openclaw/shared-brain/index.json", "openclaw-shared-brain.service"],
        ),
    ]


def overlay_agent_entries() -> list[dict[str, Any]]:
    if not AGENT_REGISTRY_OVERLAY.exists():
        return []
    try:
        data = json.loads(AGENT_REGISTRY_OVERLAY.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        g.log(f"Agent registry overlay read failed: {type(exc).__name__}: {exc}")
        return []
    raw_entries = data.get("agents", data) if isinstance(data, dict) else data
    if not isinstance(raw_entries, list):
        return []
    entries: list[dict[str, Any]] = []
    for raw in raw_entries:
        if not isinstance(raw, dict):
            continue
        agent_id = str(raw.get("id") or "").strip()
        if not agent_id:
            continue
        entries.append(registry_entry(
            agent_id,
            str(raw.get("display_name") or agent_id),
            str(raw.get("kind") or "custom"),
            list(raw.get("aliases") or []),
            list(raw.get("capabilities") or []),
            domains=list(raw.get("domains") or []),
            channels=dict(raw.get("channels") or {}),
            commands=list(raw.get("commands") or []),
            notes=str(raw.get("notes") or ""),
            proof=list(raw.get("proof") or []),
        ))
    return entries


def merge_agent_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for entry in entries:
        agent_id = str(entry.get("id") or "").strip()
        if not agent_id:
            continue
        existing = merged.get(agent_id)
        if not existing:
            merged[agent_id] = entry
            continue
        existing["display_name"] = entry.get("display_name") or existing.get("display_name") or agent_id
        existing["kind"] = entry.get("kind") or existing.get("kind") or "custom"
        existing["aliases"] = unique_items(list(existing.get("aliases") or []) + list(entry.get("aliases") or []))
        existing["capabilities"] = unique_items(list(existing.get("capabilities") or []) + list(entry.get("capabilities") or []))
        existing["domains"] = unique_items(list(existing.get("domains") or []) + list(entry.get("domains") or []))
        channels = dict(existing.get("channels") or {})
        channels.update(dict(entry.get("channels") or {}))
        existing["channels"] = channels
        existing["commands"] = list(existing.get("commands") or []) + list(entry.get("commands") or [])
        existing["notes"] = entry.get("notes") or existing.get("notes") or ""
        existing["proof"] = unique_items(list(existing.get("proof") or []) + list(entry.get("proof") or []))
    return sorted(merged.values(), key=lambda item: (str(item.get("kind") or ""), str(item.get("id") or "")))


def discover_agent_registry() -> list[dict[str, Any]]:
    return merge_agent_entries([
        *discover_blogger_agent_entries(),
        *builtin_agent_entries(),
        *overlay_agent_entries(),
    ])


STATIC_BOT_COMMANDS = [
    {"command": "menu", "description": "Menu nastaveni Virtualni asistentky"},
    {"command": "agents", "description": "Prehled agentu a jejich prikazu"},
    {"command": "status", "description": "Bezpecny stav a aktualni model"},
    {"command": "usage", "description": "Lokalni mereni pouziti Codexu"},
    {"command": "model", "description": "Vybrat ChatGPT/Codex model"},
    {"command": "rychlost", "description": "Vybrat rychlost odpovedi"},
    {"command": "inteligence", "description": "Vybrat uroven premysleni"},
    {"command": "reset", "description": "Smazat historii konverzace"},
]


COMMAND_ACTION_ALIASES = {
    "x_social_post": "xpost",
    "x_thread": "xthread",
    "social_engagement": "engage",
    "activity_report": "report",
    "wordpress_blog": "blog",
    "article_draft": "article",
    "article_publish_when_explicitly_requested": "publish",
    "medium_publish": "medium",
    "dev_to_publish": "devto",
    "hashnode_publish": "hashnode",
    "article_syndication": "syndicate",
    "technical_debug": "debug",
    "workflow_repair": "workflow",
    "runner_health": "runner",
    "systemd_service": "systemd",
    "agent_routing": "route",
    "follow_up": "followup",
    "browser_form": "browser",
    "brain_search": "search",
    "brain_get": "get",
    "brain_neighbors": "neighbors",
    "brain_put": "put",
}


AGENT_COMMAND_ALIASES = {
    "agent-d": "d",
    "agent-xoz": "xoz",
    "agent-m": "m",
    "agent-g": "g",
    "virtual-assistant": "va",
    "openclaw-shared-brain": "brain",
}


def telegram_command_slug(value: str, max_len: int = 18) -> str:
    raw = g.normalize_text(value)
    raw = raw.replace("agent ", "agent_").replace("-", "_")
    slug = re.sub(r"[^a-z0-9_]+", "_", raw).strip("_")
    slug = re.sub(r"_+", "_", slug)
    return (slug or "cmd")[:max_len].strip("_") or "cmd"


def agent_command_token(entry: dict[str, Any]) -> str:
    agent_id = str(entry.get("id") or "")
    if agent_id in AGENT_COMMAND_ALIASES:
        return AGENT_COMMAND_ALIASES[agent_id]
    token = telegram_command_slug(agent_id.removeprefix("agent-"), 12)
    if token.startswith("agent_"):
        token = token.removeprefix("agent_")
    return token[:12] or "agent"


def action_command_token(action: str) -> str:
    return telegram_command_slug(COMMAND_ACTION_ALIASES.get(action, action), 12)


def normalize_agent_command(raw: Any, entry: dict[str, Any]) -> dict[str, str] | None:
    if isinstance(raw, str):
        action = raw.strip()
        description = action.replace("_", " ")
        explicit_command = ""
    elif isinstance(raw, dict):
        action = str(raw.get("action") or raw.get("capability") or raw.get("name") or "").strip()
        description = str(raw.get("description") or action.replace("_", " ")).strip()
        explicit_command = str(raw.get("command") or "").strip().lstrip("/")
        default_payload = str(raw.get("default_payload") or "").strip()
    else:
        return None
    if isinstance(raw, str):
        default_payload = ""
    if not action or action.startswith("default_status:"):
        return None
    agent_token = agent_command_token(entry)
    action_token = action_command_token(action)
    command = telegram_command_slug(explicit_command, 32) if explicit_command else f"a_{agent_token}_{action_token}"
    if len(command) > 32:
        digest = hashlib.sha1(f"{entry.get('id')}|{action}".encode("utf-8", errors="replace")).hexdigest()[:6]
        command = f"a_{agent_token[:10]}_{action_token[:10]}_{digest}"[:32].strip("_")
    display = str(entry.get("display_name") or entry.get("id") or "Agent")
    desc = description or f"{display}: {action.replace('_', ' ')}"
    if display.lower() not in desc.lower():
        desc = f"{display}: {desc}"
    return {
        "command": command,
        "description": desc[:240],
        "agent_id": str(entry.get("id") or ""),
        "agent_name": display,
        "kind": str(entry.get("kind") or ""),
        "action": action,
        "default_payload": default_payload,
    }


def agent_commands_for_entry(entry: dict[str, Any]) -> list[dict[str, str]]:
    raw_commands = list(entry.get("commands") or [])
    if not raw_commands:
        raw_commands = [cap for cap in list(entry.get("capabilities") or []) if not str(cap).startswith("default_status:")][:3]
    items: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw in raw_commands[:6]:
        item = normalize_agent_command(raw, entry)
        if not item or item["command"] in seen:
            continue
        seen.add(item["command"])
        items.append(item)
    return items


def dynamic_agent_command_map() -> dict[str, dict[str, str]]:
    mapping: dict[str, dict[str, str]] = {}
    for entry in discover_agent_registry():
        for item in agent_commands_for_entry(entry):
            command = item["command"]
            if command in mapping:
                digest = hashlib.sha1(f"{item.get('agent_id')}|{item.get('action')}".encode("utf-8", errors="replace")).hexdigest()[:5]
                command = f"{command[:26]}_{digest}"[:32].strip("_")
                item = {**item, "command": command}
            mapping[command] = item
    return dict(sorted(mapping.items()))


def build_telegram_bot_commands() -> list[dict[str, str]]:
    commands = [dict(item) for item in STATIC_BOT_COMMANDS]
    used = {item["command"] for item in commands}
    for command, item in dynamic_agent_command_map().items():
        if command in used:
            continue
        used.add(command)
        commands.append({"command": command, "description": item["description"]})
        if len(commands) >= 100:
            break
    return commands


def write_telegram_commands_file() -> None:
    mapping = dynamic_agent_command_map()
    TELEGRAM_COMMANDS_FILE.parent.mkdir(parents=True, exist_ok=True)
    TELEGRAM_COMMANDS_FILE.write_text(json.dumps({
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "bot_commands": build_telegram_bot_commands(),
        "dynamic_commands": list(mapping.values()),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def refresh_telegram_bot_commands(push_to_telegram: bool = False) -> str:
    commands = build_telegram_bot_commands()
    g.BOT_COMMANDS = commands
    write_telegram_commands_file()
    if not push_to_telegram:
        return "prepared"
    env = g.load_env()
    token = env.get("TELEGRAM_AGENT_G_BOT_TOKEN") or env.get("TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN") or ""
    if not token:
        return "missing-token"
    payload = urllib.parse.urlencode({"commands": json.dumps(commands, ensure_ascii=False)}).encode("utf-8")
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/setMyCommands", data=payload)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
        return "sent" if data.get("ok") else "failed"
    except Exception as exc:
        g.log(f"Telegram command refresh failed: {type(exc).__name__}: {exc}")
        return f"failed:{type(exc).__name__}"


def write_agent_registry_files() -> None:
    registry = discover_agent_registry()
    AGENT_REGISTRY_JSON.write_text(json.dumps({
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "source": [
            str(g.OPENCLAW_DIR / "*-blogger-config.json"),
            str(AGENT_REGISTRY_OVERLAY),
            "runtime builtins for Agent D/M/G and Virtualni asistentka",
        ],
        "agents": registry,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# AGENT REGISTRY",
        "",
        "Generated from live OpenClaw runtime state. Do not edit generated entries by hand.",
        f"Generated at: {dt.datetime.now().astimezone().isoformat(timespec='seconds')}",
        "",
        "To add a new agent or change competencies without code changes, edit:",
        f"`{AGENT_REGISTRY_OVERLAY}`",
        "",
        "Routing rule: choose by capability + target domain/channel first, old agent names second.",
        "",
    ]
    for entry in registry:
        lines.extend([
            f"## {entry.get('display_name')} (`{entry.get('id')}`)",
            f"- Kind: {entry.get('kind')}",
            f"- Aliases: {', '.join(entry.get('aliases') or [])}",
            f"- Domains: {', '.join(entry.get('domains') or []) or '-'}",
            f"- Capabilities: {', '.join(entry.get('capabilities') or [])}",
        ])
        channels = entry.get("channels") or {}
        if channels:
            lines.append("- Channels:")
            for key, value in channels.items():
                lines.append(f"  - {key}: `{value}`")
        commands = entry.get("commands") or []
        if commands:
            lines.append("- Commands:")
            for command in commands:
                if isinstance(command, dict):
                    label = str(command.get("command") or command.get("action") or command.get("capability") or "").strip()
                    desc = str(command.get("description") or "").strip()
                    lines.append(f"  - {label}: {desc}" if desc else f"  - {label}")
                else:
                    lines.append(f"  - {command}")
        notes = str(entry.get("notes") or "").strip()
        if notes:
            lines.append(f"- Notes: {notes}")
        lines.append("")
    AGENT_REGISTRY_MD.write_text("\n".join(lines), encoding="utf-8")
    write_telegram_commands_file()


def virtual_assistant_agents_context() -> str:
    registry = discover_agent_registry()
    if not registry:
        return ""
    lines = [
        "LIVE AGENT REGISTRY:",
        "Use this current registry over older hard-coded examples. Route by capability + domain/channel.",
    ]
    for entry in registry:
        aliases = ", ".join((entry.get("aliases") or [])[:8])
        capabilities = ", ".join((entry.get("capabilities") or [])[:8])
        domains = ", ".join(entry.get("domains") or [])
        channel_bits = []
        for key, value in list((entry.get("channels") or {}).items())[:3]:
            channel_bits.append(f"{key}={value}")
        command_bits = []
        for command in agent_commands_for_entry(entry)[:4]:
            command_bits.append(f"/{command.get('command')}={command.get('action')}")
        line = (
            f"- {entry.get('display_name')} id={entry.get('id')} kind={entry.get('kind')} "
            f"domains={domains or '-'} capabilities={capabilities or '-'} aliases={aliases or '-'}"
        )
        if channel_bits:
            line += f" channels={'; '.join(channel_bits)}"
        if command_bits:
            line += f" commands={'; '.join(command_bits)}"
        lines.append(line[:1200])
    lines.extend([
        "Routing reminders:",
        "- X/social/Twitter tasks for btc-dca.com go to Agent D, not the btc-dca WordPress blogger.",
        "- X/social/Twitter tasks for Osobni zkusenosti / osobnizkusenosti.cz go to Agent XOZ, not Agent D.",
        "- WordPress/blog/article tasks go to the blogger instance matching the requested domain.",
        "- Medium/DEV/Hashnode tasks go to Agent M.",
        "- Technical/runtime/auth/deploy blockers go to Agent G.",
        "- If a future agent appears in AGENT_CAPABILITIES.json or a blogger config, treat it as available.",
    ])
    return "\n".join(lines)


def shared_brain_context(text: str) -> str:
    if not SHARED_BRAIN_SCRIPT.exists():
        return ""
    low = g.normalize_text(text)
    trigger_terms = (
        "pameti",
        "pamet",
        "histor",
        "kontext",
        "agent",
        "routing",
        "kompetenc",
        "preference",
        "projekt",
        "btc-dca",
        "osobnizkusenosti",
        "medium",
        "dev",
        "x ",
        "telegram",
        "email",
        "openclaw",
        "nasad",
        "deploy",
    )
    if not any(term in low for term in trigger_terms):
        return ""
    try:
        result = subprocess.run(
            ["python3", str(SHARED_BRAIN_SCRIPT), "context", text, "-k", "5"],
            capture_output=True,
            text=True,
            timeout=12,
            check=False,
        )
    except Exception as exc:
        g.log(f"Shared Brain context failed: {type(exc).__name__}: {exc}")
        return ""
    output = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        g.log(f"Shared Brain context nonzero: {output[:240]}")
        return ""
    return output[:5000]


def text_matches_entry(text: str, entry: dict[str, Any]) -> int:
    low = g.normalize_text(text)
    score = 0
    for domain in entry.get("domains") or []:
        norm = g.normalize_text(str(domain))
        if norm and norm in low:
            score += 8
    for alias in entry.get("aliases") or []:
        norm = g.normalize_text(str(alias))
        if norm and norm in low:
            score += 5 if norm.startswith("agent ") else 3
    for capability in entry.get("capabilities") or []:
        norm = g.normalize_text(str(capability).replace("_", " "))
        if norm and norm in low:
            score += 2
    return score


def select_blogger_agent(text: str) -> dict[str, Any] | None:
    low = g.normalize_text(text)
    article_terms = (
        "blog",
        "wordpress",
        "clanek",
        "clanku",
        "draft",
        "article",
        "post na web",
        "osnova",
        "recenz",
        "srovnani",
        "zkusenost",
    )
    social_terms = (" x ", "x ", "x post", "twitter", "tweet", "social", "prispevek na x")
    if any(term in low for term in social_terms) and not any(term in low for term in article_terms):
        return None
    score_text = text
    if any(term in low for term in social_terms) and any(term in low for term in article_terms):
        blog_part = re.split(
            r"\s+a\s+n[aĂˇ]vrh\s+p[rĹ™]isp[eÄ›]vku\s+na\s+x\b|\s+a\s+.*?\b(?:x|twitter|tweet)\b",
            text,
            maxsplit=1,
            flags=re.IGNORECASE,
        )[0].strip()
        if blog_part:
            score_text = blog_part
    candidates = [entry for entry in discover_agent_registry() if entry.get("kind") == "blogger"]
    scored = [(text_matches_entry(score_text, entry), entry) for entry in candidates]
    scored = [(score, entry) for score, entry in scored if score > 0]
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def ensure_virtual_assistant_workspace() -> None:
    g.AGENT_WORK_DIR.mkdir(parents=True, exist_ok=True)
    for path, content in virtual_assistant_templates().items():
        if path == AGENT_REGISTRY_MD:
            continue
        if not path.exists():
            path.write_text(content, encoding="utf-8")
    if not AGENT_REGISTRY_EXAMPLE.exists():
        AGENT_REGISTRY_EXAMPLE.write_text(json.dumps({
            "agents": [
                {
                    "id": "future-agent",
                    "display_name": "Agent Future",
                    "kind": "custom",
                    "aliases": ["agent future", "future"],
                    "domains": ["example.com"],
                    "capabilities": ["what this agent owns"],
                    "commands": [
                        {"action": "example_action", "description": "Agent Future: priklad akce"}
                    ],
                    "channels": {"inbox": "/home/openclaw2/.openclaw/future-agent-inbox.jsonl"},
                    "notes": "Copy this object to AGENT_CAPABILITIES.json and edit it. Do not store secrets here.",
                }
            ]
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_agent_registry_files()


base_load_env = g.load_env
base_status_text = g.status_text
base_main = g.main


def virtual_assistant_load_env() -> dict[str, str]:
    env = base_load_env()
    token = g.pick(
        env,
        "TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN",
        "VIRTUAL_ASSISTANT_TELEGRAM_TOKEN",
        "VA_TELEGRAM_TOKEN",
        "M_TELEGRAM_TOKEN",
        "AGENT_VA_TELEGRAM_TOKEN",
        "TELEGRAM_AGENT_VA_BOT_TOKEN",
        "ASSISTANT_TELEGRAM_TOKEN",
    )
    chat_id = g.pick(
        env,
        "TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID",
        "VIRTUAL_ASSISTANT_TELEGRAM_CHAT_ID",
        "VA_TELEGRAM_CHAT_ID",
        "M_TELEGRAM_CHAT_ID",
        "AGENT_VA_TELEGRAM_CHAT_ID",
        "TELEGRAM_AGENT_VA_CHAT_ID",
        "ASSISTANT_TELEGRAM_CHAT_ID",
    )

    for key in (
        "TELEGRAM_AGENT_G_BOT_TOKEN",
        "G_TELEGRAM_TOKEN",
        "AGENT_G_TELEGRAM_TOKEN",
        "TELEGRAM_AGENT_G_CHAT_ID",
        "G_TELEGRAM_CHAT_ID",
        "AGENT_G_CHAT_ID",
    ):
        env.pop(key, None)

    if token:
        env["TELEGRAM_AGENT_G_BOT_TOKEN"] = token
    if chat_id:
        env["TELEGRAM_AGENT_G_CHAT_ID"] = chat_id
    env["AGENT_G_AI_BACKEND"] = "codex-cli"
    return env


def replace_agent_name(text: str) -> str:
    return text.replace("Agent G", AGENT_NAME).replace("Agenta G", AGENT_NAME)


def settings_help() -> str:
    dynamic = dynamic_agent_commands_text(limit=18)
    return "\n".join([
        f"Menu {AGENT_NAME}:",
        *g.settings_lines(),
        "",
        "Vyber pres tlacitko Menu u pole pro zpravu:",
        "/model - model",
        "/rychlost - rychlost odpovedi",
        "/inteligence - uroven premysleni",
        "/status - stav",
        "/usage - lokalni vyuziti",
        "/agents - agenti a jejich dynamicke prikazy",
        "",
        "Zkratky porad funguji: /mini, /max, /fast, /balanced, /deep.",
        "",
        dynamic,
    ])


def settings_panel_text(title: str | None = None) -> str:
    return "\n".join([
        (title or f"Nastaveni {AGENT_NAME}") + ":",
        *g.settings_lines(),
        "",
        "Vyber hodnotu tlacitkem.",
    ])


def settings_panel() -> tuple[str, dict[str, Any]]:
    return settings_panel_text(), g.settings_main_keyboard()


def handle_xoz_approval_callback(data: str) -> tuple[str, dict[str, Any] | None, str] | None:
    if not data.startswith("xoz:"):
        return None
    parts = data.split(":", 2)
    if len(parts) != 3:
        return ("Nerozumim schvalovacimu tlacitku.", None, "")
    action, task_id = parts[1], parts[2]
    tasks = load_orchestration_tasks()
    task = next((item for item in tasks if str(item.get("id") or "").startswith(task_id)), None)
    if not task:
        return ("Tenhle XOZ navrh uz neumim dohledat.", None, "")
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    state_path = Path(str(proof.get("state") or XOZ_STATE_FILE))
    state = g.load_json(state_path, {})
    if not isinstance(state, dict):
        state = {}
    record = xoz_task_record_for_task(state, task)
    if action == "approve":
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        record["status"] = "APPROVED_BY_JAKUB"
        record["approved_at"] = now
        statuses = state.get("task_status")
        if not isinstance(statuses, dict):
            statuses = {}
        statuses[str(task.get("id") or task_id)] = record
        state["task_status"] = statuses
        state["last_output"] = record
        g.write_json(state_path, state)
        append_jsonl(XOZ_CONTROL_INBOX_FILE, {
            "created_at": now,
            "source": "virtual-assistant",
            "agent": "Agent XOZ",
            "action": "approved_for_next_step",
            "task_id": str(task.get("id") or task_id),
            "task": str(task.get("topic") or ""),
            "expected_output": "provist dalsi schvaleny krok podle XOZ workflow a zapsat vysledek",
        })
        return ("Schvaleno. Predavam XOZ pokyn k dalsimu kroku.", None, "")
    if action == "edit":
        return ("Napis prosim upravu jednou vetou; predam ji Agentu XOZ k prepracovani.", None, "")
    return ("Nerozumim schvalovacimu tlacitku.", None, "")


def handle_settings_callback(data: str) -> tuple[str, dict[str, Any], str]:
    pending_callback = handle_pending_confirmation_callback(data)
    if pending_callback:
        text, markup, notice = pending_callback
        return text, markup if markup is not None else {}, notice
    xoz_callback = handle_xoz_approval_callback(data)
    if xoz_callback:
        text, markup, notice = xoz_callback
        return text, markup or {}, notice
    text, markup, notice = g._base_handle_settings_callback(data)
    return replace_agent_name(text), markup, notice


def dynamic_agent_commands_text(limit: int = 30) -> str:
    mapping = dynamic_agent_command_map()
    if not mapping:
        return "Dynamicke prikazy agentu: zatim zadne."
    lines = ["Dynamicke prikazy agentu:"]
    grouped: dict[str, list[dict[str, str]]] = {}
    for item in mapping.values():
        grouped.setdefault(item.get("agent_name") or item.get("agent_id") or "Agent", []).append(item)
    count = 0
    for agent_name in sorted(grouped):
        bits = []
        for item in grouped[agent_name]:
            bits.append(f"/{item['command']}")
            count += 1
            if count >= limit:
                break
        if bits:
            lines.append(f"- {agent_name}: {', '.join(bits)}")
        if count >= limit:
            break
    return "\n".join(lines)


def parse_dynamic_agent_command(text: str) -> str | None:
    match = re.match(r"^/([a-zA-Z0-9_]{1,32})(?:@\w+)?(?:\s+(.*))?$", text.strip(), flags=re.DOTALL)
    if not match:
        return None
    command = match.group(1).lower()
    payload = (match.group(2) or "").strip()
    if command == "agents":
        return dynamic_agent_commands_text(limit=60)
    mapping = dynamic_agent_command_map()
    item = mapping.get(command)
    if not item:
        return None
    agent_name = item.get("agent_name") or item.get("agent_id") or "Agent"
    action = item.get("action") or ""
    if not payload:
        payload = str(item.get("default_payload") or "").strip()
    if not payload:
        return f"{agent_name}: napis za prikaz konkretni zadani. Napr. /{command} priprav navrh ke schvaleni."
    return execute_dynamic_agent_command(item, payload)


def execute_dynamic_agent_command(item: dict[str, str], payload: str) -> str:
    agent_id = item.get("agent_id") or ""
    agent_name = item.get("agent_name") or agent_id or "Agent"
    action = item.get("action") or ""
    action_low = g.normalize_text(action)
    if action_low in {"activity_report"} or "report" in action_low:
        reply = xoz_combined_activity_report(payload) if agent_id == "agent-xoz" else None
        return reply or f"{agent_name}: zatim nemam specializovany report pro tuto akci."
    if agent_id == "agent-xoz" and any(term in action_low for term in ("social_engagement", "engage")):
        control_text = f"Agent XOZ pridej komentar na X: {payload}"
        return parse_xoz_control_request(control_text) or "Blokuje me: nepodarilo se predat engagement Agentu XOZ."
    if any(term in action_low for term in ("x_social", "x_thread", "social_engagement", "engage")):
        ok, target, path = assign_social_x_task(payload, forced_agent_id=agent_id)
        append_orchestration_event(target["agent"], target["instance"], payload, target["kind"], path)
        return f"Deleguji: {target['label']}."
    if agent_id == "virtual-assistant" and any(term in action_low for term in ("browser", "form")):
        return parse_browser_form_task_request(payload) or "Blokuje me: nerozpoznala jsem URL a pole formulare."
    if any(term in action_low for term in ("article", "wordpress", "blog")):
        registry = discover_agent_registry()
        entry = next((candidate for candidate in registry if str(candidate.get("id") or "") == agent_id), None)
        if entry and str(entry.get("kind") or "") == "blogger":
            domains = entry.get("domains") or []
            augmented = f"{payload} {domains[0] if domains else agent_id}"
            return parse_blogger_delegation_request(augmented) or f"{agent_name}: nerozpoznala jsem tema clanku."
    if agent_id == "agent-m" or any(term in action_low for term in ("medium", "dev", "hashnode", "syndicate")):
        inbox = g.OPENCLAW_DIR / "agent-m-inbox.jsonl"
        append_jsonl(inbox, {
            "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "virtual-assistant",
            "agent": "Agent M",
            "action": action,
            "task": payload,
            "expected_output": "vystup a overitelny odkaz nebo blocker",
        })
        append_orchestration_event("Agent M", "medium-dev-hashnode", payload, "publishing-assignment", str(inbox))
        upsert_orchestration_task("Agent M", "medium-dev-hashnode", payload, "publishing-assignment", str(inbox), {"inbox": str(inbox)})
        return "Deleguji: Agent M."
    if agent_id == "agent-g" or any(term in action_low for term in ("debug", "workflow", "runner", "systemd")):
        item_payload = {
            "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "virtual-assistant",
            "agent": "Agent G",
            "kind": "technical-blocker",
            "action": action,
            "task": payload,
            "expected_output": "vyresit technicky ukol nebo vratit konkretni blocker",
        }
        append_jsonl(AGENT_G_INBOX_FILE, item_payload)
        deliver_agent_g_handoff(item_payload)
        append_orchestration_event("Agent G", "operations", payload, "technical-blocker", str(AGENT_G_INBOX_FILE))
        upsert_orchestration_task("Agent G", "operations", payload, "technical-blocker", str(AGENT_G_INBOX_FILE), {"inbox": str(AGENT_G_INBOX_FILE)})
        return "Deleguji: Agent G."
    registry = discover_agent_registry()
    entry = next((candidate for candidate in registry if str(candidate.get("id") or "") == agent_id), None)
    channels = dict(entry.get("channels") or {}) if entry else {}
    inbox_value = channels.get("inbox") or channels.get("control_inbox")
    if inbox_value:
        inbox = Path(str(inbox_value))
        append_jsonl(inbox, {
            "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "virtual-assistant",
            "agent": agent_name,
            "action": action,
            "task": payload,
            "expected_output": "vystup nebo konkretni blocker",
        })
        append_orchestration_event(agent_name, agent_id, payload, f"agent-command:{action}", str(inbox))
        upsert_orchestration_task(agent_name, agent_id, payload, f"agent-command:{action}", str(inbox), {"inbox": str(inbox)})
        return f"Deleguji: {agent_name}."
    return f"Blokuje me: {agent_name} nema v registry dohledatelny inbox pro prikaz `{action}`."


def load_pending_confirmations() -> dict[str, Any]:
    try:
        data = json.loads(PENDING_CONFIRMATIONS_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    items = data.get("items")
    if not isinstance(items, dict):
        items = {}
    data["items"] = items
    return data


def save_pending_confirmations(data: dict[str, Any]) -> None:
    PENDING_CONFIRMATIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    data["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    PENDING_CONFIRMATIONS_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def confirmation_keyboard(action_id: str) -> dict[str, Any]:
    return {
        "inline_keyboard": [[
            {"text": "Ano", "callback_data": f"confirm:yes:{action_id}"},
            {"text": "Ne", "callback_data": f"confirm:no:{action_id}"},
        ]]
    }


def send_confirmation_request(action_id: str, label: str) -> int | None:
    _, chat_id = telegram_token_chat()
    if not chat_id:
        return None
    try:
        message = f"Rozumim to jako: {label}\n\nSpustit?"
        result = telegram_api_post("sendMessage", {
            "chat_id": chat_id,
            "text": message,
            "reply_markup": confirmation_keyboard(action_id),
        })
        if result.get("ok"):
            g.log(f"-> {message[:500]}")
            return int((result.get("result") or {}).get("message_id") or 0) or None
        return None
    except Exception as exc:
        g.log(f"Confirmation request send failed: {type(exc).__name__}: {exc}")
        return None


def queue_action_confirmation(action_key: str, label: str, text: str) -> str:
    data = load_pending_confirmations()
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    stored_text = browser_contextual_task_text(text) if action_key == "browser-form" else text
    fingerprint = hashlib.sha1(f"{action_key}|{g.normalize_text(stored_text)}".encode("utf-8", errors="replace")).hexdigest()[:20]
    current_time = dt.datetime.now().astimezone()
    for existing in data.get("items", {}).values():
        if not isinstance(existing, dict):
            continue
        existing_fingerprint = str(existing.get("fingerprint") or "")
        if not existing_fingerprint:
            existing_fingerprint = hashlib.sha1(
                f"{existing.get('action_key')}|{g.normalize_text(str(existing.get('text') or ''))}".encode("utf-8", errors="replace")
            ).hexdigest()[:20]
        if existing_fingerprint != fingerprint:
            continue
        created = parse_iso_time(existing.get("created_at"))
        if not created or (current_time - created).total_seconds() > 900:
            continue
        status = str(existing.get("status") or "")
        if status == "PENDING":
            return f"Potvrzeni uz ceka: {existing.get('label') or label}."
        if status in {"CONFIRMED", "EXECUTED"}:
            return f"Uz potvrzeno a spusteno: {existing.get('label') or label}."
        if status == "CANCELED":
            return f"Uz stornovano: {existing.get('label') or label}."
    for pending_item in data.get("items", {}).values():
        if isinstance(pending_item, dict) and pending_item.get("status") == "PENDING":
            pending_item["status"] = "SUPERSEDED"
            pending_item["resolved_at"] = now
    action_id = hashlib.sha1(f"{action_key}|{stored_text}|{now}".encode("utf-8", errors="replace")).hexdigest()[:16]
    data["items"][action_id] = {
        "id": action_id,
        "created_at": now,
        "status": "PENDING",
        "action_key": action_key,
        "label": label,
        "text": stored_text,
        "fingerprint": fingerprint,
    }
    save_pending_confirmations(data)
    message_id = send_confirmation_request(action_id, label)
    if message_id:
        data["items"][action_id]["telegram_message_id"] = message_id
        save_pending_confirmations(data)
        return f"Ke spusteni je pripraveno: {label}."
    return f"Rozumim to jako: {label}. Potvrd prosim `ano`, nebo to uprav."


def execute_confirmed_action(action_key: str, text: str) -> str:
    if action_key == "xoz-style-draft":
        return parse_xoz_style_and_draft_request(text) or "Nepodarilo se pripravit XOZ navrh."
    if action_key == "browser-form":
        return parse_browser_form_task_request(text) or "Nepodarilo se spustit browser formular."
    if action_key == "xoz-control":
        return parse_xoz_control_request(text) or "Nepodarilo se predat XOZ control ukol."
    if action_key == "cancel-social":
        return parse_cancel_social_assignment_request(text) or "Nepodarilo se zrusit social zadani."
    if action_key == "social-x":
        return parse_social_x_delegation_request(text) or "Nepodarilo se delegovat X/social ukol."
    if action_key == "combined-delegation":
        return parse_combined_delegation_request(text) or "Nepodarilo se rozdelit kombinovanou delegaci."
    if action_key == "blogger":
        return parse_blogger_delegation_request(text) or "Nepodarilo se delegovat blogger ukol."
    if action_key == "general-delegation":
        return parse_general_delegation_request(text) or "Nepodarilo se delegovat ukol."
    return "Neznam typ potvrzene akce."


def handle_pending_confirmation_callback(data: str) -> tuple[str, dict[str, Any] | None, str] | None:
    if not data.startswith("confirm:"):
        return None
    parts = data.split(":", 2)
    if len(parts) != 3:
        return ("Nerozumim potvrzovacimu tlacitku.", None, "")
    decision, action_id = parts[1], parts[2]
    state = load_pending_confirmations()
    item = state["items"].get(action_id)
    if not isinstance(item, dict):
        return ("Tohle potvrzeni uz neumim dohledat.", None, "")
    if item.get("status") != "PENDING":
        return ("Tohle potvrzeni uz bylo zpracovane.", None, "")
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    if decision == "no":
        item["status"] = "CANCELED"
        item["resolved_at"] = now
        save_pending_confirmations(state)
        return (f"Stornovano: {item.get('label') or 'akce'}.", {"inline_keyboard": []}, "")
    if decision != "yes":
        return ("Nerozumim potvrzovacimu tlacitku.", None, "")
    item["status"] = "CONFIRMED"
    item["resolved_at"] = now
    save_pending_confirmations(state)
    reply = execute_confirmed_action(str(item.get("action_key") or ""), str(item.get("text") or ""))
    item["status"] = "EXECUTED"
    item["executed_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    item["reply"] = str(reply)[:500]
    save_pending_confirmations(state)
    return (f"Potvrzeno. {reply}", {"inline_keyboard": []}, "")


def parse_pending_confirmation_text(text: str) -> str | None:
    low = g.normalize_text(text).strip(" .!?")
    yes_terms = {"ano", "souhlasim", "souhlasím", "potvrzuji", "spustit", "proved"}
    no_terms = {"ne", "storno", "zrus", "zruš", "nepotvrzuji"}
    if low not in yes_terms and low not in no_terms:
        return None
    state = load_pending_confirmations()
    pending = [item for item in state.get("items", {}).values() if isinstance(item, dict) and item.get("status") == "PENDING"]
    if not pending:
        return None
    pending.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    action_id = str(pending[0].get("id") or "")
    decision = "yes" if low in yes_terms else "no"
    result = handle_pending_confirmation_callback(f"confirm:{decision}:{action_id}")
    return result[0] if result else None


def is_pending_target_correction_text(text: str) -> bool:
    low = g.normalize_text(text)
    target_xoz = any(term in low for term in ("agent xoz", "agenta xoz", "agentovi xoz", "na xoz", "pro xoz"))
    correction = any(term in low for term in ("tohle je na", "to patri", "patri to", "ma to dostat", "spravny agent", "predat"))
    return target_xoz and correction


def recent_social_request_from_history(exclude_text: str = "") -> str:
    history = g.load_json(g.HISTORY_FILE, [])
    if not isinstance(history, list):
        return ""
    exclude_low = g.normalize_text(exclude_text)
    for item in reversed(history[-30:]):
        if not isinstance(item, dict) or str(item.get("role") or "") != "user":
            continue
        content = str(item.get("content") or "").strip()
        if not content or g.normalize_text(content) == exclude_low:
            continue
        if is_social_x_delegation_request_text(content):
            return content
    return ""


def parse_pending_target_correction(text: str) -> str | None:
    if not is_pending_target_correction_text(text):
        return None
    state = load_pending_confirmations()
    social_action_keys = {"social-x", "xoz-style-draft", "combined-delegation", "general-delegation"}
    pending = [
        item for item in state.get("items", {}).values()
        if isinstance(item, dict) and item.get("status") == "PENDING" and str(item.get("action_key") or "") in social_action_keys
    ]
    pending.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
    if pending:
        item = pending[0]
        original = str(item.get("text") or "").strip()
        item["action_key"] = "social-x"
        item["label"] = "delegovat X/social navrh Agentu XOZ pro Osobni zkusenosti"
        item["text"] = original + "\nCil: Agent XOZ; kanal X pro Osobni zkusenosti. Zachovej tema a pozadavky z puvodniho zadani."
        item["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        save_pending_confirmations(state)
        send_confirmation_request(str(item.get("id") or ""), str(item.get("label") or ""))
        return "Upraveno: pending zadani smeruje na Agenta XOZ a zachovava puvodni tema."
    original = recent_social_request_from_history(text)
    if original:
        corrected = original + "\nCil: Agent XOZ; kanal X pro Osobni zkusenosti. Zachovej tema a pozadavky z puvodniho zadani."
        return queue_action_confirmation("social-x", "delegovat X/social navrh Agentu XOZ pro Osobni zkusenosti", corrected)
    return "Nemam pending X zadani, ktere bych mohla bezpecne presmerovat."


def is_explicit_command_text(text: str) -> bool:
    return text.strip().startswith("/")


def is_xoz_control_request_text(text: str) -> bool:
    if is_browser_form_task_text(text):
        return False
    low = g.normalize_text(text)
    if not any(term in low for term in ("xoz", "agent xoz", "oz", "osobnizkusenosti", "osobni zkusenosti")):
        return False
    if not any(term in low for term in ("komentar", "koment", "comment", "engagement")):
        return False
    if not any(term in low for term in ("nastav", "uprav", "zmen", "zvys", "sniz", "limit", "pocet", "mnozstvi", "kolik", "pridej", "vloz", "okomentuj", "komentuj")):
        return False
    return True


def is_social_x_delegation_request_text(text: str) -> bool:
    if not is_social_delegation_task(text):
        return False
    low = g.normalize_text(text)
    if is_blog_article_delegation_task(text) and blogger_delegation_target(text):
        return False
    return any(term in low for term in ("navrh", "prispevek", "tweet", "x post", "social", "schval", "ke schvaleni", "publikuj", "postni"))


def is_cancel_social_assignment_request_text(text: str) -> bool:
    low = g.normalize_text(text)
    return (
        any(term in low for term in ("zrus", "storno", "cancel"))
        and (any(term in low for term in ("agent d", "agenta d", "agentovi d")) or bool(re.search(r"\bd\b", low)))
    )


def is_combined_delegation_request_text(text: str) -> bool:
    blog_text = article_text_for_combined_delegation(text)
    blog_target = blogger_delegation_target(blog_text)
    return bool(blog_target is not None and is_blog_article_delegation_task(blog_text) and is_social_delegation_task(text))


def is_blogger_delegation_request_text(text: str) -> bool:
    if is_xoz_activity_request_text(text):
        return False
    target = blogger_delegation_target(text)
    if not target:
        return False
    low = g.normalize_text(text)
    return any(term in low for term in ("clanek", "clanku", "članek", "článku", "draft", "post", "tema", "téma", "napiš", "napis", "napsat", "vygeneruj", "priprav", "připrav", "zadej", "deleguj"))


def is_general_delegation_request_text(text: str) -> bool:
    low = g.normalize_text(text)
    asks_delegation = any(term in low for term in (
        "deleguj",
        "delegovat",
        "prislusnym agentum",
        "příslušným agentům",
        "agentum",
        "agentům",
        "zapoj agent",
        "nemas tvorit",
        "nemas to tvorit",
    ))
    return bool(asks_delegation or (is_orchestration_task(text) and is_social_delegation_task(text)))


def pending_action_candidate(text: str) -> tuple[str, str] | None:
    if is_explicit_command_text(text):
        return None
    if is_browser_form_action_text(text):
        urls = find_urls_in_text(text)
        domain = domain_from_url(urls[0]) if urls else "zadanem webu"
        low = g.normalize_text(text)
        form_kind = "recenzi/komentar" if any(term in low for term in ("#reviews", "/produkt/", "recenze", "review")) else "formular/komentar"
        return "browser-form", f"vyplnit a odeslat {form_kind} na {domain} pres Playwright"
    if is_xoz_activity_request_text(text):
        return None
    if is_xoz_style_and_draft_request_text(text):
        return "xoz-style-draft", "pripravit XOZ navrh prispevku ke schvaleni"
    if is_xoz_control_request_text(text):
        return "xoz-control", "predat Agentu XOZ X engagement/control ukol"
    if is_cancel_social_assignment_request_text(text):
        return "cancel-social", "zrusit social/X zadani"
    if is_combined_delegation_request_text(text):
        return "combined-delegation", "rozdelit zadani mezi prislusne agenty"
    if is_social_x_delegation_request_text(text):
        return "social-x", "delegovat X/social ukol"
    if is_blogger_delegation_request_text(text):
        target = blogger_delegation_target(text)
        agent_name = target[1] if target else "prislusneho blogovaciho agenta"
        topic = extract_blogger_topic(text)
        topic_match = re.search(r"\bo\s+([^.;\n]{3,120})", text, flags=re.IGNORECASE)
        topic_label = topic_match.group(1).strip() if topic_match else topic[:140].strip()
        mode = "publikovat clanek" if explicit_publish_requested(text) else "vytvorit draft clanku"
        return "blogger", f"{mode} pres {agent_name}: {topic_label}"
    if is_general_delegation_request_text(text):
        return "general-delegation", "delegovat ukol dalsim agentum"
    return None


def parse_settings_command(text: str) -> str | None:
    reply = g._base_parse_settings_command(text)
    if reply is None:
        dynamic_reply = parse_dynamic_agent_command(text)
        if dynamic_reply:
            return dynamic_reply
        pending_text_reply = parse_pending_confirmation_text(text)
        if pending_text_reply:
            return pending_text_reply
        target_correction_reply = parse_pending_target_correction(text)
        if target_correction_reply:
            return target_correction_reply
        xoz_activity_reply = parse_xoz_activity_request(text)
        if xoz_activity_reply:
            return xoz_activity_reply
        status_reply = parse_delegation_status_request(text)
        if status_reply:
            return status_reply
        gmail_reply = parse_gmail_signup_request(text)
        if gmail_reply:
            return gmail_reply
        feedback_reply = parse_work_style_feedback(text)
        if feedback_reply:
            return feedback_reply
        if is_explicit_command_text(text) and is_cancel_social_assignment_request_text(text):
            return parse_cancel_social_assignment_request(text)
        routing_correction_reply = parse_routing_correction_request(text)
        if routing_correction_reply:
            return routing_correction_reply
        candidate = pending_action_candidate(text)
        if candidate:
            return queue_action_confirmation(candidate[0], candidate[1], text)
        if not is_explicit_command_text(text):
            return None
        style_draft_reply = parse_xoz_style_and_draft_request(text)
        if style_draft_reply:
            return style_draft_reply
        browser_form_reply = parse_browser_form_task_request(text)
        if browser_form_reply:
            return browser_form_reply
        xoz_control_reply = parse_xoz_control_request(text)
        if xoz_control_reply:
            return xoz_control_reply
        social_x_reply = parse_social_x_delegation_request(text)
        if social_x_reply:
            return social_x_reply
        combined_delegation_reply = parse_combined_delegation_request(text)
        if combined_delegation_reply:
            return combined_delegation_reply
        delegation_reply = parse_blogger_delegation_request(text)
        if delegation_reply:
            return delegation_reply
        general_delegation_reply = parse_general_delegation_request(text)
        if general_delegation_reply:
            return general_delegation_reply
        return None
    return replace_agent_name(reply)


def status_text(token: str, chat_id: str) -> str:
    env = g.load_env()
    email_config = gmail_env_config()
    lines = [
        replace_agent_name(base_status_text(token, chat_id)),
        "",
        "Email:",
        f"Gmail OAuth token: {'nalezen' if email_config.get('oauth_secret') else 'chybi'}",
        f"Mailbox: {email_config.get('address') or 'nenastaven'}",
        f"Kontrola mailboxu: kazdych {email_config.get('poll_seconds', '7200')} s",
        f"Setup email: {email_config.get('setup_recipient') or 'nenastaven'}",
    ]
    return "\n".join(lines)


base_build_web_context = g.build_web_context
base_route_model_for_task = g.route_model_for_task
base_timeout_for_route = g.timeout_for_route


def is_account_or_browser_task(text: str) -> bool:
    low = g.normalize_text(text)
    account_terms = (
        "gmail",
        "google account",
        "google ucet",
        "linkedin",
        "ucet",
        "registr",
        "signup",
        "sign up",
        "prihlas",
        "profil",
        "browser",
        "playwright",
        "formular",
        "form",
        "komentar",
        "komentář",
        "comment",
        "kontaktni formular",
        "kontaktní formulář",
    )
    action_terms = (
        "zaloz",
        "vytvor",
        "vypln",
        "over",
        "zkontrol",
        "priprav",
        "udel",
        "odesli",
        "odešli",
        "potvrd",
        "potvrdit",
        "submit",
        "posli",
        "pošli",
        "pridej",
        "přidej",
    )
    return any(term in low for term in account_terms) and any(term in low for term in action_terms)


def is_orchestration_task(text: str) -> bool:
    low = g.normalize_text(text)
    if is_oz_draft_task(text):
        return True
    campaign_terms = (
        "btc-dca",
        "btc dca",
        "kampan",
        "oznam",
        "integrac",
        "burz",
        "medium",
        "dev",
        "hashnode",
        "blog",
        "wordpress",
        "x post",
        "twitter",
        "agent c",
        "agent m",
        "agent d",
        "agenta c",
        "agenta m",
        "agenta d",
        "agent oz",
        "agenta oz",
        "osobni zkusenosti",
        "osobní zkušenosti",
        "osobnizkusenosti",
    )
    action_terms = (
        "draft",
        "clanek",
        "clanku",
        "članek",
        "článku",
        "napis",
        "napiš",
        "vygeneruj",
        "oznam",
        "oznami",
        "oznamit",
        "pridani",
        "publik",
        "pridej",
        "pridat",
        "integrac",
        "zverejni",
        "spust",
        "zapoj",
        "kontakt",
        "koordin",
        "over",
        "resit",
    )
    return any(term in low for term in campaign_terms) and any(term in low for term in action_terms)


def is_oz_draft_task(text: str) -> bool:
    low = g.normalize_text(text)
    oz_terms = (
        "agent oz",
        "agenta oz",
        "oz agent",
        "osobni zkusenosti",
        "osobní zkušenosti",
        "osobnizkusenosti",
    )
    draft_terms = (
        "draft",
        "clanek",
        "clanku",
        "članek",
        "článku",
        "tema",
        "téma",
        "srovnani",
        "srovnání",
        "recenz",
        "zkusenost",
        "zkušenost",
    )
    return any(term in low for term in oz_terms) and any(term in low for term in draft_terms)


def explicit_publish_requested(text: str) -> bool:
    low = g.normalize_text(text)
    if any(term in low for term in ("publikuj", "publish", "zverejni", "zveřejni", "vydej")):
        return True
    return "postni" in low and "draft" not in low and "navrh" not in low


def resolve_blogger_instance(candidates: tuple[str, ...], markers: tuple[str, ...]) -> str:
    for instance in candidates:
        if (g.OPENCLAW_DIR / f"{instance}-blogger-config.json").exists():
            return instance
    try:
        for cfg_path in sorted(g.OPENCLAW_DIR.glob("*-blogger-config.json")):
            instance = cfg_path.name.removesuffix("-blogger-config.json")
            try:
                data = json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                data = {}
            haystack = g.normalize_text(" ".join([
                instance,
                str(data.get("agent_name") or ""),
                str(data.get("WP_SITE_URL") or data.get("wp_site_url") or ""),
                str(data.get("site_name") or ""),
            ]))
            if any(marker in haystack for marker in markers):
                return instance
    except Exception:
        pass
    return candidates[0]


def blogger_delegation_target(text: str) -> tuple[str, str] | None:
    entry = select_blogger_agent(text)
    if entry:
        return str(entry.get("id")), str(entry.get("display_name") or entry.get("id"))

    low = g.normalize_text(text)
    if any(term in low for term in ("agent oz", "agenta oz", "osobni zkusenosti", "osobní zkušenosti", "osobnizkusenosti")):
        instance = resolve_blogger_instance(
            ("osobnizkusenosti-cz", "oz", "osobnizkusenosti", "osobni-zkusenosti"),
            ("agent oz", "osobnizkusenosti", "osobni zkusenosti"),
        )
        return instance, "Agent osobnizkusenosti-cz"
    if any(term in low for term in ("agent c", "agenta c", "btc-dca", "btc dca")):
        social_terms = (" x ", "x ", "x post", "twitter", "tweet", "prispevek", "příspěvek", "social")
        blog_terms = ("blog", "wordpress", "clanek", "clanku", "članek", "článku", "article")
        if any(term in low for term in social_terms) and not any(term in low for term in blog_terms):
            return None
        instance = resolve_blogger_instance(("btc-dca", "btcdca"), ("btc-dca", "btc dca", "btcdca"))
        return instance, "Agent C"
    return None


def extract_blogger_topic(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    match = re.search(r"(?:na\s+t[eé]ma|tema|téma)\s+(.+)$", cleaned, flags=re.IGNORECASE)
    if match and match.group(1).strip():
        return match.group(1).strip(" .")
    return cleaned.strip(" .")


def article_text_for_combined_delegation(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    split = re.split(
        r"\s+a\s+n[aá]vrh\s+p[rř]isp[eě]vku\s+na\s+x\b",
        cleaned,
        maxsplit=1,
        flags=re.IGNORECASE,
    )
    article = split[0].strip(" .") if split and split[0].strip() else cleaned
    if "obsah muze byt cokoliv" in g.normalize_text(cleaned) and "obsah muze byt cokoliv" not in g.normalize_text(article):
        article = article.rstrip(" .") + "; obsah muze byt cokoliv, jde o test"
    return article


def strip_blogger_followup_instructions(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip())
    patterns = (
        r"\s+(?:a\s+)?(?:pošli|posli|zašli|zasli)\s+(?:mi\s+)?(?:na\s+n[eě]j\s+)?(?:odkaz|link).*$",
        r"\s+(?:a\s+)?(?:chci|chci\s+jej|chci\s+ho)\s+.*?(?:vid[eě]t|schv[aá]lit).*$",
        r"\s+(?:a\s+)?(?:pak\s+)?(?:mi\s+)?(?:dej|ukaž|ukaz|pošli|posli)\s+.*?(?:v[yý]stup|odkaz|link).*$",
    )
    for pattern in patterns:
        cleaned = re.sub(pattern, "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip(" .")


def is_vague_or_instruction_topic(text: str) -> bool:
    low = g.normalize_text(text)
    vague_terms = (
        "libovolne tema",
        "libovolne",
        "cokoliv",
        "random",
        "jakekoliv",
        "jakekoliv tema",
        "neco",
    )
    instruction_terms = (
        "posli mi",
        "odkaz",
        "link",
        "chci jej videt",
        "chci ho videt",
        "schvalit",
    )
    return any(term in low for term in vague_terms) or any(term in low for term in instruction_terms)


def default_blogger_topic(text: str) -> str:
    low = g.normalize_text(text)
    if any(term in low for term in ("osobni zkusenosti", "osobnizkusenosti", "agent oz", "agenta oz")):
        return "Jak si nastavit jednoduchy osobni rozpocet a neztratit motivaci"
    if any(term in low for term in ("btc-dca", "btc dca")):
        return "Jak pravidelne investovat do bitcoinu bez zbytecneho stresu"
    return "Prakticky navod z osobni zkusenosti"


def normalize_blogger_topic(topic: str, original_text: str) -> str:
    cleaned = strip_blogger_followup_instructions(topic)
    cleaned = re.sub(r"^(?:a\s+)?(?:na\s+)?(?:libovoln[eé]\s+t[eé]ma|jakekoliv\s+tema|jak[eé]koliv\s+t[eé]ma)\b", "", cleaned, flags=re.IGNORECASE).strip(" .")
    if not cleaned or is_vague_or_instruction_topic(cleaned):
        return default_blogger_topic(original_text)
    return cleaned.strip(" .")


def extract_blogger_topic(text: str) -> str:
    cleaned = strip_blogger_followup_instructions(re.sub(r"\s+", " ", text.strip()))
    if is_vague_or_instruction_topic(cleaned):
        return default_blogger_topic(text)
    match = re.search(r"(?:na\s+t[eĂ©]ma|tema|tĂ©ma)\s+(.+)$", cleaned, flags=re.IGNORECASE)
    if match and match.group(1).strip():
        return normalize_blogger_topic(match.group(1), text)
    return normalize_blogger_topic(cleaned, text)


def write_blogger_requested_topic(instance: str, topic: str) -> Path:
    state_path = g.OPENCLAW_DIR / f"{instance}-blogger-state.json"
    state = {
        "date": dt.date.today().isoformat(),
        "topic": topic,
        "keywords": topic,
        "phases_done": ["topic"],
        "images": [],
        "errors": [],
        "requested_by": "virtual-assistant",
        "requested_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    g.write_json(state_path, state)
    return state_path


def append_orchestration_event(agent_name: str, instance: str, topic: str, mode: str, runner: str) -> None:
    board = g.AGENT_WORK_DIR / "ORCHESTRATION.md"
    board.parent.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    line = (
        f"\n- {ts} | {agent_name} | instance `{instance}` | {mode} | "
        f"topic: {topic[:180]} | runner: {runner} | status: ASSIGNED\n"
    )
    with board.open("a", encoding="utf-8") as handle:
        handle.write(line)


def delegation_task_id(agent_name: str, instance: str, topic: str, kind: str) -> str:
    raw = f"{agent_name}|{instance}|{kind}|{topic}".encode("utf-8", errors="replace")
    return hashlib.sha1(raw).hexdigest()[:16]


def load_orchestration_tasks() -> list[dict[str, Any]]:
    try:
        data = json.loads(ORCHESTRATION_TASKS_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [item for item in data if isinstance(item, dict)]


def save_orchestration_tasks(tasks: list[dict[str, Any]]) -> None:
    ORCHESTRATION_TASKS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ORCHESTRATION_TASKS_FILE.write_text(json.dumps(tasks[-200:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def upsert_orchestration_task(
    agent_name: str,
    instance: str,
    topic: str,
    kind: str,
    runner: str,
    proof: dict[str, str] | None = None,
) -> str:
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    task_id = delegation_task_id(agent_name, instance, topic, kind)
    tasks = load_orchestration_tasks()
    existing = next((item for item in tasks if item.get("id") == task_id), None)
    item = existing or {
        "id": task_id,
        "created_at": now,
        "status": "ASSIGNED",
        "last_reported_status": "",
    }
    item.update({
        "updated_at": now,
        "agent": agent_name,
        "instance": instance,
        "kind": kind,
        "topic": topic,
        "runner": runner,
        "proof": proof or {},
    })
    if existing is None:
        tasks.append(item)
    save_orchestration_tasks(tasks)
    return task_id


def append_jsonl(path: Path, item: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False) + "\n")


def read_jsonl(path: Path, limit: int = 500) -> list[dict[str, Any]]:
    if not path.exists() or not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return []
    items: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            item = json.loads(line)
        except Exception:
            continue
        if isinstance(item, dict):
            items.append(item)
    return items


def ensure_xoz_channel_state() -> dict[str, Any]:
    state = g.load_json(XOZ_STATE_FILE, {})
    if not isinstance(state, dict):
        state = {}
    XOZ_ACTIVITY_LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    XOZ_ACTIVITY_LOG_FILE.touch(exist_ok=True)
    XOZ_CONTROL_INBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    XOZ_CONTROL_INBOX_FILE.touch(exist_ok=True)
    XOZ_INBOX_FILE.parent.mkdir(parents=True, exist_ok=True)
    XOZ_INBOX_FILE.touch(exist_ok=True)
    channels = state.get("channels")
    if not isinstance(channels, dict):
        channels = {}
    channels.update({
        "assignment_inbox": str(XOZ_INBOX_FILE),
        "control_inbox": str(XOZ_CONTROL_INBOX_FILE),
        "activity_log": str(XOZ_ACTIVITY_LOG_FILE),
        "state": str(XOZ_STATE_FILE),
    })
    state["channels"] = channels
    state["contract"] = {
        "activity_log": "Agent XOZ zapisuje kazdy komentar/post jako JSONL: created_at, action, status, text, url, target_url, task_id.",
        "control_inbox": "VA sem zapisuje zmeny limitu/poctu/strategie komentaru a XOZ je ma potvrdit ve state.",
    }
    g.write_json(XOZ_STATE_FILE, state)
    return state


def parse_iso_time(raw: Any) -> dt.datetime | None:
    text = str(raw or "").strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)
        return parsed.astimezone()
    except Exception:
        return None


def xoz_activity_records() -> list[dict[str, Any]]:
    records = read_jsonl(XOZ_ACTIVITY_LOG_FILE, 1000)
    state = g.load_json(XOZ_STATE_FILE, {})
    if isinstance(state, dict):
        for key in ("activity", "activities", "activity_log", "comments", "published_comments"):
            value = state.get(key)
            if isinstance(value, list):
                records.extend(item for item in value if isinstance(item, dict))
    unique: dict[str, dict[str, Any]] = {}
    for record in records:
        key = str(record.get("id") or record.get("url") or record.get("comment_url") or record.get("created_at") or json.dumps(record, sort_keys=True, ensure_ascii=False))
        unique[key] = record
    return list(unique.values())


def is_xoz_comment_record(record: dict[str, Any]) -> bool:
    haystack = g.normalize_text(" ".join(str(record.get(key) or "") for key in ("action", "kind", "type", "status", "text", "url", "comment_url", "target_url")))
    if any(term in haystack for term in ("repost", "retweet", "reshare", "sdileni", "preposl")):
        return False
    if any(term in haystack for term in ("comment", "komentar", "koment")):
        return True
    return bool(record.get("comment_url") or record.get("target_url")) and "draft" not in haystack


def is_xoz_repost_record(record: dict[str, Any]) -> bool:
    haystack = g.normalize_text(" ".join(str(record.get(key) or "") for key in ("action", "kind", "type", "status", "text", "summary", "url", "target_url")))
    return any(term in haystack for term in ("repost", "retweet", "reshare", "share", "sdileni", "sdílení", "preposl", "přeposl"))


def is_xoz_activity_request_text(text: str) -> bool:
    if is_browser_form_action_text(text):
        return False
    low = g.normalize_text(text)
    if not any(term in low for term in ("xoz", "agent xoz", "oz", "osobnizkusenosti", "osobni zkusenosti")):
        return False
    if not any(term in low for term in ("komentar", "koment", "comment", "repost", "retweet", "sdileni", "sdílení", "kolik", "aktivita", "prehled", "přehled", "vystup", "dohledat")):
        return False
    return True


def xoz_activity_overview(records: list[dict[str, Any]], label: str, today_only: bool = False) -> str:
    records.sort(key=lambda item: str(item.get("created_at") or item.get("time") or item.get("at") or ""), reverse=True)
    lines = [f"Agent XOZ: dohledatelne {label} dnes: {len(records)}" if today_only else f"Agent XOZ: dohledatelne {label}: {len(records)}"]
    for record in records[:5]:
        url = str(record.get("url") or record.get("comment_url") or record.get("target_url") or "").strip()
        text_part = " ".join(str(record.get("text") or record.get("summary") or "").split())[:120]
        when = str(record.get("created_at") or record.get("time") or "")[:19]
        detail = " - ".join(part for part in (when, text_part, url) if part)
        if detail:
            lines.append(f"- {detail}")
    return "\n".join(lines)


def xoz_comment_overview(records: list[dict[str, Any]], today_only: bool = False) -> str:
    return xoz_activity_overview(records, "komentare", today_only)


def xoz_combined_activity_report(text: str = "") -> str:
    records = xoz_activity_records()
    low = g.normalize_text(text)
    today_only = any(term in low for term in ("dnes", "today"))
    if today_only:
        today = dt.datetime.now().astimezone().date()
        filtered = []
        for record in records:
            timestamp = parse_iso_time(record.get("created_at") or record.get("time") or record.get("at"))
            if timestamp and timestamp.date() == today:
                filtered.append(record)
        records = filtered
    comments = [record for record in records if is_xoz_comment_record(record)]
    reposts = [record for record in records if is_xoz_repost_record(record)]
    scope = "dnes" if today_only else "celkem"
    lines = [f"Agent XOZ: {scope} komentare {len(comments)}, reposty {len(reposts)}."]
    recent = sorted(
        comments + reposts,
        key=lambda item: str(item.get("created_at") or item.get("time") or item.get("at") or ""),
        reverse=True,
    )
    seen: set[str] = set()
    for record in recent:
        key = str(record.get("id") or record.get("url") or record.get("comment_url") or record.get("created_at") or "")
        if key in seen:
            continue
        seen.add(key)
        kind = "repost" if is_xoz_repost_record(record) else "komentar"
        url = str(record.get("url") or record.get("comment_url") or record.get("target_url") or "").strip()
        summary = " ".join(str(record.get("text") or record.get("summary") or "").split())[:120]
        detail = " - ".join(part for part in (kind, summary, url) if part)
        if detail:
            lines.append(f"- {detail}")
        if len(lines) >= 6:
            break
    return "\n".join(lines)


def parse_xoz_activity_request(text: str) -> str | None:
    if not is_xoz_activity_request_text(text):
        return None
    low = g.normalize_text(text)
    wants_reposts = any(term in low for term in ("repost", "retweet", "sdileni", "sdílení"))
    if wants_reposts:
        records = [record for record in xoz_activity_records() if is_xoz_repost_record(record)]
        label = "reposty"
    else:
        records = [record for record in xoz_activity_records() if is_xoz_comment_record(record)]
        label = "komentare"
    today = dt.datetime.now().astimezone().date()
    today_only = any(term in low for term in ("dnes", "today"))
    if today_only:
        filtered = []
        for record in records:
            ts = parse_iso_time(record.get("created_at") or record.get("time") or record.get("at"))
            if ts and ts.date() == today:
                filtered.append(record)
        records = filtered
    if not records:
        state = ensure_xoz_channel_state()
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        if not state.get("activity_channel_announced_at"):
            state["activity_channel_announced_at"] = now
            g.write_json(XOZ_STATE_FILE, state)
            return f"Zatim nemam dohledatelny zaznam o {label} Agent XOZ."
        return f"Zatim nemam dohledatelny zaznam o {label} Agent XOZ."
    return xoz_activity_overview(records, label, today_only)


def parse_xoz_control_request(text: str) -> str | None:
    if not is_xoz_control_request_text(text):
        return None
    low = g.normalize_text(text)
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    numbers = re.findall(r"\b\d+\b", low)
    item = {
        "created_at": now,
        "source": "virtual-assistant",
        "agent": "Agent XOZ",
        "task": text.strip(),
        "requested_comment_count": int(numbers[0]) if numbers else 1,
        "action": "add_comment" if any(term in low for term in ("pridej", "vloz", "okomentuj", "komentuj")) else "configure_engagement",
        "expected_output": "potvrzeni nastaveni a nasledny activity_log s overitelnymi komentari",
    }
    append_jsonl(XOZ_CONTROL_INBOX_FILE, item)
    state = ensure_xoz_channel_state()
    requests = state.get("control_requests")
    if not isinstance(requests, list):
        requests = []
    requests.append(item)
    state["control_requests"] = requests[-100:]
    state["last_control_request"] = item
    g.write_json(XOZ_STATE_FILE, state)
    upsert_orchestration_task(
        "Agent XOZ",
        "xoz-poster",
        text.strip(),
        "xoz-control",
        str(XOZ_CONTROL_INBOX_FILE),
        {"control_inbox": str(XOZ_CONTROL_INBOX_FILE), "state": str(XOZ_STATE_FILE), "activity_log": str(XOZ_ACTIVITY_LOG_FILE)},
    )
    return "Predavam Agentu XOZ. Vystup overim."


def is_browser_form_task_text(text: str) -> bool:
    if not is_browser_form_action_text(text):
        return False
    urls = find_urls_in_text(text)
    if not urls:
        return False
    if any(("x.com" in url or "twitter.com" in url) for url in urls):
        return False
    return True


def is_browser_form_action_text(text: str) -> bool:
    low = g.normalize_text(text)
    object_terms = (
        "formular",
        "form",
        "komentar",
        "comment",
        "recenze",
        "review",
        "hodnoceni",
        "rating",
    )
    action_terms = (
        "vypln",
        "odesli",
        "potvrd",
        "submit",
        "pridej",
        "vloz",
        "okomentuj",
        "zverejni",
        "publikuj",
    )
    return any(term in low for term in object_terms) and any(term in low for term in action_terms)


def browser_contextual_task_text(text: str) -> str:
    if find_urls_in_text(text):
        return text.strip()
    history = g.load_json(g.HISTORY_FILE, [])
    if not isinstance(history, list):
        return text.strip()
    recent_context: list[str] = []
    selected_url = ""
    for item in reversed(history[-20:]):
        if not isinstance(item, dict):
            continue
        content = str(item.get("content") or "").strip()
        if not content:
            continue
        if not selected_url:
            urls = find_urls_in_text(content)
            if urls:
                selected_url = urls[-1]
        low = g.normalize_text(content)
        if any(term in low for term in ("formular", "recenze", "review", "hodnoceni", "komentar")):
            recent_context.append(content[:1200])
        if selected_url and len(recent_context) >= 3:
            break
    parts = [selected_url, text.strip(), *reversed(recent_context[:3])]
    return "\n".join(part for part in parts if part).strip()


def random_comment_for_form(seed: str) -> str:
    comments = [
        "Diky za prakticky clanek, pomohl mi udelat si v tom jasno.",
        "Zajimava osobni zkusenost, podobne veci ted taky resim.",
        "Dobry postreh, hlavne ta cast o praktickem pouziti mi dava smysl.",
        "Fajn shrnuti, ocenil jsem konkretni pohled z praxe.",
    ]
    idx = int(hashlib.sha1(seed.encode("utf-8", errors="replace")).hexdigest()[:4], 16) % len(comments)
    return comments[idx]


def extract_comment_form_entries(text: str) -> list[dict[str, str]]:
    emails = re.findall(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", text)
    if not emails:
        return []
    entries: list[dict[str, str]] = []
    for idx, email_value in enumerate(emails):
        email_pos = text.find(email_value)
        window = text[max(0, email_pos - 120): email_pos + 180]
        name = ""
        patterns = (
            r"jm[eé]no\s+(?:bude|je|:)?\s+([A-Za-z0-9._-]{2,40})",
            r"name\s+(?:will be|is|:)?\s+([A-Za-z0-9._-]{2,40})",
        )
        for pattern in patterns:
            matches = re.findall(pattern, window, flags=re.IGNORECASE)
            if matches:
                name = matches[-1]
                break
        if not name:
            name = f"komentar{idx + 1}"
        comment = random_comment_for_form(f"{email_value}|{name}|{idx}")
        entries.append({"kind": "comment", "email": email_value, "name": name, "comment": comment})
    return entries


def extract_review_form_entry(text: str) -> dict[str, str] | None:
    low = g.normalize_text(text)
    if not any(term in low for term in ("recenze", "review", "hodnoceni", "rating", "hvezd", "hvězd")):
        return None
    name = ""
    for pattern in (
        r"(?:jm[eé]no|name)\s*[:*\-]*\s*([A-Za-zÀ-ž][A-Za-zÀ-ž ._-]{1,60})",
        r"jm[eé]nem\s+([A-Za-zÀ-ž][A-Za-zÀ-ž ._-]{1,60})",
    ):
        match = re.search(pattern, text, flags=re.IGNORECASE)
        if match:
            name = re.sub(r"\s+", " ", match.group(1)).strip(" *.-")
            break
    rating_match = re.search(r"\b([1-5])\s*(?:/\s*5|hv[eě]zdi|star)", text, flags=re.IGNORECASE)
    rating = rating_match.group(1) if rating_match else "5"
    review = ""
    review_match = re.search(r"(?:recenze|review)\s*[:*\-]*\s*[\"“]?(.{20,1200}?)[\"”]?(?:\n\n|$)", text, flags=re.IGNORECASE | re.DOTALL)
    if review_match:
        review = re.sub(r"\s+", " ", review_match.group(1)).strip(' "“”*')
    if not review:
        quoted = re.findall(r'["“]([^"”]{20,1200})["”]', text, flags=re.DOTALL)
        if quoted:
            review = re.sub(r"\s+", " ", quoted[-1]).strip()
    email_match = re.search(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", text)
    if not name:
        name = "Ema Vale"
    if not review:
        return None
    return {
        "kind": "review",
        "email": email_match.group(0) if email_match else "",
        "name": name,
        "comment": review,
        "rating": rating,
    }


def default_review_form_entry(text: str) -> dict[str, str] | None:
    low = g.normalize_text(text)
    any_data = any(term in low for term in (
        "jakymikoliv daty",
        "jakakoliv data",
        "libovolnymi daty",
        "libovolny komentar",
        "libovolnou recenzi",
        "jakykoliv komentar",
        "jakoukoliv recenzi",
        "random komentar",
        "random recenzi",
        "hodnoty si vymysli",
        "data si vymysli",
        "komentar vymysli",
        "recenzi vymysli",
    ))
    review_target = any(term in low for term in ("#reviews", "/reviews", "recenze", "review", "hodnoceni", "/produkt/"))
    if not (any_data and review_target):
        return None
    config = gmail_env_config()
    return {
        "kind": "review",
        "email": str(config.get("address") or "mailto.jakub.elias@gmail.com"),
        "name": "Ema Vale",
        "comment": "Prijemna textura, snadno se nanasi a po pouziti pusobi plet sveze. Ocenuji jednoduche pouziti a lehky pocit na pleti.",
        "rating": "5",
    }


def default_comment_form_entry(text: str) -> dict[str, str] | None:
    low = g.normalize_text(text)
    wants_comment = any(term in low for term in ("komentar", "comment", "okomentuj"))
    wants_action = any(term in low for term in ("pridej", "vloz", "odesli", "potvrd", "okomentuj"))
    if not (wants_comment and wants_action):
        return None
    config = gmail_env_config()
    return {
        "kind": "comment",
        "email": str(config.get("address") or "mailto.jakub.elias@gmail.com"),
        "name": "Ema Vale",
        "comment": random_comment_for_form(text),
    }


def browser_task_paths(task_id: str, index: int) -> dict[str, Path]:
    base = g.AGENT_WORK_DIR / "browser-tasks"
    base.mkdir(parents=True, exist_ok=True)
    stem = f"{task_id}-{index}"
    return {
        "task": base / f"{stem}.json",
        "result": base / f"{stem}.result.json",
        "result_tmp": base / f"{stem}.result.tmp",
        "log": base / f"{stem}.log",
        "screenshot": base / f"{stem}.png",
    }


def wordpress_comment_actions(entry: dict[str, str]) -> list[dict[str, str]]:
    return [
        {"type": "fill", "selector": "textarea#comment, textarea[name='comment']", "value": entry["comment"]},
        {"type": "fill", "selector": "input#author, input[name='author']", "value": entry["name"]},
        {"type": "fill", "selector": "input#email, input[name='email']", "value": entry["email"]},
        {"type": "click", "selector": "input#submit, input[type='submit'], button[type='submit'], button:has-text('Odeslat')"},
    ]


def review_form_actions(entry: dict[str, str]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = [
        {"type": "click", "selector": "#tab-title-reviews a[href='#tab-reviews'], a[href='#tab-reviews']", "optional": True},
        {"type": "fill", "selector": "form#commentform input#author, form#commentform input[name='author']", "value": entry["name"]},
    ]
    if entry.get("email"):
        actions.append({"type": "fill", "selector": "form#commentform input#email, form#commentform input[name='email']", "value": entry["email"]})
    actions.extend([
        {"type": "fill", "selector": "form#commentform textarea#comment, form#commentform textarea[name='comment']", "value": entry["comment"]},
        {"type": "select", "selector": "form#commentform select#rating, form#commentform select[name='rating']", "value": entry.get("rating") or "5", "optional": True},
        {"type": "click", "selector": f"form#commentform p.stars a.star-{entry.get('rating') or '5'}, form#commentform a.star-{entry.get('rating') or '5'}", "optional": True},
        {"type": "click", "selector": "form#commentform input#submit, form#commentform input[type='submit'], form#commentform button[type='submit']"},
    ])
    return actions


def start_playwright_form_task(url: str, entry: dict[str, str], task_id: str, index: int) -> dict[str, str]:
    helper = Path("/home/openclaw2/scripts/virtual_assistant_playwright.mjs")
    paths = browser_task_paths(task_id, index)
    task = {
        "url": url,
        "allowSubmit": True,
        "waitUntil": "commit",
        "timeoutMs": 60000,
        "screenshotPath": str(paths["screenshot"]),
        "actions": review_form_actions(entry) if entry.get("kind") == "review" else wordpress_comment_actions(entry),
    }
    paths["task"].write_text(json.dumps(task, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    command = (
        f"node {shlex.quote(str(helper))} {shlex.quote(str(paths['task']))} "
        f"> {shlex.quote(str(paths['result_tmp']))} 2> {shlex.quote(str(paths['log']))}; "
        f"rc=$?; if [ -s {shlex.quote(str(paths['result_tmp']))} ]; then "
        f"mv {shlex.quote(str(paths['result_tmp']))} {shlex.quote(str(paths['result']))}; "
        f"else rm -f {shlex.quote(str(paths['result_tmp']))}; fi; "
        f"echo exit_code=$rc >> {shlex.quote(str(paths['log']))}; exit $rc"
    )
    subprocess.Popen(["bash", "-lc", command], cwd=str(g.AGENT_WORK_DIR), start_new_session=True)
    return {key: str(value) for key, value in paths.items()}


def parse_browser_form_task_request(text: str) -> str | None:
    if not is_browser_form_task_text(text):
        return None
    urls = find_urls_in_text(text)
    if not urls:
        return None
    url = urls[0]
    review_entry = extract_review_form_entry(text)
    if not review_entry:
        review_entry = default_review_form_entry(text)
    entries = [review_entry] if review_entry else extract_comment_form_entries(text)
    if not entries:
        default_comment = default_comment_form_entry(text)
        entries = [default_comment] if default_comment else []
    if not entries:
        return "Blokuje me: rozpoznala jsem browser/formular ukol, ale nenasla jsem dost hodnot pro jeho pole."
    task_id = delegation_task_id("Virtualni asistentka", "browser", text.strip(), "browser-form")
    proof_items = []
    for idx, entry in enumerate(entries, 1):
        try:
            proof_items.append(start_playwright_form_task(url, entry, task_id, idx))
        except Exception as exc:
            g.log(f"Playwright form task start failed: {type(exc).__name__}: {exc}")
            fallback = browser_task_paths(task_id, idx)
            fallback["log"].write_text(f"start_failed={type(exc).__name__}: {exc}\n", encoding="utf-8")
            proof_items.append({key: str(value) for key, value in fallback.items()})
    proof = {
        "url": url,
        "entries": json.dumps(entries, ensure_ascii=False),
        "tasks": json.dumps(proof_items, ensure_ascii=False),
    }
    upsert_orchestration_task(
        "Virtualni asistentka",
        "browser",
        text.strip(),
        "browser-form",
        str(g.AGENT_WORK_DIR / "browser-tasks"),
        proof,
    )
    return f"Spoustim browser formular pres Playwright: {len(entries)} odeslani. Vystup overim."


def browser_form_submission_evidence(data: dict[str, Any], entry: dict[str, str]) -> str:
    page_text = g.normalize_text(str(data.get("pageText") or ""))
    marker = data.get("submitMarker") if isinstance(data.get("submitMarker"), dict) else {}
    marker_text = g.normalize_text(" ".join(str(marker.get(key) or "") for key in ("bodySubmitted", "resultText")))
    comment = g.normalize_text(str(entry.get("comment") or ""))
    name = g.normalize_text(str(entry.get("name") or ""))
    success_terms = (
        "dekujeme",
        "děkujeme",
        "odeslano",
        "odesláno",
        "odeslana",
        "odeslána",
        "ceka na schvaleni",
        "čeká na schválení",
        "awaiting moderation",
        "comment submitted",
        "review submitted",
        "success",
    )
    haystack = f"{marker_text}\n{page_text}"
    if any(term in haystack for term in success_terms):
        return "potvrzovaci hlaska po odeslani"
    if comment and comment[:40] in page_text:
        return "vlozeny text je videt na strance"
    if name and comment and name in page_text and comment.split(" ")[0] in page_text:
        return "jmeno a cast komentare jsou videt na strance"
    return ""


def browser_form_task_observation(task: dict[str, Any]) -> tuple[str, str]:
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    try:
        task_files = json.loads(str(proof.get("tasks") or "[]"))
    except Exception:
        task_files = []
    try:
        entries = json.loads(str(proof.get("entries") or "[]"))
    except Exception:
        entries = []
    if not isinstance(entries, list):
        entries = []
    if not isinstance(task_files, list) or not task_files:
        return "BLOCKED", "Browser formular nema ulozene Playwright task soubory."
    done = 0
    blockers: list[str] = []
    unverified: list[str] = []
    pending = 0
    for index, item in enumerate(task_files):
        if not isinstance(item, dict):
            continue
        entry = entries[index] if index < len(entries) and isinstance(entries[index], dict) else {}
        result_path = Path(str(item.get("result") or ""))
        log_path = Path(str(item.get("log") or ""))
        if result_path.exists():
            try:
                result_text = result_path.read_text(encoding="utf-8", errors="replace").strip()
                if not result_text:
                    pending += 1
                    continue
                data = json.loads(result_text)
            except Exception as exc:
                if task_age_seconds(task) <= 900:
                    pending += 1
                else:
                    blockers.append(f"nejde precist dokonceny result: {type(exc).__name__}")
                continue
            if data.get("ok"):
                evidence = browser_form_submission_evidence(data, entry)
                if evidence:
                    done += 1
                else:
                    unverified.append("Playwright vyplnil a klikl submit, ale nenasel potvrzeni ani viditelny vlozeny obsah.")
            else:
                blockers.append(str(data.get("error") or data.get("summary") or "Playwright vratil ok=false")[:180])
        elif log_path.exists():
            try:
                log_tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-4:])
            except Exception:
                log_tail = ""
            if "start_failed" in log_tail:
                blockers.append(log_tail[:180])
            else:
                exit_match = re.search(r"exit_code=(\d+)", log_tail)
                if exit_match and exit_match.group(1) != "0":
                    blockers.append(f"Playwright skoncil s exit code {exit_match.group(1)}")
                else:
                    pending += 1
        else:
            pending += 1
    if done == len(task_files):
        return "DONE", f"Browser formular ma overeny vysledek po odeslani: {done}/{len(task_files)}."
    if unverified and not blockers:
        return "BLOCKED", "Nemuzu potvrdit odeslani formulare: " + "; ".join(unverified[:2])
    if blockers:
        return "BLOCKED", "Browser formular se nepodarilo dokoncit: " + "; ".join(blockers[:2])
    if pending:
        return "VERIFYING", "Browser formular bezi pres Playwright; cekam na dokonceny vysledek."
    if task_age_seconds(task) > 900:
        return "BLOCKED", "Browser formular nema vysledek z Playwright helperu do 15 minut."
    return "VERIFYING", "Browser formular bezi pres Playwright."


def cancel_misrouted_xoz_browser_tasks(tasks: list[dict[str, Any]]) -> int:
    changed = 0
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if str(task.get("kind") or "") != "xoz-control":
            continue
        if str(task.get("status") or "ASSIGNED") in {"DONE", "BLOCKED", "CANCELED"}:
            continue
        topic = str(task.get("topic") or "")
        if not is_browser_form_task_text(topic):
            continue
        task["status"] = "CANCELED"
        task["last_reported_status"] = "CANCELED"
        task["reported_at"] = now
        task["updated_at"] = now
        task["last_observation"] = "Zruseno: WordPress/formularovy komentar patri VA browser Playwright workflow, ne Agentu XOZ."
        changed += 1
    return changed


def cancel_misrouted_activity_blogger_tasks(tasks: list[dict[str, Any]]) -> int:
    changed = 0
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if not str(task.get("kind") or "").startswith("blogger-"):
            continue
        if str(task.get("status") or "ASSIGNED") == "CANCELED":
            continue
        topic = str(task.get("topic") or "")
        if not is_xoz_activity_request_text(topic):
            continue
        task["status"] = "CANCELED"
        task["last_reported_status"] = "CANCELED"
        task["reported_at"] = now
        task["updated_at"] = now
        task["last_observation"] = "Zruseno: slo o dotaz na XOZ aktivitu, ne o zadani clanku."
        changed += 1
    return changed


def load_agent_g_handoff_state() -> dict[str, Any]:
    try:
        state = json.loads(AGENT_G_HANDOFF_STATE_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        state = {}
    if not isinstance(state, dict):
        state = {}
    delivered = state.get("delivered")
    if not isinstance(delivered, dict):
        delivered = {}
    state["delivered"] = delivered
    return state


def save_agent_g_handoff_state(state: dict[str, Any]) -> None:
    AGENT_G_HANDOFF_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    AGENT_G_HANDOFF_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def agent_g_raw_env() -> dict[str, str]:
    env = base_load_env()
    if not isinstance(env, dict):
        return {}
    return env


def agent_g_token_and_chat() -> tuple[str, str]:
    env = agent_g_raw_env()
    token = g.pick(
        env,
        "TELEGRAM_AGENT_G_BOT_TOKEN",
        "TELEGRAM_AGENT_G_TOKEN",
        "TELEGRAM_G_BOT_TOKEN",
        "G_TELEGRAM_BOT_TOKEN",
        "G_TELEGRAM_TOKEN",
        "AGENT_G_TELEGRAM_TOKEN",
        "AGENT_G_BOT_TOKEN",
        "G_BOT_TOKEN",
    )
    chat_id = g.pick(
        env,
        "TELEGRAM_AGENT_G_CHAT_ID",
        "G_TELEGRAM_CHAT_ID",
        "AGENT_G_CHAT_ID",
        "TELEGRAM_AGENT_G_ADMIN_CHAT_ID",
        "M_TELEGRAM_CHAT_ID",
        "TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID",
        "VIRTUAL_ASSISTANT_TELEGRAM_CHAT_ID",
        "VA_TELEGRAM_CHAT_ID",
    )
    if token and not chat_id:
        chat_id = g.DEFAULT_CHAT_ID or "6247540911"
    return token, chat_id


def agent_g_telegram_notify(text: str) -> str:
    token, chat_id = agent_g_token_and_chat()
    if not token or not chat_id:
        return "missing-token-or-chat"
    payload = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=payload)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8", errors="replace"))
        return "sent" if result.get("ok") else "failed"
    except Exception as exc:
        g.log(f"Agent G Telegram handoff failed: {type(exc).__name__}: {exc}")
        return f"failed:{type(exc).__name__}"


def append_agent_g_history_message(content: str) -> str:
    try:
        history = json.loads(AGENT_G_HISTORY_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        history = []
    if not isinstance(history, list):
        history = []
    marker = hashlib.sha1(content.encode("utf-8", errors="replace")).hexdigest()[:16]
    for item in history[-80:]:
        if isinstance(item, dict) and marker in str(item.get("content") or ""):
            return "deduped"
    history.append({"role": "user", "content": f"[VA-HANDOFF:{marker}]\n{content}"})
    AGENT_G_HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    AGENT_G_HISTORY_FILE.write_text(json.dumps(history[-500:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return "written"


def append_agent_g_memory_line(line: str) -> str:
    AGENT_G_MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if AGENT_G_MEMORY_FILE.exists():
        try:
            existing = AGENT_G_MEMORY_FILE.read_text(encoding="utf-8", errors="replace")
        except Exception:
            existing = ""
    if line in existing:
        return "deduped"
    with AGENT_G_MEMORY_FILE.open("a", encoding="utf-8") as handle:
        if existing and not existing.endswith("\n"):
            handle.write("\n")
        handle.write(line + "\n")
    return "written"


def agent_g_handoff_text(item: dict[str, Any]) -> str:
    return "\n".join([
        "INSTRUKCE OD VIRTUALNI ASISTENTKY PRO AGENTA G",
        f"ID: {item.get('id') or ''}",
        f"Typ: {item.get('kind') or ''}",
        f"Blokovany agent: {item.get('blocked_agent') or ''} / {item.get('blocked_instance') or ''}",
        f"Ukol: {item.get('blocked_topic') or ''}",
        f"Problem: {item.get('blocker') or ''}",
        f"Ocekavany vystup: {item.get('expected_output') or ''}",
        "Po vyreseni zapis vysledek do sve odpovedi a pokud je to runtime oprava, dopln overitelny log/status.",
    ]).strip()


def deliver_agent_g_handoff(item: dict[str, Any]) -> dict[str, str]:
    handoff_id = str(item.get("id") or hashlib.sha1(json.dumps(item, sort_keys=True, ensure_ascii=False).encode("utf-8", errors="replace")).hexdigest()[:16])
    state = load_agent_g_handoff_state()
    delivered = state["delivered"]
    if isinstance(delivered.get(handoff_id), dict) and delivered[handoff_id].get("version") == AGENT_G_HANDOFF_VERSION:
        return {**delivered[handoff_id], "deduped": "true"}
    text = agent_g_handoff_text(item)
    append_jsonl(AGENT_G_HANDOFFS_FILE, {**item, "handoff_text": text, "handoff_created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds")})
    memory_status = append_agent_g_memory_line(f"- VA handoff {handoff_id}: {item.get('blocked_agent')} / {item.get('blocker')}")
    history_status = append_agent_g_history_message(text)
    telegram_status = agent_g_telegram_notify("VA handoff: mam pro tebe technicky blocker.\n\n" + text[:3200])
    result = {
        "handoff_id": handoff_id,
        "handoffs": "written",
        "memory": memory_status,
        "history": history_status,
        "telegram": telegram_status,
        "at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "version": AGENT_G_HANDOFF_VERSION,
        "history_path": str(AGENT_G_HISTORY_FILE),
        "memory_path": str(AGENT_G_MEMORY_FILE),
    }
    delivered[handoff_id] = result
    save_agent_g_handoff_state(state)
    return result


def ensure_agent_g_handoffs_once() -> int:
    count = 0
    candidates = read_jsonl(AGENT_G_INBOX_FILE, 1000)
    candidates.extend(read_jsonl(AGENT_G_HANDOFFS_FILE, 1000))
    seen: set[str] = set()
    for item in candidates:
        if not isinstance(item, dict):
            continue
        if item.get("source") != "virtual-assistant" or item.get("agent") != "Agent G":
            continue
        handoff_id = str(item.get("id") or "")
        if handoff_id and handoff_id in seen:
            continue
        if handoff_id:
            seen.add(handoff_id)
        result = deliver_agent_g_handoff(item)
        if result.get("deduped") != "true":
            count += 1
    return count


def assign_agent_d_x_idea(text: str) -> tuple[bool, str]:
    state_path = Path("/home/openclaw2/x-post-state.json")
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    idea = {
        "text": text.strip(),
        "added": dt.date.today().isoformat(),
        "source": "virtual-assistant",
        "assigned_at": now,
    }
    try:
        state = g.load_json(state_path, {})
        if not isinstance(state, dict):
            state = {}
        items = state.get("custom_instructions", [])
        if not isinstance(items, list):
            items = []
        items.append(idea)
        state["custom_instructions"] = items
        state["virtual_assistant_last_assignment"] = idea
        g.write_json(state_path, state)
        upsert_orchestration_task(
            "Agent D",
            "x-poster",
            text.strip(),
            "x-social-draft",
            str(state_path),
            {"state": str(state_path), "workflow_output": ".rpi-output-poster"},
        )
        return True, str(state_path)
    except Exception as exc:
        inbox = g.OPENCLAW_DIR / "agent-d-inbox.jsonl"
        append_jsonl(inbox, {
            "created_at": now,
            "source": "virtual-assistant",
            "agent": "Agent D",
            "task": text.strip(),
            "error": str(exc)[:240],
        })
        upsert_orchestration_task(
            "Agent D",
            "x-poster",
            text.strip(),
            "x-social-draft",
            str(inbox),
            {"inbox": str(inbox), "workflow_output": ".rpi-output-poster"},
        )
        return False, str(inbox)


def social_x_target(text: str, forced_agent_id: str = "") -> dict[str, str]:
    low = g.normalize_text(text)
    if forced_agent_id == "agent-xoz" or (
        forced_agent_id != "agent-d"
        and any(term in low for term in ("xoz", "agent xoz", "osobnizkusenosti", "osobni zkusenosti", "osobnizkusenosti.cz", "oz"))
        and not any(term in low for term in ("btc-dca", "btc dca", "btcdca"))
    ):
        return {
            "id": "agent-xoz",
            "agent": "Agent XOZ",
            "instance": "xoz-poster",
            "kind": "xoz-social-draft",
            "state": str(XOZ_STATE_FILE),
            "inbox": str(XOZ_INBOX_FILE),
            "label": "navrh prispevku na X pro Osobni zkusenosti: Agent XOZ",
        }
    return {
        "id": "agent-d",
        "agent": "Agent D",
        "instance": "x-poster",
        "kind": "x-social-draft",
        "state": "/home/openclaw2/x-post-state.json",
        "inbox": str(g.OPENCLAW_DIR / "agent-d-inbox.jsonl"),
        "label": "navrh prispevku na X pro btc-dca/default: Agent D",
    }


def assign_social_x_task(text: str, forced_agent_id: str = "") -> tuple[bool, dict[str, str], str]:
    target = social_x_target(text, forced_agent_id=forced_agent_id)
    if target["id"] == "agent-d":
        ok, path = assign_agent_d_x_idea(text)
        return ok, target, path

    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    task_id = delegation_task_id(target["agent"], target["instance"], text.strip(), target["kind"])
    item = {
        "task_id": task_id,
        "created_at": now,
        "source": "virtual-assistant",
        "agent": target["agent"],
        "task": text.strip(),
        "format_preferences": xoz_current_draft_preferences(),
        "expected_output": "navrh X prispevku ke schvaleni, bez publikace; vratit hotovy text a obrazovy podklad/prompt",
    }
    try:
        inbox = Path(target["inbox"])
        append_jsonl(inbox, item)
        state_path = Path(target["state"])
        state = g.load_json(state_path, {})
        if not isinstance(state, dict):
            state = {}
        assignments = state.get("assignments", [])
        if not isinstance(assignments, list):
            assignments = []
        assignments.append(item)
        state["assignments"] = assignments[-100:]
        state["virtual_assistant_last_assignment"] = item
        statuses = state.get("task_status")
        if not isinstance(statuses, dict):
            statuses = {}
        statuses[task_id] = {
            **(statuses.get(task_id) if isinstance(statuses.get(task_id), dict) else {}),
            "task_id": task_id,
            "topic": text.strip(),
            "status": "DELIVERED",
            "received_at": now,
            "updated_at": now,
            "expected_output": "navrh X prispevku ke schvaleni, bez publikace",
        }
        state["task_status"] = statuses
        g.write_json(state_path, state)
        upsert_orchestration_task(
            target["agent"],
            target["instance"],
            text.strip(),
            target["kind"],
            str(inbox),
            {"inbox": str(inbox), "state": str(state_path)},
        )
        return True, target, str(inbox)
    except Exception as exc:
        fallback = g.OPENCLAW_DIR / "agent-xoz-inbox-failed.jsonl"
        append_jsonl(fallback, {**item, "error": str(exc)[:240]})
        upsert_orchestration_task(
            target["agent"],
            target["instance"],
            text.strip(),
            target["kind"],
            str(fallback),
            {"inbox": str(fallback), "error": str(exc)[:240]},
        )
        return False, target, str(fallback)


def xoz_task_record_for_task(state: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
    statuses = state.get("task_status")
    task_id = str(task.get("id") or "")
    if isinstance(statuses, dict) and isinstance(statuses.get(task_id), dict):
        return statuses[task_id]
    topic = str(task.get("topic") or "").strip()
    if isinstance(statuses, dict):
        for record in statuses.values():
            if isinstance(record, dict) and str(record.get("topic") or "").strip() == topic:
                return record
    assignments = state.get("assignments")
    if isinstance(assignments, list):
        for assignment in reversed(assignments):
            if not isinstance(assignment, dict):
                continue
            if str(assignment.get("task_id") or "") == task_id or str(assignment.get("task") or "").strip() == topic:
                return {
                    "task_id": task_id,
                    "topic": topic,
                    "status": "DELIVERED",
                    "received_at": assignment.get("created_at") or task.get("created_at") or "",
                }
    return {}


def find_bybit_affiliate_link(text: str) -> str:
    sources = [text]
    history = g.load_json(g.HISTORY_FILE, [])
    if isinstance(history, list):
        for item in reversed(history[-80:]):
            if isinstance(item, dict):
                sources.append(str(item.get("content") or ""))
    candidates: list[str] = []
    for source in sources:
        if "bybit" not in g.normalize_text(source):
            continue
        urls = find_urls_in_text(source)
        for url in urls:
            domain = domain_from_url(url)
            if domain.endswith("bybit.com") or domain.endswith("bybit.eu"):
                candidates.append(re.sub(r"[`'\".,);\]]+$", "", url))
    for url in candidates:
        low = url.lower()
        if any(term in low for term in ("ref=", "invite", "affiliate", "partner", "/b/")):
            return url
    if candidates:
        return candidates[0]
    return ""


def xoz_generate_x_draft(topic: str) -> str:
    low = g.normalize_text(topic)
    if "bybit" in low:
        affiliate_link = find_bybit_affiliate_link(topic)
        link_text = affiliate_link or "[DOPLNIT SCHVALENY BYBIT AFFILIATE ODKAZ]"
        if ("1 euro" in low or "1 eur" in low) and ("20 eur" in low or "20 euro" in low):
            return (
                "Bybit ma akci pro nove uzivatele: po vkladu 1 EUR muzes podle podminek akce ziskat bonus 20 EUR. "
                "Pokud hledas alternativu pro nakup a spravu krypta, muze to byt zajimavy zpusob, jak si platformu vyzkouset s malym vkladem. "
                "Pred registraci si zkontroluj aktualni podminky a dostupnost akce.\n\n"
                f"{link_text}"
            )
        return (
            "Osobni zkusenost: u krypta mi dava nejvetsi smysl mit burzu jako nastroj, ne jako misto pro impulzivni rozhodovani. "
            "Bybit muze byt uzitecny pro pokrocilejsi praci s kryptem, ale porad plati: nejdriv pravidla, limity a jasny plan.\n\n"
            f"{link_text}"
        )
    if "krypto" in low or "crypto" in low or "bitcoin" in low or "btc" in low:
        return (
            "Osobni zkusenost: u krypta se nejvic vyplaci klidny proces, ne honba za dalsim tipem. "
            "Kdyz si clovek predem urci pravidla, limity a duvod, proc do toho jde, dela mnohem mene impulzivnich rozhodnuti."
        )
    if "ai" in low or "agent" in low:
        return (
            "Osobni zkusenost: nejvetsi rozdil v praci s AI agenty neni v tom, ze neco napisou za me. "
            "Je v tom, ze drzi kontext, hlidaji navaznosti a nenechaji ukoly vysumet. Tam zacina realna uspora casu."
        )
    return (
        "Osobni zkusenost: nejlepsi veci v praci casto nevzniknou z dalsiho nastroje, ale z dobreho procesu. "
        "Kdyz je jasne, kdo ma co prevzit, jak se overi vysledek a kdy se vratit se stavem, prestanou ukoly mizet mezi radky."
    )


def xoz_generate_image_prompt(topic: str) -> str:
    low = g.normalize_text(topic)
    if "bybit" in low:
        if ("1 euro" in low or "1 eur" in low) and ("20 eur" in low or "20 euro" in low):
            return "Moderni realisticka kryptomenova promo scena: jedna eurova mince prechazi do balicku dvaceti eurovych minci, mobilni telefon s abstraktnim burzovnim rozhranim, ciste svetlo, bez log, bez znacek a bez textu v obrazku."
        return "Realisticka mobilni pracovni scena: clovek kontroluje krypto portfolio na telefonu, vedle notebook s jednoduchym planem a poznamkami, cisty moderni styl, bez log a bez textu v obrazku."
    if "krypto" in low or "bitcoin" in low or "btc" in low:
        return "Realisticka pracovni scena s notebookem, grafem krypta a rucne psanymi pravidly investicniho planu, civilni ceske prostredi, bez log a bez textu v obrazku."
    return "Realisticka kancelarska scena s poznamkami, checklistem a telefonem pro pripravu socialniho prispevku, prirozene svetlo, bez log a bez textu v obrazku."


def generated_image_url(prompt: str) -> str:
    clean = re.sub(r"\s+", " ", prompt.strip())
    encoded = urllib.parse.quote(clean[:900])
    return f"https://image.pollinations.ai/prompt/{encoded}?width=1536&height=864&nologo=true&enhance=true&model=flux"


def xoz_current_draft_preferences() -> list[str]:
    state = g.load_json(XOZ_STATE_FILE, {})
    prefs = state.get("draft_format_preferences") if isinstance(state, dict) else []
    if not isinstance(prefs, list):
        return []
    return [str(item).strip() for item in prefs if str(item or "").strip()]


def update_xoz_draft_preferences_from_text(text: str) -> list[str]:
    low = g.normalize_text(text)
    additions: list[str] = []
    if ("promo" in low or "affiliate" in low) and any(term in low for term in ("ne", "bez", "nechci")):
        additions.append("Bez kratkeho oznaceni promo/affiliate v textu ani v podkladu.")
    if any(term in low for term in ("hotovy text", "text")) and any(term in low for term in ("obrazek", "fotka", "image")):
        additions.append("Navrh ma obsahovat hotovy text a obrazovy podklad/prompt ke schvaleni.")
    if "schvalovac" in low or "schvaleni" in low:
        additions.append("VA ma vratit navrh ke schvaleni a nepublikovat bez potvrzeni.")
    if not additions and any(term in low for term in ("tohle ne", "bez", "nechci")):
        additions.append("Respektovat posledni stylistickou pripominku bez dalsiho doptavani.")
    state = ensure_xoz_channel_state()
    existing = state.get("draft_format_preferences")
    if not isinstance(existing, list):
        existing = []
    prefs = unique_items([str(item) for item in existing] + additions)
    state["draft_format_preferences"] = prefs[-20:]
    state["draft_format_preferences_updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    g.write_json(XOZ_STATE_FILE, state)
    if additions:
        try:
            g.append_memory_line("- XOZ format preference: " + " ".join(additions)[:500])
        except Exception as exc:
            g.log(f"XOZ preference memory write failed: {type(exc).__name__}: {exc}")
    return prefs


def infer_recent_xoz_topic(text: str) -> str:
    brand_pattern = r"\b(Bybit|Binance|Coinbase|XTB|Kraken|OKX|Bitget|BTC-DCA|Bitcoin|Ethereum)\b"
    current_brands = re.findall(brand_pattern, text, flags=re.IGNORECASE)
    if current_brands:
        return current_brands[-1]
    try:
        history = g.load_json(g.HISTORY_FILE, [])
    except Exception:
        history = []
    if isinstance(history, list):
        for item in reversed(history[-16:]):
            if isinstance(item, dict):
                brands = re.findall(brand_pattern, str(item.get("content") or ""), flags=re.IGNORECASE)
                if brands:
                    return brands[-1]
    return "aktualni navrh pro Osobni zkusenosti podle schvaleneho formatu"


def xoz_worker_once(tasks: list[dict[str, Any]] | None = None) -> int:
    tasks = tasks if tasks is not None else load_orchestration_tasks()
    changed = 0
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    ensure_xoz_channel_state()
    for task in tasks:
        if not isinstance(task, dict):
            continue
        if str(task.get("kind") or "") != "xoz-social-draft":
            continue
        if str(task.get("status") or "ASSIGNED") in {"DONE", "BLOCKED", "CANCELED"}:
            continue
        proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
        state_path = Path(str(proof.get("state") or g.OPENCLAW_DIR / "agent-xoz-state.json"))
        state = g.load_json(state_path, {})
        if not isinstance(state, dict):
            state = {}
        statuses = state.get("task_status")
        if not isinstance(statuses, dict):
            statuses = {}
        task_id = str(task.get("id") or delegation_task_id("Agent XOZ", "xoz-poster", str(task.get("topic") or ""), "xoz-social-draft"))
        record = xoz_task_record_for_task(state, task)
        if not isinstance(record, dict):
            record = {}
        before = json.dumps(record, sort_keys=True, ensure_ascii=False)
        record["task_id"] = task_id
        record["topic"] = str(task.get("topic") or "").strip()
        record["received_at"] = record.get("received_at") or task.get("created_at") or now
        record["accepted_at"] = record.get("accepted_at") or now
        record["in_progress_at"] = record.get("in_progress_at") or now
        record["expected_output"] = record.get("expected_output") or "navrh X prispevku ke schvaleni, bez publikace"
        record["format_preferences"] = record.get("format_preferences") or xoz_current_draft_preferences()
        if not record.get("output"):
            record["output"] = xoz_generate_x_draft(record["topic"])
            record["image_prompt"] = xoz_generate_image_prompt(record["topic"])
            record["image_url"] = generated_image_url(record["image_prompt"])
            record["output_at"] = now
            record["status"] = "READY_FOR_APPROVAL"
        else:
            if not record.get("image_prompt"):
                record["image_prompt"] = xoz_generate_image_prompt(record["topic"])
            if record.get("image_prompt") and not record.get("image_url"):
                record["image_url"] = generated_image_url(str(record.get("image_prompt") or ""))
            record["status"] = record.get("status") or "READY_FOR_APPROVAL"
        record["updated_at"] = now
        statuses[task_id] = record
        state["task_status"] = statuses
        state["last_output"] = record
        after = json.dumps(record, sort_keys=True, ensure_ascii=False)
        if before != after:
            state_path.parent.mkdir(parents=True, exist_ok=True)
            g.write_json(state_path, state)
            changed += 1
    return changed


def is_social_delegation_task(text: str) -> bool:
    low = g.normalize_text(text)
    return any(term in low for term in (
        " x ",
        "x ",
        "x post",
        "twitter",
        "tweet",
        "prispevek",
        "příspěvek",
        "social",
        "kampan",
        "kampaň",
    ))


def is_blog_article_delegation_task(text: str) -> bool:
    low = g.normalize_text(text)
    return any(term in low for term in (
        "blog",
        "wordpress",
        "clanek",
        "clanku",
        "article",
        "draft clanku",
        "napsat clanek",
        "vygeneruj clanek",
    ))


def parse_social_x_delegation_request(text: str) -> str | None:
    if not is_social_x_delegation_request_text(text):
        return None
    ok, target, path = assign_social_x_task(text)
    append_orchestration_event(target["agent"], target["instance"], text, target["kind"], path)
    return f"Deleguji: {target['label']}." if ok else f"Deleguji: {target['label']} pres fallback inbox."


def parse_cancel_social_assignment_request(text: str) -> str | None:
    low = g.normalize_text(text)
    if not any(term in low for term in ("zrus", "storno", "cancel")):
        return None
    if not any(term in low for term in ("agent d", "agenta d", "agentovi d")) and not re.search(r"\bd\b", low):
        return None
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    removed = 0
    state_path = Path("/home/openclaw2/x-post-state.json")
    try:
        state = g.load_json(state_path, {})
        if isinstance(state, dict):
            items = state.get("custom_instructions", [])
            if isinstance(items, list):
                kept = []
                for item in items:
                    item_text = g.normalize_text(str(item.get("text") if isinstance(item, dict) else item))
                    should_remove = "osobnizkusenosti" in item_text or "osobni zkusenosti" in item_text or "xoz" in item_text or "oz " in item_text
                    if should_remove:
                        removed += 1
                    else:
                        kept.append(item)
                state["custom_instructions"] = kept
            assignment = state.get("virtual_assistant_last_assignment")
            if isinstance(assignment, dict):
                assignment_text = g.normalize_text(str(assignment.get("text") or ""))
                if "osobnizkusenosti" in assignment_text or "osobni zkusenosti" in assignment_text or "xoz" in assignment_text or "oz " in assignment_text:
                    state.pop("virtual_assistant_last_assignment", None)
            g.write_json(state_path, state)
    except Exception as exc:
        g.log(f"Cancel Agent D assignment state update failed: {type(exc).__name__}: {exc}")

    tasks = load_orchestration_tasks()
    changed = False
    for task in tasks:
        if str(task.get("agent") or "") != "Agent D" or str(task.get("kind") or "") != "x-social-draft":
            continue
        topic_low = g.normalize_text(str(task.get("topic") or ""))
        if "osobnizkusenosti" not in topic_low and "osobni zkusenosti" not in topic_low and "xoz" not in topic_low and "oz " not in topic_low:
            continue
        task["status"] = "CANCELED"
        task["last_reported_status"] = "CANCELED"
        task["reported_at"] = now
        task["last_observation"] = "Zadani pro Agent D zruseno; spravny cil je Agent XOZ."
        task["updated_at"] = now
        changed = True
    if changed:
        save_orchestration_tasks(tasks)
    return f"Zruseno: zadani pro Agenta D jsem oznacila jako zrusene. Spravny cil pro X Osobni zkusenosti je Agent XOZ."


def parse_routing_correction_request(text: str) -> str | None:
    low = g.normalize_text(text)
    if not ("agent d" in low or "agenta d" in low):
        return None
    if not ("xoz" in low or "osobnizkusenosti" in low or "osobni zkusenosti" in low):
        return None
    if not ("btc-dca" in low or "btc dca" in low or "btcdca" in low):
        return None
    memory_line = "- Routing: X/social pro Osobni zkusenosti patri Agentovi XOZ; Agent D patri jen na btc-dca.com social/X."
    try:
        g.append_memory_line(memory_line)
    except Exception as exc:
        g.log(f"Routing correction memory write failed: {type(exc).__name__}: {exc}")
    return "Beru. Routing opraven: X pro Osobni zkusenosti smeruju na Agent XOZ; Agent D nechavam pro btc-dca."


def parse_combined_delegation_request(text: str) -> str | None:
    blog_text = article_text_for_combined_delegation(text)
    blog_target = blogger_delegation_target(blog_text)
    has_blog = blog_target is not None and is_blog_article_delegation_task(blog_text)
    has_social = is_social_delegation_task(text)
    if not (has_blog and has_social):
        return None

    blog_reply = parse_blogger_delegation_request(blog_text)
    ok, social_target, target = assign_social_x_task(text)
    append_orchestration_event(social_target["agent"], social_target["instance"], text, social_target["kind"], target)

    parts: list[str] = ["Deleguji:"]
    if blog_reply and blog_target:
        parts.append(f"- clanek/draft: {blog_target[1]}")
    else:
        append_orchestration_event("Blog agent", "blog", text, "blog-assignment-needs-routing", "ORCHESTRATION.md")
        parts.append("- clanek/draft: blog agent, potrebuji doresit cil nebo konfiguraci")
    parts.append(f"- {social_target['label']}" if ok else f"- {social_target['label']}, fallback inbox")
    parts.append("")
    parts.append("Ozvu se, az budu mit overeny vystup nebo skutecny blocker.")
    return "\n".join(parts)


def parse_delegation_status_request(text: str) -> str | None:
    low = g.normalize_text(text)
    status_terms = ("vystup", "vysledek", "odkaz", "link", "url", "stav", "kde je", "posli mi na nej")
    new_task_terms = ("zajisti", "vytvor", "vygeneruj", "napis", "udelej navrh", "priprav", "at vznikne", "dej na x", "prispevek", "navrh", "postni", "publikuj")
    if not any(term in low for term in status_terms):
        return None
    if is_social_x_delegation_request_text(text) or is_combined_delegation_request_text(text) or is_browser_form_action_text(text):
        return None
    if any(term in low for term in new_task_terms):
        return None
    tasks = load_orchestration_tasks()
    if not tasks:
        return None
    candidates = [task for task in tasks if str(task.get("kind") or "").startswith("blogger-")]
    if any(term in low for term in ("oz", "osobni zkusenosti", "osobnizkusenosti")):
        candidates = [
            task for task in candidates
            if any(marker in g.normalize_text(" ".join([str(task.get("agent") or ""), str(task.get("instance") or ""), str(task.get("topic") or "")]))
                   for marker in ("oz", "osobni zkusenosti", "osobnizkusenosti"))
        ]
    else:
        non_btc = [
            task for task in candidates
            if "btc-dca" not in g.normalize_text(" ".join([str(task.get("agent") or ""), str(task.get("instance") or ""), str(task.get("topic") or "")]))
        ]
        if non_btc:
            candidates = non_btc
    if not candidates:
        return None
    candidates.sort(key=lambda item: str(item.get("created_at") or item.get("updated_at") or ""), reverse=True)
    task = candidates[0]
    status, note = observe_delegation_task(task)
    if status == "DONE":
        return f"Predchozi delegace: {note}"
    if status == "BLOCKED":
        return f"Blocker u predchozi delegace: {note}"
    return f"Predchozi delegace jeste nema overeny vystup: {note}"


def parse_general_delegation_request(text: str) -> str | None:
    low = g.normalize_text(text)
    asks_delegation = any(term in low for term in (
        "deleguj",
        "delegovat",
        "prislusnym agentum",
        "prislusnym agentum",
        "agentum",
        "agentum",
        "zapoj agent",
        "nemas tvorit",
        "nemas to tvorit",
    ))
    social_task = is_social_delegation_task(text)
    if not (asks_delegation or (is_orchestration_task(text) and social_task)):
        return None

    assigned: list[str] = []
    blockers: list[str] = []
    if social_task or "agent d" in low or "agenta d" in low:
        ok, social_target, target = assign_social_x_task(text)
        append_orchestration_event(social_target["agent"], social_target["instance"], text, social_target["kind"], target)
        if ok:
            assigned.append(social_target["label"])
        else:
            blockers.append(f"{social_target['label']}, fallback inbox")

    if any(term in low for term in ("medium", "dev", "hashnode", "agent m", "agenta m")):
        inbox = g.OPENCLAW_DIR / "agent-m-inbox.jsonl"
        append_jsonl(inbox, {
            "created_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "source": "virtual-assistant",
            "agent": "Agent M",
            "task": text.strip(),
            "expected_output": "draft/publish plan for Medium/DEV/Hashnode with verification links",
        })
        append_orchestration_event("Agent M", "medium-dev-hashnode", text, "publishing-assignment", str(inbox))
        assigned.append("Medium/DEV/Hashnode: Agent M")

    wants_btc_blog = any(term in low for term in ("blog", "wordpress", "agent c", "agenta c")) or (
        any(term in low for term in ("btc-dca", "btc dca"))
        and any(term in low for term in ("blog", "wordpress", "clanek", "clanku", "članek", "článku", "article"))
    )
    if wants_btc_blog and not blogger_delegation_target(text):
        instance = resolve_blogger_instance(("btc-dca", "btcdca"), ("btc-dca", "btc dca", "btcdca"))
        append_orchestration_event("Agent C", instance, text, "blog-assignment-needs-topic", "ORCHESTRATION.md")
        blockers.append("blog na btc-dca.com: Agent C, ale chybi jednoznacne tema")

    if not assigned and not blockers:
        append_orchestration_event("Virtual Assistant", "orchestration", text, "needs-routing", "ORCHESTRATION.md")
        blockers.append("rozpoznala jsem delegaci, ale neurcila jsem bezpecneho ciloveho agenta")

    lines = ["Deleguji:"]
    lines.extend(f"- {item}" for item in assigned)
    if blockers:
        lines.append("")
        lines.append("K doreseni:")
        lines.extend(f"- {item}" for item in blockers)
    lines.append("")
    lines.append("Ozvu se, az budu mit overeny vystup nebo skutecny blocker.")
    return "\n".join(lines)


def parse_blogger_delegation_request(text: str) -> str | None:
    if is_xoz_activity_request_text(text):
        return None
    target = blogger_delegation_target(text)
    if not target:
        return None
    low = g.normalize_text(text)
    if not any(term in low for term in ("clanek", "clanku", "članek", "článku", "draft", "post", "tema", "téma", "napiš", "napis", "napsat", "vygeneruj", "priprav", "připrav", "zadej", "deleguj")):
        return None

    instance, agent_name = target
    publish = explicit_publish_requested(text)
    target_low = g.normalize_text(f"{instance} {agent_name}")
    personal_experience_target = any(term in target_low for term in ("agent oz", "osobnizkusenosti", "osobni zkusenosti"))
    if personal_experience_target and publish:
        return (
            "U Agenta OZ jsem rozpoznala pozadavek s publikaci. Protoze Osobni zkusenosti maji vychozi rezim draft, "
            "publikaci nespoustim automaticky. Potvrd prosim jednou vetou `publikuj Agent OZ: ...`, pokud ma jit opravdu ven."
        )

    topic = extract_blogger_topic(text)
    script = Path("/home/openclaw2/scripts/btc-dca-blogger.py")
    if not script.exists():
        return f"Blokuje me: blogger runtime neni dostupny na `{script}`. Spravny cil jsem ale urcila jako {agent_name}, instance `{instance}`."

    cfg_path = g.OPENCLAW_DIR / f"{instance}-blogger-config.json"
    if not cfg_path.exists():
        return f"Blokuje me: pro {agent_name} chybi konfigurace `{cfg_path}`. Nepouziju nahradne Agenta C."
    cfg_data = g.load_json(cfg_path, {})
    if not isinstance(cfg_data, dict):
        cfg_data = {}
    default_post_status = g.normalize_text(str(cfg_data.get("wp_post_status") or cfg_data.get("WP_POST_STATUS") or ""))
    site_url = str(cfg_data.get("WP_SITE_URL") or cfg_data.get("wp_site_url") or "")
    site_domain = domain_from_url(site_url)
    explicit_link_requested = any(term in g.normalize_text(text) for term in ("odkaz", "link", "url", "nahled"))
    requires_link = default_post_status == "draft" or explicit_link_requested

    state_path = write_blogger_requested_topic(instance, topic)
    log_path = g.OPENCLAW_DIR / "logs" / f"virtual-assistant-{instance}-delegation.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    topic_arg = shlex.quote(topic)
    if publish:
        command = f"python3 {shlex.quote(str(script))} --instance {shlex.quote(instance)} --topic {topic_arg} --phase all --force"
    elif default_post_status == "draft":
        article_command = f"python3 {shlex.quote(str(script))} --instance {shlex.quote(instance)} --topic {topic_arg} --phase article --force"
        publish_command = f"python3 {shlex.quote(str(script))} --instance {shlex.quote(instance)} --topic {topic_arg} --phase publish --force"
        command = f"{article_command} && {publish_command}"
    else:
        command = f"python3 {shlex.quote(str(script))} --instance {shlex.quote(instance)} --topic {topic_arg} --phase article --force"
    runner = ""
    tmux_path = shutil.which("tmux")
    if tmux_path:
        session = f"va-{instance}-{dt.datetime.now().strftime('%Y%m%d-%H%M%S')}"
        tmux_command = (
            f"cd {shlex.quote(str(g.AGENT_WORK_DIR))}; "
            f"echo '[virtual-assistant] start {session} {dt.datetime.now().astimezone().isoformat(timespec='seconds')}' >> {shlex.quote(str(log_path))}; "
            f"{command} >> {shlex.quote(str(log_path))} 2>&1; "
            f"code=$?; echo '[virtual-assistant] exit '$code' {dt.datetime.now().astimezone().isoformat(timespec='seconds')}' >> {shlex.quote(str(log_path))}; exit $code"
        )
        subprocess.run(
            [tmux_path, "new-session", "-d", "-s", session, "bash", "-lc", tmux_command],
            check=True,
            cwd=str(g.AGENT_WORK_DIR),
        )
        runner = f"tmux:{session}"
    else:
        with log_path.open("a", encoding="utf-8") as log_handle:
            proc = subprocess.Popen(
                ["bash", "-lc", command],
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                cwd=str(g.AGENT_WORK_DIR),
                start_new_session=True,
            )
        runner = f"pid:{proc.pid}"
    mode = "publish" if publish else "draft"
    append_orchestration_event(agent_name, instance, topic, mode, runner)
    upsert_orchestration_task(
        agent_name,
        instance,
        topic,
        "blogger-publish" if publish else "blogger-draft",
        runner,
        {
            "state": str(g.OPENCLAW_DIR / f"{instance}-blogger-state.json"),
            "log": str(log_path),
            "config": str(cfg_path),
            "site_url": site_url,
            "domain": site_domain,
            "default_post_status": default_post_status,
            "wants_link": str(explicit_link_requested),
            "requires_link": str(requires_link),
        },
    )

    if personal_experience_target:
        return f"Deleguji draft clanku na {agent_name}."
    return f"Deleguji {'publikaci' if publish else 'draft clanku'} na {agent_name}."


def virtual_assistant_route_model_for_task(text: str, history: list[dict[str, str]], settings: dict[str, str]) -> dict[str, str]:
    if text.startswith("EMAIL INSTRUKCE PRO VIRTUALNI ASISTENTKU"):
        return {
            "model": "gpt-5.5",
            "reasoning_effort": "high",
            "tier": "email_instruction",
            "reason": "emailova instrukce vyzaduje samostatne zpracovani a odpoved",
        }
    if is_oz_draft_task(text):
        return {
            "model": "gpt-5.5",
            "reasoning_effort": "high",
            "tier": "oz_draft",
            "reason": "Agent OZ / Osobni zkusenosti draft bez publikace",
        }
    if is_orchestration_task(text):
        return {
            "model": "gpt-5.5",
            "reasoning_effort": "high",
            "tier": "orchestration",
            "reason": "kampan/orchestrace vice agentu",
        }
    if is_account_or_browser_task(text):
        return {
            "model": "gpt-5.5",
            "reasoning_effort": "high",
            "tier": "account_browser",
            "reason": "ucet/browser workflow vyzaduje samostatne planovani",
        }
    return base_route_model_for_task(text, history, settings)


def virtual_assistant_timeout_for_route(settings: dict[str, str], route: dict[str, str]) -> int:
    if route.get("tier") in {"account_browser", "orchestration", "email_instruction", "oz_draft"}:
        return 480
    return max(180, base_timeout_for_route(settings, route))


def browser_targets_for_text(text: str) -> list[str]:
    low = g.normalize_text(text)
    targets: list[str] = []
    if any(word in low for word in ("gmail", "google", "email", "e-mail", "mail")) and any(word in low for word in ("zaloz", "signup", "registr", "ucet", "adres")):
        targets.append("https://accounts.google.com/signup")
    if "linkedin" in low and any(word in low for word in ("zaloz", "signup", "registr", "profil", "ucet")):
        targets.append("https://www.linkedin.com/signup")
    for match in re.findall(r"https?://[^\s)>\"]+", text):
        if match not in targets:
            targets.append(match)
    return targets[:2]


def browser_check_context(text: str) -> str:
    helper = Path("/home/openclaw2/scripts/virtual_assistant_browser.py")
    if not helper.exists():
        return ""
    parts: list[str] = []
    for url in browser_targets_for_text(text):
        try:
            result = subprocess.run(
                [str(helper), url],
                capture_output=True,
                text=True,
                timeout=45,
                check=False,
            )
            output = (result.stdout or result.stderr or "").strip()
        except Exception as exc:
            output = f"Browser helper error: {exc}"
        if output:
            parts.append(f"BROWSER CHECK {url}:\n{output[:3000]}")
    return "\n\n".join(parts)


def virtual_assistant_build_web_context(text: str) -> str:
    parts = []
    agent_context = virtual_assistant_agents_context()
    if agent_context:
        parts.append(agent_context)
    brain_context = shared_brain_context(text)
    if brain_context:
        parts.append(brain_context)
    browser_context = browser_check_context(text)
    if browser_context:
        parts.append(browser_context)
    base_context = base_build_web_context(text)
    if base_context:
        parts.append(base_context)
    return "\n\n".join(parts)


def _call_gemini_model(history: list[dict[str, str]], api_key: str, model: str) -> str:
    """Gemini API fallback when Codex CLI is unavailable."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    contents: list = []
    prev_role: str | None = None
    for msg in history[-16:]:
        role = "model" if msg.get("role") == "assistant" else "user"
        text = msg.get("content", "")
        if role == prev_role and contents:
            contents[-1]["parts"].append({"text": text})
        else:
            contents.append({"role": role, "parts": [{"text": text}]})
        prev_role = role
    if not contents or contents[0]["role"] != "user":
        contents.insert(0, {"role": "user", "parts": [{"text": "."}]})
    blogger_context = ""
    try:
        blogger_context = g.blogger_agents_context()
    except Exception:
        blogger_context = ""
    system_instruction = g.SYSTEM_PROMPT
    registry_context = virtual_assistant_agents_context()
    if registry_context:
        system_instruction = f"{system_instruction}\n\n{registry_context}"
    if blogger_context:
        system_instruction = f"{system_instruction}\n\n{blogger_context}"
    payload = json.dumps({
        "system_instruction": {"parts": [{"text": system_instruction}]},
        "contents": contents,
        "generationConfig": {"temperature": 0.7, "maxOutputTokens": 1500},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"Gemini API HTTP {exc.code}: {body}") from exc
    candidates = result.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini API: prazdna odpoved")
    parts = candidates[0].get("content", {}).get("parts", [])
    text = " ".join(p.get("text", "") for p in parts).strip()
    if not text:
        raise RuntimeError("Gemini API: prazdny text v odpovedi")
    return text


def _call_gemini(history: list[dict[str, str]], api_key: str) -> str:
    configured_models = os.environ.get("GEMINI_VA_MODELS", "")
    models = [item.strip() for item in configured_models.split(",") if item.strip()]
    if not models:
        models = [
            "gemini-flash-latest",
            "gemini-3.5-flash",
            "gemini-3.1-flash-lite",
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
        ]
    last_error: Exception | None = None
    for model in models:
        for attempt in range(3):
            try:
                return _call_gemini_model(history, api_key, model)
            except RuntimeError as exc:
                last_error = exc
                text = str(exc)
                if "HTTP 503" not in text and "HTTP 429" not in text:
                    g.log(f"Gemini fallback skip: model={model} error={text[:140]}")
                    break
                g.log(f"Gemini fallback retry: model={model} attempt={attempt + 1} error={text[:140]}")
                time.sleep(2 + attempt * 3)
            except Exception as exc:
                last_error = exc
                break
    raise RuntimeError(f"Gemini API selhalo po retry/fallback modelech: {last_error}") from last_error


def virtual_assistant_call_codex(history: list[dict[str, str]]) -> str:
    cli = g.find_codex()
    if cli and g.codex_auth_status() == "chatgpt-auth-ok":
        g.ensure_agent_workspace()
        settings = g.load_settings()
        user_text = history[-1].get("content", "") if history else ""
        route = g.route_model_for_task(user_text, history, settings)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=str(g.LOG_FILE.parent), delete=False) as tmp:
            out_path = Path(tmp.name)
        command = [
            cli, "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "danger-full-access",
            "--json", "--output-last-message", str(out_path),
        ]
        if route.get("model"):
            command.extend(["--model", route["model"]])
        command.extend(["-c", f"model_reasoning_effort=\"{route.get('reasoning_effort', settings.get('reasoning_effort', 'medium'))}\""])
        prompt = g.build_prompt(history, g.build_web_context(user_text), settings)
        g.log(f"Model route: {route.get('model')} tier={route.get('tier')} reason={route.get('reason')} sandbox=danger-full-access")
        command.append("-")
        timeout = g.timeout_for_route(settings, route)
        try:
            result = subprocess.run(
                command,
                cwd=str(g.AGENT_WORK_DIR),
                env=g.codex_env(),
                input=prompt,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            out_path.unlink(missing_ok=True)
            raise TimeoutError(f"Codex odpoved nestihla dobehnout do {timeout}s; ulozene preference zustavaji zachovane") from exc
        try:
            reply = out_path.read_text(encoding="utf-8", errors="replace").strip()
        finally:
            out_path.unlink(missing_ok=True)
        raw_usage = None
        for line in result.stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed" and isinstance(event.get("usage"), dict):
                raw_usage = event["usage"]
            item = event.get("item") if isinstance(event, dict) else None
            if not reply and isinstance(item, dict) and item.get("type") == "agent_message" and item.get("text"):
                reply = str(item["text"]).strip()
        if result.returncode != 0:
            err = (result.stderr or result.stdout or "").replace("\n", " ").strip()[:600]
            raise RuntimeError(f"Codex CLI selhal ({result.returncode}): {err}")
        if not reply:
            raise RuntimeError("Codex CLI vratil prazdnou odpoved")
        g.record_codex_usage(raw_usage, route)
        return reply

    # Gemini API fallback — Codex CLI neni instalovany nebo nema ChatGPT auth
    env = g.load_env()
    api_key = next(
        (env.get(k) for k in ("GEMINI_VA_API_KEY", "GEMINI_API_KEY_FREE", "GEMINI_AGENT_C_KEY") if env.get(k)),
        None,
    )
    if api_key:
        g.log("Gemini fallback: Codex neni dostupny, pouzivam Gemini API")
        return _call_gemini(history, api_key)
    raise RuntimeError(
        "AI backend neni dostupny — Codex CLI neni instalovany a GEMINI_VA_API_KEY neni v .env.local"
    )


def sanitize_virtual_assistant_reply(reply: str) -> str:
    text = str(reply or "").strip()
    if not text:
        return text
    technical_markers = (
        "Instance:",
        "State:",
        "Log:",
        "Runner:",
        "Tema:",
        "Téma:",
        "Az draft",
        "Až draft",
        "/home/openclaw2/",
        "ORCHESTRATION.md",
    )
    if any(marker in text for marker in technical_markers):
        for line in text.splitlines():
            clean = line.strip()
            if clean and not any(marker in clean for marker in technical_markers):
                return clean
        return text.splitlines()[0].strip()
    return text


def virtual_assistant_call_ai(history: list[dict[str, str]]) -> str:
    cleaned_history = remove_automated_google_history(history)
    if len(cleaned_history) != len(history):
        history[:] = cleaned_history
        g.write_json(g.HISTORY_FILE, history[-g.MAX_HISTORY:])
        g.log("Automated Google email instructions removed from Virtual Assistant history")
    try:
        return sanitize_virtual_assistant_reply(virtual_assistant_call_codex(history))
    except Exception as codex_exc:
        g.log(f"Codex backend failed, trying Virtual Assistant fallback: {str(codex_exc)[:180]}")
        env = g.load_env()
        api_key = next(
            (env.get(k) for k in ("GEMINI_VA_API_KEY", "GEMINI_API_KEY_FREE", "GEMINI_AGENT_C_KEY", "GEMINI_API_KEY_G", "GEMINI_API_KEY") if env.get(k)),
            None,
        )
        if api_key:
            return sanitize_virtual_assistant_reply(_call_gemini(history, api_key))
        raise codex_exc


def email_state_default() -> dict[str, Any]:
    return {
        "processed_message_ids": [],
        "last_check_at": "",
        "setup_email_sent": False,
    }


def load_email_state() -> dict[str, Any]:
    state = g.load_json(g.EMAIL_STATE_FILE, email_state_default())
    if not isinstance(state, dict):
        state = email_state_default()
    state.setdefault("processed_message_ids", [])
    state.setdefault("last_check_at", "")
    state.setdefault("setup_email_sent", False)
    if not isinstance(state["processed_message_ids"], list):
        state["processed_message_ids"] = []
    return state


def save_email_state(state: dict[str, Any]) -> None:
    processed = [str(item) for item in state.get("processed_message_ids", []) if item]
    state["processed_message_ids"] = processed[-500:]
    state["last_check_at"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    g.write_json(g.EMAIL_STATE_FILE, state)


def gmail_token_from_secret(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        raise RuntimeError("MAILTO_JAKUB_GMAIL_OAUTH_TOKEN chybi")
    if raw.startswith("{"):
        data = json.loads(raw)
        if data.get("access_token"):
            return str(data["access_token"])
        refresh_token = data.get("refresh_token")
        client_id = data.get("client_id")
        client_secret = data.get("client_secret")
        if refresh_token and client_id and client_secret:
            payload = urllib.parse.urlencode({
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            }).encode("utf-8")
            req = urllib.request.Request(
                "https://oauth2.googleapis.com/token",
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                refreshed = json.loads(resp.read().decode("utf-8"))
            token = refreshed.get("access_token")
            if token:
                return str(token)
        raise RuntimeError("Gmail OAuth JSON nema access_token ani refresh_token/client_id/client_secret")
    return raw


def gmail_oauth_secret_kind(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return "missing"
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return "json_invalid"
        keys = {str(key) for key in data.keys()}
        if {"refresh_token", "client_id", "client_secret"}.issubset(keys):
            return "json_refresh_token"
        if "access_token" in keys:
            return "json_access_token"
        if "refresh_token" in keys:
            return "json_refresh_token_missing_client"
        return "json_unknown"
    if raw.startswith("ya29."):
        return "raw_access_token"
    if raw.startswith("1//"):
        return "raw_refresh_token_missing_client"
    return "raw_bearer_unknown"


def gmail_env_config() -> dict[str, str]:
    env = g.load_env()
    return {
        "oauth_secret": g.pick(env, "MAILTO_JAKUB_GMAIL_OAUTH_TOKEN", "VIRTUAL_ASSISTANT_GMAIL_OAUTH_TOKEN"),
        "address": g.pick(env, "MAILTO_JAKUB_GMAIL_ADDRESS", "VIRTUAL_ASSISTANT_EMAIL_ADDRESS", default="mailto.jakub.elias@gmail.com"),
        "trusted_senders": g.pick(env, "VIRTUAL_ASSISTANT_EMAIL_TRUSTED_SENDERS", default="jakub.elias88@gmail.com,mailto.jakub.elias@gmail.com"),
        "setup_recipient": g.pick(env, "VIRTUAL_ASSISTANT_EMAIL_SETUP_RECIPIENT", default="jakub.elias88@gmail.com"),
        "poll_seconds": g.pick(env, "VIRTUAL_ASSISTANT_EMAIL_POLL_SECONDS", default="7200"),
    }


def gmail_request(access_token: str, method: str, path: str, data: dict[str, Any] | None = None, query: dict[str, str] | None = None) -> dict[str, Any]:
    url = "https://gmail.googleapis.com/gmail/v1/users/me/" + path.lstrip("/")
    if query:
        url += "?" + urllib.parse.urlencode(query)
    payload = json.dumps(data).encode("utf-8") if data is not None else None
    headers = {"Authorization": f"Bearer {access_token}"}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:600]
        raise RuntimeError(f"Gmail API HTTP {exc.code}: {body}") from exc


def header_value(message: dict[str, Any], name: str) -> str:
    headers = message.get("payload", {}).get("headers", [])
    if not isinstance(headers, list):
        return ""
    for item in headers:
        if isinstance(item, dict) and str(item.get("name", "")).lower() == name.lower():
            return str(item.get("value", ""))
    return ""


def clean_header_text(value: str) -> str:
    return re.sub(r"[\r\n]+", " ", value).strip()


def repair_mojibake(value: str) -> str:
    text = value
    markers = ("Ã", "Â", "Å", "Ă", "Ć", "Ë")

    def score(candidate: str) -> int:
        return sum(candidate.count(marker) for marker in markers)

    for _ in range(3):
        if not any(marker in text for marker in markers):
            break
        candidates = [text]
        for encoding in ("latin1", "cp1252", "cp1250"):
            try:
                candidates.append(text.encode(encoding).decode("utf-8"))
            except UnicodeError:
                pass
        fixed = min(candidates, key=score)
        if fixed == text or score(fixed) >= score(text):
            break
        text = fixed
    return text


def decoded_header_value(message: dict[str, Any], name: str) -> str:
    raw = header_value(message, name)
    if not raw:
        return ""
    try:
        decoded = str(email.header.make_header(email.header.decode_header(raw)))
    except Exception:
        decoded = raw
    return repair_mojibake(clean_header_text(decoded))


def encoded_subject_header(subject: str) -> str:
    clean = repair_mojibake(clean_header_text(subject))
    return email.header.Header(clean, "utf-8").encode()


def decode_gmail_body(payload: dict[str, Any]) -> str:
    chunks: list[str] = []

    def walk(part: dict[str, Any]) -> None:
        mime = str(part.get("mimeType", ""))
        body = part.get("body", {}) if isinstance(part.get("body"), dict) else {}
        data = body.get("data")
        if data and mime in {"text/plain", "text/html", ""}:
            try:
                raw = base64.urlsafe_b64decode(str(data) + "===")
                text = raw.decode("utf-8", errors="replace")
                if mime == "text/html":
                    text = re.sub(r"<(br|p|div|li)\b[^>]*>", "\n", text, flags=re.I)
                    text = re.sub(r"<[^>]+>", " ", text)
                chunks.append(re.sub(r"\s+", " ", text).strip())
            except Exception:
                pass
        for child in part.get("parts", []) if isinstance(part.get("parts"), list) else []:
            if isinstance(child, dict):
                walk(child)

    walk(payload)
    return "\n".join(chunk for chunk in chunks if chunk).strip()


def email_address(value: str) -> str:
    return email.utils.parseaddr(value)[1].strip().lower()


def trusted_email_sender(sender: str, config: dict[str, str]) -> bool:
    trusted = {item.strip().lower() for item in config.get("trusted_senders", "").split(",") if item.strip()}
    return email_address(sender) in trusted


def is_automated_google_email(sender: str, subject: str, body: str) -> bool:
    sender_addr = email_address(sender)
    sender_text = g.normalize_text(sender)
    subject_text = g.normalize_text(subject)
    body_head = g.normalize_text(body[:2000])
    from_google = (
        sender_addr.endswith("@google.com")
        or sender_addr.endswith("@accounts.google.com")
        or sender_addr.endswith("@cloudnotifications.google.com")
        or "google" in sender_text
    )
    automated_sender = any(token in sender_addr for token in ("no-reply", "noreply", "notification", "notifications"))
    google_notice_terms = (
        "google cloud",
        "google account",
        "oauth",
        "security alert",
        "bezpecnostni",
        "compromised credentials",
        "potentially compromised",
        "client secret",
        "verification",
        "overeni googlem",
        "access blocked",
        "pristup zablokovan",
        "api project",
    )
    haystack = f"{subject_text}\n{body_head}"
    return from_google and (automated_sender or any(term in haystack for term in google_notice_terms))


def is_automated_google_history_message(message: dict[str, str]) -> bool:
    content = str(message.get("content") or "")
    if not content.startswith("EMAIL INSTRUKCE PRO VIRTUALNI ASISTENTKU"):
        return False
    low = g.normalize_text(content[:4000])
    return (
        ("od:" in low and "google" in low)
        and any(term in low for term in ("oauth", "google cloud", "security", "bezpecnost", "compromised", "client secret", "pristup zablokovan"))
    )


def remove_automated_google_history(history: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        item for item in history
        if not (isinstance(item, dict) and is_automated_google_history_message(item))
    ]


def gmail_send(access_token: str, to_addr: str, from_addr: str, subject: str, body: str, thread_id: str = "", reply_to_message_id: str = "", references: str = "") -> None:
    headers = [
        f"From: {clean_header_text(from_addr)}",
        f"To: {clean_header_text(to_addr)}",
        f"Subject: {encoded_subject_header(subject)}",
        "MIME-Version: 1.0",
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: 8bit",
    ]
    if reply_to_message_id:
        headers.append(f"In-Reply-To: {clean_header_text(reply_to_message_id)}")
    if references or reply_to_message_id:
        headers.append(f"References: {clean_header_text((references + ' ' + reply_to_message_id).strip())}")
    raw = "\r\n".join(headers) + "\r\n\r\n" + body
    encoded = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    payload: dict[str, Any] = {"raw": encoded}
    if thread_id:
        payload["threadId"] = thread_id
    gmail_request(access_token, "POST", "messages/send", payload)


def build_email_instruction(message: dict[str, Any], body: str, trusted: bool) -> str:
    sender = header_value(message, "From")
    subject = decoded_header_value(message, "Subject") or "(bez predmetu)"
    date = header_value(message, "Date")
    trust_line = "Odesilatel je duveryhodny Jakubuv kanal." if trusted else "Odesilatel neni v duveryhodnem seznamu; necin zavazky a neodpovidej tretim stranam bez schvaleni."
    return "\n".join([
        "EMAIL INSTRUKCE PRO VIRTUALNI ASISTENTKU",
        trust_line,
        f"Od: {sender}",
        f"Datum: {date}",
        f"Predmet: {subject}",
        "",
        body[:12000],
        "",
        "Odpovez jako emailova odpoved. Bud konkretni, proved pouzitelne kroky, pokud jsou bezpecne, a kdyz je potreba schvaleni, napis jeden dalsi krok.",
    ])


def process_gmail_message(access_token: str, message_id: str, config: dict[str, str]) -> None:
    message = gmail_request(access_token, "GET", f"messages/{message_id}", query={"format": "full"})
    body = decode_gmail_body(message.get("payload", {}) if isinstance(message.get("payload"), dict) else {})
    sender_header = header_value(message, "From")
    sender = email_address(sender_header)
    if not sender or not body:
        return
    trusted = trusted_email_sender(sender_header, config)
    subject = decoded_header_value(message, "Subject") or "(bez predmetu)"
    if is_automated_google_email(sender_header, subject, body):
        gmail_request(access_token, "POST", f"messages/{message_id}/modify", {"removeLabelIds": ["UNREAD"]})
        g.log(f"Automated Google email ignored: from={sender} subject={subject[:80]}")
        return
    history = g.load_json(g.HISTORY_FILE, [])
    if not isinstance(history, list):
        history = []
    history = remove_automated_google_history(history)
    history.append({"role": "user", "content": build_email_instruction(message, body, trusted)})
    reply = g.call_ai(history)
    history.append({"role": "assistant", "content": reply})
    g.write_json(g.HISTORY_FILE, history[-g.MAX_HISTORY:])
    if trusted:
        reply_subject = subject if subject.lower().startswith("re:") else f"Re: {subject}"
        gmail_send(
            access_token,
            sender,
            config["address"],
            reply_subject,
            reply,
            thread_id=str(message.get("threadId", "")),
            reply_to_message_id=header_value(message, "Message-ID"),
            references=header_value(message, "References"),
        )
    else:
        gmail_send(
            access_token,
            config["setup_recipient"],
            config["address"],
            f"Virtualni asistentka: novy email k revizi - {subject}",
            "\n".join([
                f"Prisla zprava od neduveryhodneho odesilatele: {sender_header}",
                f"Predmet: {subject}",
                "",
                "Navrh reakce / shrnuti:",
                reply,
            ]),
        )
    gmail_request(access_token, "POST", f"messages/{message_id}/modify", {"removeLabelIds": ["UNREAD"]})
    g.log(f"Email processed and replied: from={sender} trusted={trusted} subject={subject[:80]}")


def gmail_poll_once() -> None:
    config = gmail_env_config()
    if not config["oauth_secret"]:
        g.log("Email poll skipped: MAILTO_JAKUB_GMAIL_OAUTH_TOKEN missing")
        return
    access_token = gmail_token_from_secret(config["oauth_secret"])
    state = load_email_state()
    processed = {str(item) for item in state.get("processed_message_ids", [])}
    if not state.get("setup_email_sent"):
        gmail_send(
            access_token,
            config["setup_recipient"],
            config["address"],
            "Virtualni asistentka: email napojen",
            "Email mailbox je napojeny. Budu ho kontrolovat priblizne kazdych 5 minut a na instrukce z duveryhodnych adres budu reagovat odpovedi z teto schranky.",
        )
        state["setup_email_sent"] = True
        g.log(f"Email setup confirmation sent to {config['setup_recipient']}")
    result = gmail_request(
        access_token,
        "GET",
        "messages",
        query={"q": "in:inbox is:unread newer_than:14d", "maxResults": "10"},
    )
    messages = result.get("messages", [])
    if not isinstance(messages, list):
        messages = []
    for item in messages:
        if not isinstance(item, dict) or not item.get("id"):
            continue
        message_id = str(item["id"])
        if message_id in processed:
            continue
        try:
            process_gmail_message(access_token, message_id, config)
            processed.add(message_id)
        except Exception as exc:
            g.log(f"Email message processing failed id={message_id}: {exc}")
    state["processed_message_ids"] = list(processed)
    save_email_state(state)


def telegram_token_chat() -> tuple[str, str]:
    env = g.load_env()
    token = env.get("TELEGRAM_AGENT_G_BOT_TOKEN") or env.get("TELEGRAM_VIRTUAL_ASSISTANT_BOT_TOKEN") or ""
    chat_id = env.get("TELEGRAM_AGENT_G_CHAT_ID") or env.get("TELEGRAM_VIRTUAL_ASSISTANT_CHAT_ID") or g.DEFAULT_CHAT_ID
    return token, chat_id


def telegram_api_post(method: str, payload: dict[str, Any], timeout: int = 20) -> dict[str, Any]:
    token, _ = telegram_token_chat()
    if not token:
        return {"ok": False, "description": "missing-token"}
    data = urllib.parse.urlencode({key: json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list)) else str(value) for key, value in payload.items()}).encode("utf-8")
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/{method}", data=data)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def telegram_notify(text: str) -> bool:
    token, chat_id = telegram_token_chat()
    if not token or not chat_id:
        g.log("Delegation monitor notification skipped: Telegram token/chat missing")
        return False
    try:
        result = telegram_api_post("sendMessage", {"chat_id": chat_id, "text": text})
        return bool(result.get("ok"))
    except Exception as exc:
        g.log(f"Delegation monitor Telegram notification failed: {type(exc).__name__}: {exc}")
        return False


def xoz_approval_keyboard(task_id: str) -> dict[str, Any]:
    short_id = str(task_id or "")[:32]
    return {
        "inline_keyboard": [[
            {"text": "Schvalit", "callback_data": f"xoz:approve:{short_id}"},
            {"text": "Upravit", "callback_data": f"xoz:edit:{short_id}"},
        ]]
    }


def telegram_notify_xoz_approval(task: dict[str, Any], note: str) -> str:
    token, chat_id = telegram_token_chat()
    if not token or not chat_id:
        return "failed"
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    state_path = Path(str(proof.get("state") or XOZ_STATE_FILE))
    state = g.load_json(state_path, {})
    record = xoz_task_record_for_task(state if isinstance(state, dict) else {}, task)
    image_url = str(record.get("image_url") or "").strip() if isinstance(record, dict) else ""
    output = str(record.get("output") or "").strip() if isinstance(record, dict) else ""
    caption = output or note
    if len(caption) > 900:
        caption = caption[:897].rstrip() + "..."
    caption = caption + "\n\nChces neco upravit, nebo schvalujes?"
    keyboard = xoz_approval_keyboard(str(task.get("id") or ""))
    try:
        if image_url:
            result = telegram_api_post("sendPhoto", {
                "chat_id": chat_id,
                "photo": image_url,
                "caption": caption,
                "reply_markup": keyboard,
            }, timeout=30)
        else:
            result = telegram_api_post("sendMessage", {
                "chat_id": chat_id,
                "text": note,
                "reply_markup": keyboard,
            }, timeout=20)
        if result.get("ok"):
            return "sent"
    except Exception as exc:
        g.log(f"XOZ approval Telegram photo failed: {type(exc).__name__}: {exc}")
    return "sent" if telegram_notify(note) else "failed"


def telegram_notify_deduped(text: str, window_seconds: int = 1800) -> str:
    key_text = re.sub(r"\s+", " ", text.strip())
    key = hashlib.sha1(key_text.encode("utf-8", errors="replace")).hexdigest()[:20]
    now = time.time()
    try:
        state = json.loads(NOTIFICATION_DEDUPE_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        state = {}
    if not isinstance(state, dict):
        state = {}
    try:
        last_sent = float(state.get(key) or 0)
    except (TypeError, ValueError):
        last_sent = 0
    if last_sent and now - last_sent < window_seconds:
        g.log(f"Telegram notification deduped: {key_text[:180]}")
        return "deduped"
    ok = telegram_notify(text)
    if ok:
        state[key] = now
        cutoff = now - max(window_seconds * 4, 3600)
        cleaned = {}
        for item_key, item_value in state.items():
            try:
                sent_at = float(item_value)
            except (TypeError, ValueError):
                continue
            if sent_at >= cutoff:
                cleaned[str(item_key)] = sent_at
        NOTIFICATION_DEDUPE_FILE.parent.mkdir(parents=True, exist_ok=True)
        NOTIFICATION_DEDUPE_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return "sent" if ok else "failed"


def task_age_seconds(task: dict[str, Any]) -> int:
    raw = str(task.get("created_at") or "")
    try:
        created = dt.datetime.fromisoformat(raw)
        if created.tzinfo is None:
            created = created.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)
        return max(0, int((dt.datetime.now().astimezone() - created).total_seconds()))
    except Exception:
        return 0


def should_auto_escalate_to_agent_g(task: dict[str, Any], note: str = "") -> bool:
    if task.get("escalated_to_agent_g_at"):
        return False
    kind = str(task.get("kind") or "")
    agent = str(task.get("agent") or "")
    if kind != "x-social-draft" or agent != "Agent D":
        return False
    haystack = g.normalize_text(f"{note} {task.get('last_observation') or ''}")
    return any(term in haystack for term in ("nevznikl overitelny x vystup", "assignment se nepropsal", "runner", "chyba", "blocker"))


def escalate_task_to_agent_g(task: dict[str, Any], note: str) -> bool:
    if task.get("escalated_to_agent_g_at"):
        return False
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    topic = str(task.get("topic") or "").strip()
    escalation_topic = f"Vyres blocker u {task.get('agent')}: {topic}"
    escalation_id = delegation_task_id("Agent G", "operations", escalation_topic, "technical-blocker")
    item = {
        "id": escalation_id,
        "created_at": now,
        "source": "virtual-assistant",
        "agent": "Agent G",
        "kind": "technical-blocker",
        "related_task_id": task.get("id"),
        "blocked_agent": task.get("agent"),
        "blocked_instance": task.get("instance"),
        "blocked_kind": task.get("kind"),
        "blocked_topic": topic,
        "blocker": note,
        "proof": task.get("proof") if isinstance(task.get("proof"), dict) else {},
        "expected_output": "opravit nebo restartovat prislusny X workflow/sluzbu, doplnit overitelny vystup do state/logu, nebo vratit konkretni technicky blocker",
    }
    append_jsonl(AGENT_G_INBOX_FILE, item)
    handoff_result = deliver_agent_g_handoff(item)
    append_orchestration_event("Agent G", "operations", escalation_topic, "technical-blocker", str(AGENT_G_INBOX_FILE))
    upsert_orchestration_task(
        "Agent G",
        "operations",
        escalation_topic,
        "technical-blocker",
        str(AGENT_G_INBOX_FILE),
        {
            "inbox": str(AGENT_G_INBOX_FILE),
            "handoffs": str(AGENT_G_HANDOFFS_FILE),
            "history": str(AGENT_G_HISTORY_FILE),
            "related_task_id": str(task.get("id") or ""),
            "blocked_agent": str(task.get("agent") or ""),
            "handoff": json.dumps(handoff_result, ensure_ascii=False),
        },
    )
    task["escalated_to_agent_g_at"] = now
    task["agent_g_escalation_id"] = escalation_id
    task["agent_g_escalation_note"] = note
    task["agent_g_handoff"] = handoff_result
    return True


def escalate_reported_agent_d_blockers_once() -> int:
    tasks = load_orchestration_tasks()
    changed = 0
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    for task in tasks:
        if not isinstance(task, dict):
            continue
        note = str(task.get("last_observation") or "")
        if str(task.get("status") or "") == "BLOCKED" and should_auto_escalate_to_agent_g(task, note):
            if escalate_task_to_agent_g(task, note):
                task["status"] = "VERIFYING"
                task["last_observation"] = "Agent D ma blocker; predano Agentovi G k technicke oprave."
                task["updated_at"] = now
                task["last_reported_status"] = "VERIFYING"
                task.pop("reported_at", None)
                changed += 1
    if changed:
        save_orchestration_tasks(tasks)
    return changed


def escalate_recent_agent_d_blocker_log_once() -> int:
    if not g.LOG_FILE.exists():
        return 0
    try:
        lines = g.LOG_FILE.read_text(encoding="utf-8", errors="replace").splitlines()[-1200:]
    except Exception:
        return 0
    recent = []
    for line in lines:
        match = re.match(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+->\s+Blocker:\s+(Agent D.*)$", line)
        if not match:
            continue
        ts = parse_log_time(match.group(1))
        if not ts:
            continue
        if (dt.datetime.now().astimezone() - ts).total_seconds() > 72 * 3600:
            continue
        recent.append((ts, match.group(2).strip()))
    if not recent:
        return 0
    existing = "\n".join(json.dumps(item, ensure_ascii=False) for item in read_jsonl(AGENT_G_INBOX_FILE, 1000))
    changed = 0
    for ts, blocker in recent[-5:]:
        key = hashlib.sha1(f"agent-d-log-blocker|{blocker}".encode("utf-8", errors="replace")).hexdigest()[:16]
        if key in existing:
            continue
        now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        topic = f"Vyres Agent D X blocker z logu: {blocker[:160]}"
        item = {
            "id": key,
            "created_at": now,
            "source": "virtual-assistant",
            "agent": "Agent G",
            "kind": "technical-blocker",
            "related_task_id": "",
            "blocked_agent": "Agent D",
            "blocked_instance": "x-poster",
            "blocked_kind": "x-social-draft",
            "blocked_topic": "neznamy, vytazeno z VA blocker logu",
            "blocker": blocker,
            "proof": {
                "state": "/home/openclaw2/x-post-state.json",
                "log": str(g.LOG_FILE),
                "source": "virtual-assistant-log",
            },
            "expected_output": "dohledat proc Agent D/X poster nevytvoril overitelny vystup, opravit workflow/sluzbu nebo vratit konkretni technicky blocker",
        }
        append_jsonl(AGENT_G_INBOX_FILE, item)
        handoff_result = deliver_agent_g_handoff(item)
        append_orchestration_event("Agent G", "operations", topic, "technical-blocker", str(AGENT_G_INBOX_FILE))
        upsert_orchestration_task(
            "Agent G",
            "operations",
            topic,
            "technical-blocker",
            str(AGENT_G_INBOX_FILE),
            {
                "inbox": str(AGENT_G_INBOX_FILE),
                "handoffs": str(AGENT_G_HANDOFFS_FILE),
                "history": str(AGENT_G_HISTORY_FILE),
                "blocked_agent": "Agent D",
                "source": "virtual-assistant-log",
                "handoff": json.dumps(handoff_result, ensure_ascii=False),
            },
        )
        existing += "\n" + key
        changed += 1
    return changed


def delegation_delivery_note(task: dict[str, Any]) -> str:
    agent = str(task.get("agent") or "Agent").strip() or "Agent"
    kind = str(task.get("kind") or "")
    if kind == "x-social-draft":
        return "Doruceno: Agent D ma zadani."
    if kind == "xoz-social-draft":
        return "Doruceno: Agent XOZ ma zadani."
    if kind == "technical-blocker" and agent == "Agent G":
        return "Predano Agentovi G: technicky blocker je v jeho inboxu a pameti."
    if kind.startswith("blogger-"):
        return f"Doruceno: {agent} ma zadani."
    return f"Doruceno: {agent} ma zadani."


def find_urls_in_text(text: str) -> list[str]:
    return re.findall(r"https?://[^\s\"'<>]+", text or "")


def output_urls_from_state(value: Any, expected_domain: str = "", key_path: str = "") -> list[str]:
    urls: list[str] = []
    output_key_terms = (
        "post_url",
        "draft_url",
        "preview_url",
        "permalink",
        "wp_url",
        "wordpress_url",
        "published_url",
        "canonical_url",
        "post_link",
    )
    if isinstance(value, dict):
        for key, item in value.items():
            child_key = f"{key_path}.{key}" if key_path else str(key)
            urls.extend(output_urls_from_state(item, expected_domain, child_key))
    elif isinstance(value, list):
        for item in value:
            urls.extend(output_urls_from_state(item, expected_domain, key_path))
    elif isinstance(value, str):
        key_low = g.normalize_text(key_path)
        if any(term in key_low for term in output_key_terms) or key_low.endswith(".url"):
            urls.extend(find_urls_in_text(value))
    if expected_domain:
        urls = [url for url in urls if expected_domain in domain_from_url(url)]
    return list(dict.fromkeys(urls))


def first_state_value_by_key(value: Any, names: set[str]) -> Any:
    if isinstance(value, dict):
        for key, item in value.items():
            if g.normalize_text(str(key)) in names:
                return item
            found = first_state_value_by_key(item, names)
            if found not in (None, ""):
                return found
    elif isinstance(value, list):
        for item in value:
            found = first_state_value_by_key(item, names)
            if found not in (None, ""):
                return found
    return None


def site_base_from_task(task: dict[str, Any], proof: dict[str, Any], expected_domain: str) -> str:
    raw = str(proof.get("site_url") or "").strip()
    if not raw:
        config_raw = str(proof.get("config") or "")
        config_path = Path(config_raw) if config_raw else None
        if config_path and config_path.exists() and config_path.is_file():
            config = g.load_json(config_path, {})
            if isinstance(config, dict):
                raw = str(config.get("WP_SITE_URL") or config.get("wp_site_url") or "").strip()
    if not raw and expected_domain:
        raw = f"https://{expected_domain}"
    return raw.rstrip("/")


def draft_preview_urls_from_state(task: dict[str, Any], proof: dict[str, Any], state: dict[str, Any], expected_domain: str) -> list[str]:
    post_id = first_state_value_by_key(state, {"post_id", "wp_post_id", "wordpress_post_id"})
    post_id_text = str(post_id or "").strip()
    if not re.fullmatch(r"\d+", post_id_text):
        return []
    base = site_base_from_task(task, proof, expected_domain)
    if not base:
        return []
    return [
        f"{base}/?p={post_id_text}&preview=true",
        f"{base}/wp-admin/post.php?post={post_id_text}&action=edit",
    ]


def blogger_task_requires_link(task: dict[str, Any], proof: dict[str, Any]) -> bool:
    if str(proof.get("requires_link") or "").lower() == "true":
        return True
    if str(proof.get("wants_link") or "").lower() == "true":
        return True
    return str(task.get("kind") or "") == "blogger-draft" and str(proof.get("default_post_status") or "").lower() == "draft"


def should_recheck_reported_blogger_task(task: dict[str, Any]) -> bool:
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    if not str(task.get("kind") or "").startswith("blogger-"):
        return False
    if str(task.get("last_reported_status") or "") != "DONE":
        return False
    observation = str(task.get("last_observation") or "")
    return blogger_task_requires_link(task, proof) and "http" not in observation


def blogger_task_observation(task: dict[str, Any]) -> tuple[str, str]:
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    state_raw = str(proof.get("state") or "")
    log_raw = str(proof.get("log") or "")
    expected_domain = str(proof.get("domain") or "")
    requires_link = blogger_task_requires_link(task, proof)
    state_path = Path(state_raw) if state_raw else None
    log_path = Path(log_raw) if log_raw else None
    state: dict[str, Any] = {}
    if state_path and state_path.exists() and state_path.is_file():
        state = g.load_json(state_path, {})
        if not isinstance(state, dict):
            state = {}
    urls = output_urls_from_state(state, expected_domain)
    if not urls:
        urls = draft_preview_urls_from_state(task, proof, state, expected_domain)
    errors = state.get("errors")
    if isinstance(errors, list) and errors:
        return "BLOCKED", f"{task.get('agent')} narazil na chybu: {str(errors[-1])[:220]}"
    phases = {g.normalize_text(str(item)) for item in (state.get("phases_done") or []) if item}
    article_present = bool(state.get("article") or state.get("draft") or state.get("content") or state.get("post_title") or state.get("post_id"))
    if urls:
        return "DONE", f"{task.get('agent')} ma overeny vystup: {urls[0]}"
    log_tail = ""
    if log_path and log_path.exists() and log_path.is_file():
        try:
            log_tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-40:])
        except Exception:
            log_tail = ""
    if requires_link and (article_present or "[virtual-assistant] exit 0" in log_tail):
        domain_note = f" na domene {expected_domain}" if expected_domain else ""
        return "BLOCKED", f"{task.get('agent')} vytvoril draft/podklad, ale nenasla jsem odkaz k nahledu{domain_note}."
    if article_present or any(phase in phases for phase in ("article", "publish", "published", "post")):
        return "DONE", f"{task.get('agent')} dokoncil draft/podklad podle state souboru."
    if log_tail:
        if "[virtual-assistant] exit 0" in log_tail and task_age_seconds(task) > 180:
            return "VERIFYING", f"{task.get('agent')} dobehl bez chyby, cekam jeste na vystup ve state/logu."
        if "[virtual-assistant] exit " in log_tail and "[virtual-assistant] exit 0" not in log_tail:
            return "BLOCKED", f"{task.get('agent')} runner skoncil chybou. Detail je v delegacnim logu."
    if task_age_seconds(task) > 3600:
        return "BLOCKED", f"{task.get('agent')} nedodal overitelny vystup do 60 minut."
    return "VERIFYING", f"{task.get('agent')} je zadany, cekam na overitelny vystup."


def x_task_observation(task: dict[str, Any]) -> tuple[str, str]:
    agent = str(task.get("agent") or "Agent D")
    proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
    state_path = Path(str(proof.get("state") or "/home/openclaw2/x-post-state.json"))
    state: dict[str, Any] = {}
    if state_path.exists():
        state = g.load_json(state_path, {})
        if not isinstance(state, dict):
            state = {}
    if str(task.get("kind") or "") == "xoz-social-draft":
        record = xoz_task_record_for_task(state, task)
        output = str(record.get("output") or record.get("draft") or record.get("draft_text") or "").strip() if isinstance(record, dict) else ""
        if output:
            image_prompt = str(record.get("image_prompt") or "").strip() if isinstance(record, dict) else ""
            image_url = str(record.get("image_url") or "").strip() if isinstance(record, dict) else ""
            parts = [f"Agent XOZ navrhl X prispevek:\n{output}"]
            if image_url:
                parts.append(f"Obrazek:\n{image_url}")
            elif image_prompt:
                parts.append(f"Obrazek/prompt:\n{image_prompt}")
            parts.append("Chces neco upravit, nebo schvalujes?")
            return "DONE", "\n\n".join(parts)
        if isinstance(record, dict) and record.get("in_progress_at"):
            return "VERIFYING", "Agent XOZ prevzal zadani a pracuje na vystupu."
        if isinstance(record, dict) and record.get("accepted_at"):
            return "VERIFYING", "Agent XOZ potvrdil prevzeti zadani."
    state_text = json.dumps(state, ensure_ascii=False)
    urls = [url for url in find_urls_in_text(state_text) if "twitter.com" in url or "x.com" in url]
    if urls:
        return "DONE", f"{agent} ma overeny X vystup: {urls[0]}"
    assignment = state.get("virtual_assistant_last_assignment") if isinstance(state, dict) else None
    assignment_text = ""
    if isinstance(assignment, dict):
        assignment_text = str(assignment.get("text") or assignment.get("task") or "").strip()
    if assignment_text == str(task.get("topic") or "").strip():
        if task_age_seconds(task) > 3600:
            return "BLOCKED", f"{agent} ma zadani ulozene, ale do 60 minut nevznikl overitelny X vystup."
        return "VERIFYING", f"{agent} ma zadani ulozene, cekam na navrh nebo overitelny vystup."
    if task_age_seconds(task) > 900:
        return "BLOCKED", f"{agent} assignment se nepropsal do state souboru."
    return "VERIFYING", f"{agent} assignment cekam na propsani do state souboru."


def observe_delegation_task(task: dict[str, Any]) -> tuple[str, str]:
    kind = str(task.get("kind") or "")
    if kind.startswith("blogger-"):
        return blogger_task_observation(task)
    if kind == "x-social-draft":
        return x_task_observation(task)
    if kind == "xoz-social-draft":
        return x_task_observation(task)
    if kind == "browser-form":
        return browser_form_task_observation(task)
    if kind == "xoz-control":
        created_at = parse_iso_time(task.get("created_at"))
        records = []
        for record in xoz_activity_records():
            if not is_xoz_comment_record(record):
                continue
            record_time = parse_iso_time(record.get("created_at") or record.get("time") or record.get("at"))
            if created_at and record_time and record_time < created_at:
                continue
            records.append(record)
        if records:
            return "DONE", xoz_comment_overview(records, today_only=False)
        if task_age_seconds(task) > 3600:
            return "BLOCKED", "Agent XOZ nedodal overitelny komentar do activity logu do 60 minut."
        return "VERIFYING", "Agent XOZ ma control zadani; vysledek overuji z activity logu."
    if kind == "technical-blocker":
        proof = task.get("proof") if isinstance(task.get("proof"), dict) else {}
        related_id = str(proof.get("related_task_id") or "")
        for related in load_orchestration_tasks():
            if isinstance(related, dict) and str(related.get("id") or "") == related_id and str(related.get("status") or "") == "DONE":
                return "DONE", "Agent G vyresil technicky blocker; puvodni delegace ma overeny vystup."
        return "VERIFYING", "Agent G resi technicky blocker."
    return "VERIFYING", f"{task.get('agent')} je evidovany, ale nema specializovany verifier."


def delegation_monitor_once() -> None:
    lock_handle = None
    if fcntl is not None:
        lock_path = g.AGENT_WORK_DIR / "DELEGATION_MONITOR.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_handle = lock_path.open("w", encoding="utf-8")
        try:
            fcntl.flock(lock_handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock_handle.close()
            return
    tasks = load_orchestration_tasks()
    try:
        if not tasks:
            return
        pre_changed = cancel_misrouted_xoz_browser_tasks(tasks)
        if pre_changed:
            g.log(f"Canceled {pre_changed} misrouted XOZ browser/form task(s)")
        activity_cleanup_changed = cancel_misrouted_activity_blogger_tasks(tasks)
        if activity_cleanup_changed:
            g.log(f"Canceled {activity_cleanup_changed} misrouted activity/blogger task(s)")
        try:
            xoz_changed = xoz_worker_once(tasks)
            if xoz_changed:
                g.log(f"Agent XOZ worker updated {xoz_changed} task(s)")
        except Exception as exc:
            g.log(f"Agent XOZ worker error: {type(exc).__name__}: {exc}")
        changed = bool(pre_changed or activity_cleanup_changed)
        for task in tasks:
            status = str(task.get("status") or "ASSIGNED")
            rechecking_reported_link = status in {"DONE", "BLOCKED"} and bool(task.get("reported_at")) and should_recheck_reported_blogger_task(task)
            rechecking_agent_d_blocker = status == "BLOCKED" and bool(task.get("reported_at")) and should_auto_escalate_to_agent_g(task, str(task.get("last_observation") or ""))
            if status in {"DONE", "BLOCKED", "CANCELED"} and task.get("reported_at") and not rechecking_reported_link and not rechecking_agent_d_blocker:
                continue
            new_status, note = observe_delegation_task(task)
            now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
            if new_status == "BLOCKED" and should_auto_escalate_to_agent_g(task, note):
                if escalate_task_to_agent_g(task, note):
                    g.log(f"Agent D blocker escalated to Agent G: {str(task.get('id') or '')}")
                new_status = "VERIFYING"
                note = "Agent D ma blocker; predano Agentovi G k technicke oprave."
            if new_status != status or note != task.get("last_observation"):
                task["status"] = new_status
                task["last_observation"] = note
                task["updated_at"] = now
                changed = True
            if (
                new_status in {"ASSIGNED", "VERIFYING"}
                and not task.get("delivery_reported_at")
                and task_age_seconds(task) <= 8 * 3600
            ):
                message = delegation_delivery_note(task)
                notify_result = telegram_notify_deduped(message)
                if notify_result in {"sent", "deduped"}:
                    if notify_result == "sent":
                        g.log(f"-> {message}")
                    task["delivery_reported_at"] = now
                    task["delivery_reported_status"] = new_status
                    changed = True
            should_report = task.get("last_reported_status") != new_status or (
                rechecking_reported_link and new_status == "DONE" and "http" in note
            )
            if new_status in {"DONE", "BLOCKED"} and should_report:
                verb = "Hotovo" if new_status == "DONE" else "Blocker"
                message = f"{verb}: {note}"
                if new_status == "DONE" and str(task.get("kind") or "") == "xoz-social-draft":
                    notify_result = telegram_notify_xoz_approval(task, note)
                else:
                    notify_result = telegram_notify_deduped(message)
                if notify_result in {"sent", "deduped"}:
                    if notify_result == "sent":
                        g.log(f"-> {message}")
                    task["last_reported_status"] = new_status
                    task["reported_at"] = now
                    changed = True
        if changed:
            save_orchestration_tasks(tasks)
    finally:
        if lock_handle is not None:
            try:
                fcntl.flock(lock_handle.fileno(), fcntl.LOCK_UN)
            finally:
                lock_handle.close()


def delegation_monitor_worker_loop() -> None:
    g.log("Virtual Assistant delegation monitor started")
    while True:
        try:
            delegation_monitor_once()
        except Exception as exc:
            g.log(f"Delegation monitor error: {type(exc).__name__}: {exc}")
        time.sleep(60)


def parse_log_time(raw: str) -> dt.datetime | None:
    try:
        parsed = dt.datetime.strptime(raw, "%Y-%m-%d %H:%M:%S")
        return parsed.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)
    except Exception:
        return None


def telegram_recovery_state() -> dict[str, Any]:
    try:
        data = json.loads(RECOVERY_STATE_FILE.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    processed = data.get("processed")
    if not isinstance(processed, list):
        processed = []
    data["processed"] = processed[-200:]
    attempts = data.get("attempts")
    if not isinstance(attempts, dict):
        attempts = {}
    data["attempts"] = attempts
    return data


def save_telegram_recovery_state(state: dict[str, Any]) -> None:
    RECOVERY_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    attempts = state.get("attempts")
    if isinstance(attempts, dict) and len(attempts) > 200:
        state["attempts"] = dict(list(attempts.items())[-200:])
    RECOVERY_STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def has_recent_confirmation_for_text(text: str, max_age_seconds: int = 86400) -> bool:
    normalized = g.normalize_text(text)
    now = dt.datetime.now().astimezone()
    state = load_pending_confirmations()
    for item in state.get("items", {}).values():
        if not isinstance(item, dict):
            continue
        if str(item.get("status") or "") not in {"PENDING", "CONFIRMED", "EXECUTED", "CANCELED"}:
            continue
        if g.normalize_text(str(item.get("text") or "")) != normalized:
            continue
        created = parse_iso_time(item.get("created_at"))
        if created and (now - created).total_seconds() <= max_age_seconds:
            return True
    return False


def recover_unanswered_telegram_once() -> None:
    log_path = g.LOG_FILE
    if not log_path.exists():
        return
    try:
        lines = log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-1500:]
    except Exception:
        return
    events: list[tuple[int, dt.datetime, str, str]] = []
    for idx, line in enumerate(lines):
        match = re.match(r"^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+(<-|->)\s*(.*)$", line)
        if not match:
            continue
        ts = parse_log_time(match.group(1))
        if not ts:
            continue
        direction = match.group(2)
        text = match.group(3).strip()
        if text:
            events.append((idx, ts, direction, text))
    incoming = [event for event in events if event[2] == "<-" and event[3] and not event[3].startswith("/")]
    if not incoming:
        return
    now = dt.datetime.now().astimezone()
    state = telegram_recovery_state()
    processed = set(str(item) for item in state.get("processed") or [])
    attempts = state.get("attempts") if isinstance(state.get("attempts"), dict) else {}
    changed = False
    for idx, ts, _, text in incoming[-10:]:
        later_incoming = [candidate[0] for candidate in incoming if candidate[0] > idx]
        next_incoming_idx = min(later_incoming) if later_incoming else 10**12
        reply_exists = any(
            direction == "->" and event_idx > idx and event_idx < next_incoming_idx
            for event_idx, _, direction, _ in events
        )
        if reply_exists:
            continue
        age = (now - ts).total_seconds()
        if age < 180:
            continue
        msg_id = hashlib.sha1(f"{ts.isoformat()}|{text}".encode("utf-8", errors="replace")).hexdigest()[:16]
        if msg_id in processed:
            continue
        if has_recent_confirmation_for_text(text):
            processed.add(msg_id)
            changed = True
            g.log(f"Telegram recovery skipped confirmed/pending action {msg_id}")
            continue
        attempt = attempts.get(msg_id) if isinstance(attempts.get(msg_id), dict) else {}
        last_attempt_raw = str(attempt.get("last_attempt_at") or "")
        if last_attempt_raw:
            try:
                last_attempt = dt.datetime.fromisoformat(last_attempt_raw)
                if last_attempt.tzinfo is None:
                    last_attempt = last_attempt.replace(tzinfo=now.tzinfo)
                if (now - last_attempt).total_seconds() < 600:
                    continue
            except Exception:
                pass
        try:
            reply = parse_settings_command(text)
            if not reply:
                history = g.load_json(g.HISTORY_FILE, [])
                if not isinstance(history, list):
                    history = []
                history.append({"role": "user", "content": text})
                reply = g.call_ai(history)
                history.append({"role": "assistant", "content": reply})
                g.write_json(g.HISTORY_FILE, history[-g.MAX_HISTORY:])
            if telegram_notify(reply):
                g.log(f"Telegram recovery replied to unanswered message {msg_id}")
                g.log(f"-> {reply[:500]}")
                processed.add(msg_id)
                attempts.pop(msg_id, None)
                changed = True
            else:
                attempt["last_attempt_at"] = now.isoformat(timespec="seconds")
                attempt["last_error"] = "telegram_send_failed"
                attempts[msg_id] = attempt
                changed = True
                g.log(f"Telegram recovery produced reply but send failed for {msg_id}")
        except Exception as exc:
            attempt["last_attempt_at"] = now.isoformat(timespec="seconds")
            attempt["last_error"] = f"{type(exc).__name__}: {str(exc)[:180]}"
            attempt["count"] = int(attempt.get("count") or 0) + 1
            if not attempt.get("fallback_sent_at") and age >= 300:
                fallback = "Zachytila jsem zpravu. Zpracovani se nedokoncilo, zkusim ji znovu a nenecham ji zapadnout."
                if telegram_notify(fallback):
                    g.log(f"Telegram recovery sent fallback for unanswered message {msg_id}")
                    g.log(f"-> {fallback}")
                    attempt["fallback_sent_at"] = now.isoformat(timespec="seconds")
            attempts[msg_id] = attempt
            changed = True
            g.log(f"Telegram recovery failed for {msg_id}: {type(exc).__name__}: {exc}")
    if changed:
        state["processed"] = list(processed)[-200:]
        state["attempts"] = attempts
        state["updated_at"] = dt.datetime.now().astimezone().isoformat(timespec="seconds")
        save_telegram_recovery_state(state)


def telegram_recovery_worker_loop() -> None:
    g.log("Virtual Assistant telegram recovery worker started")
    while True:
        try:
            recover_unanswered_telegram_once()
        except Exception as exc:
            g.log(f"Telegram recovery worker error: {type(exc).__name__}: {exc}")
        time.sleep(90)


def telegram_command_refresh_worker_loop() -> None:
    g.log("Virtual Assistant Telegram command refresh worker started")
    while True:
        try:
            status = refresh_telegram_bot_commands(push_to_telegram=True)
            g.log(f"Telegram bot commands refresh: {status}")
        except Exception as exc:
            g.log(f"Telegram command refresh worker error: {type(exc).__name__}: {exc}")
        time.sleep(600)


def gmail_worker_loop() -> None:
    g.log("Virtual Assistant email worker started")
    while True:
        try:
            gmail_poll_once()
        except Exception as exc:
            g.log(f"Email poll error: {exc}")
        config = gmail_env_config()
        try:
            delay = max(300, int(config.get("poll_seconds", "7200") or "7200"))
        except ValueError:
            delay = 7200
        time.sleep(delay)


def virtual_assistant_main() -> None:
    try:
        refresh_telegram_bot_commands(push_to_telegram=False)
    except Exception as exc:
        g.log(f"Telegram command preparation failed: {type(exc).__name__}: {exc}")
    if "--daemon" in os.sys.argv:
        threading.Thread(target=gmail_worker_loop, name="virtual-assistant-email-worker", daemon=True).start()
        threading.Thread(target=delegation_monitor_worker_loop, name="virtual-assistant-delegation-monitor", daemon=True).start()
        threading.Thread(target=telegram_recovery_worker_loop, name="virtual-assistant-telegram-recovery", daemon=True).start()
        threading.Thread(target=telegram_command_refresh_worker_loop, name="virtual-assistant-command-refresh", daemon=True).start()
    base_main()


def parse_work_style_feedback(text: str) -> str | None:
    low = g.normalize_text(text)
    operational_terms = (
        "prispevek",
        "tweet",
        " x ",
        "x ",
        "x post",
        "clanek",
        "deleg",
        "zadani",
        "zrus",
        "vytvor",
        "udelej",
        "navrh prispevku",
        "ke schvaleni",
    )
    if any(term in low for term in operational_terms):
        return None
    feedback_words = (
        "feedback",
        "pripom",
        "poznamka",
        "priste",
        "styl",
        "ton",
        "empat",
        "samostat",
        "nesamostat",
        "zacykl",
        "opakuj",
        "schval",
        "uprav",
        "prizpusob",
    )
    if not any(word in low for word in feedback_words):
        return None
    if not any(word in low for word in ("mas", "mela", "měl", "měla", "priste", "chci", "nechci", "lepsi", "spis", "poznamka", "pripom")):
        return None
    if len(text.strip()) < 12:
        return None

    compact = re.sub(r"\s+", " ", text.strip())
    memory_line = "- Pracovni feedback: " + compact[:500]
    try:
        g.append_memory_line(memory_line)
    except Exception as exc:
        g.log(f"Virtual Assistant feedback memory write failed: {exc}")
    return (
        "Rozumim, tohle si beru jako pravidlo pro priste. "
        "Budu vic cist zamer za pripominkou, sama upravim ton/proces a nebudu z toho delat dalsi ukol pro tebe. "
        "Kdyz pripravim navrh, dam ti rovnou pouzitelnou verzi a zeptam se jemne: chces neco upravit, nebo schvalujes tento smer?"
    )


def is_xoz_style_and_draft_request_text(text: str) -> bool:
    low = g.normalize_text(text)
    if not any(term in low for term in ("navrh", "prispevek", "post", "tweet", "takovy navrh")):
        return False
    if not any(term in low for term in ("tohle ne", "promo", "affiliate", "bez", "nechci", "udel", "priprav")):
        return False
    if any(term in low for term in ("btc-dca", "btc dca", "agent d")) and not any(term in low for term in ("xoz", "osobni zkusenosti", "osobnizkusenosti", "oz")):
        return False
    return True


def parse_xoz_style_and_draft_request(text: str) -> str | None:
    if not is_xoz_style_and_draft_request_text(text):
        return None
    prefs = update_xoz_draft_preferences_from_text(text)
    topic = infer_recent_xoz_topic(text)
    preference_text = "; ".join(prefs[-6:])
    payload = (
        f"Osobni zkusenosti X navrh ke schvaleni na tema {topic}. "
        "Vytvor hotovy text a obrazovy podklad/prompt. Nepublikuj bez schvaleni."
    )
    if preference_text:
        payload += f" Format preference: {preference_text}"
    ok, target, path = assign_social_x_task(payload, forced_agent_id="agent-xoz")
    append_orchestration_event(target["agent"], target["instance"], payload, target["kind"], path)
    return "Deleguji: navrh prispevku na X pro Osobni zkusenosti: Agent XOZ."


def parse_gmail_signup_request(text: str) -> str | None:
    low = g.normalize_text(text)
    wants_email = any(word in low for word in ("gmail", "google email", "google mail", "e-mail", "email"))
    wants_signup = any(word in low for word in ("zaloz", "vytvor", "registr", "signup", "ucet", "adres"))
    wants_availability = any(word in low for word in ("voln", "dostupn", "over", "zkontrol", "registraci", "registrace"))
    if not (wants_email and (wants_signup or wants_availability)):
        return None

    return "\n".join([
        "Beru. Drzim trvale pravidlo: Gmail smi byt jen kombinace meho jmena a prijmeni, bez profesnich slov, cisel nebo prefixu.",
        "",
        "1. ema.vale@gmail.com",
        "2. vale.ema@gmail.com",
        "",
        "Poznamka: Gmail bere tecky v adrese jako stejnou schranku, takze `emavale@gmail.com` je stejna varianta jako `ema.vale@gmail.com` a `valeema@gmail.com` je stejna varianta jako `vale.ema@gmail.com`.",
        "Volnost neumim spolehlive potvrdit mimo realny Google signup krok; nebudu ji predstirat. Pri registraci zkusim tyto dve varianty v poradi. Pokud nebudou volne, nebudu pridavat slova jako assistant/virtual/work. Navrhnu upravit jmeno nebo prijmeni.",
        "",
        "Postup:",
        "- otevrit https://accounts.google.com/signup",
        "- jmeno: Ema",
        "- prijmeni: Vale",
        "- datum narozeni: doplnit az podle toho, jakou verejnou identitu schvalis",
        "- gender: radeji neuvadet, pokud Google dovoli preskocit",
        "- zkusit prvni adresu, kdyz nebude volna, jit postupne dalsi variantou",
        "- silne heslo nevkladat do chatu ani pameti; zadat ho jen v session/browseru",
        "- u citliveho kroku mimo moji session pripravim vse kolem a pockam na browser handoff",
        "",
        "Navazne po zalozeni pripravim LinkedIn profil, fotku/prompt a kratky nabidkovy text. Chces neco upravit, nebo mam brat jmeno Ema Vale a prvni variantu Gmailu jako schvaleny smer?",
    ])


g._base_handle_settings_callback = g.handle_settings_callback
g._base_parse_settings_command = g.parse_settings_command
g.load_env = virtual_assistant_load_env
g.ensure_agent_workspace = ensure_virtual_assistant_workspace
g.build_web_context = virtual_assistant_build_web_context
g.route_model_for_task = virtual_assistant_route_model_for_task
g.timeout_for_route = virtual_assistant_timeout_for_route
g.call_codex = virtual_assistant_call_codex
g.call_ai = virtual_assistant_call_ai
g.main = virtual_assistant_main
g.settings_help = settings_help
g.settings_panel_text = settings_panel_text
g.settings_panel = settings_panel
g.handle_settings_callback = handle_settings_callback
g.parse_settings_command = parse_settings_command
g.status_text = status_text
g.BOT_COMMANDS = build_telegram_bot_commands()


if __name__ == "__main__":
    g.main()
