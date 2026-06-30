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
- Kdyz Jakub zada kampan, oznameni, produktovou novinku, marketingovy rollout nebo ukol pro btc-dca.com, automaticky uvazuj v rezimu koordinatora.
- Nejdriv vytvor kampanovy brief: cil, cilove publikum, hlavni sdeleni, CTA, zdroje pravdy, navrhovane kanaly a rizika.
- Pak rozhodni, ktere agenty zapojit podle `/home/openclaw2/.openclaw/virtual-assistant/AGENT_REGISTRY.md`.
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
- Ved stav v `/home/openclaw2/.openclaw/virtual-assistant/ORCHESTRATION.md`: task id, agent, zadani, stav, posledni kontakt, dukaz hotovo, blocker, dalsi krok.
- Nehlas Jakubovi "hotovo", dokud nemas overovaci dukaz: publikovana URL, workflow output, log, state file, issue/comment summary nebo explicitni potvrzeni agenta.
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
            "Umi fungovat jako orchestrace Jakubovych agentu: rozpadne kampan na ukoly, zada je Agentum C/M/D/G podle role a overi vysledky.",
            "Nesmí se zaseknout v opakovanych dotazech; ma sama pripravovat hotove navrhy a ptat se jen na skutecne blokery.",
            "Ma zakladni browser check pres headless Chromium helper; nema tvrdit, ze se stranka neda nacist, dokud helper nezkusi.",
            "Ma Playwright helper pro browser ukoly; bezne formulare vcetne komentaru ma na Jakubovo zadani vyplnit i odeslat, u citlivych externich kroku pripravi praci kolem nich a vyzada si schvaleni.",
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
            "- Kanal: blogovaci agent z runtime registru, typicky instance `oz` / Agent OZ, pokud je dostupna v konfiguraci blogeru.",
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


def ensure_virtual_assistant_workspace() -> None:
    g.AGENT_WORK_DIR.mkdir(parents=True, exist_ok=True)
    for path, content in virtual_assistant_templates().items():
        if not path.exists():
            path.write_text(content, encoding="utf-8")


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
        "",
        "Zkratky porad funguji: /mini, /max, /fast, /balanced, /deep.",
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


def handle_settings_callback(data: str) -> tuple[str, dict[str, Any], str]:
    text, markup, notice = g._base_handle_settings_callback(data)
    return replace_agent_name(text), markup, notice


def parse_settings_command(text: str) -> str | None:
    reply = g._base_parse_settings_command(text)
    if reply is None:
        combined_delegation_reply = parse_combined_delegation_request(text)
        if combined_delegation_reply:
            return combined_delegation_reply
        delegation_reply = parse_blogger_delegation_request(text)
        if delegation_reply:
            return delegation_reply
        general_delegation_reply = parse_general_delegation_request(text)
        if general_delegation_reply:
            return general_delegation_reply
        gmail_reply = parse_gmail_signup_request(text)
        if gmail_reply:
            return gmail_reply
        feedback_reply = parse_work_style_feedback(text)
        if feedback_reply:
            return feedback_reply
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
    return any(term in low for term in ("publikuj", "publish", "zverejni", "zveřejni", "vydej", "postni"))


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


def append_jsonl(path: Path, item: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(item, ensure_ascii=False) + "\n")


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
        return False, str(inbox)


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


def parse_combined_delegation_request(text: str) -> str | None:
    has_blog = blogger_delegation_target(text) is not None
    has_social = is_social_delegation_task(text)
    if not (has_blog and has_social):
        return None

    parts: list[str] = ["Kombinovanou delegaci jsem rozdělila na samostatné úkoly:"]
    blog_reply = parse_blogger_delegation_request(text)
    if blog_reply:
        parts.append("")
        parts.append("Agent pro článek:")
        parts.append(blog_reply)
    else:
        parts.append("")
        parts.append("Agent pro článek: rozpoznala jsem blogový cíl, ale chybí jasné téma nebo konfigurace. Zapsala jsem to k dořešení.")
        append_orchestration_event("Blog agent", "blog", text, "blog-assignment-needs-routing", "ORCHESTRATION.md")

    ok, target = assign_agent_d_x_idea(text)
    append_orchestration_event("Agent D", "x-poster", text, "x-social-draft", target)
    parts.append("")
    parts.append("Agent D / X:")
    if ok:
        parts.append(f"Zadání uloženo do `{target}` jako podklad pro návrh X příspěvku.")
    else:
        parts.append(f"Primární stav nešel zapsat, zadání je uložené aspoň v `{target}`.")
    parts.append("")
    parts.append("Nebudu to vydávat za hotové publikování, dokud nebude ověřený draft článku a návrh X příspěvku.")
    return "\n".join(parts)


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
        ok, target = assign_agent_d_x_idea(text)
        append_orchestration_event("Agent D", "x-poster", text, "x-social-draft", target)
        if ok:
            assigned.append(f"Agent D / X: zadani ulozeno do `{target}` jako podklad pro dalsi draft.")
        else:
            blockers.append(f"Agent D / X: primarni stav nesel zapsat, ulozeno aspon do inboxu `{target}`.")

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
        assigned.append(f"Agent M: zadani ulozeno do `{inbox}`.")

    wants_btc_blog = any(term in low for term in ("blog", "wordpress", "agent c", "agenta c")) or (
        any(term in low for term in ("btc-dca", "btc dca"))
        and any(term in low for term in ("blog", "wordpress", "clanek", "clanku", "članek", "článku", "article"))
    )
    if wants_btc_blog and not blogger_delegation_target(text):
        instance = resolve_blogger_instance(("btc-dca", "btcdca"), ("btc-dca", "btc dca", "btcdca"))
        append_orchestration_event("Agent C", instance, text, "blog-assignment-needs-topic", "ORCHESTRATION.md")
        blockers.append(f"Agent C: chybi jednoznacne tema clanku, zapsano do ORCHESTRATION pro follow-up; nepoustim publikaci bez tematu.")

    if not assigned and not blockers:
        append_orchestration_event("Virtual Assistant", "orchestration", text, "needs-routing", "ORCHESTRATION.md")
        blockers.append("Rozpoznala jsem delegacni zadani, ale neurcila jsem bezpecneho ciloveho agenta. Zapsano do ORCHESTRATION k doreseni.")

    lines = ["Delegace provedena / zapsana:"]
    lines.extend(f"- {item}" for item in assigned)
    if blockers:
        lines.append("")
        lines.append("K doreseni:")
        lines.extend(f"- {item}" for item in blockers)
    lines.append("")
    lines.append("Nebudu to vydavat za hotove publikovani, dokud nebude overeny vystup od prislusneho agenta.")
    return "\n".join(lines)


def parse_blogger_delegation_request(text: str) -> str | None:
    target = blogger_delegation_target(text)
    if not target:
        return None
    low = g.normalize_text(text)
    if not any(term in low for term in ("clanek", "clanku", "članek", "článku", "draft", "post", "tema", "téma", "napiš", "napis", "napsat", "vygeneruj", "priprav", "připrav", "zadej", "deleguj")):
        return None

    instance, agent_name = target
    publish = explicit_publish_requested(text)
    if agent_name in {"Agent OZ", "Agent osobnizkusenosti-cz"} and publish:
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

    state_path = write_blogger_requested_topic(instance, topic)
    log_path = g.OPENCLAW_DIR / "logs" / f"virtual-assistant-{instance}-delegation.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    topic_arg = shlex.quote(topic)
    if publish:
        command = f"python3 {shlex.quote(str(script))} --instance {shlex.quote(instance)} --topic {topic_arg} --phase all --force"
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

    if agent_name in {"Agent OZ", "Agent osobnizkusenosti-cz"}:
        return "\n".join([
            f"Zadano agentovi osobnizkusenosti-cz jako draft, bez publikace.",
            f"Instance: `{instance}`",
            f"Tema: {topic}",
            f"State: `{state_path}`",
            f"Log: `{log_path}`",
            f"Runner: `{runner}`",
            "Az draft dobehne, overim vystup ze state/logu. Agenta C jsem nepouzila.",
        ])
    return "\n".join([
        f"Zadano Agentovi C.",
        f"Instance: `{instance}`",
        f"Rezim: {'publikace' if publish else 'draft/article bez publikace'}",
        f"Tema: {topic}",
        f"State: `{state_path}`",
        f"Log: `{log_path}`",
        f"Runner: `{runner}`",
    ])


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
    models = ["gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"]
    last_error: Exception | None = None
    for model in models:
        for attempt in range(3):
            try:
                return _call_gemini_model(history, api_key, model)
            except RuntimeError as exc:
                last_error = exc
                text = str(exc)
                if "HTTP 503" not in text and "HTTP 429" not in text:
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


def virtual_assistant_call_ai(history: list[dict[str, str]]) -> str:
    cleaned_history = remove_automated_google_history(history)
    if len(cleaned_history) != len(history):
        history[:] = cleaned_history
        g.write_json(g.HISTORY_FILE, history[-g.MAX_HISTORY:])
        g.log("Automated Google email instructions removed from Virtual Assistant history")
    try:
        return virtual_assistant_call_codex(history)
    except Exception as codex_exc:
        g.log(f"Codex backend failed, trying Virtual Assistant fallback: {str(codex_exc)[:180]}")
        env = g.load_env()
        api_key = next(
            (env.get(k) for k in ("GEMINI_VA_API_KEY", "GEMINI_API_KEY_FREE", "GEMINI_AGENT_C_KEY", "GEMINI_API_KEY_G", "GEMINI_API_KEY") if env.get(k)),
            None,
        )
        if api_key:
            return _call_gemini(history, api_key)
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
    if "--daemon" in os.sys.argv:
        threading.Thread(target=gmail_worker_loop, name="virtual-assistant-email-worker", daemon=True).start()
    base_main()


def parse_work_style_feedback(text: str) -> str | None:
    low = g.normalize_text(text)
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
g.BOT_COMMANDS = [
    {"command": "menu", "description": "Menu nastaveni Virtualni asistentky"},
    {"command": "status", "description": "Bezpecny stav a aktualni model"},
    {"command": "usage", "description": "Lokalni mereni pouziti Codexu"},
    {"command": "model", "description": "Vybrat ChatGPT/Codex model"},
    {"command": "rychlost", "description": "Vybrat rychlost odpovedi"},
    {"command": "inteligence", "description": "Vybrat uroven premysleni"},
    {"command": "reset", "description": "Smazat historii konverzace"},
]


if __name__ == "__main__":
    g.main()
